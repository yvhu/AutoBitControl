# 任务页「测试」手选窗口触发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务页每个任务卡片新增「测试」按钮，弹窗多选启用窗口后只对这些窗口触发该任务，行为与「立即触发」完全一致（错峰、全局开窗上限、任务并发、在途守卫、任务开关限制）。

**Architecture:** 后端在既有 `POST /api/tasks/:key/trigger` 上新增 `profileIds` 分支（复用「立即触发」的 `enqueue` 路径，不带 `immediate`），批次 `source='trigger-test'`。前端扩展 `triggerTask` 签名、新增 `useTestTask` hook 与 `TestWindowModal` 弹窗组件，任务卡片挂载入口。

**Tech Stack:** TypeScript（严格模式）、Express 5、Node SQLite（libsql）、React 18 + Vite 5 + antd 5 + react-query、vitest + @testing-library/react + supertest。

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块说明职责与依赖方向。
- 注释 / 文档 / commit message 一律中文；commit 风格 conventional：`feat:`/`docs:` + 中文描述。
- 依赖方向不可反向：`tasks → engine → {integrations, automation} → infrastructure`；`server → {engine, infrastructure}`；前端只经 `web/src/api/endpoints.ts` 发请求。
- 任务开关（`meta.enabled` + 本地库 `task_states`）对测试入口**照旧生效**（停用 → 409），不新增 bypass。
- 测试入口与「立即触发」共享全部真机规则：随机错峰（`execution.staggerMaxSec`）、全局开窗上限（`maxConcurrentWindows`）、任务级并发（`meta.concurrency`）、在途守卫；**不带 `immediate`**。
- 窗口池与「立即触发」一致：仅启用窗口（`profiles.enabled === 1`）。
- 错误码复用既有 `ERROR_CODES`（`INVALID_ARGUMENT` 40000、`PROFILE_NOT_FOUND` 40402、`TASK_NOT_FOUND` 40401、`TASK_DISABLED` 40901、`TASK_RUNNING` 40902），不新增。
- 每批改完必须 `npm run typecheck`、`npm test` 通过；前端改动另跑 `npm run test:web`。

---

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/server/routes/tasks.ts` | 修改 | trigger 路由新增 `profileIds` 分支 + swagger 注解 |
| `tests/web.test.ts` | 修改 | 后端 trigger `profileIds` 分支路由单测 |
| `web/src/api/endpoints.ts` | 修改 | `triggerTask` 签名扩展为 opts 对象，返回类型加 `selected` |
| `web/src/pages/dashboard/hooks.ts` | 修改 | 调用点随签名改为 opts 对象 |
| `web/src/api/schema.d.ts` | 修改 | 手补 trigger requestBody `profileIds` 与 `scope` 枚举 |
| `web/src/pages/tasks/hooks.ts` | 修改 | 新增 `useTestTask` |
| `web/src/pages/tasks/TestWindowModal.tsx` | 新建 | 窗口多选弹窗组件 + 纯过滤函数 |
| `web/src/pages/tasks/TestWindowModal.test.tsx` | 新建 | 纯函数与弹窗交互单测 |
| `web/src/pages/tasks/index.tsx` | 修改 | 任务卡片挂「测试」按钮 + 弹窗 |
| `web/src/pages/tasks/TasksPage.test.tsx` | 修改 | mock 模块补 `fetchProfiles`，防导入 undefined |
| `docs/API-GUIDE.md` | 修改 | 试跑验证与运维要点补「测试」入口说明 |

---

### Task 1: 后端 trigger 端点支持 `profileIds`

**Files:**
- Modify: `src/server/routes/tasks.ts`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: `deps.db.listProfiles(enabledOnly: boolean): Promise<ProfileRow[]>`、`deps.db.countInFlightRuns(taskKey: string, date: string, profileId?: number): Promise<number>`、`deps.db.createBatch(kind: BatchKind, taskKey: string, source: string): Promise<BatchRow>`、`deps.enqueuer.enqueue(profile, taskKey, opts?: { immediate?: boolean; batchId?: number }): void`、`deps.enqueuer.hasTaskInFlight(taskKey: string, profileId?: number): boolean`
- Produces: `POST /api/tasks/:key/trigger` body 支持 `{ profileIds: string[] }`，成功返回 `{ scope: 'selected' }`

- [ ] **Step 1: 写失败测试**

在 `tests/web.test.ts` 的 `describe('server API（RESTful + envelope）', ...)` 内，紧跟现有用例 `it('单窗口触发该窗口在途返回 409', ...)`（约 454 行）之后，插入以下用例：

```ts
  it('多窗口测试触发：选中窗口入队不走 immediate，批次 source=trigger-test', async () => {
    const deps = makeDeps()
    deps.db.listProfiles.mockResolvedValue([
      { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      { id: 2, bitbrowserId: 'bb-2', name: '窗口2', enabled: 1, circuitBreakerCount: 0 },
    ])
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ profileIds: ['bb-1', 'bb-2'] })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ scope: 'selected' })
    expect(deps.db.createBatch).toHaveBeenCalledWith('bulk', 't1', 'trigger-test')
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(2)
    expect(deps.enqueuer.enqueue.mock.calls[0][0].bitbrowserId).toBe('bb-1')
    expect(deps.enqueuer.enqueue.mock.calls[1][0].bitbrowserId).toBe('bb-2')
    expect(deps.enqueuer.enqueue.mock.calls[0][2]).toEqual({ batchId: 88 })
  })

  it('多窗口测试触发：重复 id 去重', async () => {
    const deps = makeDeps()
    deps.db.listProfiles.mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }])
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ profileIds: ['bb-1', 'bb-1'] })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ scope: 'selected' })
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
  })

  it('多窗口测试触发：空数组 400', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ profileIds: [] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('多窗口测试触发：未知窗口 404', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ profileIds: ['nope'] })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40402)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('多窗口测试触发：未启用窗口 400', async () => {
    const deps = makeDeps()
    deps.db.listProfiles.mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 0, circuitBreakerCount: 0 }])
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ profileIds: ['bb-1'] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('多窗口测试触发：选中窗口在途 409', async () => {
    const deps = makeDeps()
    deps.db.listProfiles.mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }])
    deps.db.countInFlightRuns.mockImplementation((_k: string, _d: string, pid?: number) => Promise.resolve(pid === 1 ? 1 : 0))
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ profileIds: ['bb-1'] })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(40902)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('多窗口测试触发：任务停用 409', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ profileIds: ['bb-1'] })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(40901)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts -t "多窗口测试触发"`

Expected: FAIL（`profileIds` 分支未实现 → 走全量分支，`scope` 为 `all`、`createBatch` 收到 `trigger-all`）。

- [ ] **Step 3: 实现 `profileIds` 分支**

在 `src/server/routes/tasks.ts` 的 `router.post('/tasks/:key/trigger', ...)` 内，把 body 类型与缓存行替换为：

```ts
    // Express 5 bodyless 请求时 req.body 可能为 undefined，统一 ?? {} 兜底
    const body = (req.body ?? {}) as { bitbrowserId?: string; profileIds?: unknown }
    // 指定窗口列表：测试入口（手选若干启用窗口；语义等同批量触发，走错峰 + 双闸门）
    if (body.profileIds !== undefined) {
      if (!Array.isArray(body.profileIds) || body.profileIds.length === 0 || !body.profileIds.every((id) => typeof id === 'string' && id !== '')) {
        throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'profileIds 必须为非空字符串数组')
      }
      const ids = [...new Set(body.profileIds as string[])]
      const allProfiles = await deps.db.listProfiles(false)
      const selected: ProfileRow[] = []
      for (const id of ids) {
        const p = allProfiles.find((x: ProfileRow) => x.bitbrowserId === id)
        if (!p) throw new HttpError(404, ERROR_CODES.PROFILE_NOT_FOUND, `窗口不存在: ${id}`)
        if (p.enabled !== 1) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `窗口未启用: ${id}`)
        selected.push(p)
      }
      const busy: string[] = []
      for (const p of selected) {
        if ((await deps.db.countInFlightRuns(key, todayStr(), p.id)) > 0 || deps.enqueuer.hasTaskInFlight(key, p.id)) busy.push(p.bitbrowserId)
      }
      if (busy.length > 0) throw new HttpError(409, ERROR_CODES.TASK_RUNNING, `以下窗口任务执行中，请等待结束再触发: ${busy.join(', ')}`)
      const batch = await deps.db.createBatch('bulk', key, 'trigger-test')
      for (const p of selected) deps.enqueuer.enqueue(p, key, { batchId: batch.id })
      ok(res, { scope: 'selected' })
      return
    }
    // 指定窗口：单窗口触发（面板矩阵行级重跑）
    if (body.bitbrowserId) {
```

（即：保留原 `if (body.bitbrowserId) {` 及其后全量分支代码不变，仅在其前插入 `profileIds` 分支，并扩展 body 类型。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/web.test.ts -t "多窗口测试触发"`

Expected: PASS（7 条用例全过）。

- [ ] **Step 5: 同步 swagger 注解**

在同一文件的 `@swagger` 注释块 `/api/tasks/{key}/trigger` 中，requestBody schema 的 `bitbrowserId` 属性之后追加 `profileIds`，并把 200 响应的 `scope` 枚举加上 `selected`：

```yaml
 *               bitbrowserId:
 *                 type: string
 *                 description: 指定窗口 id（缺省跑全部启用窗口）
 *               profileIds:
 *                 type: array
 *                 items: { type: string }
 *                 description: 指定窗口 id 列表（测试入口，手选启用窗口；语义同批量触发，走错峰与并发闸门）
```

```yaml
 *                     scope: { type: string, enum: [single, all, selected] }
```

- [ ] **Step 6: 回归 + 提交**

Run: `npm test`
Expected: 全部 PASS（含 OpenAPI 文档用例）。

```bash
git add src/server/routes/tasks.ts tests/web.test.ts
git commit -m "feat: trigger 端点支持 profileIds 手选窗口（测试入口，走错峰与并发闸门）"
```

---

### Task 2: 前端 API 层 `triggerTask` 签名扩展

**Files:**
- Modify: `web/src/api/endpoints.ts:9`
- Modify: `web/src/pages/dashboard/hooks.ts:34`
- Modify: `web/src/api/schema.d.ts:594-601,616`

**Interfaces:**
- Produces: `triggerTask(key: string, opts?: { bitbrowserId?: string; profileIds?: string[] }): Promise<{ scope: 'single' | 'all' | 'selected' }>`

- [ ] **Step 1: 改 `endpoints.ts`**

把第 9 行替换为：

```ts
export type TriggerScope = 'single' | 'all' | 'selected'
export const triggerTask = (key: string, opts: { bitbrowserId?: string; profileIds?: string[] } = {}) =>
  post<{ scope: TriggerScope }>(`/api/tasks/${encodeURIComponent(key)}/trigger`, opts)
```

- [ ] **Step 2: 改 `dashboard/hooks.ts` 调用点**

把第 34 行的 `triggerTask(key, bitbrowserId)` 替换为：

```ts
    mutationFn: ({ key, bitbrowserId }: { key: string; bitbrowserId?: string }) => triggerTask(key, { bitbrowserId }),
```

- [ ] **Step 3: 手补 `schema.d.ts` 类型**

在 `web/src/api/schema.d.ts` 的 `/api/tasks/{key}/trigger` POST requestBody 中，`bitbrowserId` 属性之后加：

```ts
                        /** @description 指定窗口 id 列表（测试入口，手选启用窗口） */
                        profileIds?: string[];
```

并把 200 响应的 `scope` 枚举行改为：

```ts
                                scope?: "single" | "all" | "selected";
```

- [ ] **Step 4: 类型与既有测试验证**

Run: `npm run typecheck`
Expected: 无错误。

Run: `npm run test:web`
Expected: 既有前端测试全 PASS（`tasks/hooks.ts` 的 `triggerTask(key)` 调用仍编译通过）。

- [ ] **Step 5: 提交**

```bash
git add web/src/api/endpoints.ts web/src/pages/dashboard/hooks.ts web/src/api/schema.d.ts
git commit -m "feat: triggerTask 前端签名支持 profileIds 与 selected 范围"
```

---

### Task 3: 前端「测试」入口（hook + 弹窗 + 卡片集成）

**Files:**
- Modify: `web/src/pages/tasks/hooks.ts`（新增 `useTestTask`）
- Create: `web/src/pages/tasks/TestWindowModal.tsx`
- Create: `web/src/pages/tasks/TestWindowModal.test.tsx`
- Modify: `web/src/pages/tasks/index.tsx`
- Modify: `web/src/pages/tasks/TasksPage.test.tsx`

**Interfaces:**
- Consumes: `triggerTask`（Task 2）、`fetchProfiles(): Promise<ProfileRow[]>`、`useTasks`/`useTriggerTask` 模式
- Produces:
  - `useTestTask(): UseMutationResult<{ scope: TriggerScope }, unknown, { key: string; profileIds: string[] }>`
  - `enabledProfiles(profiles: ProfileRow[]): ProfileRow[]`
  - `filterByKeyword(profiles: ProfileRow[], kw: string): ProfileRow[]`
  - `TestWindowModal`（默认导出），props `{ open: boolean; taskName: string; submitting: boolean; onCancel: () => void; onSubmit: (profileIds: string[]) => void }`

- [ ] **Step 1: 写失败测试（弹窗组件）**

创建 `web/src/pages/tasks/TestWindowModal.test.tsx`：

```tsx
/**
 * TestWindowModal 单测：启用窗口过滤、关键词过滤、至少选一个校验、提交 payload
 * 依赖方向：mock ../../api/endpoints；antd App + QueryClientProvider 包裹
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import TestWindowModal, { enabledProfiles, filterByKeyword } from './TestWindowModal'
import { fetchProfiles } from '../../api/endpoints'
import type { ProfileRow } from '../../types'

vi.mock('../../api/endpoints', () => ({ fetchProfiles: vi.fn() }))

const mk = (id: number, name: string, bitbrowserId: string, enabled: number, open = false): ProfileRow =>
  ({ id, name, bitbrowserId, enabled, open }) as unknown as ProfileRow

describe('enabledProfiles / filterByKeyword（纯函数）', () => {
  const rows = [mk(1, '窗口1', 'bb-1', 1), mk(2, '窗口2', 'bb-2', 0), mk(3, '张三', 'bb-3', 1)]

  it('只保留启用窗口', () => {
    expect(enabledProfiles(rows).map((p) => p.id)).toEqual([1, 3])
  })

  it('按名称/ID 关键词过滤；空白关键词不过滤', () => {
    expect(filterByKeyword(rows, '张三').map((p) => p.id)).toEqual([3])
    expect(filterByKeyword(rows, 'bb-3').map((p) => p.id)).toEqual([3])
    expect(filterByKeyword(rows, '   ').length).toBe(3)
  })
})

function renderModal(onSubmit = vi.fn(), onCancel = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <App>
      <QueryClientProvider client={qc}>
        <TestWindowModal open taskName="测试任务" submitting={false} onCancel={onCancel} onSubmit={onSubmit} />
      </QueryClientProvider>
    </App>,
  )
  return { onSubmit, onCancel }
}

describe('TestWindowModal', () => {
  beforeEach(() => {
    vi.mocked(fetchProfiles).mockResolvedValue([mk(1, '窗口1', 'bb-1', 1), mk(2, '窗口2', 'bb-2', 0)])
  })

  it('只列出启用窗口', async () => {
    renderModal()
    expect(await screen.findByText(/窗口1/)).toBeInTheDocument()
    expect(screen.queryByText(/窗口2/)).not.toBeInTheDocument()
  })

  it('未选中时提交按钮禁用；选中后提交调用 onSubmit(profileIds)', async () => {
    const { onSubmit } = renderModal()
    await screen.findByText(/窗口1/)
    const ok = screen.getByRole('button', { name: '提交执行' })
    expect(ok).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(ok).not.toBeDisabled())
    fireEvent.click(ok)
    expect(onSubmit).toHaveBeenCalledWith(['bb-1'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:web -- TestWindowModal`
Expected: FAIL（`./TestWindowModal` 不存在 → 无法解析模块）。

- [ ] **Step 3: 实现弹窗组件**

创建 `web/src/pages/tasks/TestWindowModal.tsx`：

```tsx
/**
 * 测试窗口选择弹窗（tasks 页）：多选启用窗口后对选中窗口触发任务
 * 依赖方向：依赖 api/endpoints 与 types；被 tasks/index 引用
 * 设计思路：窗口池与「立即触发」一致（仅启用窗口）；至少选一个才可提交
 */
import { useEffect, useMemo, useState } from 'react'
import { Modal, Input, Checkbox, Space, Spin, Empty, Typography } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { fetchProfiles } from '../../api/endpoints'
import type { ProfileRow } from '../../types'

/** 只保留启用窗口（与「立即触发」窗口池一致） */
export function enabledProfiles(profiles: ProfileRow[]): ProfileRow[] {
  return profiles.filter((p) => p.enabled === 1)
}

/** 按名称/比特 id 关键词过滤；空白关键词返回原数组 */
export function filterByKeyword(profiles: ProfileRow[], kw: string): ProfileRow[] {
  const q = kw.trim().toLowerCase()
  if (!q) return profiles
  return profiles.filter((p) => p.name.toLowerCase().includes(q) || (p.bitbrowserId ?? '').toLowerCase().includes(q))
}

/** 窗口勾选项文案：序号 名称（ID 前 8 位）· 已打开 */
export function profileLabel(p: ProfileRow): string {
  return `${String(p.id).padStart(2, '0')} ${p.name}（${(p.bitbrowserId ?? '').slice(0, 8)}）${p.open ? ' · 已打开' : ''}`
}

export interface TestWindowModalProps {
  open: boolean
  taskName: string
  submitting: boolean
  onCancel: () => void
  onSubmit: (profileIds: string[]) => void
}

export default function TestWindowModal({ open, taskName, submitting, onCancel, onSubmit }: TestWindowModalProps) {
  const { data, isPending } = useQuery({ queryKey: ['profiles'], queryFn: fetchProfiles, enabled: open })
  const [selected, setSelected] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')

  // 每次打开重置选择与搜索
  useEffect(() => {
    if (open) {
      setSelected([])
      setKeyword('')
    }
  }, [open])

  const total = enabledProfiles(data ?? [])
  const profiles = useMemo(() => filterByKeyword(total, keyword), [total, keyword])

  return (
    <Modal
      open={open}
      title={`测试执行：${taskName}`}
      okText="提交执行"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: selected.length === 0 }}
      onOk={() => onSubmit(selected)}
      onCancel={onCancel}
    >
      {isPending ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : total.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无启用窗口" />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Typography.Text type="secondary">
            选择要执行该任务的启用窗口（可多选，等同于只对这些窗口「立即触发」）
          </Typography.Text>
          <Input placeholder="搜索窗口名称 / ID" allowClear value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <Checkbox.Group
              value={selected}
              onChange={(v) => setSelected(v as string[])}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              {profiles.map((p) => (
                <Checkbox key={p.bitbrowserId} value={p.bitbrowserId}>
                  {profileLabel(p)}
                </Checkbox>
              ))}
            </Checkbox.Group>
          </div>
        </Space>
      )}
    </Modal>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:web -- TestWindowModal`
Expected: PASS（4 条用例全过）。

- [ ] **Step 5: 新增 `useTestTask` hook**

在 `web/src/pages/tasks/hooks.ts` 末尾（`useTriggerTask` 之后）追加：

```ts
export function useTestTask() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, profileIds }: { key: string; profileIds: string[] }) => triggerTask(key, { profileIds }),
    onSuccess: (_res, { profileIds }) => {
      message.success(`已提交 ${profileIds.length} 个窗口执行`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 6: 任务卡片挂「测试」按钮 + 弹窗**

在 `web/src/pages/tasks/index.tsx`：

1）顶部 hooks 导入补 `useTestTask`，并新增弹窗导入：

```tsx
import {
  bucketTasks,
  categoryColor,
  categoryLabel,
  groupColor,
  groupTasks,
  toggleKey,
  useSetTaskEnabled,
  useTasks,
  useTestTask,
  useTriggerTask,
  type TaskGroup,
} from './hooks'
import TestWindowModal from './TestWindowModal'
```

2）`TaskCard` 内新增本地状态与 mutation：

```tsx
function TaskCard({ task }: { task: TaskMetaView }) {
  const setEnabled = useSetTaskEnabled()
  const trigger = useTriggerTask()
  const test = useTestTask()
  const [testOpen, setTestOpen] = useState(false)
```

3）把卡片右侧 `{task.enabled && ( <Button ... 立即触发 /> )}` 之后追加「测试」按钮：

```tsx
          {task.enabled && (
            <Button size="small" onClick={() => setTestOpen(true)}>
              测试
            </Button>
          )}
```

4）在 `TaskCard` 的 `</Card>` 之前（右侧 `</div>` 之后）挂载弹窗：

```tsx
      <TestWindowModal
        open={testOpen}
        taskName={task.name}
        submitting={test.isPending}
        onCancel={() => setTestOpen(false)}
        onSubmit={(profileIds) => test.mutate({ key: task.key, profileIds }, { onSuccess: () => setTestOpen(false) })}
      />
    </Card>
```

- [ ] **Step 7: 更新 `TasksPage.test.tsx` 的模块 mock**

把该文件第 13-17 行的 `vi.mock('../../api/endpoints', ...)` 改为补上 `fetchProfiles`：

```tsx
vi.mock('../../api/endpoints', () => ({
  fetchTasks: vi.fn(),
  setTaskEnabled: vi.fn(),
  triggerTask: vi.fn(),
  fetchProfiles: vi.fn(),
}))
```

- [ ] **Step 8: 跑前端测试与类型检查**

Run: `npm run test:web`
Expected: 全部 PASS（含新增弹窗用例与既有 TasksPage 用例）。

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 9: 提交**

```bash
git add web/src/pages/tasks/hooks.ts web/src/pages/tasks/TestWindowModal.tsx web/src/pages/tasks/TestWindowModal.test.tsx web/src/pages/tasks/index.tsx web/src/pages/tasks/TasksPage.test.tsx
git commit -m "feat: 任务页新增「测试」手选窗口触发入口"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md`（「试跑与验证」约 122 行；「运维要点」约 1136 行）

> 注：`docs/API-GUIDE.md` 现为「函数手册」结构（止于第 7 章），无独立 REST 总表章节；本次把触发入口说明补在最相关的两处用户可见位置。

- [ ] **Step 1: 补「试跑与验证」**

在 `docs/API-GUIDE.md` 第 122 行「**面板验证**」条目后追加第 3 条（原第 3 条「看现场」顺延为第 4 条）：

```md
3. **面板手选窗口测试**：任务页卡片点「测试」，弹窗多选若干启用窗口后只对这些窗口执行（行为等同「立即触发」，只是窗口集合手选；受任务开关与全部真机规则约束）。
```

- [ ] **Step 2: 补「运维要点」**

在 `docs/API-GUIDE.md` 的「6）运维要点」小节约 1136 行「单窗口触发」条目后追加一条：

```md
- 多窗口测试触发：任务页卡片「测试」→ 弹窗多选启用窗口，等价于「立即触发」的子集（走错峰与并发闸门，受开关限制）；对应 `POST /api/tasks/:key/trigger` + body `{"profileIds":["<id>","<id>"]}`，返回 `scope=selected`。
```

- [ ] **Step 3: 提交**

```bash
git add docs/API-GUIDE.md
git commit -m "docs: 同步任务页「测试」手选窗口触发说明"
```

---

### Task 5: 全量验证

**Files:** 无（只验证）

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 2: 后端测试**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 3: 前端测试**

Run: `npm run test:web`
Expected: 全部 PASS。

- [ ] **Step 4: 手动真机冒烟（需比特浏览器在运行，遵守 AGENTS 真机规范）**

1. 确认无 AI 自启残留 node 进程，复用用户已运行的 `npm run dev` 后端（不要并行再起第二个后端）。
2. 打开 Vite 面板任务页，找任一**启用**任务点「测试」，弹窗应只列启用窗口。
3. 选 1~2 个窗口提交，观察：仅选中窗口开窗执行；日志/看板出现 `source=trigger-test` 批次；未选中窗口不受影响。
4. 复验「立即触发」与看板行级「执行/重跑」行为不变；对停用任务不显示「测试」按钮。

---

## Self-Review

**Spec coverage：**
- 入口（任务页卡片「测试」）→ Task 3；窗口多选弹窗 → Task 3 Step 3；仅启用窗口 → `enabledProfiles`；至少选一个 → `okButtonProps.disabled` + 测试。
- 后端 `profileIds` 分支、三态互斥、校验（空数组/未知 id/未启用/在途/停用）、批次 `source=trigger-test`、`scope=selected`、不带 `immediate` → Task 1。
- 前端 `triggerTask` 签名与 `dashboard/hooks.ts` 调用点、`schema.d.ts` 手补 → Task 2。
- 文档 8.2/8.3 同步 → Task 4（已说明手册现存结构，落到实际位置）。
- 验证计划（typecheck/test/test:web + 真机）→ Task 5。

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码。

**Type consistency：** `TriggerScope`（endpoints）与后端 `scope` 枚举、schema.d.ts 枚举一致；`enabledProfiles`/`filterByKeyword`/`TestWindowModal` props 在测试与实现中一致；`useTestTask` 的 `{ key, profileIds }` 入参与卡片调用一致。

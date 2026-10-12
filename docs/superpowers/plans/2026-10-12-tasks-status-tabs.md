# 任务页状态 Tab + 移除 deprecated 字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务页 `/tasks` 改为「已启用 / 已停用」两个状态 Tab（默认已启用、带数量、Tab 内保留站点分组折叠），并彻底删除从未使用的 `deprecated` 字段。

**Architecture:** 纯前端展示层改动 + 一个死字段的全链路删除。分桶逻辑用纯函数 `bucketTasks`（可单测），组件把现有「站点分组折叠列表」抽成 `GroupedTaskList`（自持展开态）再套 antd `<Tabs>`；后端仅删除 `deprecated` 的透传与 swagger 注解，不新增接口。

**Tech Stack:** React 18 + antd 5 + react-query + vitest/testing-library/jsdom（web）；Express + TypeScript（backend）。

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、TS 严格模式；注释/日志用中文。
- 依赖方向不可反向：本改动不触碰分层依赖。
- **提交纪律（用户指令）**：本次改动**未经用户人工确认前不要执行 `git commit`**。各任务末尾的 Commit 步骤保留备查，实际提交在用户确认后执行（可合并为一次或按任务分次）。
- 文档同步（硬性）：`deprecated` 从 `docs/API-GUIDE.md` §2.1 表删除。**经核实本手册无「面板使用」章节**，面板 UI 变更无需改手册。
- 验证命令：后端 `npm run typecheck` + `npm test`；前端 `npm run test:web` + `npm --prefix web exec tsc -b`。
- 前端单测单跑：`npm --prefix web test -- <相对路径>`。

---

## File Structure

| 文件 | 职责 | 本计划中的改动 |
| --- | --- | --- |
| `src/engine/task.ts` | `TaskMeta` 类型 | 删 `deprecated` 字段与注释 |
| `src/server/routes/tasks.ts` | `/api/tasks` 路由 | 删 swagger `deprecated` 注解 + 响应字段 |
| `web/src/api/schema.d.ts` | 手补的 API 类型 | 删任务视图 `deprecated?` |
| `web/src/pages/tasks/hooks.ts` | 任务页纯函数与 hooks | 新增 `taskBucket` / `bucketTasks` / `TaskBucket` |
| `web/src/pages/tasks/index.tsx` | 任务页组件 | 删 deprecated 用法；抽 `GroupedTaskList`；套两状态 `Tabs` |
| `web/src/pages/tasks/hooks.test.ts` | hooks 单测 | 新增分桶单测 |
| `web/src/pages/tasks/TasksPage.test.tsx` | 页面组件测试（新建） | Tab 数量/默认选中/切换 |
| `docs/API-GUIDE.md` | 用户手册 | 删 §2.1 `deprecated` 行 |

---

## Task 1: 全链路删除 `deprecated` 字段

**Files:**
- Modify: `src/engine/task.ts`
- Modify: `src/server/routes/tasks.ts`
- Modify: `web/src/api/schema.d.ts`
- Modify: `web/src/pages/tasks/index.tsx`
- Modify: `docs/API-GUIDE.md`

**Interfaces:**
- Consumes: 无（纯删除）。
- Produces: `TaskMeta` 不再有 `deprecated`；`GET /api/tasks` 响应不再有 `deprecated` 字段；任务卡片 `dimmed` 仅依据 `enabled === false`。

- [ ] **Step 1: 删 `src/engine/task.ts` 的字段与注释**

把顶部注释块里的 deprecated 行去掉，并删除字段行。改后（`task.ts` 第 8-13 行与前字段处）为：

```ts
/**
 * 任务元信息：
 * key 全局唯一（API/数据库/面板都用它标识）；
 * url 为空表示文档示例（仅手动触发）
 */
```
```ts
  lastUpdated?: string
  /** 任务开关（纯代码开关）：false 时手动触发接口 409；面板开关可运行时覆盖 */
  enabled?: boolean
```
（即删除 ` * deprecated 标记失效任务（面板置灰）；` 与 `  deprecated?: boolean` 两处。）

- [ ] **Step 2: 删 `src/server/routes/tasks.ts` 的 swagger 注解与响应字段**

删除 swagger 属性行：
```
 *                       deprecated: { type: boolean }
```
删除响应构造里的：
```ts
        deprecated: m.deprecated ?? false,
```
改后响应对象从 `lastUpdated` 直接到 `enabled`：
```ts
        lastUpdated: m.lastUpdated ?? null,
        enabled: await deps.db.getTaskEnabled(m.key, m.enabled ?? true),
```

- [ ] **Step 3: 删 `web/src/api/schema.d.ts` 的字段**

删除任务列表 items 里的这一行：
```ts
                                deprecated?: boolean;
```

- [ ] **Step 4: 删 `web/src/pages/tasks/index.tsx` 的 deprecated 用法**

`TaskCard` 内两处：把
```tsx
  const dimmed = task.deprecated || task.enabled === false
```
改为
```tsx
  const dimmed = task.enabled === false
```
并删除标签行：
```tsx
            {task.deprecated && <Tag color="default">已失效</Tag>}
```

- [ ] **Step 5: 删 `docs/API-GUIDE.md` §2.1 表里的 `deprecated` 行**

删除该行（约第 156 行）：
```md
| `deprecated` | `boolean?` | `false` | `true` → 面板置灰显示「已失效」 |
```

- [ ] **Step 6: 验证后端类型与测试**

Run: `npm run typecheck`
Expected: 无输出（通过）。

Run: `npm test`
Expected: `Tests 625 passed`（或同基线全过）。

- [ ] **Step 7: 验证前端类型与测试**

Run: `npm --prefix web exec tsc -b`
Expected: 无错误输出。

Run: `npm run test:web`
Expected: 全部通过。

- [ ] **Step 8: Commit（用户确认后执行）**

```bash
git add src/engine/task.ts src/server/routes/tasks.ts web/src/api/schema.d.ts web/src/pages/tasks/index.tsx docs/API-GUIDE.md
git commit -m "refactor: 移除未使用的 deprecated 字段（全链路）"
```

---

## Task 2: 分桶纯函数 `taskBucket` / `bucketTasks`

**Files:**
- Modify: `web/src/pages/tasks/hooks.ts`
- Test: `web/src/pages/tasks/hooks.test.ts`

**Interfaces:**
- Consumes: `TaskMetaView`（来自 `../../types`）。
- Produces:
  - `export type TaskBucket = 'enabled' | 'disabled'`
  - `export function taskBucket(t: TaskMetaView): TaskBucket`
  - `export function bucketTasks(tasks: TaskMetaView[]): Record<TaskBucket, TaskMetaView[]>`

- [ ] **Step 1: 写失败测试**

在 `web/src/pages/tasks/hooks.test.ts` 末尾追加：

```ts
import { taskBucket, bucketTasks } from './hooks'

describe('taskBucket', () => {
  const t = (enabled: boolean | undefined) => ({ key: 'k', enabled }) as unknown as TaskMetaView
  it('enabled: false → disabled', () => {
    expect(taskBucket(t(false))).toBe('disabled')
  })
  it('enabled: true → enabled', () => {
    expect(taskBucket(t(true))).toBe('enabled')
  })
  it('enabled 缺省（undefined）→ enabled', () => {
    expect(taskBucket(t(undefined))).toBe('enabled')
  })
})

describe('bucketTasks', () => {
  it('保序分桶', () => {
    const tasks = [
      { key: 'a', enabled: true },
      { key: 'b', enabled: false },
      { key: 'c', enabled: true },
    ] as unknown as TaskMetaView[]
    const b = bucketTasks(tasks)
    expect(b.enabled.map((x) => x.key)).toEqual(['a', 'c'])
    expect(b.disabled.map((x) => x.key)).toEqual(['b'])
  })
  it('空输入 → 两桶皆空', () => {
    expect(bucketTasks([])).toEqual({ enabled: [], disabled: [] })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix web test -- src/pages/tasks/hooks.test.ts`
Expected: FAIL，报 `taskBucket is not a function` / 导入失败。

- [ ] **Step 3: 实现纯函数**

在 `web/src/pages/tasks/hooks.ts` 的 `groupTasks` 附近追加：

```ts
/** 任务状态桶：显式 enabled:false 视为停用，其余（含 undefined）视为启用 */
export type TaskBucket = 'enabled' | 'disabled'

/** 判定任务属于哪个状态桶 */
export function taskBucket(t: TaskMetaView): TaskBucket {
  return t.enabled === false ? 'disabled' : 'enabled'
}

/** 按状态保序分桶（供任务页状态 Tab） */
export function bucketTasks(tasks: TaskMetaView[]): Record<TaskBucket, TaskMetaView[]> {
  const out: Record<TaskBucket, TaskMetaView[]> = { enabled: [], disabled: [] }
  for (const t of tasks) out[taskBucket(t)].push(t)
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix web test -- src/pages/tasks/hooks.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit（用户确认后执行）**

```bash
git add web/src/pages/tasks/hooks.ts web/src/pages/tasks/hooks.test.ts
git commit -m "feat: 任务页状态分桶纯函数 bucketTasks"
```

---

## Task 3: 任务页改为两个状态 Tab

**Files:**
- Modify: `web/src/pages/tasks/index.tsx`
- Test: `web/src/pages/tasks/TasksPage.test.tsx`（新建）

**Interfaces:**
- Consumes: `bucketTasks` / `TaskBucket`（Task 2）、`groupTasks` / `groupColor` / `toggleKey`（已存在）。
- Produces: 默认导出 `TasksPage`（渲染两状态 Tab）；仍导出 `triggerButton`（供 `hooks.test.ts` 引用）。

- [ ] **Step 1: 写失败测试（组件级）**

新建 `web/src/pages/tasks/TasksPage.test.tsx`：

```tsx
/**
 * TasksPage 状态 Tab 单测：默认选中「已启用」、Tab 带数量、切换后展示对应分组
 * 依赖方向：mock ../../api/endpoints；用 antd App + QueryClientProvider 包裹
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import TasksPage from './index'
import { fetchTasks } from '../../api/endpoints'
import type { TaskMetaView } from '../../types'

vi.mock('../../api/endpoints', () => ({
  fetchTasks: vi.fn(),
  setTaskEnabled: vi.fn(),
  triggerTask: vi.fn(),
}))

const tasks = [
  { key: 'a', name: '启用任务', enabled: true, group: { key: 'g1', name: '组一' } },
  { key: 'b', name: '停用任务', enabled: false, group: { key: 'g2', name: '组二' } },
] as unknown as TaskMetaView[]

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <App>
      <QueryClientProvider client={qc}>
        <TasksPage />
      </QueryClientProvider>
    </App>,
  )
}

describe('TasksPage 状态 Tab', () => {
  it('默认选中已启用并带数量；切换到已停用展示对应分组', async () => {
    vi.mocked(fetchTasks).mockResolvedValue(tasks)
    renderPage()

    const enabledTab = await screen.findByRole('tab', { name: /已启用 1/ })
    expect(enabledTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /已停用 1/ })).toBeInTheDocument()

    // 默认 Tab 展示启用桶的分组；停用桶的分组尚未挂载
    expect(await screen.findByText('组一')).toBeInTheDocument()
    expect(screen.queryByText('组二')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /已停用/ }))
    expect(await screen.findByText('组二')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix web test -- src/pages/tasks/TasksPage.test.tsx`
Expected: FAIL（当前页面无 Tab，找不到 `role=tab`）。

- [ ] **Step 3: 重写 `web/src/pages/tasks/index.tsx`**

完整改后内容（`TaskCard` / `GroupCard` 本体不变，新增 `GroupedTaskList`，页尾换成 `Tabs`；导入新增 `Tabs`，删除已无用的 `task.deprecated` 引用）：

```tsx
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Card, Col, Empty, Row, Space, Spin, Switch, Tabs, Tag, Typography, theme } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import type { TaskMetaView } from '../../types'
import {
  bucketTasks,
  categoryColor,
  categoryLabel,
  groupColor,
  groupTasks,
  toggleKey,
  useSetTaskEnabled,
  useTasks,
  useTriggerTask,
  type TaskGroup,
} from './hooks'

const WALLET_ICON: Record<string, string> = { metamask: '🦊', petra: '🐍' }

function walletIcon(wallet: string | null): string {
  return (wallet && WALLET_ICON[wallet]) || '▣'
}

/** note 折叠样式：超 3 行截断（-webkit-box 多行省略） */
const NOTE_CLAMP: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

function TaskCard({ task }: { task: TaskMetaView }) {
  const setEnabled = useSetTaskEnabled()
  const trigger = useTriggerTask()
  const dimmed = task.enabled === false
  const [noteExpanded, setNoteExpanded] = useState(false)
  const noteRef = useRef<HTMLSpanElement>(null)
  const [noteOverflow, setNoteOverflow] = useState(false)

  // 折叠态测量是否超 3 行（scrollHeight > clientHeight 即溢出），决定「展开」按钮显隐
  useLayoutEffect(() => {
    const el = noteRef.current
    setNoteOverflow(el ? el.scrollHeight > el.clientHeight + 1 : false)
  }, [task.note])

  return (
    <Card size="small" style={{ height: '100%', ...(dimmed ? { opacity: 0.45 } : undefined) }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ fontSize: 22, lineHeight: 1.4 }}>{walletIcon(task.wallet)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size="small" wrap>
            <Typography.Text strong>{task.name}</Typography.Text>
            <Typography.Text type="secondary">{task.key}</Typography.Text>
            <Tag color={categoryColor(task.category)}>{categoryLabel(task.category)}</Tag>
            {task.enabled === false && <Tag color="default">已停用</Tag>}
          </Space>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <Typography.Text type="secondary">
              ⏱ 钱包 {task.wallet ?? '无'} · 并发 {task.concurrency} · 重试{' '}
              {task.retry?.max ?? '默认'} 次
              {task.lastUpdated ? ` · 更新于 ${task.lastUpdated}` : ''}
            </Typography.Text>
          </div>
          {task.note && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Typography.Text type="secondary">
                <span ref={noteRef} style={noteExpanded ? undefined : NOTE_CLAMP}>
                  📝 {task.note}
                </span>
              </Typography.Text>
              {noteOverflow && (
                <Typography.Link style={{ marginLeft: 4 }} onClick={() => setNoteExpanded((v) => !v)}>
                  {noteExpanded ? '收起' : '展开'}
                </Typography.Link>
              )}
            </div>
          )}
          {task.sourceUrl && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Space size="small" wrap>
                {(Array.isArray(task.sourceUrl) ? task.sourceUrl : [task.sourceUrl]).map((u, i) => (
                  <Typography.Link key={u} href={u} target="_blank" rel="noreferrer">
                    🔗 来源页{i > 0 ? i + 1 : ''}
                  </Typography.Link>
                ))}
              </Space>
            </div>
          )}
        </div>
        <Space size="small">
          <Switch
            checked={task.enabled}
            loading={setEnabled.isPending && setEnabled.variables?.key === task.key}
            onChange={(checked) => setEnabled.mutate({ key: task.key, enabled: checked })}
          />
          {task.enabled && (
            <Button
              type="primary"
              size="small"
              icon={<ThunderboltOutlined />}
              loading={trigger.isPending && trigger.variables === task.key}
              disabled={triggerButton(task.inFlight).disabled}
              onClick={() => trigger.mutate(task.key)}
            >
              {triggerButton(task.inFlight).label}
            </Button>
          )}
        </Space>
      </div>
    </Card>
  )
}

function GroupCard({ group, color, open, onToggle }: { group: TaskGroup; color: string; open: boolean; onToggle: () => void }) {
  const { token } = theme.useToken()
  return (
    <div style={{ background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', cursor: 'pointer' }} onClick={onToggle}>
        <span style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${color}, ${color}b3)`, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flexShrink: 0 }}>
          {group.name.charAt(0)}
        </span>
        <Typography.Text strong>{group.name}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{group.tasks.length} 个任务</Typography.Text>
        <span style={{ marginLeft: 'auto', color: token.colorTextTertiary, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <Row gutter={[12, 12]} align="stretch" style={{ padding: '0 12px 12px' }}>
          {group.tasks.map((t) => (
            <Col key={t.key} xs={24} xl={12}>
              <TaskCard task={t} />
            </Col>
          ))}
        </Row>
      )}
    </div>
  )
}

/** 单个状态 Tab 内的任务列表：按站点分组折叠；展开态各 Tab 独立 */
function GroupedTaskList({ tasks }: { tasks: TaskMetaView[] }) {
  const [openKeys, setOpenKeys] = useState<string[]>([])

  if (tasks.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该状态下暂无任务" />
  }

  const groups = groupTasks(tasks)
  const flat = groups.length === 1 && groups[0].key === ''
  if (flat) {
    return (
      <Row gutter={[12, 12]} align="stretch">
        {tasks.map((t) => (
          <Col key={t.key} xs={24} xl={12}>
            <TaskCard task={t} />
          </Col>
        ))}
      </Row>
    )
  }

  const allOpen = groups.every((g) => openKeys.includes(g.key))
  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Typography.Text>任务分组</Typography.Text>
        <Space size={8} style={{ marginLeft: 'auto' }}>
          <Button size="small" disabled={allOpen} onClick={() => setOpenKeys(groups.map((g) => g.key))}>全部展开</Button>
          <Button size="small" disabled={openKeys.length === 0} onClick={() => setOpenKeys([])}>全部收起</Button>
        </Space>
      </div>
      {groups.map((g, i) => (
        <GroupCard key={g.key} group={g} color={groupColor(g.key, i)} open={openKeys.includes(g.key)} onToggle={() => setOpenKeys((keys) => toggleKey(keys, g.key))} />
      ))}
    </Space>
  )
}

export default function TasksPage() {
  const tasks = useTasks()
  const [activeKey, setActiveKey] = useState<'enabled' | 'disabled'>('enabled')

  if (tasks.isPending) {
    return (
      <Card size="small">
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      </Card>
    )
  }

  if (tasks.isError || !tasks.data) {
    return <Empty description="任务列表加载失败" />
  }

  if (tasks.data.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />
  }

  const buckets = bucketTasks(tasks.data)

  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Tabs
        activeKey={activeKey}
        onChange={(k) => setActiveKey(k as 'enabled' | 'disabled')}
        items={[
          { key: 'enabled', label: `已启用 ${buckets.enabled.length}`, children: <GroupedTaskList tasks={buckets.enabled} /> },
          { key: 'disabled', label: `已停用 ${buckets.disabled.length}`, children: <GroupedTaskList tasks={buckets.disabled} /> },
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        → 任务定义在代码（src/tasks），开关与触发在此页管理
      </Typography.Text>
    </Space>
  )
}

/** 触发按钮态：在途禁用显示「运行中」，否则可点「立即触发」（isPending 时由 antd loading 接管） */
export function triggerButton(inFlight: boolean): { disabled: boolean; label: string } {
  return inFlight ? { disabled: true, label: '运行中' } : { disabled: false, label: '立即触发' }
}
```

- [ ] **Step 4: 跑组件测试确认通过**

Run: `npm --prefix web test -- src/pages/tasks/TasksPage.test.tsx`
Expected: PASS。

- [ ] **Step 5: 全量验证**

Run: `npm --prefix web test`
Expected: 全部通过（含既有 `hooks.test.ts`）。

Run: `npm --prefix web exec tsc -b`
Expected: 无错误。

Run: `npm run typecheck`
Expected: 无输出。

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 6: 人工验收（真机面板）**

`npm run dev` 启动；打开面板 `/tasks`：
- 顶部两 Tab「已启用 N / 已停用 N」，默认选中「已启用」；
- Tab 内站点分组折叠、组头图标/数量、展开收起、搜索无影响；
- 点某启用任务的开关置为停用 → 刷新后卡片从「已启用」移到「已停用」，Tab 数量更新，不自动跳 Tab。

- [ ] **Step 7: Commit（用户确认后执行）**

```bash
git add web/src/pages/tasks/index.tsx web/src/pages/tasks/TasksPage.test.tsx
git commit -m "feat: 任务页按启用状态分为已启用/已停用两个 Tab"
```

---

## Self-Review

**Spec coverage**
- 两状态 Tab（默认已启用/带数量）→ Task 3。
- `bucketTasks` 分桶规则（enabled===false→停用，否则启用）→ Task 2。
- Tab 内保留站点分组（GroupedTaskList 自持 openKeys、全部展开/收起随 Tab）→ Task 3。
- 空态「该状态下暂无任务」→ Task 3（`GroupedTaskList`）。
- 移除 `deprecated`（task.ts / routes/tasks.ts / schema.d.ts / index.tsx / API-GUIDE）→ Task 1。
- 测试 → Task 2（纯函数）+ Task 3（组件）。
- 文档同步 → Task 1 Step 5（仅 §2.1 表行；手册无面板使用章节）。

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码。

**Type consistency:** `TaskBucket`/`taskBucket`/`bucketTasks` 在 Task 2 定义、Task 3 使用，名称一致；`GroupedTaskList` 仅 Task 3 内定义与使用；`triggerButton` 保持既有导出签名不变。

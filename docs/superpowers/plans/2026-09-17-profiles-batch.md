# 窗口页批量操作实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 窗口页新增行多选与批量操作（批量打开/关闭/复制ID/重置熔断），后端新增 `POST /api/profiles/batch` 端点统一循环处理并返回逐项结果。

**Architecture:** 后端 `profilesRouter` 内抽出 `applyAction(id, action)` 私有辅助（单窗口端点与批量端点共用），新增 `/profiles/batch` 循环调用并逐项捕获错误。前端 antd Table 加 `rowSelection`，顶部工具条加 4 个批量按钮，复制 ID 纯前端。

**Tech Stack:** Node + Express 5 + TS 严格模式；React 18 + Vite 5 + antd 5 + react-query；vitest + supertest + testing-library。

## Global Constraints

- 无分号、单引号、2 空格缩进；文件头中文注释块说明模块职责与依赖方向；日志/commit message 用中文（conventional：`feat:`/`fix:`/`docs:`）。
- 依赖方向不可反向：`tasks → engine → {integrations, automation} → infrastructure`，`server → {engine, infrastructure}`。
- 后端路由统一 `{code,message,data}` 响应（`ok`/`fail` + `asyncHandler`），错误走 `HttpError` + `ERROR_CODES`（`INVALID_ARGUMENT` = 40000，`PROFILE_NOT_FOUND` = 40402）。
- `web/src/api/schema.d.ts` 为生成文件（不改）；前端新类型手补到 `web/src/types.ts`。
- 每次改完跑 `npm run typecheck`、`npm test`、`npm run test:web` 全过。
- 文档同步（硬性要求）：改功能必须同步 `docs/API-GUIDE.md`。

---

### Task 1: 后端批量端点（抽 applyAction + /profiles/batch + swagger）

**Files:**
- Modify: `src/server/routes/profiles.ts`（新增 `BatchAction` 类型、`applyAction` 辅助、重构三个单窗口端点复用、新增 `/profiles/batch`、补 @swagger 注解）
- Test: `tests/web.test.ts`（新增批量端点测试用例）

**Interfaces:**
- Consumes: `deps.db`（`listProfiles` / `getOpenWindow` / `setOpenWindow` / `clearOpenWindow` / `resetCircuitBreaker`）、`deps.bitbrowser`（`openBrowser` / `closeBrowser` / `isOpen`）、`find(id)`（文件内已有辅助，抛 404）
- Produces: `POST /api/profiles/batch` 请求体 `{ action: 'open'|'close'|'resetBreaker', ids: number[] }`，响应 `{ total, succeeded, failed: [{ id, error }] }`

- [ ] **Step 1: 写失败测试**

在 `tests/web.test.ts` 的 `describe('server API（RESTful + envelope）')` 内、现有 profiles 相关 `it` 块之后（约第 505 行 `POST /api/profiles/:id/close 无登记也调一次 closeBrowser` 之后）追加：

```ts
  it('POST /api/profiles/batch action=open 逐项开窗并汇总', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/batch').send({ action: 'open', ids: [1] })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ total: 1, succeeded: 1, failed: [] })
    expect(deps.bitbrowser.openBrowser).toHaveBeenCalledWith('bb-1')
    expect(deps.db.setOpenWindow).toHaveBeenCalledWith('bb-1', '127.0.0.1:61234')
  })

  it('POST /api/profiles/batch action=close 逐项关窗并汇总', async () => {
    const deps = makeDeps()
    deps.db.getOpenWindow.mockResolvedValue({ http: '127.0.0.1:61234' })
    const res = await request(createApp(deps as never)).post('/api/profiles/batch').send({ action: 'close', ids: [1] })
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ total: 1, succeeded: 1, failed: [] })
    expect(deps.bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(deps.db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('POST /api/profiles/batch action=resetBreaker 逐项清零', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/batch').send({ action: 'resetBreaker', ids: [1] })
    expect(res.body.code).toBe(0)
    expect(deps.db.resetCircuitBreaker).toHaveBeenCalledWith(1)
  })

  it('POST /api/profiles/batch 单项不存在记入 failed，其余继续，HTTP 仍 200', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/batch').send({ action: 'resetBreaker', ids: [999, 1] })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.succeeded).toBe(1)
    expect(res.body.data.failed).toEqual([{ id: 999, error: '窗口不存在: 999' }])
    expect(deps.db.resetCircuitBreaker).toHaveBeenCalledWith(1)
  })

  it('POST /api/profiles/batch action 非法返回 400', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/profiles/batch').send({ action: 'nope', ids: [1] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })

  it('POST /api/profiles/batch ids 为空数组返回 400', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/profiles/batch').send({ action: 'open', ids: [] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/web.test.ts`
Expected: 新增 6 个用例 FAIL（`Cannot POST /api/profiles/batch` → 404），已有用例仍 PASS。

- [ ] **Step 3: 实现后端**

`src/server/routes/profiles.ts` 改动：

3a. 在 `import type { AppDb, ProfileRow } ...` 之后、`export function profilesRouter` 之前新增 swagger 注解（放在现有 `/api/profiles/{id}/close` 注解块之后）：

```ts
/**
 * @swagger
 * /api/profiles/batch:
 *   post:
 *     summary: 批量窗口操作（打开/关闭/重置熔断），逐项处理并汇总成败
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, ids]
 *             properties:
 *               action: { type: string, enum: [open, close, resetBreaker] }
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *     responses:
 *       '200':
 *         description: 逐项结果汇总
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     succeeded: { type: integer }
 *                     failed:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           error: { type: string }
 *       '400':
 *         description: action 非法或 ids 非空数字数组（业务码 40000）
 */
```

3b. 在 `export function profilesRouter(...)` 内部、`const find = ...` 之后新增 `BatchAction` 类型与 `applyAction` 辅助：

```ts
  /** 批量操作类型（打开/关闭/重置熔断） */
  type BatchAction = 'open' | 'close' | 'resetBreaker'

  /** 单窗口动作执行（单窗口端点与批量端点共用）；open 返回 already 语义 */
  const applyAction = async (id: number, action: BatchAction): Promise<{ already?: boolean }> => {
    const profile = await find(id)
    if (action === 'resetBreaker') {
      await deps.db.resetCircuitBreaker(id)
      return {}
    }
    if (action === 'open') {
      // 已有登记且 pid 实测存活 → 直接复用（already），避免重复开窗
      const row = await deps.db.getOpenWindow(profile.bitbrowserId)
      if (row && (await deps.bitbrowser.isOpen(profile.bitbrowserId))) return { already: true }
      const opened = await deps.bitbrowser.openBrowser(profile.bitbrowserId)
      await deps.db.setOpenWindow(profile.bitbrowserId, opened.http)
      return { already: false }
    }
    // close：无论有无登记都调一次关窗（窗口可能由别处打开未登记）；关窗失败忽略
    const row = await deps.db.getOpenWindow(profile.bitbrowserId)
    await deps.bitbrowser.closeBrowser(profile.bitbrowserId).catch(() => {})
    if (row) await deps.db.clearOpenWindow(profile.bitbrowserId)
    return {}
  }
```

3c. 重构三个单窗口端点复用 `applyAction`（替换现有实现体）：

`POST /profiles/:id/breaker/reset` 替换为：

```ts
  router.post('/profiles/:id/breaker/reset', asyncHandler(async (req, res) => {
    await applyAction(Number(req.params.id), 'resetBreaker')
    ok(res)
  }))
```

`POST /profiles/:id/open` 替换为：

```ts
  router.post('/profiles/:id/open', asyncHandler(async (req, res) => {
    ok(res, await applyAction(Number(req.params.id), 'open'))
  }))
```

`POST /profiles/:id/close` 替换为：

```ts
  router.post('/profiles/:id/close', asyncHandler(async (req, res) => {
    await applyAction(Number(req.params.id), 'close')
    ok(res)
  }))
```

3d. 新增批量端点（放在 `router.post('/profiles/:id/close', ...)` 之后、`return router` 之前）：

```ts
  router.post('/profiles/batch', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { action?: unknown; ids?: unknown }
    const valid: BatchAction[] = ['open', 'close', 'resetBreaker']
    if (!valid.includes(body.action as BatchAction)) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'action 必须为 open/close/resetBreaker')
    }
    if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((x) => typeof x === 'number')) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'ids 必须为非空数字数组')
    }
    const action = body.action as BatchAction
    const ids = body.ids as number[]
    const failed: Array<{ id: number; error: string }> = []
    let succeeded = 0
    for (const id of ids) {
      try {
        await applyAction(id, action)
        succeeded++
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) })
      }
    }
    ok(res, { total: ids.length, succeeded, failed })
  }))
```

注意：`find` 依赖 `deps.db.listProfiles(false)`，单个不存在抛 `HttpError(404, 40402, '窗口不存在: N')`，`applyAction` 内部调用 `find`，故批量中单项不存在会 throw 进 `failed` 且不影响其余项。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/web.test.ts`
Expected: 全部 PASS（新增 6 例 + 原有 profiles 用例因重构仍绿）。

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/profiles.ts tests/web.test.ts
git commit -m "feat: 窗口批量操作端点 /api/profiles/batch（打开/关闭/重置熔断，逐项汇总）"
```

---

### Task 2: 前端类型与 API 封装

**Files:**
- Modify: `web/src/types.ts`（手补 `ProfileBatchAction` / `ProfileBatchResult`）
- Modify: `web/src/api/endpoints.ts`（新增 `batchProfiles`）

**Interfaces:**
- Consumes: 无（独立）
- Produces: `ProfileBatchAction`、`ProfileBatchResult`、`batchProfiles(action, ids)` 供 Task 3/4 使用

- [ ] **Step 1: 加类型**

`web/src/types.ts` 在 `ProfileRow` 定义附近追加：

```ts
/** 批量窗口操作类型（与后端 /api/profiles/batch 的 action 枚举一致） */
export type ProfileBatchAction = 'open' | 'close' | 'resetBreaker'

/** 批量操作结果（total=总数，succeeded=成功数，failed=逐项失败清单） */
export interface ProfileBatchResult {
  total: number
  succeeded: number
  failed: Array<{ id: number; error: string }>
}
```

- [ ] **Step 2: 加端点封装**

`web/src/api/endpoints.ts` 中 `resetBreaker` 定义行之后追加：

```ts
export const batchProfiles = (action: ProfileBatchAction, ids: number[]) =>
  post<ProfileBatchResult>('/api/profiles/batch', { action, ids })
```

并在该文件顶部 import 类型处（第 2 行 `import type { ... } from '../types'`）追加 `ProfileBatchAction, ProfileBatchResult` 两个类型名。

- [ ] **Step 3: typecheck 验证**

Run: `npm run typecheck`
Expected: 通过（0 error）。

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/api/endpoints.ts
git commit -m "feat: 前端批量窗口操作类型与 API 封装"
```

---

### Task 3: 前端 hooks（joinBitbrowserIds + useBatchProfiles）+ 单测

**Files:**
- Modify: `web/src/pages/profiles/hooks.ts`
- Test: `web/src/pages/profiles/hooks.test.ts`

**Interfaces:**
- Consumes: `batchProfiles`（Task 2）、`ProfileBatchAction`（Task 2）
- Produces: `joinBitbrowserIds(profiles, ids): string[]`、`useBatchProfiles()`（供 Task 4 使用）

- [ ] **Step 1: 写失败测试**

`web/src/pages/profiles/hooks.test.ts` 顶部 import 加 `joinBitbrowserIds`，并在文件末尾追加：

```ts
describe('joinBitbrowserIds', () => {
  const profiles = [
    mk(1, '窗口A', 'bb-1'),
    mk(2, '窗口B', 'bb-2'),
    mk(3, '窗口C', 'bb-3'),
  ]

  it('按选中 id 取对应 bitbrowserId，保持选中顺序', () => {
    expect(joinBitbrowserIds(profiles, [3, 1])).toEqual(['bb-3', 'bb-1'])
  })

  it('空选返回空数组', () => {
    expect(joinBitbrowserIds(profiles, [])).toEqual([])
  })

  it('忽略不存在的 id', () => {
    expect(joinBitbrowserIds(profiles, [1, 999])).toEqual(['bb-1'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web -- src/pages/profiles/hooks.test.ts`
Expected: 新增 3 例 FAIL（`joinBitbrowserIds is not exported`）。

- [ ] **Step 3: 实现 hooks**

`web/src/pages/profiles/hooks.ts` 改动：

3a. import 处（`import { HttpError } from '../../api/client'` 之后）追加：

```ts
import { batchProfiles } from '../../api/endpoints'
import type { ProfileBatchAction } from '../../types'
```

3b. 在 `useSyncProfiles` 之后追加两个导出：

```ts
/** 按选中窗口 id 提取 bitbrowserId（保持入参顺序，忽略不存在项；复制 ID 与批量按钮共用） */
export function joinBitbrowserIds(profiles: ProfileRow[], ids: Array<string | number>): string[] {
  const set = new Set(ids.map(String))
  return profiles.filter((p) => set.has(String(p.id))).map((p) => p.bitbrowserId)
}

/** 批量窗口操作（打开/关闭/重置熔断）；完成后按汇总弹消息并刷新窗口列表 */
export function useBatchProfiles() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ action, ids }: { action: ProfileBatchAction; ids: number[] }) => batchProfiles(action, ids),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      if (res.failed.length === 0) {
        message.success(`已完成 ${res.succeeded} 个窗口`)
        return
      }
      const sample = res.failed.slice(0, 3).map((f) => `#${f.id}: ${f.error}`).join('；')
      message.warning(`成功 ${res.succeeded}，失败 ${res.failed.length}（${sample}${res.failed.length > 3 ? ' 等' : ''}）`)
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 4: 跑测试 + typecheck 确认通过**

Run: `npm run test:web -- src/pages/profiles/hooks.test.ts` 然后 `npm run typecheck`
Expected: 测试全部 PASS，typecheck 0 error。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/profiles/hooks.ts web/src/pages/profiles/hooks.test.ts
git commit -m "feat: 窗口批量操作 hooks（joinBitbrowserIds + useBatchProfiles）"
```

---

### Task 4: 窗口页 UI（行多选 + 批量工具条 + 复制 ID）

**Files:**
- Modify: `web/src/pages/profiles/index.tsx`

**Interfaces:**
- Consumes: `joinBitbrowserIds`、`useBatchProfiles`（Task 3）

- [ ] **Step 1: 实现 UI**

`web/src/pages/profiles/index.tsx` 改动：

4a. import 调整：
- `import { useMemo, useState } from 'react'` 后追加 `import type { Key } from 'react'`
- antd import（第 2-16 行）追加 `Divider`
- 从 `./hooks` import 列表（第 20-30 行）追加 `joinBitbrowserIds, useBatchProfiles`

4b. 组件体内 `const reset = useResetBreaker()` 之后追加：

```tsx
  const batch = useBatchProfiles()
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
```

4c. `copyId` 函数之后追加批量复制函数：

```tsx
  const copyIds = async () => {
    const ids = joinBitbrowserIds(profiles.data ?? [], selectedRowKeys)
    try {
      await navigator.clipboard.writeText(ids.join('\n'))
      message.success(`已复制 ${ids.length} 个窗口ID`)
    } catch {
      message.error('复制失败，请手动复制')
    }
  }
```

4d. 顶部卡片 `Space` 内、现有 `Typography.Text`（`{profiles.data?.length ?? 0} 个窗口 ...`）之后追加批量工具条：

```tsx
          <Divider type="vertical" />
          <Typography.Text type={selectedRowKeys.length > 0 ? 'primary' : 'secondary'}>
            {selectedRowKeys.length > 0 ? `已选 ${selectedRowKeys.length} 个窗口` : '未选窗口'}
          </Typography.Text>
          <Button
            disabled={selectedRowKeys.length === 0}
            loading={batch.isPending && batch.variables?.action === 'open'}
            onClick={() => batch.mutate({ action: 'open', ids: selectedRowKeys.map(Number) })}
          >
            批量打开
          </Button>
          <Button
            disabled={selectedRowKeys.length === 0}
            loading={batch.isPending && batch.variables?.action === 'close'}
            onClick={() => batch.mutate({ action: 'close', ids: selectedRowKeys.map(Number) })}
          >
            批量关闭
          </Button>
          <Button disabled={selectedRowKeys.length === 0} onClick={copyIds}>
            复制 ID
          </Button>
          <Button
            disabled={selectedRowKeys.length === 0}
            loading={batch.isPending && batch.variables?.action === 'resetBreaker'}
            onClick={() => batch.mutate({ action: 'resetBreaker', ids: selectedRowKeys.map(Number) })}
          >
            重置熔断
          </Button>
```

4e. `<Table<ProfileRow>` 增加 `rowSelection`（在 `rowKey={(p) => p.id}` 之后）：

```tsx
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
          }}
```

- [ ] **Step 2: typecheck + 前端单测验证**

Run: `npm run typecheck` 然后 `npm run test:web`
Expected: typecheck 0 error，前端单测全部 PASS（含 Task 3 新增用例）。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/profiles/index.tsx
git commit -m "feat: 窗口页行多选与批量操作工具条"
```

---

### Task 5: 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md`

- [ ] **Step 1: 更新 8.2 窗口页说明**

将 8.2 节「窗口页」条目（约第 1101 行）末尾追加批量操作描述：

```md
表头含复选框可多选窗口，选中后顶部工具条出现「已选 N 个窗口」与四个批量按钮——「批量打开」「批量关闭」「复制 ID」（换行合并选中窗口 ID 写入剪贴板，纯前端）「重置熔断」（未选中任何窗口时置灰）；批量打开/关闭/重置熔断走后端 `/api/profiles/batch`，完成后弹消息汇总成功/失败数。
```

- [ ] **Step 2: 更新 8.3 REST 接口总表**

在 8.3 表格 `| POST | /api/profiles/:id/breaker/reset | 重置该窗口熔断计数 |` 之后新增一行：

```md
| POST | `/api/profiles/batch` | 批量窗口操作（action=open/close/resetBreaker + ids，逐项汇总成功/失败） |
```

- [ ] **Step 3: Commit**

```bash
git add docs/API-GUIDE.md
git commit -m "docs: API-GUIDE 同步窗口批量操作说明与接口总表"
```

---

## 验证清单（全部任务完成后）

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（含 Task 1 后端批量用例）
- [ ] `npm run test:web` 通过（含 Task 3 hooks 用例）
- [ ] `npm run dev` 面板人工验收：窗口页勾选多行 → 批量打开/关闭/复制 ID/重置熔断按钮可用性与汇总消息（复制 ID 与重置熔断不需真实比特环境；打开/关闭需比特浏览器在跑）

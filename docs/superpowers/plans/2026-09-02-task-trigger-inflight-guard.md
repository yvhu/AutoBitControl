# 任务触发在途防护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务存在在途 run（当天 pending/running/retry_wait 或排队中的窗口会话）时，后端 409 拦截、前端禁用触发按钮；在途结束自动恢复。

**Architecture:** 双重在途判定——DB 新方法 `countInFlightRuns`（runs 表当天在途行）+ `CoalescingEnqueuer.hasTaskInFlight`（队列内存态，补住开窗/探活阶段 DB 无行的漏洞）；trigger 路由入队前 409，GET /api/tasks 与 GET /api/dashboard 返回 `inFlight` 字段，前端任务页/看板页按钮据此禁用并轮询恢复。

**Tech Stack:** TypeScript + Express 5（后端）、vitest + supertest（后端测试）、React 18 + antd 5 + @tanstack/react-query（前端）、vitest + jsdom（前端测试）。

## Global Constraints

- 在途口径 = `status IN ('pending','running','retry_wait')` 且 `date = 今天`（只查当天，崩溃残留 running 行次日自愈，不做启动清理）
- 队列内存态判定只覆盖 pending 条目与 running 会话（followUp 是「已合并待重排」，不算在途）
- 新错误码 `TASK_RUNNING: 40902`（与 `TASK_DISABLED: 40901` 并列，code = status*100 + 序号）
- cron 到点触发不走 trigger 路由，不受 409 限制
- `web/src/api/schema.d.ts` 按项目先例手改（不重新跑 openapi-typescript 生成）
- 后端测试命令：`npm test`（root vitest，include `tests/**/*.test.ts`）；前端：`npm --prefix web run test`；类型检查：`npm run typecheck`、`npm --prefix web run build`
- 提交信息风格：英文 conventional commits（feat:/fix:/test:/docs:），与 `git log` 现状一致
- 每任务完成必须提交；测试未通过不得进入下一任务

---

### Task 1: AppDb.countInFlightRuns（DB 在途计数）

**Files:**
- Modify: `src/infrastructure/db.ts`（AppDb 类内，`listRunsForDate` 方法后追加）
- Test: `tests/db.test.ts`（文件末尾追加 describe）

**Interfaces:**
- Consumes: 现有 `AppDb.exec` 私有方法（绑定参数 SQL）
- Produces: `countInFlightRuns(taskKey: string, date: string, profileId?: number): Promise<number>` —— 后续 Task 3/4 路由使用；`profileId` 缺省为全局口径，传入则按窗口过滤

- [ ] **Step 1: 写失败测试**

`tests/db.test.ts` 末尾追加：

```ts
describe('countInFlightRuns', () => {
  it('计入 pending/running/retry_wait，终态不计', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    await db.upsertRun(p1.id, 't', '2026-09-02', 0, 'pending')
    await db.upsertRun(p2.id, 't', '2026-09-02', 0, 'running')
    await db.upsertRun(p1.id, 't', '2026-09-02', 1, 'retry_wait')
    await db.upsertRun(p2.id, 't', '2026-09-02', 1, 'success')
    await db.upsertRun(p1.id, 't', '2026-09-02', 2, 'failed')
    await db.upsertRun(p1.id, 't', '2026-09-02', 3, 'skipped')
    expect(await db.countInFlightRuns('t', '2026-09-02')).toBe(3)
    db.close()
  })

  it('date 与 profileId 过滤', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    await db.upsertRun(p1.id, 't', '2026-09-02', 0, 'running')
    await db.upsertRun(p2.id, 't', '2026-09-02', 0, 'running')
    await db.upsertRun(p1.id, 't', '2026-09-01', 0, 'running')
    expect(await db.countInFlightRuns('t', '2026-09-02')).toBe(2)
    expect(await db.countInFlightRuns('t', '2026-09-02', p1.id)).toBe(1)
    expect(await db.countInFlightRuns('t', '2026-09-02', p2.id)).toBe(1)
    expect(await db.countInFlightRuns('t', '2026-09-01', p1.id)).toBe(1)
    expect(await db.countInFlightRuns('other', '2026-09-02')).toBe(0)
    db.close()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/db.test.ts -t countInFlightRuns`
Expected: FAIL——`db.countInFlightRuns is not a function`

- [ ] **Step 3: 实现方法**

`src/infrastructure/db.ts` 中 `listRunsForDate` 方法后追加：

```ts
  /** 某任务当天在途 run 数（pending/running/retry_wait 计入，终态不计）；可选按窗口过滤（看板行级判定用） */
  async countInFlightRuns(taskKey: string, date: string, profileId?: number): Promise<number> {
    const base = `SELECT COUNT(*) AS c FROM runs WHERE task_key = ? AND date = ? AND status IN ('pending','running','retry_wait')`
    const rows = profileId === undefined
      ? await this.exec(base, [taskKey, date])
      : await this.exec(`${base} AND profile_id = ?`, [taskKey, date, profileId])
    return Number(rows[0]?.c ?? 0)
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/db.test.ts`
Expected: 全部 PASS（含新增 2 例）

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/db.ts tests/db.test.ts
git commit -m "feat: db countInFlightRuns for task in-flight guard"
```

---

### Task 2: CoalescingEnqueuer.hasTaskInFlight（队列内存态判定）

**Files:**
- Modify: `src/engine/queue.ts`（`running` 字段类型 + enqueue 内读写 + 新方法）
- Test: `tests/queue.test.ts`（CoalescingEnqueuer describe 内追加）

**Interfaces:**
- Consumes: 现有 `CoalescingEnqueuer` 的 `pending` Map 与 `running` 集合
- Produces: `hasTaskInFlight(taskKey: string, profileId?: number): boolean` —— Task 3/4 路由使用；`profileId` 缺省全局，传入按窗口过滤。`running` 集合类型变为 `Map<number, Set<string>>`（窗口 id → 会话内任务集合）

- [ ] **Step 1: 写失败测试**

`tests/queue.test.ts` 的 `describe('CoalescingEnqueuer', ...)` 内追加：

```ts
  it('hasTaskInFlight：running 会话与 pending 条目均判在途', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const run = vi.fn((_profile: { id: number }, _taskKeys: string[]) => gate.then(() => undefined))
    const q = new TaskQueue(1)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const p1 = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    const p2 = { id: 2, bitbrowserId: 'bb-2', name: 'B', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(p1, 'task-a')
    await new Promise(r => setTimeout(r, 10))
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
    enq.enqueue(p2, 'task-b')
    await new Promise(r => setTimeout(r, 10))
    expect(enq.hasTaskInFlight('task-b')).toBe(true)
    release()
    await q.onIdle()
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
  })

  it('hasTaskInFlight 指定窗口只看该窗口', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const run = vi.fn((_profile: { id: number }, _taskKeys: string[]) => gate.then(() => undefined))
    const q = new TaskQueue(2)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const p1 = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    const p2 = { id: 2, bitbrowserId: 'bb-2', name: 'B', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(p1, 'task-a')
    await new Promise(r => setTimeout(r, 10))
    expect(enq.hasTaskInFlight('task-a', 1)).toBe(true)
    expect(enq.hasTaskInFlight('task-a', 2)).toBe(false)
    release()
    await q.onIdle()
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/queue.test.ts -t hasTaskInFlight`
Expected: FAIL——`enq.hasTaskInFlight is not a function`

- [ ] **Step 3: 实现**

`src/engine/queue.ts` 三处修改：

1. 字段声明（原 `private running = new Set<number>()` 替换）：

```ts
  /** 正在运行的窗口 → 会话内任务集合（in-flight 判定用，会话结束即删） */
  private running = new Map<number, Set<string>>()
```

2. `enqueue` 内 p-queue 回调（原 `this.running.add(profile.id)` / `this.running.delete(profile.id)` 替换）：

```ts
      this.pending.delete(profile.id)
      this.running.set(profile.id, new Set(fresh.taskKeys))
      try {
        await this.runner.runWindowTasks(fresh.profile, [...fresh.taskKeys])
      } catch (e) {
        this.logger.error({ err: (e as Error).message }, '窗口任务执行异常')
      }
      this.running.delete(profile.id)
```

3. 类内新增方法（`enqueue` 方法后追加）：

```ts
  /**
   * 某任务是否在途：排队中（pending 条目）或正在跑（running 会话）的窗口会话包含该任务；
   * 指定 profileId 时只看该窗口（看板行级判定用）。followUp 是「已合并待重排」不算在途
   */
  hasTaskInFlight(taskKey: string, profileId?: number): boolean {
    const inSet = (keys: Set<string> | undefined) => !!keys?.has(taskKey)
    if (profileId !== undefined) {
      return inSet(this.pending.get(profileId)?.taskKeys) || inSet(this.running.get(profileId))
    }
    for (const e of this.pending.values()) if (e.taskKeys.has(taskKey)) return true
    for (const keys of this.running.values()) if (keys.has(taskKey)) return true
    return false
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/queue.test.ts`
Expected: 全部 PASS（原 5 例 + 新增 2 例；`running` 类型变化不破坏既有合并行为）

- [ ] **Step 5: 提交**

```bash
git add src/engine/queue.ts tests/queue.test.ts
git commit -m "feat: enqueuer hasTaskInFlight with per-session task keys"
```

---

### Task 3: trigger 409 守卫 + GET /api/tasks inFlight + 错误码

**Files:**
- Modify: `src/server/http/errors.ts`（ERROR_CODES 加一行）
- Modify: `src/server/routes/tasks.ts`（GET 列表加字段、trigger 加守卫、swagger 注解）
- Test: `tests/web.test.ts`（makeDeps/MockDeps 补 mock + 新用例）

**Interfaces:**
- Consumes: Task 1 的 `db.countInFlightRuns(taskKey, date, profileId?)`、Task 2 的 `enqueuer.hasTaskInFlight(taskKey, profileId?)`、现有 `todayStr`（`src/infrastructure/db`）
- Produces: `GET /api/tasks` 每任务 `inFlight: boolean`；`POST /api/tasks/:key/trigger` 在途 409（`TASK_RUNNING: 40902`）——Task 5/6 前端消费

- [ ] **Step 1: 更新 mock 基建**

`tests/web.test.ts` 中：

1. `MockDeps` 接口两处修改——`db` 接口加 `countInFlightRuns: Mock`；`enqueuer` 类型改为：

```ts
  enqueuer: { enqueue: Mock; hasTaskInFlight: Mock }
```

2. `makeDeps()` 中对应初始化——`db` 对象加：

```ts
      countInFlightRuns: vi.fn().mockResolvedValue(0),
```

`enqueuer` 改为：

```ts
    enqueuer: { enqueue: vi.fn(), hasTaskInFlight: vi.fn().mockReturnValue(false) },
```

- [ ] **Step 2: 写失败测试**

`tests/web.test.ts` 第一个 describe（`server API（RESTful + envelope）`）内，`POST /api/tasks/:key/trigger 入队` 用例后追加：

```ts
  it('触发任务存在在途 run 返回 409（业务码 40902）', async () => {
    const deps = makeDeps()
    deps.db.countInFlightRuns.mockResolvedValue(1)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(40902)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('触发任务队列内存态在途返回 409', async () => {
    const deps = makeDeps()
    deps.enqueuer.hasTaskInFlight.mockReturnValue(true)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('单窗口触发该窗口在途返回 409', async () => {
    const deps = makeDeps()
    deps.db.countInFlightRuns.mockImplementation((_k: string, _d: string, pid?: number) => Promise.resolve(pid === 1 ? 1 : 0))
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ bitbrowserId: 'bb-1' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(40902)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('GET /api/tasks 附加 inFlight（DB 在途与队列在途任一命中）', async () => {
    const deps = makeDeps()
    deps.db.countInFlightRuns.mockResolvedValue(2)
    const res = await request(createApp(deps as never)).get('/api/tasks')
    expect(res.body.data[0].inFlight).toBe(true)
    deps.db.countInFlightRuns.mockResolvedValue(0)
    deps.enqueuer.hasTaskInFlight.mockReturnValue(true)
    const res2 = await request(createApp(deps as never)).get('/api/tasks')
    expect(res2.body.data[0].inFlight).toBe(true)
  })
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts -t 40902`
Expected: FAIL——409 用例返回 200 或 40901；inFlight 用例断言 `true` 实际 `undefined`

- [ ] **Step 4: 实现错误码**

`src/server/http/errors.ts` 的 `ERROR_CODES` 中 `TASK_DISABLED: 40901,` 后加：

```ts
  TASK_RUNNING: 40902,
```

- [ ] **Step 5: 实现路由**

`src/server/routes/tasks.ts`：

1. 顶部 import 增加 `todayStr`（第 10 行改为）：

```ts
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import { todayStr } from '../../infrastructure/db'
```

2. GET /tasks 的 list.push 中 `enabled: await deps.db.getTaskEnabled(...)` 后加：

```ts
        inFlight: (await deps.db.countInFlightRuns(m.key, todayStr())) > 0 || deps.enqueuer.hasTaskInFlight(m.key),
```

3. trigger 路由——现有 `if (body.bitbrowserId) {` 块内、`deps.enqueuer.enqueue(profile, key)` 前插入：

```ts
      if ((await deps.db.countInFlightRuns(key, todayStr(), profile.id)) > 0 || deps.enqueuer.hasTaskInFlight(key, profile.id)) {
        throw new HttpError(409, ERROR_CODES.TASK_RUNNING, '该窗口任务执行中，请等待结束后再触发')
      }
```

现有「未指定：全部启用窗口触发」的 for 循环前插入：

```ts
    if ((await deps.db.countInFlightRuns(key, todayStr())) > 0 || deps.enqueuer.hasTaskInFlight(key)) {
      throw new HttpError(409, ERROR_CODES.TASK_RUNNING, '任务执行中，请等待全部窗口结束后再触发')
    }
```

- [ ] **Step 6: 更新 swagger 注解**

`src/server/routes/tasks.ts`：

1. GET /api/tasks 的 200 schema data.items.properties 中 `enabled: { type: boolean }` 后加：

```ts
 *                       inFlight: { type: boolean, description: '是否有在途 run（当天 pending/running/retry_wait 或排队中的窗口会话）' }
```

2. trigger 的 `409:` 描述（原 `description: 任务已停用（业务码 40901）`）替换为：

```ts
 *       '409':
 *         description: 任务已停用（40901）或执行中（40902）
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/web.test.ts`
Expected: 全部 PASS（原有用例不回归：makeDeps 默认 countInFlightRuns=0、hasTaskInFlight=false，原有 trigger 用例仍 200）

- [ ] **Step 8: 提交**

```bash
git add src/server/http/errors.ts src/server/routes/tasks.ts tests/web.test.ts
git commit -m "feat: 409 guard on trigger while task in flight + tasks inFlight field"
```

---

### Task 4: dashboard runs 行级 inFlight

**Files:**
- Modify: `src/server/routes/dashboard.ts`（deps 加 enqueuer、runs 行加 inFlight、swagger）
- Modify: `src/server/app.ts`（dashboardRouter 装配传 enqueuer）
- Test: `tests/web.test.ts`（新用例）

**Interfaces:**
- Consumes: Task 1 `db.countInFlightRuns(taskKey, date, profileId)`、Task 2 `enqueuer.hasTaskInFlight(taskKey, profileId)`
- Produces: `GET /api/dashboard` 每个 run 行 `inFlight: boolean`——Task 6 前端消费

- [ ] **Step 1: 写失败测试**

`tests/web.test.ts` 的 `GET /api/dashboard runs 附加 durationSec` 用例后追加：

```ts
  it('GET /api/dashboard runs 附加 inFlight（该窗口该任务在途）', async () => {
    const deps = makeDeps()
    deps.db.listRunsForDate.mockResolvedValue([
      { id: 1, profileId: 1, taskKey: 't1', date: '2026-08-28', status: 'running', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口1' },
      { id: 2, profileId: 2, taskKey: 't1', date: '2026-08-28', status: 'running', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口2' },
    ])
    deps.db.countInFlightRuns.mockImplementation((_k: string, _d: string, pid?: number) => Promise.resolve(pid === 1 ? 1 : 0))
    const res = await request(createApp(deps as never)).get('/api/dashboard?date=2026-08-28')
    expect(res.status).toBe(200)
    expect(res.body.data.runs[0].inFlight).toBe(true)
    expect(res.body.data.runs[1].inFlight).toBe(false)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts -t inFlight`
Expected: FAIL——runs 行无 `inFlight` 字段（undefined）

- [ ] **Step 3: 实现路由**

`src/server/routes/dashboard.ts`：

1. import 加类型（第 8 行 `import { todayStr, type AppDb, type RunStatus } from '../../infrastructure/db'` 后追加）：

```ts
import type { CoalescingEnqueuer } from '../../engine/queue'
```

2. `dashboardRouter` 签名改为：

```ts
export function dashboardRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer }): Router {
```

3. GET /dashboard 内 `const runs = ...` 改为：

```ts
    const rows = await deps.db.listRunsForDate(date)
    const runs = await Promise.all(rows.map(async (r) => ({
      ...r,
      durationSec: runDurationSec(r.startedAt, r.finishedAt),
      inFlight: (await deps.db.countInFlightRuns(r.taskKey, date, r.profileId)) > 0 || deps.enqueuer.hasTaskInFlight(r.taskKey, r.profileId),
    })))
```

- [ ] **Step 4: 装配传依赖**

`src/server/app.ts` 第 64 行改为：

```ts
  api.use(dashboardRouter({ db: deps.db, enqueuer: deps.enqueuer }))
```

- [ ] **Step 5: 更新 swagger 注解**

`src/server/routes/dashboard.ts` runs items properties 中 `profileName: { type: string }` 后加：

```ts
 *                           inFlight: { type: boolean, description: '该窗口该任务是否有在途 run（当天 pending/running/retry_wait 或排队会话）' }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/web.test.ts` 然后 `npm run typecheck`
Expected: 全部 PASS；typecheck 无错误（app.ts 装配签名变化已同步）

- [ ] **Step 7: 提交**

```bash
git add src/server/routes/dashboard.ts src/server/app.ts tests/web.test.ts
git commit -m "feat: dashboard runs row-level inFlight field"
```

---

### Task 5: 任务页按钮禁用 + 轮询恢复

**Files:**
- Modify: `web/src/api/schema.d.ts`（/api/tasks data item 手补 inFlight）
- Modify: `web/src/pages/tasks/hooks.ts`（useTasks 轮询）
- Modify: `web/src/pages/tasks/index.tsx`（按钮禁用 + 文案）
- Test: `web/src/pages/tasks/hooks.test.ts`（新增纯函数测试）

**Interfaces:**
- Consumes: Task 3 的 `GET /api/tasks` 响应 `inFlight: boolean`（DeepRequired 后必填）
- Produces: 任务卡片「立即触发」在途时 disabled 显示「运行中」；`useTasks` 每 5s 轮询自动恢复

- [ ] **Step 1: 写失败测试（按钮态纯函数）**

`web/src/pages/tasks/index.tsx` 的按钮态判定抽成纯函数（在文件底部 `export function`）——先写测试。

`web/src/pages/tasks/hooks.test.ts` 末尾追加（函数先导出到 hooks 亦可——放 index.tsx 导出、测试从 index.tsx 导入）：

```ts
import { triggerButton } from './index'

describe('triggerButton', () => {
  it('在途 → disabled + 「运行中」', () => {
    expect(triggerButton(true, false)).toEqual({ disabled: true, label: '运行中' })
  })
  it('非在途 → 可点 + 「立即触发」', () => {
    expect(triggerButton(false, false)).toEqual({ disabled: false, label: '立即触发' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix web run test -- pages/tasks/hooks.test.ts`
Expected: FAIL——`triggerButton` 不存在

- [ ] **Step 3: 手补 schema.d.ts 类型**

`web/src/api/schema.d.ts` 中 `/api/tasks` 的 data item（`enabled?: boolean;` 一行所在块，约第 44 行）后加：

```ts
                                inFlight?: boolean;
```

（与 `enabled?: boolean;` 同缩进；项目先例：schema.d.ts 手改，见 2026-08-31 两份计划）

- [ ] **Step 4: 实现**

1. `web/src/pages/tasks/hooks.ts` 的 `useTasks`：

```ts
export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
    refetchInterval: 5000,
  })
}
```

2. `web/src/pages/tasks/index.tsx`：

- 文件底部追加纯函数：

```tsx
/** 触发按钮态：在途禁用显示「运行中」，否则可点「立即触发」（isPending 时由 antd loading 接管） */
export function triggerButton(inFlight: boolean, _isPending: boolean): { disabled: boolean; label: string } {
  return inFlight ? { disabled: true, label: '运行中' } : { disabled: false, label: '立即触发' }
}
```

- TaskCard 的 Button 改为（在 `loading={...}` 行后加 disabled 与文案）：

```tsx
          {task.enabled && (
            <Button
              type="primary"
              size="small"
              icon={<ThunderboltOutlined />}
              loading={trigger.isPending && trigger.variables === task.key}
              disabled={triggerButton(task.inFlight, trigger.isPending).disabled}
              onClick={() => trigger.mutate(task.key)}
            >
              {triggerButton(task.inFlight, trigger.isPending).label}
            </Button>
          )}
```

- [ ] **Step 5: 运行测试与构建确认通过**

Run: `npm --prefix web run test` 然后 `npm --prefix web run build`
Expected: 全部 PASS；build 成功（TaskMetaView.inFlight 类型推导通过）

- [ ] **Step 6: 提交**

```bash
git add web/src/api/schema.d.ts web/src/pages/tasks/hooks.ts web/src/pages/tasks/index.tsx web/src/pages/tasks/hooks.test.ts
git commit -m "feat: tasks page disable trigger button while task in flight"
```

---

### Task 6: 看板页行级按钮与全部窗口执行禁用

**Files:**
- Modify: `web/src/api/schema.d.ts`（dashboard runs item 手补 inFlight）
- Modify: `web/src/pages/dashboard/hooks.ts`（useTasks 轮询）
- Modify: `web/src/pages/dashboard/index.tsx`（行级按钮与全部窗口执行禁用）
- Test: `web/src/pages/dashboard/groupRuns.test.ts`（仅当 groupRuns 受影响时——本任务不动 groupRuns，验证靠 build）

**Interfaces:**
- Consumes: Task 4 的 `GET /api/dashboard` run 行 `inFlight: boolean`、Task 3 的 tasks `inFlight`
- Produces: 行级「执行/重跑」该 (窗口,任务) 在途时禁用；「全部窗口执行」所选任务在途时禁用

- [ ] **Step 1: 手补 schema.d.ts 类型**

`web/src/api/schema.d.ts` 中 `/api/dashboard` 的 runs item 块（含 `startedAt?: string | null;` 与 `finishedAt?: string | null;` 的同一 item 类型，durationSec 所在块）在 `durationSec?: number | null;` 后加：

```ts
                            inFlight?: boolean;
```

（缩进与该 item 内其他字段一致）

- [ ] **Step 2: 实现 hooks 轮询**

`web/src/pages/dashboard/hooks.ts` 的 `useTasks`：

```ts
export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, refetchInterval: 5000 })
}
```

- [ ] **Step 3: 实现按钮禁用**

`web/src/pages/dashboard/index.tsx`：

1. 行级按钮（`title: '操作'` 列 render 内，`disabled={!id}` 处）改为：

```tsx
            disabled={!id || r.inFlight}
```

2. 「全部窗口执行」按钮（`handleTriggerAll` 旁）改为：

```tsx
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={trigger.isPending && !trigger.variables?.bitbrowserId}
            disabled={taskFilter ? (taskNameByKey.get(taskFilter)?.inFlight ?? false) : true}
            onClick={handleTriggerAll}
          >
            全部窗口执行
          </Button>
```

（保留 `handleTriggerAll` 内「请先选择一个任务」的 message.warning 逻辑不动，仅加 disabled 态）

- [ ] **Step 4: 构建确认通过**

Run: `npm --prefix web run test` 然后 `npm --prefix web run build`
Expected: 全部 PASS；build 成功（RunRow.inFlight 类型推导通过）

- [ ] **Step 5: 提交**

```bash
git add web/src/api/schema.d.ts web/src/pages/dashboard/hooks.ts web/src/pages/dashboard/index.tsx
git commit -m "feat: dashboard disable execute buttons while in flight"
```

---

## Self-Review

**Spec coverage:** 双重判定（Task 1+2）；trigger 409 + 错误码 40902 + 消息（Task 3）；GET /api/tasks inFlight（Task 3）；GET /api/dashboard 行级 inFlight（Task 4）；任务页禁用 + 运行中文案 + 5s 轮询（Task 5）；看板行级 + 全部窗口执行禁用 + 轮询（Task 6）；swagger 三处注解（Task 3、4）；测试覆盖 db/queue/路由三层（Task 1-4）。边界条款（只查当天、cron 不拦、followUp 不算在途）已在 Global Constraints 与 Task 2 注释中固化。

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码。

**Type consistency:** `countInFlightRuns(taskKey: string, date: string, profileId?: number): Promise<number>` 在 Task 1 定义、Task 3/4 调用签名一致；`hasTaskInFlight(taskKey: string, profileId?: number): boolean` 在 Task 2 定义、Task 3/4 调用一致；`inFlight: boolean` 后端返回（Task 3/4）与前端 schema（Task 5/6）字段名一致；`TASK_RUNNING: 40902` 定义（Task 3）与测试断言一致。

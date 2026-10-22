# 窗口池调度 Phase 2：窗口池调度器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 1 基础上实现真正的窗口池调度：窗口跨任务保持打开、每窗口任务集、先处理当前窗口、关闭窗口排队轮转、定时入队幂等、内存/全局健康接入，默认通过 `execution.windowPool.enabled` 开启。

**Architecture:** 新增 `WindowPoolScheduler`，与旧 `CoalescingEnqueuer` 共用 `RunEnqueuer` 接口；它用 `runs` 表作为每窗口任务集、`open_windows` 作为池状态，每秒 tick：对账窗口 → 内存/健康 → 给空闲池窗口分配到期任务 → 必要时补池/轮转 → 记录状态。`WindowRunner` 增加“单任务 + 保持窗口打开”模式。旧调度器保留作为回滚路径，Phase 3 删除。

**Tech Stack:** Node 20 + TypeScript strict、Express、libsql（AppDb/sqlite-client）、Vitest、patchright、antd（池状态面板）。

## Global Constraints

- 中文注释/文档/commit；标识符英文；文件 kebab-case，类 PascalCase；无分号、单引号、2 空格。
- 本地库只经 AppDb/sqlite-client；批量写尽量单事务。
- Phase 2 默认 `execution.windowPool.enabled=false`；开启后走新调度，关闭时保持旧行为。
- 任务默认无顺序、无任务级并发限制；窗口池只受 `maxOpenWindows` + 内存调速约束。
- 不重复执行：定时/批量入队 skip 已成功；`runs` 终态不再调度。
- 全局不变量：窗口同一时刻只跑一个任务；实际打开数（含 opening/closing/手动）≤ `effectivePool`；只有 `pending/retry_wait` 到期行可认领。
- 每个任务结束跑 `npm run typecheck` + 对应测试；最后 `npm test` + `npm run test:web`。
- 文档同步：`docs/API-GUIDE.md`、`AGENTS.md` 与 `docs/superpowers/specs/2026-10-22-window-pool-scheduler-design.md` 同批更新。

---

### Task 1: runs 队列查询、窗口使用计数与幂等入队

**Files:**
- Modify: `src/infrastructure/db.ts`
- Modify: `src/engine/queue.ts`
- Modify: `tests/db.test.ts`
- Modify: `tests/queue.test.ts`

**Interfaces:**
- `AppDb.listPendingWindowKeys(date, nowMs): Promise<Array<{ profileId: number; oldestQueuedAt: string | null }>>`
- `AppDb.listPendingRunsForWindow(profileId, date, nowMs): Promise<RunRow[]>`
- `AppDb.incrementWindowUsage(bitbrowserId): Promise<void>`
- `RunEnqueuer.enqueue(profile, taskKey, opts?: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean })`

- [ ] **Step 1: 写 DB 队列查询测试**

在 `tests/db.test.ts` 增加：

```ts
it('listPendingWindowKeys/listPendingRunsForWindow 只返回最新 slot 到期行', async () => {
  const p1 = await qdb.upsertProfile('bb-q1', '窗口1')
  const p2 = await qdb.upsertProfile('bb-q2', '窗口2')
  await qdb.enqueueRun(p1.id, 'A', DATE, 1, 0)
  await qdb.enqueueRun(p1.id, 'B', DATE, 2, 0)
  await qdb.enqueueRun(p2.id, 'A', DATE, 3, Date.now() + 60_000) // 未到期
  const keys = await qdb.listPendingWindowKeys(DATE, Date.now())
  expect(keys.map((k) => k.profileId)).toEqual([p1.id])
  const rows = await qdb.listPendingRunsForWindow(p1.id, DATE, Date.now())
  expect(rows.map((r) => r.taskKey).sort()).toEqual(['A', 'B'])
})
```

- [ ] **Step 2: 实现查询**

```ts
async listPendingWindowKeys(date: string, nowMs: number): Promise<Array<{ profileId: number; oldestQueuedAt: string | null }>> {
  return (await this.exec(
    `SELECT r.profile_id AS profileId, MIN(r.queued_at) AS oldestQueuedAt
     FROM runs r
     WHERE r.date = ? AND r.status IN ('pending','retry_wait') AND r.not_before_ms <= ?
       AND NOT EXISTS (SELECT 1 FROM runs r2
         WHERE r2.profile_id = r.profile_id AND r2.task_key = r.task_key
           AND r2.date = r.date AND r2.slot > r.slot)
     GROUP BY r.profile_id ORDER BY oldestQueuedAt, r.profile_id`,
    [date, nowMs],
  )) as unknown as Array<{ profileId: number; oldestQueuedAt: string | null }>
}

async listPendingRunsForWindow(profileId: number, date: string, nowMs: number): Promise<RunRow[]> {
  return (await this.exec(
    `${SELECT_RUN} WHERE r.profile_id = ? AND r.date = ? AND r.status IN ('pending','retry_wait')
       AND r.not_before_ms <= ?
       AND NOT EXISTS (SELECT 1 FROM runs r2
         WHERE r2.profile_id = r.profile_id AND r2.task_key = r.task_key
           AND r2.date = r.date AND r2.slot > r.slot)
     ORDER BY r.queued_at, r.id`,
    [profileId, date, nowMs],
  )) as unknown as RunRow[]
}

async incrementWindowUsage(bitbrowserId: string): Promise<void> {
  await this.exec(
    `UPDATE open_windows SET tasks_done = tasks_done + 1, last_used_at = ? WHERE bitbrowser_id = ?`,
    [localWallNow(), bitbrowserId],
  )
}
```

- [ ] **Step 3: 幂等入队**

`CoalescingEnqueuer.enqueue` 增加 `skipIfSuccess`：
- 读取该窗口当天该任务最新行；若 `status==='success'` → 直接返回（记 debug/warn「今日已成功，跳过重复入队」）。
- 其余逻辑不变；`skipIfSuccess` 默认 false（旧路径兼容）。
- `enqueue` 仍是 `RunEnqueuer` 的实现；把接口从 `queue.ts` 导出：

```ts
export interface RunEnqueuer {
  enqueue(profile: ProfileRow, taskKey: string, opts?: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean }): Promise<void>
  cancelBatch(batchId: number): Promise<number>
  start(): void
  stop(): void
}
```

`CoalescingEnqueuer implements RunEnqueuer`。

- [ ] **Step 4: 测试 + typecheck**

Run: `npm run typecheck && npx vitest run tests/db.test.ts tests/queue.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/db.ts src/engine/queue.ts tests/db.test.ts tests/queue.test.ts
git commit -m "feat: 增加窗口池队列查询与幂等入队"
```

---

### Task 2: WindowRunner 单任务 keep-open 模式与关窗方法

**Files:**
- Modify: `src/engine/window-runner.ts`
- Modify: `tests/windowRunner.test.ts`

**Interfaces:**
- `runWindowTasks(profile, tasks, opts?: { keepWindowOpen?: boolean }): Promise<Map<string, RunRow | null>>`
- `closePoolWindow(profile: ProfileRow, reason: string): Promise<void>`
- 关闭会话后：keep-open 时不关窗、`setWindowState(id,'open')`、`incrementWindowUsage(id)`；环境/连接失败仍按原逻辑关窗。

- [ ] **Step 1: 写测试**
- 成功任务 + `keepWindowOpen:true`：不调用 `closeBrowser`；state 保持/回写 open；`incrementWindowUsage` 调用。
- `keepWindowOpen:false`（默认）：仍关窗。
- `closePoolWindow`：走 SerialQueue、等 pids、清登记。
- 复用窗口 keep-open 不重复关闭。

- [ ] **Step 2: 实现**

在 `runWindowTasks` 第三参传入 `keepWindowOpen`；finally 分支：

```ts
if (!reusedFlag && open) {
  if (opts?.keepWindowOpen) {
    await this.deps.db.setOpenWindow(profile.bitbrowserId, open.http, process.pid, 'open').catch(() => {})
    await this.deps.db.incrementWindowUsage(profile.bitbrowserId).catch(() => {})
  } else {
    await this.closeWindowSafely(profile.bitbrowserId, '会话结束')
    await this.deps.db.clearOpenWindow(profile.bitbrowserId).catch(() => {})
  }
}
```

新增：

```ts
async closePoolWindow(profile: ProfileRow, reason: string): Promise<void> {
  await this.closeWindowSafely(profile.bitbrowserId, reason)
  await this.deps.db.clearOpenWindow(profile.bitbrowserId).catch(() => {})
}
```

- [ ] **Step 3: 测试 + typecheck**
- [ ] **Step 4: Commit**

```bash
git add src/engine/window-runner.ts tests/windowRunner.test.ts
git commit -m "feat: WindowRunner 支持单任务 keep-open 与池关窗"
```

---

### Task 3: WindowPoolScheduler 核心

**Files:**
- Create: `src/engine/window-pool.ts`
- Create: `tests/window-pool.test.ts`
- Modify: `src/engine/queue.ts`（新增 `RunEnqueuer` 已在 Task 1）

**Interfaces:**
- `class WindowPoolScheduler implements RunEnqueuer`
- `constructor(deps)` deps: `db`, `runner` (`runWindowTasks` + `closePoolWindow`), `logger`, `bitbrowser` (`openPids`), `memory: MemoryGovernor`, `health: GlobalHealthGate`, `openCloseQueue: SerialQueue`, `cfg` (`WindowPoolConfig`), `profiles` loader, `now?`, `tickMs?`.
- `getStatus(): PoolStatus`
- `enqueue` writes DB + request tick; `cancelBatch` delegates db.stopQueuedRuns.

**Tick algorithm（按设计文档第 6 节）**：
1. 对账 `open_windows`：`opening/closing` 超时清理；`open` 池窗口 pid 不存在清行。
2. `memory.update({freeMb: os.freemem()/MB, actualOpen: pids.size, maxOpenWindows})`；`effectivePool`。
3. `health.canOpen(now)` 为 false → 关闭 idle 池窗口，return。
4. 读取池窗口（`listPoolWindows`）、每个池窗口的 `listPendingRunsForWindow`；读取 `listPendingWindowKeys` 队列。
5. 对每个空闲池窗口（无 inFlight）：
   - 从该窗口 pending 行取第一条到期任务（无顺序）；
   - `claimQueuedRuns([row.id], now)`；成功则以单任务调用 `runner.runWindowTasks(profile, [{taskKey,date,batchId}], {keepWindowOpen:true})`，并 `inFlight` 记录。
   - 若 runner 返回环境级失败/窗口健康 open → `runner.closePoolWindow`。
6. 补池/轮转：
   - `actualOpen < effectivePool` 且队列有窗口、冷却/健康允许 → 从未在池内的队列窗口取一个，分配其第一条任务并让 runner 开窗（keep-open）。
   - 池窗口任务集为空且队列有其它窗口 → `closePoolWindow` 让位（每 tick 最多关 1 个，避免抖动）。
   - 池窗口任务集为空且无队列 → 保留 idle；`idleCloseSec`/`windowMaxTasks`/`windowMaxLifetimeSec` 到限关闭。
7. 记录状态变化日志（池大小/内存/队列/窗口）。

- [ ] **Step 1: 写测试（fake DB/runner/clock/memory/health）**
  - 任务1 在窗口1-4；任务2 到点后同一 4 窗口继续跑 task2，不新开窗。
  - 关闭的窗口任务2 pending 入队，当前池清空后轮转打开。
  - 无任务级并发：4 个窗口可同时跑同一任务。
  - 内存 critical 不补池；恢复后继续。
  - 全局 health paused 不补池/不开新窗。
  - 不重复：success 行不再分配。
  - 窗口空闲/寿命/任务数到限关闭。

- [ ] **Step 2: 实现；复用 `claimQueuedRuns`/`listPending...`，不新建重复 SQL。**

- [ ] **Step 3: 测试 + typecheck**
- [ ] **Step 4: Commit**

```bash
git add src/engine/window-pool.ts tests/window-pool.test.ts
git commit -m "feat: 新增窗口池调度器"
```

---

### Task 4: App 装配、RunEnqueuer 接口与特性开关

**Files:**
- Modify: `src/engine/queue.ts`（接口已导出）
- Modify: `src/app.ts`
- Modify: `src/server/app.ts`
- Modify: `tests/web.test.ts`（mock 类型适配）

- [ ] **Step 1: 装配**
  - 创建 `MemoryGovernor`、`GlobalHealthGate`、`SerialQueue`（已有）。
  - `cfg.execution.windowPool.enabled` 为 true → `new WindowPoolScheduler(...)`；否则旧 `CoalescingEnqueuer`。
  - `ServerDeps.enqueuer` 改为 `RunEnqueuer`。
  - TaskStopper/Server 路由只依赖 `enqueue/cancelBatch`，保持兼容。
- [ ] **Step 2: 测试开关分支（旧/新）与 server typecheck**
- [ ] **Step 3: 全量测试**
- [ ] **Step 4: Commit**

```bash
git add src/app.ts src/server/app.ts tests/web.test.ts
git commit -m "feat: 接入窗口池调度特性开关"
```

---

### Task 5: 定时/触发幂等与 Phase 2 文档

**Files:**
- Modify: `src/engine/scheduler.ts`
- Modify: `src/server/routes/tasks.ts`
- Modify: `src/server/routes/batches.ts`
- Modify: `src/server/routes/schedules.ts`（如需要）
- Modify: `docs/API-GUIDE.md`, `AGENTS.md`
- Modify: tests (scheduler/web)

- [ ] **Step 1: 所有批量/定时入队传 `skipIfSuccess: true`；单窗口手动触发保留 false（可重跑）。**
- [ ] **Step 2: 文档写明窗口池开启后的行为、配置、内存/健康、任务无并发/无顺序、窗口轮转；`enabled` 开启方式。**
- [ ] **Step 3: 测试：success 窗口不重复入队；failed 可重跑；定时/批量/测试触发覆盖。**
- [ ] **Step 4: Commit**

```bash
git add src/engine/scheduler.ts src/server/routes/tasks.ts src/server/routes/batches.ts src/server/routes/schedules.ts docs/API-GUIDE.md AGENTS.md tests
git commit -m "feat: 窗口池幂等触发与文档"
```

---

### Task 6: 池状态 API/面板与 Phase 2 验收

**Files:**
- Create: `src/server/routes/pool.ts`
- Modify: `src/server/app.ts`, `web/src/api/endpoints.ts`, `web/src/types.ts`
- Modify: `web/src/pages/dashboard/index.tsx` 或 `settings/index.tsx`
- Tests: `tests/web.test.ts`, `web/src/pages/...test.tsx`

- [ ] **Step 1: `GET /api/pool/status` 返回 `{enabled,state,freeMb,effectivePool,maxOpenWindows,open,busy,idle,queueWindows,pendingTasks,lastReason}`。**
- [ ] **Step 2: 面板顶部/设置页展示池状态（只读，轮询 5s）。**
- [ ] **Step 3: 测试路由/组件；全量 typecheck + npm test + test:web。**
- [ ] **Step 4: 真机验收（4 窗口、两个任务先后到点）：任务2 复用任务1 窗口、不重复、内存降级、无窗口泄漏。**
- [ ] **Step 5: Commit**

---

## Phase 2 验收标准

- `execution.windowPool.enabled=true` 时：任务1 打开 ≤maxOpenWindows 个窗口；任务2 到点后只在当前池/已打开窗口继续，不新开窗口；关闭窗口按队列轮转。
- 任务默认无顺序/无任务级并发；4 个窗口可同时跑同一任务。
- success 不重复；failed 可重跑；窗口任务集按 `queued_at` 推进。
- 内存/全局健康接入：critical/paused 不补池；恢复后继续；任务保持 pending。
- 关闭窗口等待 pids，opening/closing 不被误回收；空闲/寿命/任务数回收生效。
- 面板可看池状态；真机 2 小时无窗口泄漏。
- `npm run typecheck`、`npm test`、`npm run test:web` 全绿。

## Phase 3（后续）

- 移除 `maxConcurrentWindows`、`meta.concurrency`、旧 `CoalescingEnqueuer` 代码；
- 按真机数据校准 `perWindowMb`、`idleCloseSec`、`windowMaxLifetimeSec`；
- closing 后台对账器、探测租约/超时、内存 warning 带宽调优。

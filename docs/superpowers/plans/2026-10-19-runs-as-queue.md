# runs 即队列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把排队任务、错峰时间、重试时间从内存搬迁到 `runs` 表，用 DB-backed dispatcher 取代内存 pending/followUp/错峰定时器。

**Architecture:** `runs` 表同时是“执行队列 + 执行结果”。触发时立即写 `pending + not_before_ms + batch_id`；dispatcher 每秒拾取到期行，按窗口分组，沿用内存 gates/globalActive 启动 `WindowRunner`；重试写 `retry_wait + not_before_ms`，不再挂进程内定时器。内存只保留活跃会话和并发计数。

**Tech Stack:** Node + TypeScript（严格模式）、libsql/SQLite、patchright、express、React + antd + react-query、vitest。

**设计依据：** `docs/superpowers/specs/2026-10-19-runs-as-queue-design.md`

## Global Constraints

- 全部注释/文档/commit message 用中文。
- 无分号、单引号、2 空格缩进；TS 严格模式。
- TDD：每个任务先写失败测试，再写实现，再跑测试。
- 不提交 `config/.env`、`config/config.local.json`、`config/accounts.xlsx` 等密钥/账号文件。
- 本计划不改变并发阀门设计；`gates/globalActive` 本阶段继续使用内存。
- 本计划不改变任务执行、钱包、验证码、诊断、熔断状态机语义。
- 每个任务至少跑 `npm run typecheck`；全部完成后跑 `npm test` 和 `npm run test:web`。
- commit 步骤只有用户明确同意提交时才执行。

---

## File Structure

### 新增

- `src/engine/run-recovery.ts`：启动恢复（旧 slot 结算、当日 running 重新排队、跨日行结算）。
- `tests/run-recovery.test.ts`：启动恢复单测。

### 修改

- `src/infrastructure/db.ts`：`runs.not_before_ms/queued_at`、队列查询/写入/claim/停止/恢复方法。
- `src/engine/queue.ts`：改写为 DB-backed dispatcher（保留 `CoalescingEnqueuer` 类名与对外方法）。
- `src/engine/window-runner.ts`：重试写 `notBeforeMs`，删除 `scheduleRetry`，session 使用 claim 行的日期。
- `src/app.ts`：dispatcher 启动/停止、恢复顺序、移除 `scheduleRetry`。
- `src/engine/retry-recovery.ts`：删除（由 `run-recovery.ts` 取代）。
- `src/engine/task-stopper.ts`：排队行 CAS 结算；running 行 CAS + 取消/关窗；支持跨日 date。
- `src/server/routes/tasks.ts`、`batches.ts`：入队 await；在途/统计只用 DB。
- `src/engine/scheduler.ts`：在途只用 DB；入队 await。
- `scripts/run-task.ts`：直接 claim，不启 dispatcher；按 `not_before_ms` 自行等待重试。
- 测试：`tests/db.test.ts`、`queue.test.ts`、`queue-any-running.test.ts`、`windowRunner.test.ts`、`task-stopper.test.ts`、`scheduler.test.ts`、`web.test.ts`。
- `docs/API-GUIDE.md`、`AGENTS.md`。

---

### Task 1: `runs` 队列表结构与 DB 方法

**Files:**
- Modify: `src/infrastructure/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- `RunRow.notBeforeMs?: number`、`RunRow.queuedAt?: string | null`
- `AppDb.enqueueRun(profileId, taskKey, date, batchId, notBeforeMs): Promise<RunRow>`
- `AppDb.minPendingNotBefore(profileId, date): Promise<number | null>`
- `AppDb.listDueRuns(date, nowMs): Promise<RunRow[]>`
- `AppDb.hasRunningRunsForProfile(profileId, date): Promise<boolean>`
- `AppDb.claimQueuedRuns(runIds, nowMs): Promise<RunRow[]>`
- `AppDb.requeueClaimedRuns(runIds, error, notBeforeMs): Promise<number>`
- `AppDb.stopQueuedRuns(batchId): Promise<number>`
- `AppDb.stopQueuedRun(profileId, taskKey, date, slot): Promise<boolean>`
- `AppDb.stopRunningRun(profileId, taskKey, date, slot): Promise<boolean>`
- `AppDb.requeueStaleRunning(date, nowMs): Promise<number>`
- `AppDb.settleSupersededRuns(date): Promise<number>`
- `AppDb.settleOldQueuedRuns(today): Promise<number>`
- `AppDb.settleOldRunningRuns(today): Promise<number>`

**Steps:**
- [x] `runs` 增加 `not_before_ms INTEGER NOT NULL DEFAULT 0`、`queued_at TEXT`、`idx_runs_queue(status, not_before_ms)`；老库幂等补列。
- [x] `enqueueRun` 事务内：最新行终态则新 slot；pending 复用；retry_wait 原子提升为 pending（清 finished_at/error/failure_kind）。
- [x] `listDueRuns` 只取当天、最新 slot、`not_before_ms <= now` 的 pending/retry_wait。
- [x] `claimQueuedRuns` 条件 UPDATE 只认领 pending/retry_wait，返回实际认领行。
- [x] 停止/恢复方法覆盖排队、running、旧 slot、跨日行。
- [x] 测试使用临时文件 AppDb（`client.transaction()` 在 `file::memory:` 下不共享数据）。
- [x] `AppDb.open` 使用 `createClient({ url, timeout: 5000 })`，保证 transaction 后的 lazy 连接仍有 busy timeout。

Run: `npx vitest run tests/db.test.ts`、`npm run typecheck`。

---

### Task 2: DB-backed enqueuer / dispatcher

**Files:**
- Modify: `src/engine/queue.ts`（整体替换）
- Test: `tests/queue.test.ts`、`tests/queue-any-running.test.ts`

**Interfaces:**
- `CoalescingEnqueuer(db, runner, logger, taskConcurrencyOf, staggerMaxSec, maxConcurrentWindows, tickMs?)`
- `start()` / `stop()`
- `async enqueue(profile, taskKey, opts?)`
- `async tick()`
- `async hasTaskInFlight(taskKey, profileId?)`（DB 口径，保留兼容）
- `anyRunning()`
- `async cancelBatch(batchId)`

**Steps:**
- [x] `enqueue` 只写 DB；immediate=now；同窗口已有 pending 则沿用最早 `not_before_ms`，否则随机错峰。
- [x] `tick` 读取到期行，按 profile 分组，跳过 activeProfiles/running 窗口。
- [x] 保留内存 gates/globalActive；按 eligible 原子 claim，只为实际 claim 行占额度。
- [x] 会话结束/异常释放额度、清理 activeProfiles；异常 claim 行按 +30s backoff 重新排队。
- [x] `stop()` 清理 interval + 0ms dispatch timer，设置 stopped；tick 在每个 await 后再次检查。
- [x] 测试覆盖 due/stagger、同窗口合并、无重复会话、task/global 双闸门、异常释放、停止生命周期、claim 竞态。
- [x] Task 3 前 tick 曾临时只调度 pending；Task 3 接入 retry_wait 后已放开。

Run: `npx vitest run tests/queue.test.ts tests/queue-any-running.test.ts`、`npm run typecheck`。

---

### Task 3: runner 重试落库、app 装配与启动恢复

**Files:**
- Modify: `src/engine/window-runner.ts`、`src/app.ts`
- Create: `src/engine/run-recovery.ts`
- Delete: `src/engine/retry-recovery.ts`
- Test: `tests/windowRunner.test.ts`、`tests/run-recovery.test.ts`

**Interfaces:**
- `SessionTask` 增加可选 `date`（claim 行日期）。
- `WindowRunnerDeps` 删除 `scheduleRetry`。
- `recoverRuns({ db, logger, now? }): Promise<{ requeued: number; superseded: number; oldQueued: number; oldRunning: number }>`

**Steps:**
- [x] `retry_wait` patch 写 `notBeforeMs = now + backoffSec*1000`；删除 `scheduleRetry`。
- [x] `runWindowTasks` 使用 `SessionTask.date`（无则 `todayStr()`），预写/结算/执行/产物统一该日期。
- [x] `runManual` 先 `enqueueRun + claimQueuedRuns`，claim 失败抛错；运行使用 claim 行日期。
- [x] `recoverRuns` 先结算越界旧 slot、跨日 pending/retry/running，再把当天 running 重新排队。
- [x] `app.ts` 顺序：DB → `recoverRuns` → runner/enqueuer → `enqueuer.start()` → scheduler；shutdown `enqueuer.stop()`。
- [x] 测试覆盖 notBeforeMs、恢复顺序、日期传递、旧日期结算、task:run claim 成功/失败。

Run: `npx vitest run tests/windowRunner.test.ts tests/run-recovery.test.ts`、`npm run typecheck`。

---

### Task 4: 停止器 DB 队列语义

**Files:**
- Modify: `src/engine/task-stopper.ts`、`src/server/routes/batches.ts`
- Test: `tests/task-stopper.test.ts`、`tests/web.test.ts`

**Interfaces:**
- `TaskStopper.stop(profileId, taskKey, date?)`
- `TaskStopperDeps.cancelQueued?: (batchId) => Promise<number>`

**Steps:**
- [x] pending/retry_wait：`stopQueuedRun` CAS 结算 `skipped/stopped`，不关窗、不置标记。
- [x] running：`stopRunningRun` CAS 成功后才置 task/session 标记、关窗、清登记；CAS 失败不覆盖终态。
- [x] `stopBatch` 先 await `cancelQueued` 结算排队行，再只停止 running 行；计数 queued + running。
- [x] 行级路由和 stopBatch 传入行自身 `date`，支持跨午夜停止。
- [x] 测试覆盖 CAS 成功/失败、running 分支、批量、跨日 stop。

Run: `npx vitest run tests/task-stopper.test.ts tests/web.test.ts`、`npm run typecheck`。

---

### Task 5: 触发/统计/在途全部走 DB

**Files:**
- Modify: `src/server/routes/tasks.ts`、`src/server/routes/batches.ts`、`src/engine/scheduler.ts`
- Test: `tests/web.test.ts`、`tests/scheduler.test.ts`

**Steps:**
- [x] 所有 `inFlight` 只用 `db.countInFlightRuns`（pending/running/retry_wait）。
- [x] `/api/batches` 实时运行数只按 DB 在途行求和，不再加内存 pendingCount。
- [x] 所有 `enqueuer.enqueue` 调用 await；409 检查在 createBatch/enqueue 之前。
- [x] scheduler 在途守卫只用 DB；入队 await。
- [x] 测试移除 `hasTaskInFlight`/`pendingCount` mock，补 DB-only 断言。

Run: `npx vitest run tests/web.test.ts tests/scheduler.test.ts`、`npm run typecheck`。

---

### Task 6: 文档与全量验证

**Files:**
- Modify: `docs/API-GUIDE.md`、`AGENTS.md`

**Steps:**
- [x] API-GUIDE 增加“运行队列（runs 即队列）”说明：触发写 pending、dispatcher、retry/stagger、重启恢复、停止、面板 DB 口径。
- [x] 术语表在途定义为 pending/running/retry_wait；恢复范围写“当天 running”。
- [x] task:run 写明直接 claim、不启 dispatcher、不要与后端同窗口并发；不再承诺绝不重复。
- [x] AGENTS 更新队列/数据层/重试/错峰说明：自动重试只用 backoff，不叠加初始错峰。
- [x] 全量验证：`npm run typecheck`、`npm test`、`npm run test:web`。
- [x] 当前结果：typecheck 通过；后端 62 文件 720 tests；前端 28 文件 183 tests。

---

## Self-Review Checklist

- [x] 触发即写 pending 行，进程重启不丢排队任务。
- [x] 错峰/重试只依赖 `not_before_ms`，代码中不再有对应 `setTimeout`。
- [x] 同窗口 pending 任务共享 `not_before_ms`，合并为一次会话。
- [x] 并发 gates/globalActive 本阶段保持内存，行为不变。
- [x] `task:run` 直接 claim，不被 dispatcher 重复拾取。
- [x] 批次停止对 pending/retry_wait 不关窗，对 running 走取消/关窗。
- [x] 在途 409、看板统计、批次明细均以 DB 为准。
- [x] 旧 `pending/followUp/globalWaiting` 队列逻辑已删除，不留下第二套事实源。
- [x] 跨日队列/运行行有明确结算策略，不会永久挂 running。
- [x] 所有测试与文档同步。

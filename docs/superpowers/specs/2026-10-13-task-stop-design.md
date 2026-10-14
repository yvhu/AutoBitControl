# 通用任务停止设计（task-stop）

日期：2026-10-13
状态：已确认（用户确认设计后直接实施）

## 目标

目前只能触发任务、不能停止：手动「立即触发」/任务页「测试」/定时跑起来后，只能关窗口（会被自动重试重新开窗）或等超时（默认 180s）。本设计新增**通用停止**能力，覆盖测试、立即触发、定时、单窗口行级等所有在途运行：

- **批次级停止**：看板批次卡片上「停止」，停掉该批次所有非终态运行。
- **行级停止**：批次详情里单个「窗口×任务」运行行上「停止」。

已确认的关键决策：

- 停止后状态：**复用 `skipped` 终态**，`error` 记录「手动停止」（不新增 `cancelled` 状态）。
- 入口粒度：**批次级 + 行级**。
- 机制：**进程内取消标记**（不引入 DB 字段、不改运行状态机）。

## 现状（为什么现在不好停）

- 会话经 `CoalescingEnqueuer` → `WindowRunner.runWindowTasks` 开窗、CDP 接管、跑任务（`src/engine/window-runner.ts`）。
- 手动关窗口 = 让当前尝试失败，但任务默认 `retry.max=2`，`scheduleRetry` 退避后**自动重新开窗重试**（`window-runner.ts:392`）——不是停止。
- 改任务代码需重启后端（无 watch）；重启时 `recoverRetryTasks` 会把 `retry_wait`/`running` 行**重新入队自愈**（`retry-recovery.ts:58-86`）。
- 运行期间触发接口受在途守卫（DB 非终态行 + `enqueuer.hasTaskInFlight`）拦截，返回 409。

## 机制：CancelRegistry + runner 消费标记

新增 `src/engine/cancel-registry.ts`：进程内 `Set<string>`，key = `${profileId}:${taskKey}`。

```
request(profileId, taskKey)   // 置位（停止时调用）
isCancelled(profileId, taskKey): boolean
clear(profileId, taskKey)     // 消费/清理
```

标记的**消费点**（任一命中即视为已停止）：

1. **会话开始前**（`runWindowTasks` 最顶部，早于「预写 pending」循环）：对该会话的每个任务，若 `isCancelled` → 结算 `skipped`（「手动停止」）、`clear` 标记、从会话中剔除。若剔除后无任务，直接返回、**不开窗**。这样错峰/排队中的会话启动时不会真开窗。
2. **任务失败 catch**（`runTask` 的 catch 内，早于 `nextStateAfterFailure`）：若 `isCancelled` → 落 `skipped`（「手动停止」）、`clear` 标记，**不 `scheduleRetry`、不 `incrCircuitBreaker`**，返回。这样正在跑的任务被关窗打断后按「手动停止」结算，而不是进入重试。
3. **重试定时器回调**（`app.ts` 的 `scheduleRetry` 回调内）：若 `isCancelled` → `clear` 并跳过入队。

**清除时机（不变量：任务一次运行以任意终态收尾即排空标记）**：会话开始前跳过、`runTask` 成功与失败 catch、`settleWindowSkip`（开窗失败 / CDP 失败 / 窗口超时 / 熔断），以及重试与恢复回调跳过入队时，均 `clear` 该（窗口,任务）标记——避免停止标记残留，误跳过该（窗口,任务）的下一次合法触发。

## 停止动作 `TaskStopper.stop(profileId, taskKey)`

新增 `src/engine/task-stopper.ts`，装配注入 `db / enqueuer / registry / bitbrowser / logger`：

1. `registry.request(profileId, taskKey)`。
2. 读该（窗口,任务,今天）最新运行行；非终态（pending/running/retry_wait）→ 结算为 `skipped`（error=「手动停止」，finishedAt=now，沿用原 slot 与 batchId）。已是终态 → 不覆盖。
3. 关窗：`bitbrowser.closeBrowser(bitbrowserId)`（复用窗口也关；`closeBrowser` 失败忽略）；并清 `open_windows` 登记（若存在）。
4. 返回 `{ stopped: boolean }`（是否确实处理了一个在途行或正在跑的会话）。

**不改队列**：错峰/排队中的会话不做手术式移除，靠「会话开始前」消费标记跳过（启动时不开窗、直接结束、正常释放额度）。理由：改队列需重算闸门、清错峰定时器、处理合并条目，风险高收益低；且改任务代码必然重启，重启即清空内存。

**批次级停止**：路由取 `listRunsForBatch(id)`，筛非终态行，对每个 `stop(run.profileId, run.taskKey)`，计数返回 `{ stopped }`。

## API

- `POST /api/batches/:id/stop` → 停该批次全部非终态行，返回 `{ stopped: number }`。
  - 批次不存在 → 404 `BATCH_NOT_FOUND`；批次 id 非法 → 400。
- `POST /api/runs/:id/stop` → 停单个运行行，返回 `{ stopped: boolean }`。
  - 运行行不存在 → 404（新增错误码 `RUN_NOT_FOUND: 40409`）。

两个路由挂在 `src/server/routes/batches.ts`（复用其 `db`/`enqueuer` 依赖），新增 `stopper` 依赖注入。

swagger 注解同步；`web/src/api/schema.d.ts` 手补两路径；`web/src/types.ts` 手补返回类型。

## UI（看板 `web/src/pages/dashboard/`）

- **批次卡片**（`index.tsx` 主时间线 + 散批折叠卡）：当批次 `stats.running + pending + retryWait > 0` 时，卡片操作区显示「停止」按钮 → `stopBatch(id)`，成功后 invalidate `['batches']`。
- **批次详情行**（`BatchDetail` 表格）：行 `inFlight` 为 true 时，操作列把「执行/重跑」替换为「停止」→ `stopRun(runId)`，成功后 invalidate `['batchDetail']` 与 `['batches']`。
- hooks（`dashboard/hooks.ts`）：新增 `useStopBatch`、`useStopRun`（mirror `useTriggerTask` 的 message + invalidate 模式）。
- endpoints（`endpoints.ts`）：`stopBatch(id)`、`stopRun(runId)`。

## 状态与统计

- 停止落 `skipped`：看板统计口径不变（`skipped` 已是终态、已计入完成率）。error 文案「手动停止」在行错误列可见。
- 不新增状态机枚举、不改 `VALID_TRANSITIONS`。

## 边界与权衡

- 停止关闭整个窗口会话 → 同窗口合并的**其他任务一并失败**（立即触发为一窗口一任务，无影响；定时/合并会话有影响）——写进文档。
- 不重启就立刻重触发：旧会话（错峰/排队中）未结束前 `hasTaskInFlight` 仍为 true → 触发 409，需等其结束（≤错峰上限）或重启。已知边界。
- 复用窗口（面板已打开）停止时也会被关闭——为能中止会话所必需，接受。
- 停止与任务自然结束的竞态：若任务在关窗前后已成功，`success` 覆盖 `skipped`（如实反映"其实成功了"）。
- 重试恢复（重启）定时器：进程重启后内存标记丢失，但停止会把行结算为终态 `skipped`，故 `recoverRetryTasks` 不会重新入队。

## 明确不做

- 不新增 `cancelled` 状态、不改状态机与看板统计口径。
- 不做队列手术式移除（`enqueuer.cancel`）；靠会话开始前消费标记。
- 不做「全局全部停止」（本次仅批次级 + 行级；如后续需要再加）。
- 不做停止的持久化（进程重启即失效；重启后无在途会话，无需恢复）。

## 改动清单

1. `src/engine/cancel-registry.ts`（新）：CancelRegistry。
2. `src/engine/window-runner.ts`：构造注入 `cancelRegistry`；`runWindowTasks` 顶部过滤取消任务；`runTask` catch 消费标记。
3. `src/engine/task-stopper.ts`（新）：TaskStopper（置标记 + 结算 skipped + 关窗 + 清登记）。
4. `src/app.ts`：建 registry；`WindowRunner` 注入 registry；`scheduleRetry` 回调检查标记；建 stopper；`createApp` 传 stopper。
5. `src/server/app.ts`：`WebDeps` 加 stopper；挂 routes。
6. `src/server/routes/batches.ts`：`POST /api/batches/:id/stop`、`POST /api/runs/:id/stop` + swagger；`batchesRouter` 依赖加 `stopper`。
7. `src/server/http/errors.ts`：新增 `RUN_NOT_FOUND: 40409`。
8. `src/infrastructure/db.ts`：复用现有 `getRunById(id): Promise<RunRow | null>`（含 profileId/taskKey/bitbrowserId/status/slot/batchId），无需改动。
9. `web/src/api/endpoints.ts`、`schema.d.ts`、`types.ts`。
10. `web/src/pages/dashboard/hooks.ts`、`index.tsx`。
11. `docs/API-GUIDE.md`：在「1. 五分钟上手 → 试跑与验证」补一条「停止运行」说明（看板批次卡片/详情行「停止」→ 落 skipped「手动停止」），并在「6）运维要点」补两句（停止会关窗、同窗口合并任务一并失败、不重启重触发需等旧会话结束）。

## 验证计划

- `npm run typecheck`、`npm test`、`npm run test:web` 全绿。
- 单测：
  - `cancel-registry`：request/isCancelled/clear。
  - `window-runner`：会话开始前取消 → 不开窗、落 skipped、不重试；运行中取消（关窗打断）→ catch 落 skipped、不 `scheduleRetry`、不加熔断。
  - `task-stopper`：结算非终态行/不动终态行/关窗/清登记。
  - 路由：batch stop 计数、run stop、404/400。
  - 前端 hooks：stopBatch/stopRun 的请求与 invalidate。
- 真机：任务页「立即触发」一个任务 → 看板批次卡片「停止」或详情行「停止」→ 观察窗口立即关闭、行状态变 `skipped`（error「手动停止」）、不再重试、随后可再触发。

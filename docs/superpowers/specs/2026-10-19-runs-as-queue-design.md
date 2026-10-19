# runs 即队列：DB-first 执行队列设计

> 日期：2026-10-19
> 状态：方向已确认，待 review
> 范围：排队任务持久化、错峰时间落库、重试时间落库、dispatcher 取代内存队列
> 不在本次范围：并发阀门重构（后续单独讨论）、多进程 lease、任务执行逻辑本身

## 1. 背景与问题

当前系统已经用 SQLite 保存了批次和运行结果，但**排队中的任务仍然只存在内存里**：

- `POST /api/tasks/:key/trigger` 先创建 `batches` 行，然后调用 `CoalescingEnqueuer.enqueue`。
- `enqueue` 只写内存 `pending/running/followUp/gates/globalWaiting`。
- `runs` 的 `pending` 行要等 `WindowRunner.runWindowTasks` 开始时才写。
- 错峰、重试、兜底关窗使用内存 `setTimeout`。
- `Scheduler.lastFired` 是内存 Map。

结果是：

1. 批次创建后到窗口真正开始前，任务只存在内存；进程重启会丢。
2. 面板只能看到已开窗/已写 runs 的任务，看不到完整排队。
3. 错峰/重试/恢复各有一套时间逻辑，难以排查。
4. 队列 Map 不是“数据库缓存”，而是**第二套事实源**。

## 2. 目标

- 把**排队任务**和**允许开始时间**落进 `runs`，让数据库成为执行队列的唯一事实源。
- 进程重启后，排队任务和重试任务不丢。
- 错峰、重试不再依赖内存 `setTimeout`，统一由 dispatcher 按数据库时间触发。
- 面板能看到 `pending/retry_wait` 任务及预计开始时间。
- 保留现有任务执行器、并发闸门、状态机和批次统计语义。
- 为后续“并发阀门改成 DB 计数”打基础，但本次不改阀门。

## 3. 非目标

- 不把浏览器/CDP/正在执行的 Promise 放进数据库；这些只能留在内存。
- 不引入多进程 claim/lease（主后端仍由 `app.lock` 保证单实例；`task:run` 是独立调试路径）。
- 不重构任务代码、钱包、验证码、诊断。
- 不改变 `pending/running/success/failed/captcha_failed/retry_wait/skipped` 状态语义。
- 不重构并发阀门；`gates/globalActive` 暂时保留。
- 不把 `WalletSession`、`quizAnswerCache` 等真正的缓存搬进 DB。

## 4. 核心决策

### 4.1 用 `runs` 当队列，不新建 `queue_entries`

`runs` 已经是“窗口 × 任务 × 日期 × slot”的唯一执行记录，且已有 `pending/retry_wait` 状态。再建一套队列表会引入双向同步问题。

新增字段：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `not_before_ms` | INTEGER | 0 | 允许开始/重试的 epoch 毫秒；0 表示立即可调度 |
| `queued_at` | TEXT | NULL | 首次入队时间（本地墙钟，展示用） |

状态映射：

- `pending`：已入队，等待 dispatcher 调度。
- `retry_wait`：已失败，等待 `not_before_ms` 到期后重新调度。
- `running`：正在执行（由 runner 写入）。
- 终态不变。

不新增 `queued`/`claimed` 状态。单 dispatcher + 主进程单实例，`pending` 足够表达“排队”。

### 4.2 DB 与内存的职责边界

| 数据 | 位置 | 说明 |
|---|---|---|
| 排队任务、重试时间、错峰时间 | `runs` | 唯一事实源 |
| 批次、状态、错误、截图、诊断 | `runs/batches` | 已有 |
| 当前正在执行的窗口会话 | 内存 | page/CDP/browser/promise，无法持久化 |
| 任务级/全局并发计数 | 内存（暂定） | 后续讨论是否改成 DB 计数 |
| 停止标记 | 内存（暂定） | 运行时信号；停止已写 skipped 行 |
| 钱包会话、答题缓存 | 内存 | 真正的缓存 |

### 4.3 dispatcher 取代内存队列

新增一个 `RunDispatcher`（或改造 `CoalescingEnqueuer`）：

- 每 1 秒 tick 一次。
- 查询：
  - `status IN ('pending','retry_wait')`
  - `not_before_ms <= now`
  - 按 `profile_id` 分组
  - 排除已有 `running` 行的窗口
- 对每个窗口：
  - 同一 `(profile, task, date)` 只调度最新非终态 slot；如果发现更旧的非终态行，按现有 supersede 规则结算为 `failed`，避免旧轮次重复执行。
  - 检查任务级并发闸门（沿用现有内存 `gates`）。
  - 检查全局窗口闸门（沿用现有 `globalActive`）。
  - 通过后启动 `WindowRunner.runWindowTasks`。
- 启动前把该窗口加入内存 `activeProfiles`，防止下一 tick 重复挑中。
- 会话结束后释放 `activeProfiles`、全局额度和任务额度。
- 没有 `pending/followUp/waiting/globalWaiting` Map；未到时间的行留在 DB。

`activeProfiles` 是“当前活着的会话”句柄，不是排队队列。

### 4.4 错峰落库

- `enqueue` 时计算 `not_before_ms`：
  - 单窗口 `immediate`：`now`
  - 批量/定时/重跑：`now + random(0, staggerMaxSec * 1000)`
- 同一窗口同一批次的多个任务必须共享同一个 `not_before_ms`，否则同窗口任务会被拆成多次开窗。实现方式：
  - 窗口已有 pending 行时，新行沿用该窗口 pending 行的最小 `not_before_ms`；
  - 否则按上面的规则生成，并应用到本窗口本批次的所有任务。
- 写入 `runs.not_before_ms`。
- 不再为每个窗口挂 `setTimeout`。
- dispatcher 到点后自然拾取。
- 重试重新入队不叠加初始错峰，只使用自己的 backoff。

### 4.5 重试落库

- 任务失败进入 `retry_wait` 时：
  - `status='retry_wait'`
  - `not_before_ms = now + backoffSec * 1000`
  - 保留原 `slot`、`batch_id`、`attempts`
- 删除 `WindowRunnerDeps.scheduleRetry` 和 `app.ts` 里的 `setTimeout`。
- dispatcher 把到期的 `retry_wait` 行当作 `pending` 一样调度。
- 进程重启后 `retry_wait` 行仍在，不需要重新挂定时器。

### 4.6 重启恢复

启动时：

- `pending` 行：保留，dispatcher 会继续调度。
- `retry_wait` 行：保留，等 `not_before_ms` 到期。
- `running` 行：上一进程崩溃残留，重置为 `pending`，`not_before_ms=now`，保留原 slot/attempts/batch，错误写“进程崩溃残留，重新排队”。
- 然后启动 dispatcher。

不再需要 `recoverRetryTasks` 的“重新挂 setTimeout”逻辑；只保留 stale running 清理。

### 4.7 `task:run` 保持直接执行

`task:run` 是调试路径，不参与 dispatcher：

- 写/认领自己的 run 行为 `running`（直接 claim），再调用 `runWindowTasks`。
- dispatcher 只挑 `pending/retry_wait`，不会重复挑中。
- 不新增多进程 lease；文档继续要求不要和主后端同时操作同一窗口。

### 4.8 停止与批次取消

- 单窗口/行级停止：保持现有 `CancelRegistry` + 关窗 + 结算 `skipped`。
- 批次停止：
  - 把该批次仍为 `pending/retry_wait` 的行直接更新为 `skipped`（手动停止），不再做内存队列手术。
  - 正在 `running` 的行继续走现有停止器。
- `cancelBatch` 从队列 Map 删除的逻辑可以删除。

### 4.9 在途判定与面板统计

- `hasTaskInFlight`：直接查 `runs` 的 `pending/running/retry_wait`，不再查队列 Map。
- 触发 409 的判定统一走 DB。
- 看板“实时运行”：
  - `running` = DB 在途行数（或活跃会话数）
  - `pending` = DB pending 行数
  - `retryWait` = DB retry_wait 行数
  - 不再加 `enqueuer.pendingCount()`
- 批次明细能看到更早的 `pending` 行；这是预期行为。
- 可选：`RunRow` 增加 `notBeforeAt`（本地墙钟字符串），面板显示“排队中 · 预计 HH:mm”。本次可作为小增强。

## 5. 关键流程

### 5.1 触发

```text
POST /trigger
  → 校验任务/在途（DB）
  → createBatch
  → 对每个窗口 upsert pending run 行（slot、batch_id、not_before_ms）
  → 通知 dispatcher 尽快 tick（可选）
  → 返回
```

### 5.2 dispatcher tick

```text
每 1s:
  查 due pending/retry_wait 行（not_before_ms <= now）
  按 profile 分组
  跳过 running/active 的 profile
  按顺序检查：
    - 任务级 gates
    - 全局 globalActive
  通过 → 启动窗口会话
  不通过 → 行留在 DB，下一 tick 再试
```

### 5.3 会话执行

```text
runWindowTasks(profile, tasks)
  - 行已存在（pending）；不再预写 pending
  - 正常开窗/复用/CDP/任务执行
  - 每个任务开始 running，结束 success/failed/retry_wait
  - retry_wait 只写 not_before_ms，不再 scheduleRetry
  - 会话结束释放 active/global/task 额度
```

### 5.4 重试

```text
任务失败且还有预算
  → upsert retry_wait + not_before_ms
  → 当前会话继续/结束
  → dispatcher 到点拾取
```

## 6. 数据与迁移

### 6.1 表结构

`runs` 增加：

```sql
not_before_ms INTEGER NOT NULL DEFAULT 0
queued_at TEXT
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(status, not_before_ms)
```

### 6.2 兼容

- 老库：`ALTER TABLE runs ADD COLUMN`，默认 0。
- 老 `pending` 行：`not_before_ms=0`，立即调度。
- 老 `retry_wait` 行：`not_before_ms=0`，首次启动立即重试；可接受。
- 旧 `batches`/`runs` 查询不受影响。
- `RunRow`/API 增加 `notBeforeMs`（可选）。

### 6.3 并发写入

- dispatcher 单实例，claim 只需一次条件更新（把选中的行标记为 running 或由 runner 写 running）。
- 若 dispatcher 启动会话前需要“占位”，可用内存 `activeProfiles`；单进程足够。
- 不做 DB lease；后续多进程再讨论。

## 7. 需要删除/简化的代码

- `CoalescingEnqueuer` 的 `pending/followUp/globalWaiting/waiting` 逻辑。
- `queue.ts` 的错峰 `setTimeout`。
- `app.ts` 的 `scheduleRetry` setTimeout。
- `retry-recovery.ts` 的重试定时器重挂逻辑（保留 running 清理）。
- 触发路由/调度器里的 `enqueuer.hasTaskInFlight`（改为 DB）。
- 看板 `pendingCount()` 依赖。

保留：

- 任务级/全局 gates（本阶段）。
- `CancelRegistry`。
- `WindowRunner` 执行逻辑。
- 批次/状态机/诊断/钱包。

## 8. 测试计划

- DB：`not_before_ms` 迁移、队列查询、pending/retry_wait 到期。
- 触发：enqueue 写 pending 行，不写内存队列；批次统计立即看到 pending。
- dispatcher：同一窗口多任务合并；同窗口已有 running 时不重复启动；due 才启动；未 due 不启动。
- 错峰：immediate=now；批量在区间内；重启后 not_before 保留。
- 重试：写 retry_wait+not_before；到期被拾取；重启后仍能重试；不再 scheduleRetry。
- 停止：批次停止把 pending/retry_wait 更新为 skipped；running 走停止器。
- 崩溃恢复：running 重置 pending；pending/retry_wait 保留。
- 在途守卫：DB pending/running/retry_wait 生效；不再依赖内存。
- `task:run`：直接 claim，不被 dispatcher 重复拾取。
- 回归：现有任务执行、钱包、批次、调度器、停止、熔断测试全部通过。

## 9. 实施拆分（概要）

1. `runs.not_before_ms/queued_at` + 迁移 + 索引 + DB 队列查询/claim 方法。
2. 触发入队改为写 pending 行（含错峰时间）。
3. dispatcher 替代内存 pending/followUp/globalWaiting；保留 gates。
4. 重试改为 `retry_wait + not_before_ms`，删除 scheduleRetry。
5. 启动恢复简化为 stale running → pending。
6. 在途判定/批次统计/停止改 DB。
7. 测试与文档同步。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| SQLite 写竞争 | 单 dispatcher、短事务、`busy_timeout`；只写 due 行 |
| tick 延迟 1s | 任务为分钟级，可接受；入队后可主动触发一次 tick |
| 同窗口重复启动 | `running` 行 + 内存 `activeProfiles` 双保险 |
| 崩溃残留 | 启动时 running → pending；pending/retry 保留 |
| 老 retry_wait 立即重试 | 可接受；首次启动后由新 not_before 接管 |
| `task:run` 与主进程并发 | 保持调试路径隔离；文档要求不要并行操作同一窗口 |
| 批次统计提前出现 pending | 预期变化；面板需接受更多 pending 行 |
| 任务级/全局 gates 与 DB 队列不同步 | 本阶段 gates 仍是内存“活跃会话缓存”；后续用 DB 计数替代 |

## 11. 验收标准

1. 触发后，`runs` 立即出现 pending 行（含 batch_id、slot、not_before_ms），不再只存在内存。
2. 进程重启后，pending/retry_wait 行仍在，dispatcher 继续调度。
3. 同一窗口多个 pending 任务合并为一次会话；运行中的窗口不会被再次启动。
4. 错峰/重试只依赖 `not_before_ms`，代码中不再有对应的 `setTimeout`。
5. 单窗口/批量触发、定时、失败重跑、停止、在途 409、批次统计行为与现有语义一致。
6. `task:run` 直接执行，不被 dispatcher 重复拾取。
7. `npm run typecheck`、`npm test`、`npm run test:web` 通过。

## 12. 后续（不在本 spec）

- 并发阀门改成 DB claim/计数（在 runs 队列稳定后讨论）。
- `Scheduler.lastFired` 落库（可顺手做，但不阻塞本项）。
- 多进程 lease/claim（如果未来需要多个执行进程）。
- 队列 ETA/面板可视化增强。

# DB 并发阀门与错峰算法设计

> 日期：2026-10-19
> 状态：方向待 review
> 范围：把任务级/全局并发从内存迁移到 DB claim 事务；把错峰从“纯随机延迟”改成“均匀节奏 + 小抖动 + ETA”
> 不在本次范围：任务执行器、熔断、钱包、跨进程真实窗口探测

## 1. 背景

`runs 即队列` 落地后，排队、错峰、重试时间已经在 `runs` 表里，但还有两块遗留：

1. **并发阀门仍是内存态**：`gates: Map<taskKey, Gate>`、`globalActive`、`activeProfiles`。
   - 进程重启后清零，与 DB 的 `running` 行是两套事实。
   - claim 与内存计数是两步，理论上存在计数与 DB 状态不一致的窗口。
   - 多个 dispatcher/进程不能共享内存阀门。

2. **错峰仍是纯随机**：每个窗口 `now + random(0, staggerMaxSec)`。
   - 容易出现“前几个挤在一起、最后几个拖到 2 分钟后”的长尾。
   - 面板看不到预计开始时间。
   - 同一批次的窗口没有明确的节奏，只是随机打散。

这次把两件事一起做：**DB 做并发裁决，DB 做错峰时间；内存只保留 dispatcher 生命周期和正在执行的 runner 句柄。**

## 2. 目标

### 2.1 并发阀门

- 任务级/全局并发判断只依赖 `runs` 表。
- 在同一个 DB claim 事务里完成“计数 + 过滤 + claim”。
- 删除内存 `gates/globalActive/activeProfiles`。
- 重启后 `running` 行就是当前额度，不需要重建内存计数。
- 保持现有语义：
  - 同一窗口同一时间只有一个会话。
  - 同窗口到期任务尽量合并为一次会话。
  - 任务级 `meta.concurrency` 限制该任务同时占用几个窗口。
  - 全局 `execution.maxConcurrentWindows` 限制同时活跃窗口数。

### 2.2 错峰

- 同一批触发窗口按“均匀节奏 + 小抖动”分配 `not_before_ms`，避免长尾和聚簇。
- 错峰仍然只写 `runs.not_before_ms`，不挂定时器。
- 重试继续只用 `backoffSec`，不叠加初始错峰。
- 面板能看到排队/重试任务的预计开始时间。

## 3. 非目标

- 不新增 `sessions` 表；继续用 `runs.status='running'` 表示已占用窗口。
- 不做自适应限速/失败率反馈（后续可加）。
- 不改变任务执行、重试、停止、熔断、钱包。
- 不把比特浏览器实际窗口数搬进 DB；`openPids` 兜底保留。
- `task:run` 仍是调试直跑入口，不参与 dispatcher 的错峰/阀门排队。

## 4. Part A：DB 并发阀门

### 4.1 活跃窗口口径

一次窗口会话的多个任务行会一起 claim 为 `running`，因此：

```sql
-- 全局活跃窗口会话数（不按日期：跨午夜仍在跑的会话也必须计入）
SELECT COUNT(DISTINCT profile_id)
FROM runs
WHERE status = 'running'

-- 某任务活跃窗口数（不按日期）
SELECT COUNT(DISTINCT profile_id)
FROM runs
WHERE status = 'running' AND task_key = ?
```

- 同窗口多个 running 任务只算 1 个全局会话。
- 同任务不同窗口各算 1 个任务额度。
- 会话结束（行落终态）后计数自然下降，不需要释放内存。

### 4.2 `claimDueRuns` 事务

新增 DB 方法：

```ts
claimDueRuns(opts: {
  date: string
  nowMs: number
  limits: Map<string, number>       // taskKey -> meta.concurrency
  maxConcurrentWindows: number
}): Promise<RunRow[]>
```

在一个写事务中：

1. 查当天到期、最新 slot 的 `pending/retry_wait` 行（按 profile、not_before、id 排序）。
2. 查全部 `running` 行（不按日期；跨午夜仍在跑的会话也要占额度）：
   - `runningProfiles`：已有会话的窗口，跳过。
   - `globalActive`：`COUNT(DISTINCT profile_id)`。
   - `taskActive`：`task_key -> COUNT(DISTINCT profile_id)`。
3. 按 profile 分组到期行。
4. 对每个窗口：
   - 已有 running 行或本次已选中 → 跳过。
   - `globalActive >= maxConcurrentWindows` → 停止。
   - 过滤任务：`taskActive[taskKey] < limits[taskKey]`。
   - 没有可执行任务 → 跳过。
   - 选中该窗口 eligible 任务：
     - `globalActive++`
     - 对每个 taskKey `taskActive++`
5. 条件 claim 选中行：

```sql
UPDATE runs
SET status = 'running',
    started_at = COALESCE(started_at, ?),
    error = NULL
WHERE id IN (...)
  AND status IN ('pending','retry_wait')
```

6. 提交事务，返回实际 claim 的行。

如果 `rowsAffected` 与选中行数不一致，回滚并返回空（下一 tick 重试），避免部分 claim。

### 4.3 dispatcher 简化

`CoalescingEnqueuer` 只保留：

- `enqueue`：写 pending 行。
- `tick`：
  1. 先查 profiles（避免 profiles 查询失败时已 claim 的行 stranded）
  2. `const claimed = await db.claimDueRuns({ date, nowMs, limits, maxConcurrentWindows })`
  3. 按 `profileId` 分组；profile 缺失的行按 backoff 回队
  4. 启动 `WindowRunner.runWindowTasks`
  5. 会话异常时把 claim 行按 backoff 重新排队
- `start/stop`
- `anyRunning`：DB `COUNT(DISTINCT profile_id) WHERE status='running' > 0`
- `hasTaskInFlight`：DB（兼容保留）
- `cancelBatch`：DB

删除：

- `gates`
- `globalActive`
- `activeProfiles`
- `runSession` 的 gate 释放逻辑

### 4.4 索引

```sql
CREATE INDEX IF NOT EXISTS idx_runs_status_date_profile
ON runs(status, date, profile_id);

CREATE INDEX IF NOT EXISTS idx_runs_status_date_task
ON runs(status, date, task_key);
```

- 每 tick 一次写事务；没有 due 行时提前返回。
- 事务只覆盖“查 due + 查计数 + UPDATE selected”，不包含开窗/执行。
- `busy_timeout` 已由 `createClient({ timeout: 5000 })` 提供。

### 4.5 `task:run`

- 保持直接 `enqueueRun + claimQueuedRuns`，不经过 dispatcher 阀门。
- 它 claim 的 `running` 行会被后端 dispatcher 计数看到，所以会占用真实额度。
- 文档继续要求不要与后端同时操作同一窗口。

## 5. Part B：错峰算法优化

### 5.1 目标模型

同一批触发（全部窗口/手选/失败重跑/定时）按窗口顺序分配均匀偏移，再加小抖动：

```text
count = 本批窗口数
index = 窗口在本批中的序号（0 起）
spreadMs = execution.staggerMaxSec * 1000
spacing = count <= 1 ? 0 : spreadMs / (count - 1)
evenOffset = index * spacing
jitter = spacing * (staggerJitterPct / 100) * random(-1..1)
notBeforeMs = max(nowMs, startMs + evenOffset + jitter)
```

- `startMs`：本批触发开始时间（所有任务共用）。
- 同一窗口的多个任务共用同一个 `notBeforeMs`。
- `staggerMaxSec = 0` 或 `count <= 1` 时不延迟。
- 抖动只用于打散，不改变整体节奏；默认 ±15%。

### 5.2 配置

```json
"execution": {
  "staggerMaxSec": 120,
  "staggerJitterPct": 15
}
```

- `staggerMaxSec` 语义从“随机延迟上限”改为“本批总铺开时长（秒）”。
- `staggerJitterPct`：0-50，默认 15；0 = 完全均匀，50 = 较大抖动。
- 非法值回退默认，不阻止启动。
- 自动重试不使用初始错峰，只写 `now + backoffSec`。

### 5.3 触发入口传参

新增纯函数：

```ts
staggerNotBefore(opts: {
  startMs: number
  nowMs: number
  index: number
  count: number
  spreadMs: number
  jitterPct: number
}): number
```

调用方：

- 任务页“全部窗口”：按 `listProfiles(true)` 顺序计算 index/count。
- 任务页“手选窗口”：按 `profileIds` 顺序计算。
- `rerun-failed`：按勾选/选中窗口顺序计算。
- 定时计划：按 `listProfiles(true)` 顺序计算；同一计划多个任务共用同一 plan。
- 单窗口手动 `immediate`：不调用 stagger，`not_before_ms=now`。
- 自动重试：不调用 stagger，`not_before_ms=now+backoff`。
- `task:run`：不调用 stagger。

`enqueue` 增加可选参数：

```ts
{ immediate?: boolean; batchId?: number; notBeforeMs?: number }
```

- 传了 `notBeforeMs` 直接使用。
- 没传则保留现有 fallback（同窗口 pending 最早时间，否则旧随机）用于兼容/测试。

### 5.4 ETA 展示

- `RunRow` 已有 `notBeforeMs`。
- API 返回 `notBeforeAt`（本地墙钟字符串）或前端格式化 `notBeforeMs`。
- 批次明细里：
  - `pending`：显示“排队中 · HH:mm”
  - `retry_wait`：显示“重试等待 · HH:mm”
- 可选：看板统计加“排队中”数量（已有 pending 统计）。

## 6. 交互关系

- 错峰只决定“什么时候允许 claim”；DB 阀门决定“现在能不能 claim”。
- 两者都读/写 `runs.not_before_ms` 与 `runs.status`，没有独立内存状态。
- claim 事务不包含错峰计算；错峰在 enqueue 时已算好。
- 重试 backoff 与初始错峰解耦：重试只看 backoff，不再叠加 batch stagger。

## 7. 测试计划

### 7.1 DB 阀门

- global 上限：max=1，两个窗口到期 → 只 claim 一个。
- task 上限：concurrency=1，同任务两个窗口 → 只 claim 一个。
- 同窗口多任务：global 只 +1，每个任务各占 1。
- 已有 running 窗口不再 claim。
- claim 只命中 pending/retry_wait；终态不被改写。
- 事务失败回滚，不部分 claim。
- 两个 dispatcher 实例共享同一 DB，不能同时 claim 同一批行。

### 7.2 错峰

- `staggerNotBefore`：count=1、spread=0、jitter=0、index 边界、均匀间距。
- 同一窗口多任务共享同一 notBefore。
- 全部/手选/重跑/定时四条入口传入正确 index/count。
- 单窗口 immediate 与重试不叠加初始错峰。
- 重启后 notBefore 保留。
- ETA API/面板展示（如实现 UI）。

### 7.3 回归

- queue/windowRunner/task-stopper/web/scheduler 现有测试全部通过。
- `task:run` 不被 dispatcher 重复拾取。
- 跨日、停止、熔断行为不变。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| claim 事务较长 | 只做 SELECT + UPDATE，不包含开窗/执行 |
| 计数索引缺失 | 新增 status/date/profile、status/date/task 索引 |
| claim 标记全部任务 running | 当前实现已这样；批次统计语义不变 |
| 错峰语义变化（随机→均匀） | 文档写明；`staggerMaxSec` 仍控制总铺开时长 |
| 抖动导致早于 now | `max(nowMs, ...)` 钳制 |
| 同批次多任务计划不一致 | 同一 plan 传入所有任务；同窗口共享 notBefore |
| `task:run` 绕过阀门 | 调试入口，文档明确；其 running 行仍计入后端 |
| 多进程 | claim 事务 + SQLite 写锁串行化；`task:run` 仍是例外 |

## 9. 验收标准

1. `queue.ts` 不再包含 `gates/globalActive/activeProfiles`。
2. 任务级/全局并发由 `claimDueRuns` 事务决定。
3. 两个 dispatcher 共享 DB 时不会同时 claim 超过上限。
4. 错峰按均匀节奏 + 小抖动分配，不再纯随机长尾。
5. 同一窗口多任务共享同一 `not_before_ms`。
6. 重试只使用 backoff，不叠加初始错峰。
7. 面板能看到 pending/retry_wait 的预计开始时间（如实现 UI）。
8. `task:run`、停止、跨日、熔断行为不变。
9. `npm run typecheck`、`npm test`、`npm run test:web` 通过。

## 10. 实施顺序（概要）

1. DB `claimDueRuns` + 索引 + 单测。
2. dispatcher 改用 `claimDueRuns`，删除内存 gates/globalActive/activeProfiles。
3. 增加 `staggerNotBefore` 纯函数 + 配置 + enqueue `notBeforeMs`。
4. 四条触发入口传 index/count；重试/单窗口/ task:run 不传。
5. ETA API/UI（可选但建议一起做）。
6. 测试、文档、全量验证。

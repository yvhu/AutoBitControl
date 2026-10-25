# 窗口池调度与内存自适应设计（2026-10-22）

## 1. 背景

当前调度是“任务中心”的：

- 每个任务触发时给窗口建 `runs` 行，dispatcher 用 `claimDueRuns` 按全局 `maxConcurrentWindows`、任务级 `meta.concurrency` 认领窗口；
- 一个窗口会话可能合并多个任务，跑完就关窗；
- 批量触发、rerun 与定时计划用 `staggerMaxSec` 把窗口铺开。

真机多任务（DAC / Portal / Auralaunch 同时到点）暴露了三类问题：

1. **并发语义不匹配**：用户的心智模型是“每个窗口最终跑所有任务”，任务2 应该在任务1 已打开的窗口里接着跑；现实现会给任务2 重新开窗口，窗口反复开关、总量不受控。
2. **窗口生命周期没有治理**：全局并发是固定值，开窗/关窗又与比特 API 异步语义打架，日志出现大量 `跨进程窗口已达上限`、`浏览器正在打开`、`请降低接口调用频率`、孤儿窗口回收循环。
3. **内存没有背压**：多个重站点窗口 + 扩展 + 站点页面即可把内存顶满；没有“空闲内存不足就降级”的机制。

本设计把调度改成 **窗口池（window pool）+ 每窗口任务队列 + 内存调速**：

- 全局只保留一个窗口上限（安全上限）；
- 实际开窗数由内存动态决定；
- 每个窗口保持打开，按自己的待执行任务集逐个执行；
- 任务默认不设并发上限（所有打开的窗口都可跑），窗口不因任务切换反复开关；
- 删除批量错峰，开窗节奏由窗口池的冷却/速率控制。

## 2. 目标与非目标

### 目标

- 多任务同时到点时，窗口总数有稳定上限，不随任务数增加。
- 任务2 能在任务1 已打开的窗口里继续执行；已关闭窗口按队列轮转，不重复执行已完成的任务。
- 内存不足时自动降低有效窗口数并暂停开窗，任务保持 pending，不崩溃。
- 开窗/关窗不再产生孤儿窗口和 API 风暴。
- 系统级错误（代理不通、比特 API 不可用、断网）能全局暂停并退避，不反复开窗、不把任务打成失败。
- 调度状态可观测：池大小、打开/忙碌/空闲、内存状态、队列深度、全局健康状态。

### 非目标（本期不做）

- worker 进程隔离（进程池）——作为后续兜底方案。
- 站点级分布式限频/多机调度。
- 任务之间的复杂 DAG 依赖（先保留可选 `dependsOn` 扩展位）。
- 修改任务业务逻辑（只改调度与生命周期）。

## 3. 设计原则

1. **窗口是资源，任务是工作项**：窗口池决定“开多少、开多快”，任务只决定“哪些窗口有活干”。
2. **单窗口单任务原则**：一个窗口同一时刻只执行一个任务；任务结束窗口可继续接下一个任务。
3. **无任务级并发限制**：池内窗口都可以跑任意待执行任务；不做 per-task concurrency，站点限频由任务重试/熔断兜底。
4. **默认无任务顺序**：窗口从自己的任务集里挑任意可执行任务；确需顺序时用 `dependsOn`（后续）。
5. **资源不足时排队，不失败**：内存/开窗失败/系统级环境错误只让任务等待，不把任务结算为失败。
6. **不重复执行**：窗口 × 任务 × 日期的 `runs` 终态即完成；定时触发入队幂等。

## 4. 术语与不变量

- **窗口池**：当前由本进程管理、保持打开的比特窗口集合。
- **实际打开数**：比特 `/browser/pids` 实测的所有存活窗口 = 池窗口 + 手动/task:run 窗口 + opening/closing。
- **窗口任务集**：该窗口当天所有 `pending/retry_wait` 且已到期的 `runs` 行。
- **窗口队列**：有任务集但尚未打开（或已关闭等待轮转）的窗口，按最早待执行任务的 `queued_at` 排序。
- **有效池大小**：`effectivePool = min(maxOpenWindows, 内存允许的实际打开数)`；它是**实际总打开数**的上限，不是池窗口数。
- **不变量**
  - 任何窗口同一时刻最多一个 `running` 任务，且只有一个 CDP 会话。
  - 同一窗口同一任务同一天最多执行一次（重试沿用同一行，不新建 slot）。
  - 实际打开数（含 opening/closing/手动窗口）不超过 `effectivePool`。
  - 已终态（success/failed/skipped/captcha_failed）的行不会被再次调度。
  - 只有 `pending/retry_wait` 且 `not_before_ms <= now` 的行可被认领。

## 5. 总体架构

```
                 ┌──────────────────────────────┐
                 │  WindowPoolScheduler (每秒 tick) │
                 │  - 内存调速 / 有效池大小          │
                 │  - 全局健康门禁                  │
                 │  - 窗口状态对账 / 开窗冷却         │
                 │  - 窗口队列 / 任务选择             │
                 └──────────────┬───────────────┘
                                │ 分配 (窗口, 任务)
                 ┌──────────────▼───────────────┐
                 │ WindowRunner（单任务会话）       │
                 │ 复用已打开窗口 / 开窗             │
                 │ 连 CDP → 跑任务 → 关 CDP        │
                 │ 窗口保持打开（pool 模式）         │
                 └──────────────┬───────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   AppDb.runs               open_windows             BitBrowser API
   （任务集/队列）            （窗口状态）             （open/close/pids）
```

新增 `engine/window-pool`（或独立模块），替换 `CoalescingEnqueuer` 的认领/调度部分；`WindowRunner` 增加 pool 模式。

## 6. 调度算法

### 6.1 每秒 tick（或 2s）

1. **对账窗口**：读比特 `/browser/pids`，与 `open_windows` 状态比对：
   - pids 中不存在 → 清理 DB 行（若 state=opening/closing，按超时处理）；
   - DB 无登记但真实存活 → 视为孤儿，按回收策略关闭（只处理超过最小年龄的）。
2. **采样内存**：更新内存状态机（见第 7 节），计算 `effectivePool`。
3. **加载池**：`open_windows` 中 `owner_kind='pool'` 且 `state='open'` 的窗口；加载每个窗口的任务集。
4. **加载队列**：有任务集但不在池内的窗口，按最早 `queued_at` 排序。
5. **补池**（满足全部才开）：
   - `actualOpen < effectivePool`（实际总打开数，含手动/opening/closing）；
   - 队列非空；
   - 距上次开窗 ≥ `openCooldownMs`；
   - 内存状态不是 `critical`；
   - 全局健康状态不是 `paused`；
   - 开窗操作串行（同一时刻最多 1 个 open/close）。
6. **分配任务**：对每个空闲池窗口，从任务集中选一个可执行任务：
   - 到期（`not_before_ms <= now`）；
   - 该窗口该任务没有 running/终态；
   - 选择顺序：最早 `queued_at` 优先；窗口挑到就执行，不做任务级并发限制（4 个窗口可以同时跑同一个任务）。
   - 认领：把该行条件更新为 `running`（复用 `claimQueuedRuns` 语义），交给 `WindowRunner` 执行。
7. **轮转**：
   - 窗口任务集为空且队列有其它窗口 → 关闭该窗口，下一 tick 开队列头；
   - 任务集为空且无队列 → 保持 idle，超过 `idleCloseSec` 后关闭；
   - 达到 `windowMaxTasks` / `windowMaxLifetimeSec` → 当前任务结束后关闭，该窗口剩余任务回队列，后续重新打开。
8. **记录状态**：每次 tick 打印/记录池状态（可降噪为状态变化时记录）。

### 6.2 窗口状态机

```
closed ──reserve──▶ opening ──open成功──▶ open(idle/busy) ──close──▶ closing ──pids消失──▶ closed
   ▲                    │失败                    ▲                         │超时
   └────────────────────┘                        └─────────────────────────┘
```

- `opening`/`closing` 不参与“空闲关闭/任务分配”，但计入 `actualOpen`，避免超开。
- 状态持久化到 `open_windows`；`busy/idle` 可由 `runs` 是否 running 派生，不必额外字段。
- 开窗/关窗全部经一个进程内串行队列（`open/close` API 并发=1），并带冷却。

### 6.3 任务选择与不重复

- 任务集来自 `runs`：

  ```sql
  SELECT ... FROM runs r
  WHERE r.profile_id = ? AND r.date = ? AND r.status IN ('pending','retry_wait')
    AND r.not_before_ms <= ?
    AND NOT EXISTS (SELECT 1 FROM runs r2 WHERE ... r2.slot > r.slot)
  ORDER BY r.queued_at, r.id
  ```

- 窗口选中任务后，条件更新 `pending/retry_wait → running`；失败/停止/重试走现有状态机。
- **定时触发幂等**：
  - 若该窗口该任务当天已有 `success`，跳过，不新建 slot；
  - 若已有 `pending/running/retry_wait`，跳过（已在队列）；
  - `failed/skipped` 是否重跑由计划/手动 rerun 决定，定时触发默认不重复；
  - 手动触发/rerun 保留当前“新建 slot”语义。
- 窗口已完成任务后不会回到窗口1重来：队列按 `queued_at` 推进；关闭的窗口重新有任务时排到队尾（或按最早 pending 时间），有公平上限避免饥饿。

### 6.4 窗口优先与轮转

- 已打开的池窗口优先使用；关闭窗口只有在池有空位时才按队列顺序打开。
- 一个窗口清空任务集后：
  - 有排队的窗口 → 关闭并让位（保持池大小不变）；
  - 没有排队 → idle，等新任务或 `idleCloseSec`。
- 新任务到点：给所有“该任务当天无终态”的窗口追加 pending；已打开窗口立即参与，关闭窗口已在队列中；窗口任务集从空变非空时重新入队。
- 公平性：同一窗口连续占用超过 `cohortMaxSec`（默认 30 分钟）后，如果队列中有其它窗口在等，先轮转一次。

### 6.5 任务执行（WindowRunner 改造）

- 新增 `poolMode`/`keepWindowOpen`：
  - 会话开始：若窗口已打开（`open_windows.state='open'`）→ 直接 CDP 连接；
  - 否则走开窗流程；
  - 只执行**一个任务**（由池分配）；
  - 任务结束：关闭 CDP 连接，**不关闭浏览器窗口**；更新 `last_used_at`、`tasks_done`；
  - 关闭窗口由池的轮转/空闲/寿命策略决定。
- 每个任务会话仍创建独立 `TaskContext` 与 `WalletSession`，避免上下文跨任务泄漏。
- 任务结束/异常时尽量关闭多余标签页，导航到 `about:blank` 再断开 CDP，降低驻留内存。
- 复用窗口失效（CDP 连接失败）→ 清 `open_windows` 行，按“开窗失败”结算本轮任务并让池重新开窗。

## 7. 内存调速

### 7.1 配置

```json
"execution": {
  "windowPool": {
    "maxOpenWindows": 4,
    "memoryReserveMb": 100,
    "perWindowMb": 1024,
    "criticalFreeMb": 1024,
    "resumeFreeMb": 2048,
    "checkIntervalMs": 5000,
    "openCooldownMs": 10000,
    "idleCloseSec": 180,
    "windowMaxTasks": 3,
    "windowMaxLifetimeSec": 600,
    "cohortMaxSec": 1800
  }
}
```

- `maxOpenWindows` 是硬安全上限（不是旧的全局并发策略）；实际并发由内存决定。
- `memoryReserveMb` 只需给系统一个很小的缓冲（默认 100MB）；空闲内存本身已经扣除了系统/比特浏览器的占用。
- `perWindowMb` 初始 1024MB，**按实际观测自动校准**：每次开窗前后记录空闲内存差，维护 EWMA，夹在 512–2048MB；不同站点/任务的实际占用差异会体现在这里。
- 旧 `maxConcurrentWindows` 读取时迁移/告警；`staggerMaxSec`/`staggerJitterPct` 移除。

### 7.2 有效池大小

```
freeMb = os.freemem() / 1MB
actualOpen = 实际存活窗口数（池 + 手动 + opening + closing）
allowance = floor(max(0, freeMb - memoryReserveMb) / perWindowMb)
effectivePool = clamp(min(maxOpenWindows, actualOpen + allowance), 0, maxOpenWindows)
```

- `effectivePool` 是**实际总打开数**上限；池最多再开 `effectivePool - actualOpen` 个窗口。
- 手动/面板窗口计入 `actualOpen`，会挤占池额度，但池不会主动关闭它们。
- 不按任务数量算：任务再多也只是排队，不会扩大池。

### 7.3 内存状态机（带迟滞）

- **normal**：`free >= resumeFreeMb`，允许补池。
- **warning**：`free < memoryReserveMb + perWindowMb`，禁止补池；现有窗口跑完任务后不接新任务（可配置），让内存回落。
- **critical**：`free < criticalFreeMb`，暂停分配新任务；优先关闭 idle 窗口；运行中的任务自然结束，不 hard kill。
- **recover**：连续 N 次（默认 3）`free >= resumeFreeMb` 后回到 normal；避免抖动。
- 每次状态变化记录日志：`{freeMb,totalMb,actualOpen,effectivePool,state,reason}`；normal 状态每 30s 记一次指标。

### 7.3.1 阈值含义（以 32GB 机器、当前空闲 12.6GB 为例）

| 配置 | 含义 | 例子 |
|---|---|---|
| `memoryReserveMb: 100` | 只留很小的系统缓冲，不预留大块内存 | 空闲 12.6GB 时，预算约 12.5GB |
| `perWindowMb: 1024` | 初始每窗口估算；运行中按实际开窗内存差自动校准（512–2048MB） | 12.5GB / 1GB ≈ 12 个，但被硬上限压到 4 |
| `maxOpenWindows: 4` | 硬安全上限（用户配置） | 实际最多开 4 个 |
| `criticalFreeMb: 1024` | 空闲低于 1GB 进入 critical：暂停分配新任务、关闭 idle 窗口，运行中的任务自然结束 | 空闲 0.9GB → critical |
| `resumeFreeMb: 2048` | 空闲恢复到 2GB 且连续 3 次检查后，才从 critical/warning 回到 normal（迟滞，避免抖动） | 空闲 2.1GB 持续 15s → 恢复 |

实际公式：`effectivePool = min(maxOpenWindows, actualOpen + floor(max(0, freeMb - reserveMb) / perWindowMb))`。
例如实际已开 0 个、空闲 12.6GB：预算足够，但 `maxOpenWindows=4` 仍只开 4 个；空闲 2GB：`floor((2048-100)/1024)=1` → 最多再开 1 个；空闲 0.9GB → critical。

### 7.4 降级行为

- 不能开窗/分配任务时，`runs` 保持 `pending/retry_wait`，不落 failed。
- 内存恢复后自动继续；面板显示“内存不足，已暂停开窗”。
- 硬保险：`maxOpenWindows` 防止任务误配；`windowMaxLifetimeSec` 防止单窗口长期增长。
- `perWindowMb` 自动校准：每次开窗记录开窗前后的空闲内存差（开窗冷却期内没有其它开窗干扰），维护 EWMA 并夹在 512–2048MB；不同站点/任务的实际占用会自动反映。

## 8. 系统级健康与熔断

### 8.1 错误分层

| 层级 | 例子 | 处理 |
|---|---|---|
| 全局环境 | 比特 API 不可用、系统断网、代理服务整体不可达、磁盘满 | 全局暂停窗口池，指数退避；任务保持 pending，不重复开窗 |
| 单窗口环境 | 单个窗口崩溃、CDP 失败、扩展未加载、单窗口代理失效 | 沿用窗口熔断：连续 2 次环境失败 → open，冷却后 half_open 探测；池跳过该窗口 |
| 任务级 | 选择器失效、站点改版、任务超时、验证码失败 | 任务重试/失败；不计窗口/全局环境熔断 |

### 8.2 全局健康门禁

- 每 tick/开窗前检查比特 API 健康（`/health`，失败时退化为 `/browser/pids` 探测）；不可用 → `globalState='paused'`，关闭 idle 池窗口，任务保持 pending。
- 环境失败聚合：`globalEnvFailureWindowSec` 秒内至少 `globalEnvFailureThreshold` 个**不同窗口**出现 `failureKind='environment'` → 判为全局（代理/网络/比特 API），暂停池，不再继续开窗。
- 暂停退避：`30s → 60s → 120s → 300s → 600s` 封顶。恢复前做一次 half-open 探测：
  - 只开 1 个窗口跑 1 个 pending 任务；
  - 成功 → 恢复 `normal`，再按内存策略逐步加窗口；
  - 环境失败 → 继续退避，不批量重试。
- 暂停期间不把任务标 failed；面板显示暂停原因、失败窗口数、下次探测时间。
- 现有 `classifyFailure` 已覆盖 `net::ERR_PROXY` / `ERR_TUNNEL` / `ERR_INTERNET_DISCONNECTED` / `ECONNREFUSED` 等；新增的是“多窗口聚合判定全局”，避免一个坏代理把整个池反复开窗。

### 8.3 单任务场景

- 单任务同样走全局门禁，不会因为只有 1 个任务就立即反复重试。
- 代理不通/断网：任务保持 pending，按全局退避探测；环境恢复后自动执行。
- 单窗口代理坏：窗口熔断 + 池换窗口，不影响其它窗口。
- 面板可手动“立即探测/恢复”，用于确认环境已恢复。

### 8.4 配置

```json
"execution": {
  "health": {
    "bitbrowserProbeMs": 30000,
    "globalEnvFailureWindowSec": 300,
    "globalEnvFailureThreshold": 3,
    "probeEnabled": true,
    "backoffSec": [30, 60, 120, 300, 600]
  }
}
```

- 日志/面板暴露 `globalState`（normal/paused/probing）、最近错误、失败窗口数、下次探测时间。
- 与窗口熔断的关系：**窗口熔断管单个窗口**；**全局健康门禁管“整个环境是不是坏了”**；两者独立，任务级失败都不触发。

## 9. 开窗/关窗协议

- 进程内 `openCloseMutex`：`openBrowser`/`closeBrowser` 串行；两次开窗之间至少 `openCooldownMs`。
- 开窗：
  1. `reserveOpenWindow` 写 `state='opening'`、`owner_pid`、`owner_kind='pool'`；
  2. 调 `/browser/open`；
  3. 成功写 `http`、`state='open'`；
  4. 失败：等待/探测窗口是否实际已开；已开则补登记，未开则 `clearOpenWindow`，状态回 closed。
- 关窗：
  1. 写 `state='closing'`；
  2. 调 `/browser/close`；
  3. 轮询 `/browser/pids` 直到该 id 消失（最长 `closeWaitMs`，默认 30s）；
  4. 消失 → 删除行；超时 → 保留 `closing`，后台重试，不当作孤儿（后台对账器为 Phase 2；Phase 1 保留 `closing` 行等待后续操作/人工处理）。
- 孤儿回收：只处理 `state='open'` 且 `opened_at` 超过最小年龄、且 `owner_pid` 已死或无登记的窗口；跳过 `opening/closing`。Phase 1 暂不回收「存活但无登记」的窗口。
- Phase 2 删除 `waitForGlobalWindowCapacity` 的“超时放行”：池调度器只会在容量/内存满足时开窗，不存在绕过。Phase 1 保留旧超时放行行为（旧调度器仍在用）。

## 10. 数据模型与迁移

### 10.1 `open_windows` 扩展

新增列（migrate 补列，老库兼容）：

| 列 | 类型 | 说明 |
|---|---|---|
| `state` | TEXT NOT NULL DEFAULT 'open' | `opening/open/closing` |
| `owner_kind` | TEXT NOT NULL DEFAULT 'manual' | `pool/manual/taskrun` |
| `last_used_at` | TEXT | 最近一次任务结束时间 |
| `tasks_done` | INTEGER NOT NULL DEFAULT 0 | 该窗口已跑任务数（寿命回收） |

`busy/idle` 由 `runs` 派生，不落列。

### 10.2 `runs` 不变

`runs` 即任务集/队列；新增可选索引 `(status, date, profile_id, not_before_ms)` 供池查询。`slot` 语义不变（重试沿用同一行）。

### 10.3 启动恢复

- 对账 `open_windows` 与 `/browser/pids`：
  - 本进程池窗口（owner_pid 已死）→ 存活则接管为 `open`，否则清行；
  - `opening/closing` 超过超时 → 重新探测，必要时关闭/清行；
  - `owner_kind='manual'` 的窗口不关闭，不纳入池（但内存统计包含）。
- `recoverRuns` 仍把当天 `running` 重置为 `pending`，由池重新调度。
- 跨日逻辑保留：旧日期 pending 结算 skipped，旧日期 running 结算 failed。

## 11. 配置迁移

| 旧配置 | 新行为 |
|---|---|
| `execution.maxConcurrentWindows` | 迁移为 `windowPool.maxOpenWindows`（默认 4），启动时告警 |
| `execution.staggerMaxSec` / `staggerJitterPct` | 移除；触发不再铺开，`not_before_ms` 只用于重试 |
| `meta.concurrency` | 废弃；不生效，调度不再做任务级并发限制 |
| `execution.windowTimeoutMs` | 保留为单任务窗口会话上限；新增 `windowMaxLifetimeSec` 管理窗口驻留 |
| `execution.retryMax/retryBackoffSec` | 不变 |

触发入口（任务页立即触发、rerun-failed、定时计划）只写 pending，不再计算 stagger 的 `not_before_ms`。

## 12. 面板与可观测性

- 新增池状态（settings 或 dashboard 顶部）：
  - 内存状态（normal/warning/critical）与全局健康状态（normal/paused/probing）；
  - `effectivePool / maxOpenWindows`；
  - 打开数 / 忙碌 / 空闲 / opening / closing；
  - 队列窗口数 / pending 任务数；
  - 最近降级/暂停原因与时间、下次探测时间。
- 窗口页显示池状态（池/手动）与最近使用时间。
- 日志：
  - 状态变化：`windowPool` + 指标；
  - 开/关窗耗时、失败原因；
  - 任务分配：`{window, task, queuedMs, poolState}`；
  - 降级/恢复/轮转原因。
- API（可选）：`GET /api/pool/status` 返回上述指标，面板轮询。

## 13. 边界场景

| 场景 | 行为 |
|---|---|
| 任务1 在窗口1-4 运行，任务2 到点 | 任务2 写 pending；窗口1-4 空闲后直接接着跑任务2，不新开窗；窗口5+ 排队 |
| 任务1 在窗口1-2 已完成并关闭，任务2 到点 | 窗口1-2 的 task2 pending 入队；当前打开的窗口优先，跑完当前任务后轮转再打开 1-2（或按队列顺序） |
| 任务并发数大于池 | 不扩池；任务在窗口空闲时逐个执行 |
| 内存 critical | 停止开窗/分配新任务；关闭 idle；运行中任务自然结束；恢复后继续 |
| 全局代理/网络故障 | 全局 paused + 退避 + half-open 探测；任务保持 pending，不批量失败 |
| 单窗口代理/浏览器故障 | 窗口熔断；池换窗口；其它窗口继续 |
| 窗口 CDP 连接失败 | 清登记、本轮任务按环境失败/重试，池重新开窗；熔断逻辑保留 |
| 任务失败 retry_wait | 行保留在原窗口任务集，`not_before_ms` 到期后再被选中；窗口可先跑其它任务 |
| 手动停止批次 | 取消标记 + 结算 pending/running；池窗口回到 idle，必要时关闭 |
| 面板手动开关窗口 | `owner_kind=manual`；池不自动关闭，但计入内存/实际上限 |
| `task:run` 单窗口 | 不启动池；按当前单窗口逻辑，复用/开窗后结束关闭（保持现状） |
| 进程崩溃重启 | 对账 pids + 恢复 runs；池重新建立 |
| 跨午夜 | 保留现有跨日结算；池只处理当天 pending |

## 14. 测试策略

- 单元测试（fake clock/memory/bitbrowser/runner）：
  - 有效池大小公式、迟滞、critical/warning/recover；
  - 窗口状态机（open/close 失败、超时、孤儿回收）；
  - 任务选择：无顺序、到期过滤、最新 slot；
  - 轮转：窗口清空 → 关闭 → 下一窗口；不重复窗口；
  - 定时入队幂等：success 不重跑；
  - 全局健康门禁：比特 API 失败、环境失败聚合、退避、half-open。
- 场景测试（fake）：
  - 任务1 4 窗口 + 任务2 后到 → 同一 4 窗口跑 task2，closed 窗口排队；
  - 内存不足 → 池缩小、任务保持 pending、恢复后继续；
  - 代理整体不通 → 全局 paused，不开窗；恢复后只 probe 1 个窗口；
  - 开窗 API 失败/正在打开 → 不产生孤儿、不当 orphan 回收。
- 真机验收：
  - 同时触发两个任务（DAC + Portal），观察池大小不超过 effectivePool，任务2 复用任务1 窗口；
  - 内存下降时自动降级；恢复后继续；
  - 模拟代理断开/恢复，验证全局暂停与 half-open；
  - 连续运行 2 小时无窗口泄漏，Chrome 进程数稳定。

## 15. 分阶段实施

**Phase 1：基础治理（可独立上线）**
- 新增 `windowPool` 与 `health` 配置、内存调速/全局健康门禁模块（含单测；Phase 2 接入调度）；
- 开窗/关窗串行 + 冷却（冷却只约束开窗）；窗口状态机与孤儿回收修正；
- 触发/定时/rerun 删除 stagger（只写 pending）。
- **保留** `waitForGlobalWindowCapacity` 的“容量等待超时仍继续开窗（放行）”——Phase 1 仍是旧调度器，超时放行行为不变；Phase 2 由池调度器替换该闸门后删除。
- **保留** `closing` 登记等待对账：Phase 1 没有后台对账器，关窗失败/确认超时的 `closing` 行会残留到下次相关操作或人工处理；这是已知残留风险，Phase 2 增加后台对账。
- 验收：不再出现开窗风暴/孤儿循环；Phase 2 接入后内存不足/代理故障时能暂停而非崩溃。

**Phase 2：窗口池调度**
- `WindowRunner` 支持 keep-open / 单任务会话；
- 池调度器：窗口队列、任务集、任务选择、轮转、idle/寿命回收；
- 定时入队幂等；
- 面板池状态；
- 删除 `waitForGlobalWindowCapacity` 的“超时放行”，由池调度器在容量/内存满足时才开窗；
- 增加后台对账器：清理超时 `opening/closing` 行、重启后接管/关闭归属进程已死的池窗口；
- 接入内存 `warning` 带宽（当前 `critical/resume` 滞回之外，warning 区间过窄，Phase 2 结合 `checkIntervalMs` 校准）；
- 接入全局健康探测的租约/超时（`global-health` 模块目前只有纯函数与单测，Phase 2 由调度器持有探测租约并处理超时）。
- 验收：任务2 复用任务1 窗口；不重复执行；窗口总数受池/内存约束。

**Phase 3：清理与调优（清理部分已于 2026-10-25 完成）**
- 已移除 `maxConcurrentWindows`、`meta.concurrency`、`CoalescingEnqueuer`、旧 claim/容量 gate、stagger 配置与 `windowPool.enabled` 开关；
- 待根据真机数据校准 `perWindowMb`、`idleCloseSec`、`windowMaxLifetimeSec`；
- 可选 `dependsOn` 顺序依赖。

迁移期曾用特性开关 `execution.windowPool.enabled` 控制；Phase 3 已删除该开关，窗口池始终启用。

## 16. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 窗口长期驻留内存增长 | idle 关闭 + 任务数/寿命回收 + 内存调速 |
| 任务无并发上限导致站点限频 | 任务级重试/熔断；必要时增加 `startSpacingMs` 启动间隔 |
| 活跃窗口被新任务无限续命，队列饥饿 | `cohortMaxSec` 强制轮转；队列按最早 pending 排序 |
| 手动窗口占用内存 | 计入内存/上限，但不自动关闭；面板提示 |
| 开窗 API 仍可能异步失败 | 串行 + 冷却 + 状态机 + pids 对账；失败只排队不失败任务 |
| 全局健康门禁误判（单窗口偶发） | 阈值按“不同窗口数 + 时间窗”，且窗口熔断独立；可手动恢复 |
| 迁移期配置/任务字段失效 | 启动告警 + 文档；分阶段开关回滚 |

## 17. 待确认问题

已确认：

1. `maxOpenWindows` 默认 **4**。
2. 面板手动打开的窗口：**不复用、只计入内存/上限**，池不自动关闭。
3. 默认**任务无顺序**；需要依赖时再加 `dependsOn`。
4. `cohortMaxSec` 默认 **30 分钟**。
5. 系统级错误（代理/比特 API/断网）纳入本设计：全局健康门禁 + 窗口熔断 + 任务重试三层。
6. **不保留任务级 `meta.maxWindows`**；任务限制全部去掉，站点限频由重试/熔断/启动间隔兜底。
7. 内存阈值默认采用 `reserve 100MB / perWindow 1024MB（自动校准）/ critical 1024MB / resume 2048MB`。

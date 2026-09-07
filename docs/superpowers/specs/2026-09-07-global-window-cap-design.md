# 全局窗口上限设计（任务增长下的开窗总量控制）

日期：2026-09-07
状态：已确认，待实现信号

## 背景与目标

现状（2026-09-03 任务级并发改造）完全去掉了全局上限：每个任务独立并发额度（`meta.concurrency`，缺省 4），总开窗数的理论上限 = 各任务并发需求之和。任务少时没问题；任务数量增长后，总和随之膨胀，机器资源（内存/CPU/显存）没有兜底约束。

目标：恢复一道**全局窗口上限**（`execution.maxConcurrentWindows`），与任务级并发并存——全局闸门管机器资源（窗口总数封顶），任务级闸门管站点风控（单站同时访问窗口数限制），两道闸门取更严者。任务级语义零变化。

> 本设计**部分反转** `2026-09-03-task-level-concurrency-design.md` 的决策 #2「全局上限完全去掉，总开窗数 = 各任务并发需求之和」：恢复全局上限作为资源兜底，任务级并发保留为风控软上限。该文档其余决策（meta.concurrency 配置、滚动分批、等待判在途等）不变。

## 已确认的决策

1. **双闸门**：全局窗口上限 + 任务级 concurrency 保留为软上限，均生效
2. **闸门位置**：全局闸门只卡开窗（dispatch 时检查），enqueue 的任务级额度占坑逻辑完全不动（方案 A：改动最小、无死锁、任务级语义零变化；不采用方案 B「整窗一次过闸」与方案 C「权重比例」）
3. **配置来源**：`config/config.json` 的 `execution.maxConcurrentWindows`（与 staggerMaxSec 同模式，改配置重启生效），面板设置页只读展示，不做运行时修改
4. **缺省值 4**（代码默认值与 config.json 显式值一致）
5. 全局额度排队期间，条目仍持有任务级额度（已占坑）；全局续跑直接 dispatch 不重复错峰（会话结束天然错开）

## 1. 配置与展示

### ExecutionConfig 新增字段（src/infrastructure/config.ts）

```ts
/** 全局窗口上限：同时最多开几个窗口会话（机器资源兜底；与任务级 concurrency 双闸门取更严者） */
maxConcurrentWindows: number
```

- 代码默认值 4（defaults.execution.maxConcurrentWindows）
- `config/config.json` 的 execution 段显式加 `"maxConcurrentWindows": 4`

### 设置接口展示（src/server/routes/settings.ts）

`PublicSettings` 加 `maxConcurrentWindows: number`，swagger 注解同步，`/api/settings` 返回。前端设置页（`web/src/pages/settings/index.tsx`）加一行只读展示；`web/src/api/schema.d.ts` 手补字段。

## 2. 引擎改造（核心）

文件：`src/engine/queue.ts`

### CoalescingEnqueuer 新增全局闸门

**构造签名**：`new CoalescingEnqueuer(runner, logger, taskConcurrencyOf, staggerMaxSec, maxConcurrentWindows)`，app.ts 装配传 `cfg.execution.maxConcurrentWindows`（clamp 到 ≥1）。

**新增状态**：

```ts
/** 全局窗口闸门：同时开窗总数上限（clamp 到 ≥1；Infinity = 不限制） */
private readonly globalMax: number
private globalActive = 0
/** 全局额度已满时的窗口会话 FIFO 排队（条目保留在 pending 合并区，续跑时直接 dispatch 不重复错峰） */
private globalWaiting: Entry[] = []
```

### 流程

1. **dispatch(entry)** 开头**同步**检查全局额度（同步判定保证会话结束释放额度时的滚动续跑 FIFO 公平）：
   - `globalActive < globalMax` → `globalActive++`，继续现有开窗流程
   - 否则 entry 进 `globalWaiting` 队尾返回（条目**保留在 pending 合并区**：同窗口后续任务继续合并进同一会话）
2. **会话结束**（runWindowTasks 返回后）顺序调整为：
   - followUp 重入队（现有逻辑不变）
   - **先释放全局额度**：`globalActive--`；若 `globalWaiting` 非空，队首出队直接 `dispatch`（不重复错峰：会话结束时机天然错开，且条目不再走 occupy/额度占坑路径）
   - 再逐个释放任务额度（现有 release 逻辑不变；release 滚动续跑的新会话在 dispatch 时重新走全局检查，满了排 `globalWaiting` 队尾——全局 FIFO 公平）
3. **enqueue / occupy / release** 现有逻辑全部不动；全局闸门是 dispatch 入口的一道独立检查
4. **hasTaskInFlight / pendingCount 无需改动**：全局排队条目保留在 pending 合并区，既有的 pending 来源自动覆盖「全局排队判在途」与「已入队未开窗」口径

### 死锁分析

- 全局额度只在会话结束时释放，任务额度照旧释放；无跨闸等待环
- `globalWaiting` 条目只等全局额度，而全局额度每次会话结束必然释放 → 无死锁
- FIFO 公平性：会话结束先释放全局额度再释放任务额度，释放的任务额度滚动续跑的新会话与 `globalWaiting` 队首竞争时排在其后，不插队

### 额度语义说明

- 等待全局额度期间条目仍持有任务额度：某任务额度可能被「排队中」窗口占满——这正是任务级软上限语义（该任务排队窗口数有限），可接受
- retry_wait 不占额度（现有 scheduleRetry 语义）：退避到期重新 enqueue → 占任务额度 → dispatch 时走全局检查

## 3. 触发语义

- **批量触发**（任务页「立即触发」）：逐启用窗口 enqueue，任务额度控制下滚动分批，dispatch 时受全局闸门限制，全局满时排队滚动续跑
- **单窗口触发**（看板行级「执行/重跑」经 enqueuer 的路径）：同样受双闸门限制；task:run 调试脚本是独立进程直接跑 runManual，不经本队列、不受双闸门限制
- **409 判定不变**：`hasTaskInFlight`（经 pending 合并区自动覆盖全局排队）覆盖，任务任何窗口在跑/排队（含全局排队）即拒绝重复触发
- **stagger 错峰**（execution.staggerMaxSec，默认 120 秒）继续作用于每个新窗口会话（occupy 路径）；全局续跑不重复错峰（见上）

## 4. 测试

`tests/queue.test.ts` 新增用例：
- 全局额度满：多窗口入队（各任务额度充足）时，超 maxConcurrentWindows 的会话进 globalWaiting 排队不开窗
- 全局续跑：会话结束释放全局额度，globalWaiting 队首自动开窗（FIFO 顺序）
- 双闸门取更严者：任务额度小/全局额度小的场景分别生效
- 全局排队判在途：globalWaiting 中的条目 hasTaskInFlight 为 true
- pendingCount 含 globalWaiting 数量
- 构造签名兼容：maxConcurrentWindows 缺省/传参两种装配

`tests/web.test.ts`：PublicSettings fixture 补 `maxConcurrentWindows` 断言。

## 5. 文档

- `docs/API-GUIDE.md`：配置表 `execution` 段加 `maxConcurrentWindows` 行（全局窗口上限，缺省 4，与任务级 concurrency 双闸门）；触发/并发章节若有「总开窗数 = 各任务并发之和」表述则更正为「受全局上限约束」
- `AGENTS.md`：engine 描述（queue 一行）补「全局窗口上限 + 任务级并发双闸门」；配置段落提 `execution.maxConcurrentWindows`

## 迁移清单（实现顺序）

1. `src/infrastructure/config.ts`：`ExecutionConfig` 加 `maxConcurrentWindows`，默认值 4
2. `config/config.json`：execution 段加 `"maxConcurrentWindows": 4`
3. `src/engine/queue.ts`：新增全局闸门（globalActive/globalMax/globalWaiting）、dispatch 同步检查、会话结束释放顺序调整、构造签名加参数
4. `src/app.ts`：enqueuer 装配传 `cfg.execution.maxConcurrentWindows`
5. `src/server/routes/settings.ts`：PublicSettings + swagger + 返回值加 `maxConcurrentWindows`
6. 前端：settings 页加一行展示、`web/src/api/schema.d.ts` 手补
7. 测试更新（queue/web）
8. 文档更新（API-GUIDE.md、AGENTS.md）
9. 验证：`npm run typecheck` + `npm test`

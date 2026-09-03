# 任务级并发设计（去掉全局 concurrency）

日期：2026-09-03
状态：已确认，待实现信号

## 背景与目标

现状 `execution.concurrency` 是全局窗口并发上限（config.json=2，代码默认 6），p-queue 控制同时最多开几个窗口会话，对所有任务一视同仁。

目标：去掉全局 concurrency，改为**任务级配置**——每个任务声明自己最多同时跑几个窗口（`meta.concurrency`）。批量触发时按额度滚动分批跑完所有启用窗口；同窗口多任务合并机制保留（仅前端不再提供多任务同时触发入口，后端能力不动）。

## 已确认的决策

1. 配置来源：代码 meta 字段（与 timeoutSec/retry/captcha 同模式），不引入 tasks.json
2. 全局上限完全去掉，总开窗数 = 各任务并发需求之和
3. 批量触发遇额度满：**滚动分批**，先跑 N 个、跑完自动接下一批，直到所有启用窗口跑完
4. 单窗口触发（看板行级执行/重跑、task:run）同样受额度限制：满了排队等释放后自动开窗
5. 同窗口多任务合并开窗机制**保留**（后端能力，防未来改动）
6. 缺省值 `concurrency?: number` 不写时默认 **4**
7. 现有任务初始值：`portal-rhuna` = **2**，其余 4 个（example-checkin、faucet-example、mint-example、inception-dachain）= **4**

## 1. 配置与元数据

### TaskMeta 新增字段（src/engine/task.ts）

```ts
/** 任务级并发：同一时间最多几个窗口并行跑该任务；缺省 DEFAULT_TASK_CONCURRENCY（4）；批量触发时滚动分批跑完 */
concurrency?: number
```

同文件导出常量 `export const DEFAULT_TASK_CONCURRENCY = 4`，app.ts 装配 `taskConcurrencyOf` 与 `GET /tasks` 返回兜底都引用它（单点维护，避免两处 4 漂移）。

### 现有任务各显式写

- `src/tasks/portal-rhuna.ts`：`concurrency: 2`
- `src/tasks/example-checkin.ts`、`faucet-example.ts`、`mint-example.ts`、`inception-dachain.ts`：`concurrency: 4`

### 删除全局 concurrency

- `config/config.json`：删 `execution.concurrency` 行
- `src/infrastructure/config.ts`：删 `ExecutionConfig.concurrency` 字段与默认值 6
- `package.json`：删 `p-queue` 依赖
- `tests/config.test.ts`、`tests/web.test.ts`：删 concurrency 断言与 fixture

## 2. 引擎改造（核心）

文件：`src/engine/queue.ts`

### 删除 TaskQueue

p-queue 薄封装整体移除，`CoalescingEnqueuer` 不再持有队列。

### CoalescingEnqueuer 改造为「每任务额度 + 窗口合并」调度器

**保留**：pending 合并区、running 集合、followUp、stagger 错峰、dispatch 内 try/catch 会话隔离。

**新增**：
- `gates: Map<taskKey, { concurrency: number; active: number }>`——每任务已占额度计数（active = pending 会话 + running 会话中该任务的窗口数）
- `waiting: Map<taskKey, Array<{ profile: ProfileRow; taskKey: string }>>`——额度已满时的窗口 FIFO 排队队列

**构造签名**：`new CoalescingEnqueuer(runner, logger, taskConcurrencyOf, staggerMaxSec)`，其中 `taskConcurrencyOf: (taskKey: string) => number`，app.ts 装配为 `(key) => tasks.get(key)?.meta.concurrency ?? 4`。

### 流程

1. **enqueue(profile, taskKey)**：
   - 窗口 running → 进 followUp（现有逻辑不变）
   - 该任务 `active >= concurrency` → 进 `waiting[taskKey]` 队尾，返回
   - 否则占额度 `active++` → pending 合并/新建 + 错峰延迟后 dispatch（现有逻辑不变）
2. **dispatch(entry)**：直接执行（不再经 p-queue）→ `runWindowTasks(profile, taskKeys)` → 会话结束：
   - 处理 followUp：对追加任务重新 enqueue（走额度）
   - 对会话内每个任务 `active--` 并调用 `release(taskKey)`
3. **release(taskKey)**：`waiting[taskKey]` 队首出队 → 先检查该窗口是否 running（该窗口有其他任务在跑）→ running 则进 followUp，否则占额度 `active++` → pending 合并/新建 + 错峰 dispatch（实现滚动：跑完一个窗口自动接下一个）
4. **hasTaskInFlight(taskKey, profileId?)**：pending + running + **waiting** + followUp 全部算在途（waiting 是新增判在途来源；触发 409 与面板「运行中」按钮态依赖此语义）

### 额度释放时机

会话结束时统一释放。retry_wait 不占额度：任务进 retry_wait 时当前会话继续/关窗（现有 scheduleRetry 语义），退避到期重新 enqueue 再占额度，天然一致。

### 死锁分析

无死锁：waiting 仅在额度满时进入，会话结束必然 `active--` 并触发 release；跨任务无相互等待。

### 合并语义（保留）

多任务同时触发时：同一窗口的不同任务各自占各自任务的额度，pending 合并机制使它们共享一次开窗；某任务额度不足时该任务在该窗口的执行为 waiting 队尾条目，额度释放后可能与其他 pending 合并或单独开窗。

## 3. 触发语义

- **批量触发**（任务页「立即触发」，无 bitbrowserId）：逐启用窗口 enqueue → 额度控制下滚动分批跑完
- **单窗口触发**（看板行级执行/重跑、task:run，带 bitbrowserId）：同样受额度限制，满了排队等释放
- **409 判定不变**：`countInFlightRuns` + `hasTaskInFlight`（含 waiting）覆盖，任务任何窗口在跑/排队即拒绝重复触发
- stagger 错峰（execution.staggerMaxSec，默认 120 秒）继续作用于每个新窗口会话，包括滚动续跑的批次

## 4. API 与前端

- `GET /tasks`（src/server/routes/tasks.ts）返回加 `concurrency: m.concurrency ?? 4`，swagger 注解同步
- 任务卡片（web/src/pages/tasks/index.tsx）展示「并发 N」
- settings 接口/页面删除 concurrency：`PublicSettings`、swagger、`web/src/pages/settings/index.tsx`、`web/src/api/schema.d.ts`（手补）

## 5. 测试

`tests/queue.test.ts` 重写：
- 删 TaskQueue 用例
- CoalescingEnqueuer 换新构造签名
- 新增用例：额度满排队、滚动续跑（会话结束自动接 waiting 队首）、合并保留（同窗口多任务一次开窗）、waiting 判在途、释放调度、缺省额度 4

`tests/config.test.ts`、`tests/web.test.ts`：删 concurrency 断言与 fixture。

## 6. 文档

- `docs/API-GUIDE.md`：TaskMeta 字段表加 `concurrency` 行（缺省 4 语义）；配置表 `execution` 行删 concurrency 描述
- `AGENTS.md`：engine 描述若提并发则同步（任务 = meta 要点行可加 concurrency）

## 迁移清单（实现顺序）

1. `src/engine/task.ts` TaskMeta 加 `concurrency?`
2. `src/engine/queue.ts`：删 TaskQueue，改 CoalescingEnqueuer（gates/waiting/release/构造签名）
3. `src/app.ts`：装配 `taskConcurrencyOf`，删 `new TaskQueue(...)` 行
4. 5 个任务文件写 concurrency
5. `src/infrastructure/config.ts` + `config/config.json` 删全局 concurrency
6. `src/server/routes/tasks.ts` GET 加 concurrency；`src/server/routes/settings.ts` 删 concurrency
7. 前端：tasks 卡片并发展示、settings 页删行、schema.d.ts 手补
8. `package.json` 删 p-queue
9. 测试更新（queue/config/web）
10. 文档更新（API-GUIDE.md、AGENTS.md）
11. 验证：`npm run typecheck` + `npm test`

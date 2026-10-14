# 任务页「测试」手选窗口触发设计（task-page-window-select-trigger）

日期：2026-10-13
状态：已确认（用户确认设计后直接实施）

## 目标

新任务写完后需真机验证，目前面板只有一个全量触发口：任务页「立即触发」会跑**全部启用窗口**，无法只验一两个窗口。为任务卡片新增「测试」入口：用户手选**部分启用窗口**触发该任务，行为与「立即触发」**完全一致**，**唯一区别 = 窗口集合由用户手动选择**。

已确认的关键决策：

- 入口位置：**任务页卡片**「立即触发」旁边的「测试」按钮，弹出窗口多选弹窗。
- 窗口池：**仅启用窗口**（`profile.enabled === 1`），与「立即触发」的窗口池一致。
- 任务开关：**照旧生效**（停用任务不显示测试按钮，直接调 API 返回 409），不做 bypass。
- 执行规则：**严格照真机规则**——随机错峰、全局开窗上限、任务级并发双闸门、在途守卫全部照常生效，**不因测试而放宽**。
- 入队语义：与「立即触发」相同，走 `enqueue` **不带 `immediate`**（因此错峰生效）；区别于看板行级重跑的单窗口 `immediate` 路径。
- 批次：`kind='bulk'`、`source='trigger-test'`，进看板主时间线供追溯。

## 现状（触发入口盘点）

| 入口 | 代码位置 | 窗口范围 | 入队语义 |
| --- | --- | --- | --- |
| 任务页「立即触发」 | `src/server/routes/tasks.ts:196-201` | 全部启用窗口 | `enqueue`（无 immediate → 错峰 + 双闸门） |
| 看板行级「执行/重跑」 | `src/server/routes/tasks.ts:184-193` | 单窗口（`bitbrowserId`） | `enqueue({ immediate: true })`（跳过错峰） |
| `task:run` 脚本 | `scripts/run-task.ts` | 单窗口单任务 | `runner.runManual`（不经队列、不受开关/错峰限制） |

缺口：**新任务没有既有 run 行**，看板点不到；`task:run` 需环境变量 + 独立进程。面板上缺「手选窗口」这一触发入口（后端 `bitbrowserId` 已支持单窗口，但它是 immediate 语义且只服务看板重跑）。

## 方案（扩展 trigger 端点，新增 selected 分支）

### 后端 API：`POST /api/tasks/:key/trigger`

body 三态互斥：

| body 字段 | 分支 | 行为 |
| --- | --- | --- |
| `bitbrowserId` | 现有单窗口 | **不变**（`immediate: true`，看板行级重跑） |
| `profileIds: string[]` | **新增** | 选中窗口批量，`kind='bulk'`/`source='trigger-test'`，`enqueue` 无 immediate |
| 都缺省 | 现有全量 | **不变**（全部启用窗口） |

`profileIds` 分支校验与流程：

1. 任务不存在 → 404 `TASK_NOT_FOUND`；任务停用 → 409 `TASK_DISABLED`（与立即触发一致）。
2. `profileIds` 非数组或空数组 `[]` → 400 `INVALID_ARGUMENT`（禁止空数组等价成全量，避免误触）。
3. 逐个解析 id：不存在 → 404 `PROFILE_NOT_FOUND`；窗口未启用 → 400 `INVALID_ARGUMENT`（点名 id）。
4. 去重（同 id 传多次只入队一次）。
5. 在途守卫：任一选中窗口该任务在途（`countInFlightRuns(key, today, profile.id) > 0` 或 `enqueuer.hasTaskInFlight(key, profile.id)`）→ 409 `TASK_RUNNING`，消息点名在途窗口（整单拒绝，不做部分入队）。
6. 建批次 `createBatch('bulk', key, 'trigger-test')`。
7. 对每个选中窗口 `enqueuer.enqueue(profile, key, { batchId: batch.id })`——**不带 `immediate`**，故错峰 + 全局窗口上限 + 任务并发双闸门全部生效。
8. 返回 `{ scope: 'selected' }`。

swagger 注解同步：requestBody 增 `profileIds`（`type: string[]`），response `scope` 枚举加 `selected`。

### 前端

- `web/src/api/endpoints.ts`：`triggerTask` 扩展为 `triggerTask(key, opts?: { bitbrowserId?: string; profileIds?: string[] })`，body 按传入字段构造；返回类型 `{ scope: 'single' | 'all' | 'selected' }`。**两种调用点同步改**：`dashboard/hooks.ts`（原 `triggerTask(key, bitbrowserId)` 位置参数 → `triggerTask(key, { bitbrowserId })`）与 `tasks/hooks.ts`。
- `web/src/pages/tasks/hooks.ts`：新增 `useTestTask`（沿用 `useTriggerTask` 的 message + invalidate 模式），`mutationFn: ({ key, profileIds }) => triggerTask(key, { profileIds })`。
- `web/src/pages/tasks/index.tsx`：`TaskCard` 在「立即触发」旁加次按钮「测试」（仅 `task.enabled` 时显示），点击打开 `TestWindowModal`。
- 新增 `web/src/pages/tasks/TestWindowModal.tsx`（受控组件：`open`/`onCancel`/`onSubmit`）：
  - 用 react-query 拉 `fetchProfiles`，过滤 `enabled === 1`；
  - 展示「序号/名称/ID 前 8 位/是否已打开」，多选；
  - 至少选 1 个才允许确认；确认后 submit 并进入 loading；
  - 无启用窗口时给出空态文案。
- 测试成功后 invalidate `['tasks']`（与现有 hook 一致）。

### 批次 / 看板

- 测试批次 `kind='bulk'` → 出现在看板主时间线（`splitBatches` 只把 `single` 抽进散批折叠卡）。
- `source='trigger-test'` 仅落库追溯；本次**不改**看板 UI 展示来源标签（保持最小改动）。

## 改动清单

1. `src/server/routes/tasks.ts`：`trigger` 路由新增 `profileIds` 分支 + swagger 注解。
2. `web/src/api/endpoints.ts`：`triggerTask` 签名扩展。
3. `web/src/pages/dashboard/hooks.ts`：调用点随签名改为 opts 对象。
4. `web/src/pages/tasks/hooks.ts`：新增 `useTestTask`。
5. `web/src/pages/tasks/index.tsx`：卡片加「测试」按钮。
6. `web/src/pages/tasks/TestWindowModal.tsx`：新增窗口多选弹窗组件。
7. `web/src/api/schema.d.ts`：手补 trigger requestBody `profileIds`、`scope` 枚举（项目先例手补类型）。
8. `docs/API-GUIDE.md`：8.3 trigger 行补 `profileIds` / `scope=selected`；8.2 任务页说明补「测试」按钮。

## 边界与权衡

- 空数组判 400：避免「忘选窗口」被解释成全量触发。
- 在途整单拒绝（而非跳过在途窗口）：语义简单、可预期；前端按钮已带在途禁用态，正常不会撞上。
- 不做 bypass：测试与线上执行同规则，既满足「唯一区别=选窗口」，也避免测试路径跑出与真实执行不同的结果。
- 单窗口选择同样走错峰：与「立即触发」保持一致（用户明确要求严格执行真机规则，接受最大 `staggerMaxSec` 的启动延迟）。
- 与既有入口共享在途守卫：测试在跑时，该任务「立即触发」/定时触发同样 409（天然一致）。

## 明确不做

- 不做独立 `/test` 端点（复用 trigger，最小改动面）。
- 不做 bypass 开关/并发放宽/跳过错峰的测试快捷路径。
- 不改看板来源标签展示、不改 task:run 脚本、不改队列与 runner。
- 不在弹窗内选择停用窗口（窗口池与「立即触发」一致，仅启用窗口）。

## 验证计划

- `npm run typecheck`、`npm test`、`npm run test:web` 全绿。
- 后端路由单测（mock db/enqueuer）：
  - `profileIds` 分支对每个窗口 `enqueue` **不带** `immediate`、批次 `source='trigger-test'`、返回 `scope='selected'`；
  - 空数组 400、未知 id 404、未启用窗口 400、在途 409、任务停用 409；
  - 既有 `bitbrowserId` 与全量分支行为回归不变。
- 前端 hooks 单测：启用窗口过滤、至少选一个校验、提交 payload 正确。
- 手动真机：任务页对某新任务点「测试」→ 选 1~2 个启用窗口 → 确认后仅这些窗口开窗执行，日志/看板可见对应批次；「立即触发」与看板重跑行为不变。

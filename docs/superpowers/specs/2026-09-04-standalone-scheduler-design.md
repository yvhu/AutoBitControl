# 独立定时任务子系统设计

日期：2026-09-04
状态：已确认（用户确认后进入实现计划）

## 背景与目标

项目此前（2026-09-03）删除了基于 croner 的调度器，改为纯手动触发。本次新建一个**完全独立、解耦的定时任务子系统**：

1. 计划（schedule）是一等公民：一份时间配置 + 一组任务，与任务代码完全解耦
2. 面板新增「定时任务」栏目，结构化表单配置：先选频率模式、填时间参数、再选任务
3. 支持四种频率模式：每 N 小时 / 每日多时间点 / 每周周几 / 每月哪几天
4. 不引入任何新 npm 依赖（含 cron 库、时区库）

## 关键决策（与用户逐条确认）

| 决策点 | 结论 |
|---|---|
| 触发范围 | 到点对**全部启用窗口**入队（与任务页「立即触发」同构，沿用全局错峰） |
| 计划内任务数 | 一个计划可多任务，到点**同一时间点一起触发** |
| 时区 | 固定时区，`config.json` 配置项 `scheduler.timezone`，默认 `Asia/Shanghai` |
| 错过触发 | **跳过不补跑**（进程不在即错过，无锚点持久化） |
| 在途冲突 | 任务已有在途运行（手动触发/重试/其它计划）则**跳过该任务**并记日志 |
| 配置方式 | 结构化表单（非 cron 表达式），模式切换动态渲染参数 |
| 调度引擎 | **自研 tick 调度器**，不引入 cron 库 |

## 架构与模块边界

```
tasks → engine → {integrations, automation} → infrastructure
server → {engine, infrastructure}
```

新增 `src/engine/scheduler.ts`（Scheduler 类）——依赖 db、enqueuer、logger、config、任务注册表，**不依赖 tasks 层代码**。`src/app.ts` 在 enqueuer 装配后创建 Scheduler 并 start（约 app.ts:181 之后、createApp 之前），优雅退出时 stop。

## 数据模型

新表 `schedules`（走 SCHEMA 数组，`CREATE TABLE IF NOT EXISTS` 幂等建表）：

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL,            -- 'interval' | 'daily' | 'weekly' | 'monthly'
  config TEXT NOT NULL,          -- JSON，按模式不同
  task_keys TEXT NOT NULL,       -- JSON 数组，任务 key 列表
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

`config` JSON 四种形态：

- interval：`{ "everyHours": 6 }` — 自 00:00 起每 6 小时（06:00/12:00/18:00；00:00 不触发）
- daily：`{ "times": ["09:00", "15:00"] }` — 每日多个时间点
- weekly：`{ "weekdays": [1,3,5], "times": ["09:00"] }` — 星期（1=周一）+ 时间点
- monthly：`{ "days": [1,15], "times": ["09:00"] }` — 每月哪几天 + 时间点；小月无该日（如 31 号）自然跳过

任务关联用 JSON 数组而非关联表：规模小、整单读取，任务 key 失效时引擎侧跳过并告警即可，无需级联清理。

**触发批次**：复用 `batches` 表，`kind` 增加 `'schedule'` 值（TEXT 列，无 schema 变更），`source` 记 `计划#id name`，看板天然可见。

## 与现有系统的交互（共用状态，设计使然）

定时触发与手动触发共享 run 行、批次、在途守卫与熔断计数，行为互通但不互相破坏：

1. **run 行/批次完全兼容**：定时触发走与手动相同的 `upsertRun`（`ON CONFLICT DO UPDATE`，db.ts:323）与 slot 分配（`nextRunSlot` = 当日 MAX+1，db.ts:422）。同一任务同一天手动跑 slot 0、定时再跑即 slot 1，唯一键 `(profile_id, task_key, date, slot)` 不会撞；看板该任务一天多行（按 slot），批次列表多一个 `kind='schedule'` 批次。
2. **在途守卫互相「挡」**：手动「立即触发」的 409 守卫把 pending/running/retry_wait 都算在途（db.ts:434）——定时运行期间手动触发该任务会 409；反向定时到点发现任务在途则跳过并记日志（见触发流程第 3 步）。极端竞态（几乎同秒）时双方都过守卫入队，由队列窗口级合并合成一次运行。
3. **熔断计数共用**：定时任务的终态失败同样 `incrCircuitBreaker`（window-runner.ts:341），连续 2 次失败触发当日窗口熔断，之后该窗口所有任务（含手动）skipped，需在窗口页手动重置熔断；反向同理。语义统一，不区分触发来源。

## 调度引擎行为

### 时区处理

不引入时区库。用 `Intl.DateTimeFormat('en-CA', { timeZone, ... })` + `formatToParts` 读取配置时区的墙上时钟（年/月/日/星期/时/分）。所有「是否到点」判断在墙上时钟上做匹配，不涉及 epoch 换算，DST 无影响。

### Scheduler 类

- `start()`：`setInterval` 每 15 秒 tick；`stop()` 清除。
- 每次 tick：读全部启用计划 → 模式匹配：
  - interval：`minuteOfDay > 0 && minuteOfDay % (N*60) === 0`（午夜对齐，排除 00:00）
  - daily：当前 `HH:mm` ∈ times
  - weekly：当前星期 ∈ weekdays 且 `HH:mm` ∈ times
  - monthly：当前日 ∈ days 且 `HH:mm` ∈ times
- **每分钟去重**：内存 `Map<scheduleId, "YYYY-MM-DD HH:mm">`，同一分钟最多触发一次（tick 15s × 4 不重复）。
- **错过即跳过**：无锚点持久化。重启后从 DB 读计划、从当前时间判断，过去时刻自然不匹配。
- 计划级异常不抛出、不打断其它计划，只记日志。
- 去重 Map 为内存态：重启后若同一分钟仍匹配则可能再触发一次，由队列的窗口级合并与在途守卫兜底，接受该小概率重复。

### 触发流程（fire）

对计划内每个 taskKey：

1. key 不在任务注册表 → 告警日志，跳过
2. `meta.enabled === false` → 告警日志，跳过（与手动触发 409 语义一致）
3. 在途守卫：`db.countInFlightRuns(taskKey) > 0 || enqueuer.hasTaskInFlight(taskKey)` → 日志「跳过（在途）」
4. `db.createBatch('schedule', taskKey, '计划#id name')` → 遍历 `db.listProfiles(true)` → `enqueuer.enqueue(p, taskKey, { batchId })`（不传 immediate，沿用全局错峰 `execution.staggerMaxSec`）

### 下次执行计算（纯函数 `nextRunText`）

- interval：当天最近的下一个午夜对齐点（候选为 N、2N、… 不超过 24h，**排除 00:00**），已过当天最后一个点则明天第一个点
- daily：今天剩余 times 中最早，否则明天第一个
- weekly：扫描未来 7 天第一个匹配 weekday+time
- monthly：扫描未来 32 天第一个匹配 day+time（小月无该日自动落到下月）

输出墙上时间字符串（「今天 15:00 / 明天 09:00 / 周三 09:30 / 9月15日 10:30」），纯函数可单测。

## 配置

`config/config.json` 增加：

```json
"scheduler": { "timezone": "Asia/Shanghai" }
```

`src/infrastructure/config.ts`：`AppConfig` 接口加 `scheduler: { timezone: string }`，defaults 为 `Asia/Shanghai`。

## API 设计

新增 `src/server/routes/schedules.ts`，统一 `{code,message,data}` 响应、@swagger 注解（`src/server/openapi.ts` 自动汇总）。`ServerDeps` 增加 `scheduler` 注入。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/schedules` | 计划列表（含模式摘要、任务名、下次执行文本） |
| POST | `/api/schedules` | 新建；校验失败 400 |
| PATCH | `/api/schedules/:id` | 改名称/开关/配置/任务列表；不存在 404 |
| DELETE | `/api/schedules/:id` | 删除；不存在 404 |
| POST | `/api/schedules/:id/run` | 「立即运行一次」：跳过时间判断直接走 fire（仍受在途守卫与停用校验） |

校验规则：times 为 `HH:mm` 列表（00:00–23:59、非空）；weekdays ⊆ 1–7 非空；days ⊆ 1–31 非空；everyHours ∈ 1–23；task_keys 非空且全部存在于任务注册表。

## 前端设计

新增 `web/src/pages/schedules/`，路由 `/schedules`，导航菜单新增「定时任务」（介于「任务」与「设置」之间）：

- 页面：计划列表——名称、触发规则摘要（模式徽标 + 规则文本）、下次执行、关联任务 Tag、启用开关、操作列（立即运行/编辑/删除）
- 弹窗表单（交互顺序：**先选模式 → 动态参数 → 选任务**）：
  - interval：InputNumber 小时数（1–23），显示「每天执行时刻」预览
  - daily：Form.List + TimePicker 多时间点
  - weekly：Select multiple 星期（一~日）+ TimePicker 时间点
  - monthly：Select multiple 几号（1–31）+ TimePicker 时间点
  - 最后：任务多选（数据来自 `/api/tasks`）
- `hooks.ts`（react-query，列表轮询 + CRUD mutation）配 `hooks.test.ts`
- `web/src/api/endpoints.ts` 增 5 个函数；`web/src/api/schema.d.ts` 按项目先例手补类型
- 看板 batches 列表：`kind='schedule'` 显示「定时」徽标

UI 已通过可视化伴侣原型确认（`.superpowers/brainstorm/20260904-schedules-ui/`，交互原型：四种模式切换、时间点增删、任务多选、立即运行/编辑/删除）。

## 测试策略

- `tests/scheduler.test.ts`：四种模式时间匹配（注入假时钟）、每分钟去重、停用计划跳过、任务 key 失效跳过、`meta.enabled=false` 跳过、在途守卫跳过、正常触发路径（假 db/enqueuer，断言 `createBatch('schedule')` 与逐窗口 enqueue 不带 immediate）
- `tests/next-run.test.ts`：`nextRunText` 纯函数各模式边界（跨天、跨周、月末 31 号小月跳过、interval 午夜对齐）
- `tests/web.test.ts` 增补：schedules CRUD 用例（400 校验/404/成功路径/`/run` 立即运行）
- `web/src/pages/schedules/hooks.test.ts`：前端 hooks

## 文档更新

- `docs/API-GUIDE.md`：新增「定时任务」章节（数据模型、四种模式语义、跳过规则、API 列表）；更新「系统无定时调度」旧描述
- `AGENTS.md`：分层架构补 scheduler；任务触发描述补定时入口

## 明确不做（YAGNI）

- 不做秒级精度（分钟级足够）、不做错过补跑、不做 cron 表达式输入、不做计划间依赖/串联
- 不做窗口子集选择、不做计划级错峰覆盖（沿用全局 `staggerMaxSec`）
- 不引入任何新 npm 依赖（含时区库、cron 库）
- 不动现有任务触发路径、重试机制、队列、WindowRunner 主流程
- 旧 `task_fired_at` 残留表数据不动（无害）

## 验证计划

- `npm run typecheck`、`npm test`、`npm run test:web` 全过
- 手动：面板新建/编辑/删除/开关/立即运行可用；到点自动触发（可用「立即运行」验证触发链路）；任务在途时定时触发跳过并记日志；停用任务被计划引用时跳过告警；重启后计划从 DB 恢复

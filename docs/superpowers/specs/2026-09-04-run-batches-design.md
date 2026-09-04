# 看板「运行批次」视图设计

日期：2026-09-04
状态：设计已确认（含在线 UI 原型），待实施

## 背景

看板目前以「日期」为唯一维度：`runs` 表行键 =（窗口, 任务, 日期, slot），页面顶部日期选择器 + 按
(窗口, 任务) 折叠（最新轮置顶、历史轮次藏进展开区）。实际使用模式是**逐任务手动触发**（任务页
「立即触发」跑完一个再跑下一个），偶尔在看板单窗口「执行/重跑」个别失败窗口。以日期为维度时：

- 一天多次触发全部混在「今天」一个视图里，看不出「某一次触发」的整体结果
- 重跑产生的轮次被压进 slot 历史，无法横向对比「哪轮跑得如何」
- 顶部「今日完成率/结果分布/验证码/实时运行」四张卡与折叠表格口径纠缠

## 目标

把「一次触发动作」提升为看板的一级维度（**运行批次**）：每次触发 = 一个新批次，看板以批次时间线
展示，每批自带完成率/状态分布/打码成本，可展开查看窗口明细。日期降级为时间段筛选（今天/近 7 天/全部）。

## 核心概念

- **批次（batch）**：一次触发动作产生的整批运行记录。批量触发（任务页「立即触发」）= `bulk`；
  单窗口执行/重跑（看板行级、task:run 脚本）= `single`
- **批次界定**：按触发动作划分，不按时间窗聚合。错峰开窗（staggerMaxSec 120s）不影响归属——
  批次创建于触发时刻，错峰中的窗口仍属该批次
- **重试不产生新批次**：retry_wait 重试、重启恢复、崩溃残留重入队都是同一 run 行续跑，
  沿用原批次

## 设计

### 1. 数据模型

新增 `batches` 表（每次触发动作一行）：

```sql
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'bulk'（批量全部窗口）| 'single'（单窗口）
  task_key TEXT NOT NULL,          -- 触发的是哪个任务
  source TEXT NOT NULL,            -- 'trigger-all' | 'trigger-single' | 'task-run'
  created_at TEXT NOT NULL         -- 本地墙钟时间（localWallNow 口径）
)
```

`runs` 表加列：`ALTER TABLE runs ADD COLUMN batch_id INTEGER`。**不参与 UNIQUE 约束**，原
`(profile_id, task_key, date, slot)` 唯一键原封不动——slot 管「当天第几轮」（重试续跑），batch_id
管「哪次触发」，两维度正交。加列不重建表（上次加 slot 重建表是因为唯一键变更，本次无此问题）。
老数据 `batch_id IS NULL`，前端归入「未分批」聚合行。

索引：`batches(created_at)`（时间区间筛选）、`runs(batch_id)`（批次明细查询）各建一个。

一致性兜底：同一 (窗口,任务) 不会同时出现在两个批次——批量触发有 in-flight 守卫（409），
队列内有同窗口同任务去重。

### 2. 批次创建与透传链路

- **任务页「立即触发」**（`POST /tasks/:key/trigger` 无 bitbrowserId）：创建 `bulk` 批次 →
  每个启用窗口 `enqueue(p, key, { batchId })`
- **看板行级「执行/重跑」**：创建 `single` 批次 → `enqueue` 单窗口
- **task:run 脚本**：创建 `single` 批次 → 直接 `runManual`
- **透传**：`queue.ts` 的 `Entry` 从 `taskKeys: Set<string>` 改为 `tasks: Array<{ taskKey, batchId }>`
  （同窗口合并区会混入不同批次的任务，必须逐任务携带）→ `runWindowTasks(profile, tasks)` →
  `upsertRun` 的 patch 加 `batchId`
- **重试归原批次**：scheduleRetry / retry-recovery / 崩溃恢复的 enqueue 不带 batchId；window-runner
  落库时「续跑行沿用 existing.batchId，新轮次才写入会话传入的 batchId」——upsertRun 的 ON CONFLICT
  更新分支里 batch_id 用 COALESCE 保留已有值（与 started_at 同思路）

### 3. 后端 API

替换 `GET /api/dashboard`（前端仅看板页使用，直接换代不留双份）：

| 接口 | 用途 |
|---|---|
| `GET /api/batches?range=today\|7d\|all` | 批次列表：每批 `{id, kind, taskKey, createdAt, stats}`（聚合计数，不含窗口明细，轻量供 15s 轮询）+ 全局数字 `{running, captchaToday}` |
| `GET /api/batches/:id` | 批次明细：该批 runs 行列表（窗口/开始/结束/耗时/状态/错误/截图 + inFlight），展开时懒加载 |

- 「实时运行」= 全局 in-flight（runs 非终态行 + enqueuer 在途窗口）
- 「今日打码」复用 `captchaStats(todayStr())`
- swagger 注解同步更新；前端 `schema.d.ts` 手补类型

### 4. 前端重构（web/src/pages/dashboard）

- `index.tsx` 重写为批次时间线：
  - 筛选行：今天/近 7 天/全部 + 右上角两个全局数字（⚡实时运行、💴今日打码）
  - `BatchCard` 列表：时间 + 类型标（批量·全部窗口/单窗口）+ 任务名 + 完成率进度条 +
    状态分布 tags + 打码成本；最新批默认展开窗口明细（窗口/开始/耗时/状态/错误/操作），
    历史批折叠
  - 底部「单窗口散批 ×N」虚线卡（区间内聚合，展开列出各散批明细）
  - `batch_id IS NULL` 的历史 run 归入「未分批」聚合行（仅查询范围内存在时显示）
- `groupRuns.ts` 废弃，新写 `groupBatches.ts` 纯函数（时间倒序、散批聚合、批次 stats）+ 配套单测
- 展开明细懒加载（`useBatchDetail`）；15s 轮询只刷列表接口
- **移除**：日期选择器、状态筛选、任务筛选、窗口搜索、顶部四张统计卡（信息已下沉到批次卡片）

### 5. 边界情况

- **跨日批次**：按 `created_at` 归属日期，时间线按创建时刻倒序（不看 run 的 date）
- **进行中批次**：批量触发即刻建批，错峰开窗期间的 run 显示「待执行」
- **散批**：kind=single 的批次全部折叠进聚合行；重跑产生的 run 落在新的 single 批次，
  不再压进 slot 历史

### 6. 测试

- db：batches CRUD + runs 写入/沿用 batch_id（新轮次写入、续跑沿用）
- queue：Entry 结构改动后的合并/去重/额度释放
- window-runner：batchId 透传与沿用逻辑
- 前端：groupBatches 纯函数单测
- 路由：batches 列表/详情接口

## 范围外

- 不改调度/重试/slot 语义与状态机
- 不做批次命名、手动合并批次、删除批次等管理功能（YAGNI）
- profiles 页、任务页不变（任务页触发入口仅增加批次创建）

## 验证

- `npm run typecheck` + `npm test` + `npm run test:web`

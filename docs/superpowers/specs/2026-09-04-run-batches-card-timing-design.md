# 批次卡增强：结束时间、总耗时与重试中计数设计

日期：2026-09-04
状态：设计已确认，待实施

## 背景

看板批次时间线（2026-09-04-run-batches-design）已上线：每批卡片显示触发时间、任务名、完成率、
状态分布（成功/失败/验证码/进行中/待执行）。用户反馈两个缺口：

1. 卡片无「结束时间/总耗时」，无法感知批次何时跑完、跑了多久
2. 「进行中」把 running 与 retry_wait 混在一起，看不到重试等待中的数量

## 目标

- 批次卡片显示结束时间与总耗时（进行中的批次显示「进行中」）
- 状态分布拆分出独立的「重试中」计数

## 设计

### 1. 数据层（只读聚合，零执行链路改动）

`BatchStats` 增加 `retryWait: number`；`listBatchesForRange` 聚合拆分：
`running` 只计 running 状态，`retry_wait` 单独计入 `retryWait`。

聚合 SQL 增加 `MAX(r.finished_at) AS lastFinishedAt`（批次最后落库时刻，类型 `string | null`），
批次返回类型加 `lastFinishedAt: string | null`。

### 2. 前端展示

- schema.d.ts 手补：批次项 `lastFinishedAt?: string | null`、`stats.retryWait?: number`
- `groupBatches.ts` 新增纯函数：

  ```ts
  /** 批次时间信息：终态判定 + 总耗时（秒）；未完成返回 null */
  export function batchTiming(batch: BatchItem): { finished: boolean; durationSec: number | null }
  ```

  - `finished` = running + pending + retryWait 全为 0
  - `durationSec` = finished 且 lastFinishedAt 存在时（lastFinishedAt − createdAt）/ 1000 取整，否则 null
- `BatchCard`：
  - 状态 tags 增加「重试中 N」（金色）
  - 标题行右侧：已完成显示「HH:mm 结束 · 耗时 Xm Ys」（复用 formatDuration）；未完成显示「进行中」

### 3. 口径

- 重试中（retry_wait）不算完成、不算执行中，独立计数与展示
- 总耗时 = 最后落库时刻 − 批次创建时刻，含错峰排队时间（批次真实生命周期）
- 完成率 done 口径不变（retry_wait 仍非终态）

## 测试

- db.test.ts：聚合用例补 `retryWait` 与 `lastFinishedAt` 断言（含多状态混合批次、未完成批次 lastFinishedAt 非空——有 retry_wait 行时其 finished_at 参与 MAX）
- groupBatches.test.ts：batchTiming 用例——终态批次算耗时、进行中/重试中返回 null、无 lastFinishedAt 返回 null

## 范围外

- 不改执行链路（触发/队列/window-runner/落库）
- 不显示批次内单窗口明细的耗时（已有）
- 不做批次级平均耗时等聚合指标（YAGNI）

## 验证

- `npm run typecheck` + `npm test` + `npm run test:web`

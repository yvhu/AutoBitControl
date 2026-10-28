# 批次重跑归属原批次设计

日期：2026-10-28
状态：设计已确认（所有重跑/执行写回原批次；批次状态按窗口最新一轮统计；批次按最近活动时间归属）

## 背景与问题

看板当前有两套重跑入口，行为不一致：

1. 批次卡片头「重跑失败 N」：`canRerunFailed` 写死 `kind === 'bulk'`，定时批次（`schedule`）与单窗口批次（`single`）即使有失败也永远不显示。实际使用的定时批次没有任何批次级重跑入口。
2. 明细行「重跑/执行」：走 `POST /api/tasks/:key/trigger` 的 `bitbrowserId` 分支，固定创建新的 `single` 批次，于是重跑结果落到「单窗口散批」，与用户“重跑当前批次失败窗口”的预期割裂。

2026-10-17 的设计文档只覆盖了 `bulk` 批次，且明确“不改 slot/批次归属规则”，因此 `schedule` 的缺失属范围遗漏，不是设计意图。本次重新梳理全部重跑逻辑。

## 目标

1. 任意 `kind`（`bulk` / `schedule` / `single`）的批次，只要存在失败窗口，就显示「重跑失败 N」。
2. 批次头批量重跑、明细行单窗口重跑、明细行「执行」，全部写回**当前批次**，不再新建批次。
3. 批次统计、完成率、失败数、耗时都按“每个窗口的最新一轮”计算，重跑成功后原失败状态自动被替代。
4. 保留历史失败轮次及其截图/诊断证据，不覆盖原 run 行。

## 非目标

- 不改 `runs` 唯一键与 slot 语义，不覆盖旧 run 行。
- 不做跨批次/跨任务的「重跑今日失败」全局入口。
- 不自动重置熔断、不自动启用停用窗口。
- 不改 `skipped` 语义：手动停止、窗口超时、熔断跳过不计为失败。
- 不做批次合并、删除、重命名。

## 术语与口径

- **最新轮次**：同一批次内、同一窗口的 run 行中 `runs.id` 最大的一行。
  - **不能用 `slot` 判断**：`slot` 按 `(窗口, 任务, 日期)` 计算，跨日重跑会从 0 重新开始，用 `slot` 会误选旧行。
- **批次活动时间**：`max(batches.created_at, 该批次所有 run 的 queued_at)`，用于时间线归属与排序。
- **失败数 N**：批次内按窗口去重后，最新轮次状态为 `failed` / `captcha_failed` 的窗口数。

## 数据与统计口径

`runs` 保持追加式：

- 重跑通过 `enqueueRun` 新建一轮（同日期递增 slot；跨日从 0 开始），`batch_id` 写回原批次。
- 原失败行、错误、截图、诊断目录保持不变。
- 重试（`retry_wait` → 重新入队）仍沿用原 slot 与原 `batch_id`。

批次统计（`listBatchesForRange`）改为只看最新轮次：

```sql
FROM batches b
LEFT JOIN runs r ON r.batch_id = b.id
  AND r.id = (
    SELECT MAX(r2.id) FROM runs r2
    WHERE r2.batch_id = b.id AND r2.profile_id = r.profile_id
  )
GROUP BY b.id, r.status
```

- `stats.total` = 该批次不同窗口数（100 个窗口重跑 3 个仍是 100）。
- `stats.success/failed/captchaFailed/skipped/running/retryWait/pending` = 最新轮次状态计数。
- `lastFinishedAt` = 最新轮次中的最大 `finished_at`。
- `lastActivityAt` = `COALESCE(MAX(r.queued_at), b.created_at)`（新增返回字段）。
- 时间范围过滤与排序都改用 `lastActivityAt`。实现用 CTE/相关子查询**按批次**算出活动时间后再过滤：

```sql
WHERE date(COALESCE((SELECT MAX(r3.queued_at) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at))
        >= COALESCE(date(?), '0000-01-01')
  AND date(COALESCE((SELECT MAX(r3.queued_at) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at))
        <= date(?)
ORDER BY COALESCE((SELECT MAX(r3.queued_at) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at) DESC,
         b.id DESC
```

注意：活动时间必须按批次计算，**不能写进按 `status` 分组的 `HAVING`**——不同状态分组各自的最大 `queued_at` 不同，会把旧的失败分组过滤掉，导致统计失真。

这样昨天的批次今天重跑后会回到今天的时间线顶部，而不是消失。

历史数据清理（`cleanupOld`）的批次删除口径同步改为“批次活动时间”，避免重跑过的新活动批次仍按创建时间被提前清理；`runs` 仍按 `runs.date` 清理。

## 后端设计

### 1. `GET /api/batches`

- 统计口径按上节。
- 每项新增 `lastActivityAt`（字符串，与 `createdAt` 同格式）。
- `range` 过滤与排序按 `lastActivityAt`。

### 2. `GET /api/batches/{id}`

- 仍返回该批次全部 run 行，按窗口、`id` 升序。
- 每行新增 `isLatest`：同一窗口在批次内 `id` 最大的一行为 `true`。
- 行级 `inFlight`、`durationSec` 逻辑不变。

### 3. `GET /api/batches/{id}/rerun-candidates`

- 候选来源改为“每个窗口在批次内的最新轮次”，且最新轮次为 `failed` / `captcha_failed`。
- `runId` 为最新轮次的行 id。
- 今天最新一轮已成功的标记（`alreadySuccess`）、停用/熔断/在途阻塞、默认勾选规则保持不变。

### 4. `POST /api/batches/{id}/rerun`（新路径，`/rerun-failed` 保留为别名）

语义：按勾选窗口在**原批次**追加新一轮，必须执行，不再按“今天已成功”跳过。

请求：`{ "runIds": number[] }`。

校验：

- `runIds` 非空、去重、正整数。
- 每个 runId 必须属于该批次。
- runId 必须是其窗口在批次内的**最新轮次**；否则 400「该窗口已有更新轮次，请刷新后重试」。
- 最新轮次可以是任意非在途状态：失败、成功、跳过都允许（支持行级「执行」）。批次头弹窗仍只展示失败窗口。
- 窗口不存在 / 停用 / 熔断中 / 在途：整单 400 并列出窗口，保持 all-or-nothing。
- 任务未注册 404；任务停用 409。

执行：

- **不创建新批次**，直接 `enqueue(profile, batch.taskKey, { batchId: batch.id, notBeforeMs: Date.now() })`。
- **不传 `skipIfSuccess`**（默认 false）：用户勾选即执行，修复现有“弹窗承诺强跑、后端却跳过”的不一致。
- 响应 `{ batchId, queued }`，`queued` 为真实入队窗口数。

`/rerun-failed` 作为别名保留（同一处理器），Swagger 标记 deprecated，避免部署瞬间旧页面调用 404。

### 5. `RunEnqueuer.enqueue` 返回真实入队结果

`enqueue` 返回类型由 `Promise<void>` 改为 `Promise<boolean>`：

- `true`：已写 pending / 已提升为可执行行。
- `false`：该窗口已在运行，或 `skipIfSuccess` 命中当天成功而跳过，本次未入队。

`WindowPoolScheduler.enqueue` 在 `row.status === 'running'` 时返回 false；其余成功路径返回 true。`SchedulerDeps.enqueuer.enqueue` 的返回类型同步改为 `Promise<boolean>`；调度器与任务触发路由忽略返回值即可，`rerun` 用它统计真实 `queued`。

### 6. 行级入口路由

- 明细行有 `batchId`：`POST /api/batches/{batchId}/rerun`，body `{ runIds: [run.id] }`。
- 未分批历史（`batchId` 为空）：保留现有 `POST /api/tasks/:key/trigger` 单窗口路径（旧数据无批次可归属）。

## 前端设计

### 批次卡片

- `canRerunFailed` 去掉 `kind === 'bulk'` 限制：`stats.failed + stats.captchaFailed > 0` 即可。
- 按钮文案与弹窗不变；统计已是“最新轮次”口径，重跑成功后 N 自动减少/消失。
- 时间标题显示 `createdAt`；若 `lastActivityAt` 与 `createdAt` 不在同一天/不同时刻，追加灰色小字「最近活动 HH:mm」。
- `source === 'rerun-failed'` 的旧批次继续显示「批量 · 重跑失败」标签；新重跑不再产生该来源。

### 批次明细

- 默认只显示每个窗口的最新轮次。
- 提供「显示历史轮次 N」开关；打开后按窗口列出全部轮次，历史行标注「历史轮次」及 slot。
- 操作列只对最新行显示「停止 / 重跑 / 执行」；历史行保留「截图」「诊断」，不显示执行类操作。
- `isLatest` 由后端返回，前端不自行推断。

### 缓存刷新

重跑成功后失效 `['batches']`、`['batchDetail', batchId]`、`['rerunCandidates', batchId]`，与现有触发/停止一致。

## 边界与一致性

- 预览与执行之间状态变化：runId 不再是最新轮次 → 400，由用户刷新重试；在途/停用/熔断 → 整单 400。
- 跨日重跑：run 的 `date` 为今天，`batch_id` 为原批次，批次因活动时间回到今天列表。
- 同一窗口同批次可有多轮；截图目录 `slot-<slot>` 按日期+slot 隔离，互不覆盖。
- 批次「停止」仍只结算批次内在途/排队行，历史轮次不受影响。
- 批次完成率不会超过 100%，失败按钮不会因历史失败行残留。
- 老库无需迁移：`batches` 表结构不变，`runs` 仍按唯一键追加。

## 测试

- `tests/db.test.ts`：
  - 同批次多轮时统计只取每窗口最新轮次。
  - 跨日重跑 slot 归零后仍按 `id` 选中新轮次。
  - `lastActivityAt` 与范围过滤/排序（昨天批次今天重跑回到今天）。
  - `cleanupOld` 按活动时间保留重跑过的旧批次。
- `tests/web.test.ts`：
  - `/rerun` 不新建批次、批量写回、`skipIfSuccess` 不生效（已成功窗口仍入队）。
  - runId 不属于批次 / 不是最新轮次 → 400。
  - 停用/熔断/在途 → 400；任务停用 → 409。
  - `queued` 为真实入队数。
  - `/rerun-failed` 别名可用。
- `web/src/pages/dashboard/groupBatches.test.ts`：
  - `schedule` / `single` 批次有失败时显示重跑按钮。
  - 无失败时不显示。
- 前端组件测试：
  - 明细默认只渲染最新行，历史轮次折叠可展开。
  - 历史行无操作按钮；最新行重跑调用 `/rerun`。
- `tests/window-pool.test.ts` / `tests/run-enqueuer.test.ts`：`enqueue` 返回布尔值。

## 文档同步

- `docs/API-GUIDE.md`：
  - 批次统计口径改为“每窗口最新一轮”。
  - 看板批次使用说明：重跑失败按钮对所有批次类型可见、行级重跑归属原批次、历史轮次折叠。
  - 接口说明：`POST /api/batches/{id}/rerun`（含 `runIds`、all-or-nothing、真实 `queued`）；`/rerun-failed` 标注旧别名。
  - 时间线口径：批次按最近活动时间归属。
- `AGENTS.md`：更新 `rerun-failed` 相关描述（不再新建批次、不再带 `skipIfSuccess`）。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run test:web`
- 手动：对定时批次点「重跑失败」，确认弹窗候选为最新失败窗口；重跑成功后原批次 N 递减、明细出现新轮次、历史轮次可展开；跨日批次重跑后回到今天列表。

# 看板批次「重跑失败」设计

日期：2026-10-17
状态：设计已确认（批次内重跑失败；先预览检查最后成功，弹窗二次勾选；已成功默认不勾，用户勾选后强制执行）

## 背景

看板按运行批次展示，批次卡片只能展开看窗口明细、停止在途批次，失败窗口只能逐行点「重跑」。
用户需要在一个批次内把失败窗口一次性重新入队，并且：
- 先检查该窗口该任务今天最后一轮是否已经成功；
- 在弹窗里展示检查结果，由用户二次勾选；
- 已成功的窗口默认不勾选，但用户可以手动勾选并强制执行；
- 用户确认勾选的窗口必须执行，后端不能再用「已有后续成功」等规则静默跳过。

当前可复用能力：

- 后端 `POST /api/tasks/:key/trigger` 已支持 `profileIds` 批量入队，但它没有批次预览/勾选语义。
- 批次固定对应一个任务（`batches.task_key`），失败数已在 `GET /api/batches` 的 `stats` 中聚合。
- 队列 `enqueue` 自带同窗口合并、错峰、全局窗口上限与任务级并发双闸门；窗口在途时入队会转入
  followUp，等当前会话结束后自动执行。

## 目标

1. 批次卡片（`kind=bulk`）提供「重跑失败 N」（N = `stats.failed + stats.captchaFailed`）。
2. 点击后先请求预览接口，弹窗列出该批次全部失败窗口及检查结果。
3. 弹窗支持勾选：
   - 今天最新一轮已 `success`：默认不勾选，但可手动勾选强跑；
   - 窗口停用/熔断/profile 不存在：展示原因，不可勾选；
   - 在途窗口：展示「执行中」原因，不可勾选、默认不勾；
   - 其余失败窗口：默认勾选。
4. 用户确认后，后端对勾选窗口逐个入队，**不再按「已有后续成功」跳过**；确认即执行。
5. 新建批次、走错峰与双闸门，保持批量触发语义；无勾选时不允许提交。

## 非目标

- 不做跨批次/跨任务的「重跑今日失败」全局按钮。
- 不做表格勾选多选重跑（入口固定在批次卡片）。
- 不改 `skipped` 语义：手动停止、窗口超时、熔断跳过都不算失败，不纳入候选。
- 不自动重置熔断、不自动启用停用窗口。
- 不改队列、窗口执行器、slot/批次归属规则。

## 后端设计

### 接口 1：预览候选

`GET /api/batches/:id/rerun-candidates`

- 校验批次存在（40405）；任务不存在 404（40401）；任务已停用 409（40901），与手动触发守卫一致。
- 响应 `data`：

```json
{
  "batchId": 12,
  "taskKey": "dac-checkin-mainnet",
  "candidates": [
    {
      "runId": 345,
      "profileId": 8,
      "profileName": "窗口 8",
      "bitbrowserId": "bb-xxx",
      "status": "failed",
      "error": "timeout ...",
      "finishedAt": "2026-10-17 10:12:03",
      "latestStatus": "success",
      "latestFinishedAt": "2026-10-17 11:20:10",
      "alreadySuccess": true,
      "inFlight": false,
      "selectable": true,
      "defaultSelected": false,
      "blockedReason": null
    }
  ]
}
```

字段说明：

- `latestStatus` / `latestFinishedAt`：该窗口该任务**今天**最新一轮（`getLatestRun(profileId, taskKey, todayStr())`），
  无记录时为 `null`。
- `alreadySuccess`：`latestStatus === 'success'`。
- `inFlight`：DB 在途行或队列在途。
- `selectable`：窗口记录存在、`enabled === 1`、`circuitBreakerCount < threshold` 且不在途。
- `defaultSelected`：`selectable && !alreadySuccess`（在途不可选，默认不勾）。
- `blockedReason`：`profile-missing` / `profile-disabled` / `circuit-breaker` / `in-flight` / `null`
  （优先级：窗口不存在 > 停用 > 熔断 > 在途）。

候选来源：`listRunsForBatch(id)` 中 `status ∈ {failed, captcha_failed}` 的行，按 `profileId` 去重
（同窗口取 `slot` 最大的一行）。

### 接口 2：按勾选执行

`POST /api/batches/:id/rerun-failed`

请求体：

```json
{ "runIds": [345, 350] }
```

- `runIds` 必须为非空、去重后的正整数数组，否则 400（40000）。
- 批次不存在 404（40405）；任务不存在 404（40401）；任务已停用 409（40901）。
- 每个 runId 必须属于该批次，且状态为 `failed`/`captcha_failed`，否则 400（40000）。
- 重新校验窗口：不存在 → 400；已停用、熔断中或在途 → 400（并列出窗口名），因为预览时已禁止勾选，
  出现该情况说明状态已变化。任一勾选窗口不可执行则整单拒绝（all-or-nothing），不做静默去重。
- **不检查「今天最新一轮已成功」**：用户勾选即强制执行。
- 同一窗口命中多条 runId 时按窗口去重，取 `slot` 最大的一行。
- 创建 `createBatch('bulk', batch.taskKey, 'rerun-failed')`，对每个窗口
  `enqueue(profile, batch.taskKey, { batchId })`，**不传 `immediate`**（保留错峰与双闸门）。
- 响应 `data`：`{ "batchId": 123, "queued": 2 }`（`queued` 为去重后的窗口数）。

`batchesRouter` 依赖新增 `circuitBreakerThreshold: number`，由 `src/server/app.ts` 从
`deps.cfg.execution.circuitBreakerThreshold` 注入。

### 批次标识

沿用 `kind='bulk'`，用 `source='rerun-failed'` 区分；`batches` 表结构不变，无需迁移。
批次列表接口已返回 `source`。

## 前端设计

- 沿用项目先例在 `web/src/types.ts` 手写响应类型（`schema.d.ts` 未覆盖 `profiles/batch` 等
  手写接口，本次同样不强制生成）；`endpoints.ts` 增加 `fetchRerunCandidates(batchId)`、
  `rerunFailedBatch(batchId, runIds)`。
- `dashboard/hooks.ts`：
  - `useRerunCandidates(batchId)`：点击按钮时拉取预览（`enabled` 按需或手动调用）；
  - `useRerunFailedBatch`：成功后 toast `已提交 N 个窗口重跑`，invalidate `['batches']` 与
    `['batchDetail']`。
- 新增 `dashboard/RerunFailedModal.tsx`：
  - 打开时先加载候选，`Table` + `rowSelection` 实现二次勾选；
  - 列：窗口、失败状态/错误、最新一轮状态、可执行性；
  - 已成功行加「后续已成功」标签、默认不勾但可手动勾选；
  - 停用/熔断/窗口缺失/在途行 checkbox 置灰并显示原因（在途显示「执行中，暂不可重跑」）；
  - 确认按钮显示选中数量，选中为空时禁用；确认中防重复点击。
- `BatchCard` 头部 `failedCount > 0` 时显示「重跑失败 N」按钮，点击不触发展开/收起
  （`stopPropagation`），打开弹窗。
- 批次标签：`source === 'rerun-failed'` 显示「批量 · 重跑失败」（橙色），否则维持现有
  `KIND_TAG`。
- 单窗口散批（`kind=single`）与未分批历史不加按钮，保留现有行级「重跑」。

## 边界与一致性

- 预览与实际执行之间状态可能变化：已成功不阻止执行（用户已确认）；停用/熔断/窗口缺失/在途会拒绝执行。
- 在途窗口不可勾选；若预览后窗口变为在途，执行接口整单 400，由用户重新预览确认。
- 旧批次失败、今天尚无新轮次：`latestStatus=null`，`alreadySuccess=false`，默认勾选。
- 用户在弹窗里取消勾选某窗口：不执行该窗口。
- 用户勾选「已成功」窗口：强制执行，可能重复消耗站点额度（用户明确选择）。
- 重跑批次创建后，即使窗口随后失败/被跳过，也保留该批次记录（与现有触发一致）。
- 熔断窗口不自动重置，需用户去窗口页重置后再重跑。

## 测试计划

- `tests/web.test.ts`：
  - `GET /api/batches/:id/rerun-candidates`：候选去重、已成功标记、在途不可选（`blockedReason='in-flight'`）、
    停用/熔断不可选、默认勾选规则、批次/任务不存在、任务停用 409。
  - `POST /api/batches/:id/rerun-failed`：
    - 勾选已成功窗口也入队（不再跳过）
    - 停用/熔断/在途窗口返回 400（all-or-nothing）
    - 窗口不存在返回 400
    - runId 不属于批次或状态不是失败 → 400
    - 同一窗口多条 runId 去重
    - 正常创建 `('bulk', taskKey, 'rerun-failed')` 批次并返回 `queued`
    - 空数组/非法数组 400
- `web/src/pages/dashboard/hooks.test.ts` 与 `RerunFailedModal` 组件测试：
  默认勾选、已成功默认不勾但可勾、不可选行禁用（含在途显示原因）、确认空选禁用、提交 runIds。
- `npm run typecheck`、`npm test`、`npm run test:web`、`npx tsc -b web/tsconfig.json`。

## 文档同步

- `docs/API-GUIDE.md` §1「试跑与验证」已新增第 5 条「重跑批次失败」（原第 5 条「看现场」顺延为第 6 条），
  说明入口、勾选规则与两个接口。
- 手册当前只有第 1~7 章（函数手册），没有「面板使用」与「REST 接口总表」章节，故无 REST 表格可补。
- `src/server/routes/batches.ts` 补 `@swagger` 注解，`/api-docs` 可查两个新接口。
- 涉及 `src/api/index.ts` 导出的函数时才会触发 `tests/api-docs-drift.test.ts`；本次不加导出函数，
  不涉及该守卫。

## 验证

- 类型检查与全部测试通过。
- 真机可选：构造含失败窗口的批次，打开弹窗确认已成功窗口默认不勾、停用/熔断不可勾；
  勾选后确认，只开勾选窗口；勾选已成功窗口时确实再次执行。真机验证遵守 AGENTS.md 的并发上限与
  单入口执行规范。

# 文件随机分配「定时执行」设计（file-assign-schedule）

日期：2026-09-30
状态：待用户评审（按要求不提交 git，确认完整代码后再定）

## 1. 背景与问题

「工具中心 → 文件随机分配」目前是纯手动操作：面板填源文件夹/目标列/名称模板 → 生成预览 → 执行分配（改名文件并写回 `accounts.xlsx`）。用户希望它支持定时自动执行：到点自动把源文件夹里的文件按模板改名、随机分配给各账号行并写回目标列，全程无人值守。

现有可复用基础：

- `schedules` 表 + 自研 tick 调度器（`src/engine/scheduler.ts`）：四种频率模式（interval/daily/weekly/monthly）、时区墙上时钟匹配、每分钟去重、错过即跳过、「立即运行」。
- 计划级「上传前自动文件随机分配」（`config.fileAssign`）：当前仅在计划内有依赖文件的任务（`meta.requiresFileAssign`）通过守卫时，于开窗前执行一次分配。
- `FileAssignService` 的 busy 锁：手动分配与计划自动分配已共用。

差距：分配必须挂在有任务触发的计划上；纯「定时分配、不触发任务」的能力不存在。

## 2. 目标与范围

**目标**：文件随机分配工具支持独立的定时自动执行（不关联任务、不开窗口、不触发上传），手动分配功能保持不变。

**范围**：

- 工具页「文件随机分配」卡片内新增「定时执行」区块：启用开关、频率配置（四种模式，与定时任务页一致）、「保存定时配置」、「立即执行一次」。
- 定时分配计划复用 `schedules` 表（`taskKeys` 为空 = 纯分配计划），「定时任务」页同步可见可管理（标「仅分配」标签）。
- 参数来源：保存定时配置时把主表单的源文件夹/目标列/名称模板固化进计划 `config.fileAssign`；自动执行直接读存好的值，无人工输入。
- 到点执行：成功记日志；失败只记日志告警、本次错过即跳过；面板不显示历史执行结果。「立即执行一次」走同一路径，给用户明确的成功/失败提示。
- 并发：与手动分配共用 busy 锁。

**范围外（YAGNI）**：

- 不新增表、不新增独立调度器、不新增 REST 端点（复用 `/api/schedules`）。
- 不支持一个工具多条定时计划（约定至多一条）。
- 不做执行历史记录/面板展示（仅日志）。
- 不做外部系统级定时（Windows 任务计划等）。

## 3. 方案决策

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A. 复用 schedules 表 + 调度器支持纯分配计划 | `taskKeys=[]` + `config.fileAssign`；`Scheduler.fire` 加纯分配分支；路由校验放宽 | **采用** |
| B. 新表 + 独立每日调度器 | 完全隔离，但时区/去重/立即执行全部重写，双调度并存 | 否 |
| C. Windows 任务计划 + npm script | 面板不可见、失败无日志反馈、绕开进程内 busy 锁 | 否 |

## 4. 数据模型

复用 `schedules` 表，无表结构改动：

- 「纯分配计划」：`taskKeys = '[]'`，`mode` ∈ {interval, daily, weekly, monthly}，`config = { ...频率参数, fileAssign: { sourceDir, column, template } }`。
- 约定「文件随机分配」工具对应至多一条纯分配计划，面板自动生成固定名称「文件随机分配（定时）」。
- 开关关闭（`enabled=0`）保留配置；删除统一在「定时任务」页完成。

## 5. 后端设计

### 5.1 `src/engine/scheduler.ts`

`RunNowResult` 增加可选字段：

```ts
fileAssign?: { ran: boolean; ok: boolean; renamedCount?: number; error?: string }
```

`fire()` 调整：

- `taskKeys` 为空数组时（纯分配计划），在任务守卫循环前走独立分支：
  - 若 `config.fileAssign` 存在且执行器已装配 → 直接执行一次分配：成功 `logger.info`（含 renamedCount）、失败 `logger.warn` 且本次错过即跳过；返回 `fileAssign: { ran: true, ok: ... }`，`taskKeys: []`，不建批次、不入队。
  - 若空任务又无 `fileAssign` → 防御性 `warn` 跳过整个计划。
- 任务型计划：现有守卫 → 分配 → 入队逻辑不变（`needsAssign` 判定条件不改动）；任务计划的分配结果同样写入 `fileAssign` 字段（`ran` 反映本次是否执行了分配）。
- `SchedulerDeps.fileAssign` 类型同步改为 `run(config): Promise<ApplyResult>`（见 5.2），以透传 renamedCount。

### 5.2 `src/tools/file-assign/runner.ts`

`buildFileAssignRunner` 的 `run` 返回 `Promise<ApplyResult>`（当前为 void），使 scheduler 能拿到 `renamedCount`/`updatedRows`。`app.ts` 装配处签名兼容，无需改动。

### 5.3 `src/server/routes/schedules.ts`

`parseBody` 调整：

- 校验顺序：先合成 `finalConfig`，再校验 `taskKeys`。
- `taskKeys` 允许空数组，**仅当最终 config 含合法 `fileAssign`**；既无任务又无分配 → 400。
- swagger 注解同步：POST/PATCH 的 `taskKeys` 说明更新；`/schedules/{id}/run` 响应增加 `fileAssign` 字段。

## 6. 前端设计

### 6.1 共享组件 `web/src/components/schedule-fields.tsx`（新建）

从定时任务页弹窗抽出频率配置 JSX：Segmented 四种模式 + 动态参数（interval 间隔小时 / weekly 星期多选 / monthly 几号多选 / 非 interval 时间点 Form.List）。工具页与定时任务页弹窗复用（与 `name-template-editor` 共享先例一致）。

### 6.2 工具页 `web/src/pages/tools/file-assign.tsx`

主表单下方 Divider 分隔新增「定时执行」区块：

- 数据源：新 hook `useFileAssignSchedule`（`fetchSchedules` 过滤 `taskKeys` 为空且 `config.fileAssign` 存在的计划；多个时取 id 最小）。
- 区块内容：
  - `Switch` 启用/关闭：开 → 有旧计划则 PATCH `enabled:true`；无旧计划则以默认频率（`daily` + `09:00`）和当前主表单参数（校验通过后）POST 创建；关 → PATCH `enabled:false`。
  - 频率配置（`ScheduleFields` 组件）+ 「保存定时配置」按钮：校验主表单（源文件夹非空、模板合法）→ 把主表单参数固化进 `config.fileAssign`，连同当前频率配置一起 PATCH（无旧计划时 POST 创建）。频率改动点「保存定时配置」才落库；开关只控制启停，不自动保存频率。
  - 「立即执行一次」：`POST /api/schedules/:id/run`，成功显示「已重命名 N 个文件，写回 M 行」，失败显示错误（来自 `fileAssign` 字段）。
- `web/src/api/endpoints.ts` 无新接口；`web/src/types.ts` 手补 `RunScheduleResult.fileAssign` 类型。

### 6.3 定时任务页 `web/src/pages/schedules/index.tsx`

- 「关联任务」列：`taskKeys` 为空且带 `fileAssign` → 紫色 Tag「仅分配」。
- 弹窗校验：`taskKeys` 必填规则改为「未开自动分配时必须至少选一个任务」→ 定时任务页也能创建/编辑纯分配计划（`buildPayload` 不变）。
- 立即运行提示适配：纯分配计划显示分配结果而非「已触发 0 个任务」。

## 7. 错误处理与边界

| 场景 | 行为 |
| --- | --- |
| 到点执行失败（文件夹空/文件不足/写回失败） | `warn` 日志 + 错过即跳过；面板不显示历史结果 |
| 手动分配与定时分配并发 | 共用 `FileAssignService` busy 锁 |
| 计划 JSON 损坏 / fileAssign 形状非法 | 沿用 parseConfig / validateFileAssign 防御路径 |
| 开关开启但主表单未填源文件夹 | 前端拦截提示，不落库 |
| 纯分配计划「立即执行一次」 | 同步返回 `fileAssign` 结果，前端 message 反馈 |

## 8. 测试

- `tests/scheduler.test.ts`：纯分配计划到点执行一次且不入队；分配失败返回 `fileAssign.ok=false` 且告警；空任务无 fileAssign 防御跳过；`run` 返回值透传 renamedCount；现有用例断言不受影响。
- `tests/web.test.ts`：POST 空 taskKeys + fileAssign 成功；空 taskKeys 无 fileAssign 400；run 响应带 fileAssign 字段。
- `web/src/pages/tools/hooks.test.tsx`：`useFileAssignSchedule` 过滤逻辑 + 保存/立即执行 mutation 提示。

## 9. 文档同步（代码同批改，不提交）

- `docs/API-GUIDE.md`：
  - 第 11 章工具中心：文件随机分配加「定时执行」用法说明。
  - 8.2 面板使用：工具页新功能说明。
  - 8.3 REST 接口总表：`POST/PATCH /api/schedules` 的 taskKeys 语义（空数组 + fileAssign）、`/schedules/{id}/run` 响应 `fileAssign` 字段。
  - 第 7 章定时任务：补「仅分配计划」说明。

## 10. 验收标准

- [ ] 工具页定时区开启开关后，创建出「文件随机分配（定时）」纯分配计划，定时任务页可见且标「仅分配」。
- [ ] 到点自动执行一次分配（日志「定时文件随机分配完成」），不开窗口、不触发任务；失败时 warn 日志且当天不再重试该分钟。
- [ ] 「立即执行一次」返回成功（带 renamedCount）或失败错误提示。
- [ ] 手动分配与定时分配并发互斥（busy 锁）。
- [ ] 定时任务页可编辑/删除/开关纯分配计划。
- [ ] `npm run typecheck`、`npm test`、`npm run test:web` 全过。

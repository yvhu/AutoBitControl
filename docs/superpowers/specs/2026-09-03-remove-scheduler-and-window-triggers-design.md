# 删除调度器与窗口级触发入口设计

日期：2026-09-03
状态：已确认（用户确认后直接实施）

## 目标

项目改为**纯手动触发**模式：

1. 彻底删除调度器（Scheduler/croner/错峰/间隔调度全部移除）
2. 删除窗口层面的启动入口：看板「重跑今日失败」「全部窗口执行」、窗口页「立即跑」
3. 同步相关文档与测试

## 保留的触发面（删除后）

| 入口 | 范围 |
|---|---|
| 任务页「立即触发」 | 任务 × 全部启用窗口（`POST /api/tasks/:key/trigger` 不带 bitbrowserId） |
| 看板行级「执行/重跑」 | 单窗口 × 单任务（同接口带 bitbrowserId） |
| 重试机制（retry_wait → scheduleRetry 定时器） | 自动，不依赖调度器，保留 |
| 脚本 `npm run task:run` / smoke | 调试用，不动 |

任务开关（`enabled` + 云端 `task_states`）保留：改为纯手动触发守卫（停用 → trigger 接口 409），不再有「调度器跳过」语义。

## 改动清单

### 1. 引擎层：删除调度器

- 删 `src/engine/scheduler.ts` 整个文件（Scheduler 类、staggerToCron、pickRandomTimeInWindow、intervalDue、INTERVAL_BUFFER_MS、isIntervalSchedule 的 re-export）
- `src/engine/task.ts`：删 `TaskMeta.schedule` 字段与 `isIntervalSchedule` 函数；`enabled` 注释改为「false 时手动触发接口 409」
- `src/engine/window-runner.ts`：删成功回写调度锚点逻辑（isIntervalSchedule 导入、`setTaskFiredAt` 调用，约 300-302 行）
- `src/infrastructure/db.ts`：删 `getTaskFiredAt`/`setTaskFiredAt` 方法与 `task_fired_at` 建表（老库残留表数据不动，无害）
- `src/app.ts`：删 Scheduler 导入/装配/start/stop、`onToggle` 回调（约 14/185-187/203/218-219/242 行）
- `package.json`：删 croner 依赖
- `config/config.json` 与 `src/infrastructure/config.ts`：删 `execution.timezone` 字段与解析
- `config/.env` 如无 timezone 相关值不动

### 2. 任务 meta：清理 schedule

- `src/tasks/example-checkin.ts`：删 `schedule: { stagger: ['09:00', '11:00'] }`
- `src/tasks/faucet-example.ts`：删 `schedule: { stagger: ['10:00', '12:00'] }`
- 其余任务（mint-example/inception-dachain/portal-rhuna）本无 schedule 或仅注释提及，注释同步清理

### 3. 后端：删除两个接口

- `POST /api/profiles/:id/run`（src/server/routes/profiles.ts:246-256 + swagger 注解）删除
- `POST /api/runs/rerun-failed`（src/server/routes/runs.ts 整个文件 + src/server/app.ts 装配 + openapi 汇总）删除
- `POST /api/tasks/:key/trigger` 保留（两个保留入口共用）；src/server/routes/tasks.ts 删 `onToggle` 参数与调用
- src/server/app.ts：删 `onToggle` 类型与透传

### 4. 前端：删除三个按钮

- 看板（web/src/pages/dashboard/）：删「重跑今日失败」「全部窗口执行」按钮、`handleTriggerAll`、`useRerunFailed` hook；保留行级「执行/重跑」
- 窗口页（web/src/pages/profiles/）：删「立即跑」按钮与 `useRunProfile` hook
- 任务页（web/src/pages/tasks/）：删卡片 schedule 摘要（`scheduleText` 与单测）；开关与「立即触发」保留
- 设置页（web/src/pages/settings/）：删时区展示行
- `web/src/api/endpoints.ts`：删 `rerunFailed`（第 9 行）与 `runProfile`（第 10 行）；`web/src/api/schema.d.ts` 手补类型同步清理（trigger 保留）
- `web/src/types.ts`：任务 meta 视图删 schedule 字段

### 5. 文档

- `docs/API-GUIDE.md`：删第 7 章「调度」整章；TaskMeta 字段表删 schedule 行、改 enabled 描述；删「窗口立即跑」「重跑今日失败」「全部窗口执行」相关描述；改「上线/调度器」流程描述为纯手动；术语表删调度器/croner；跳过规则改为手动触发守卫（停用 409）
- `AGENTS.md`：分层架构描述删 scheduler(croner)；任务三步说明删 schedule 相关；「meta.enabled=false 时调度器跳过」改为「手动触发 409」；命令表格描述不变

### 6. 测试

- 删 `tests/scheduler.test.ts` 整个文件
- `tests/windowRunner.test.ts`：删间隔调度锚点回写用例（fixture `IntervalTask`/`DailyTask` 中 schedule 字段、成功回写断言）
- `tests/web.test.ts`：任务 fixture 删 schedule 字段；删除 rerun-failed/profile run 相关用例（如有）
- `web/src/pages/tasks/hooks.test.ts`：删 `scheduleText` 用例
- `web/src/pages/dashboard/hooks.ts` 与 `profiles` 页相关单测同步更新

## 验证计划

- `npm run typecheck` 通过
- `npm test`、`npm run test:web` 通过
- 手动：`npm run dev` 启动无调度日志；任务页「立即触发」、看板行级「执行/重跑」可用；看板/窗口页删除按钮不显示；停用任务手动触发返回 409

## 明确不做

- 不动 `docs/superpowers/specs/`、`docs/superpowers/plans/` 历史文档
- 不动 `task_states` 表与云端开关机制（仍作触发守卫）
- 不动 retry-recovery、队列、WindowRunner 主流程
- 不动脚本（task:run / smoke:window / smoke:wallet）

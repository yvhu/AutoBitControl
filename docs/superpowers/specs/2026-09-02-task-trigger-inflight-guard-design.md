# 任务触发在途防护设计（防重复触发）

日期：2026-09-02
状态：设计已确认，待实施

## 背景

任务页「立即触发」按钮只在入队请求期间显示 loading（毫秒级），之后可无限重复点击。
每次点击 → 全部启用窗口重新开一轮会话 → `runs` 表新增 slot 轮次 → 重复执行
（`window-runner.ts` 对终态行开新 slot）。看板行级「执行/重跑」与「全部窗口执行」同样可重复触发。

需要：任务存在在途 run 时禁止再次触发；在途结束（无 pending/running/retry_wait 行且无排队会话）后自动恢复。

## 目标

1. 「立即触发」「全部窗口执行」在任务在途时：前端禁用按钮，后端 409 硬拦截
2. 看板行级「执行/重跑」按（窗口, 任务）维度同样防护，不影响其他窗口
3. 无在途 run 即恢复可点（用户确认口径）；不做固定冷却时间

## 设计

### 在途判定口径

```
inFlight(taskKey, profileId?) =
   DB 当天在途行 > 0（status IN ('pending','running','retry_wait')，当天，可选窗口维度）
   ∪ 队列内存态会话包含该任务（pending 条目 / running 会话的 taskKeys，可选窗口维度）
```

必须双判：窗口会话「开窗 → CDP 连接 → IP 探活」阶段 runs 表尚无行（最长数分钟），
仅查库会在该阶段漏防；`retry_wait` 行的重试定时器是内存态（`app.ts` scheduleRetry），
仅查队列内存态会漏防重试退避期。

### 后端（src/infrastructure/db.ts）

- 新增 `countInFlightRuns(taskKey: string, date: string, profileId?: number): Promise<number>`：
  ```sql
  SELECT COUNT(*) AS c FROM runs
  WHERE task_key = ? AND date = ? AND status IN ('pending','running','retry_wait')
    [AND profile_id = ?]
  ```

### 后端（src/engine/queue.ts）

- `CoalescingEnqueuer.running: Set<number>` → `Map<number, Set<string>>`
  （窗口 id → 会话内任务集合；入队启动时写入，会话结束时删除）
- 新增 `hasTaskInFlight(taskKey: string, profileId?: number): boolean`：
  遍历 pending 条目与 running 会话的 taskKeys 是否含该任务；指定 profileId 时只看该窗口

### API（src/server/routes/tasks.ts + dashboard.ts + http/errors.ts）

- `ERROR_CODES` 新增 `TASK_RUNNING: 40902`
- `POST /api/tasks/:key/trigger`：入队前判定在途
  - all-window 作用域：`countInFlightRuns(key, today, 无) > 0 || enqueuer.hasTaskInFlight(key)` → 409
  - single-window 作用域：按 `(profileId, task)` 判定 → 409
  - 消息：「任务执行中，请等待全部窗口结束后再触发」（单窗口：「该窗口任务执行中，请等待结束后再触发」）
- `GET /api/tasks`：每任务加 `inFlight: boolean`（全窗口口径，同判定）
- `GET /api/dashboard`：每个 run 行加 `inFlight: boolean`（按 profileId + taskKey 判定）
  ——dashboardRouter 需新增 `enqueuer` 依赖（app.ts 装配处注入）
- 三处 Swagger 注解同步更新

### 前端（web/src/pages/tasks）

- `useTasks` 加 `refetchInterval: 5000`（在途结束自动恢复按钮）
- 卡片「立即触发」：`task.inFlight` → disabled + 文案「运行中」（保留按钮位避免布局跳动）；
  `trigger.isPending` 时仍显示 loading
- 409 错误消息由现有 `errMsg`（HttpError.message）直接展示，无需额外处理

### 前端（web/src/pages/dashboard）

- 行级「执行/重跑」：`run.inFlight` → disabled
- 「全部窗口执行」：所选任务的 `inFlight`（来自 `useTasks` 数据）→ disabled；
  dashboard 的 `useTasks`（dashboard/hooks.ts）同样加 `refetchInterval: 5000`，
  保证禁用态与任务页一致地自动恢复（任务页与看板页两处 useTasks 独立实例，需分别配置）
- 类型经 openapi-typescript 重新生成 schema.d.ts（与现有流程一致）

### 边界（明确接受）

- cron 到点触发不走 trigger 路由，不受 409 限制（调度有意执行；间隔任务已有 nextAllow 防重）
- 进程崩溃残留 running 行：当天阻塞、次日自愈（不做启动清理）
- 多进程部署时队列内存态各进程独立，DB 判定兜底（本项目单进程）

### 范围外

- 不做固定冷却时间、不合并间隔调度的 nextAllow 语义
- 不改 runs 表结构、无迁移
- 队列 running 会话的 taskKeys 跟踪仅为判定服务，不改变会话合并/重排逻辑

## 测试

- `tests/db.test.ts`：countInFlightRuns 状态过滤（pending/running/retry_wait 计入、
  终态不计）、date 过滤、profileId 维度
- `tests/queue.test.ts`：hasTaskInFlight 三态——pending 条目含任务 / running 会话含任务 /
  指定窗口维度隔离
- `tests/http.test.ts`（路由测试）：trigger 在途 409（DB 在途与队列在途两种来源）、
  无在途 200、单窗口在途不影响全窗口判定（反向亦然）、GET /api/tasks 与
  /api/dashboard 的 inFlight 字段
- web：任务页按钮禁用逻辑与看板行按钮禁用（沿用现有 web 测试基线）

## 验证

- `npm test`（后端）+ `npm run typecheck`
- `npm --prefix web run test` + `npm --prefix web run build`

# 窗口池 Phase 3：旧调度清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 窗口池已真机验收通过，删除旧调度回滚路径：`maxConcurrentWindows`、`meta.concurrency`、`CoalescingEnqueuer` 与旧 claim/capacity gate，使窗口池成为唯一调度器。

**Architecture:** `WindowPoolScheduler` 成为唯一 `RunEnqueuer`；`WindowRunner` 仅保留池/手动/task:run 三种窗口归属；面板手动开窗容量改用 `windowPool.maxOpenWindows`；删除旧 feature flag 与旧调度测试，保留池测试与 DB 队列测试。

**Tech Stack:** Node 20 + TypeScript strict、Express、libsql/AppDb、Vitest、patchantd。

## Global Constraints

- 中文注释/文档/commit；无分号、单引号、2 空格；本地库只经 AppDb。
- 删除旧路径前先跑全量测试；每任务后 `npm run typecheck` + 相关测试。
- 不改任务业务逻辑，只删除 `meta.concurrency` 这类调度字段并适配。
- 默认行为：窗口池始终启用（不再有 `enabled` 开关）；面板/task:run 仍可手动开窗。
- 文档同步：`AGENTS.md`、`docs/API-GUIDE.md`；Phase 3 完成后不再提旧全局并发/任务级并发。
- 每个任务独立可测；不 stage/commit 直到用户决定（当前会话保持工作区）。

---

### Task 1: 删除 maxConcurrentWindows 与旧容量 gate

**Files:**
- Modify: `src/infrastructure/config.ts`, `config/config.json`
- Modify: `src/app.ts`, `src/server/app.ts`, `src/server/routes/profiles.ts`
- Modify: `src/engine/window-runner.ts`
- Modify: `tests/config.test.ts`, `tests/web.test.ts`, `tests/windowRunner.test.ts`
- Modify: `docs/API-GUIDE.md`, `AGENTS.md`

- [ ] 删除 `ExecutionConfig.maxConcurrentWindows`、默认值、校验、config.json 字段。
- [ ] `profilesRouter` 容量参数改 `windowPool.maxOpenWindows`；`src/app.ts` 传 `cfg.execution.windowPool.maxOpenWindows`。
- [ ] 删除 `WindowRunner.waitForGlobalWindowCapacity`、`CAPACITY_WAIT_MS`/`CAPACITY_POLL_MS`、`reclaimOrphanWindows` 容量分支；`openWithRetry` 直接开窗（池调度器负责额度）。
- [ ] 手动/面板开窗仍受 `maxOpenWindows` 约束（`ensureWindowCapacity` 使用新值）。
- [ ] 更新测试与文档，去掉旧全局上限描述。
- [ ] 验证：`npm run typecheck && npx vitest run tests/config.test.ts tests/web.test.ts tests/windowRunner.test.ts && npm test`。
- [ ] Commit（若允许）：`refactor: 移除 maxConcurrentWindows 与旧窗口容量 gate`

---

### Task 2: 删除 meta.concurrency 与 limits

**Files:**
- Modify: `src/engine/task.ts`
- Modify: `src/tasks/*.ts`（删除 `concurrency` 字段）
- Modify: `src/engine/window-pool.ts`（`limits` → `taskKeys: Set<string>`）
- Modify: `src/app.ts`, `src/engine/queue.ts`（`RunEnqueuer` 不再需要 limits）
- Modify: tests（tasks 字符串/meta 夹具、pool/scheduler/queue）
- Modify: docs/AGENTS

- [ ] `TaskMeta` 删除 `concurrency`；删除 `DEFAULT_TASK_CONCURRENCY`（若仅此处使用）。
- [ ] `WindowPoolSchedulerDeps.limits` 改 `taskKeys: Set<string>`；`settleUnregisteredRuns` 改接收 taskKeys（或增加 `isTaskRegistered(key)`）并用它判断未注册任务。
- [ ] `createRunEnqueuer`/`WindowPoolScheduler` 构造传 `new Set(tasks.keys())`；旧 `limits` 相关代码删除。
- [ ] 所有任务文件删除 `concurrency: N`；测试夹具去掉该字段。
- [ ] 面板/API 若展示 concurrency，删除对应字段（搜索 `concurrency`）。
- [ ] 验证：`npm run typecheck && npm test && npm run test:web`（前端若改）。
- [ ] Commit：`refactor: 移除任务级并发 concurrency`

---

### Task 3: 删除 CoalescingEnqueuer、旧 claim 与特性开关

**Files:**
- Modify: `src/engine/queue.ts`（只保留 `RunEnqueuer`、`SessionTask`、`RunEnqueuer` 类型；删除 `CoalescingEnqueuer`）
- Modify: `src/infrastructure/db.ts`（删除 `claimDueRuns`、`countRunningProfiles`、`settleUnregisteredRuns` 若由其他路径替代；保留 `claimQueuedRuns`/队列查询/`settle*` 共享）
- Delete: `tests/queue.test.ts` 或改写为 `RunEnqueuer`/skip 测试（池测试已覆盖）
- Modify: `tests/db.test.ts`（删除 claimDueRuns 旧用例）
- Modify: `src/app.ts`（删除 `createRunEnqueuer` 的旧分支与 `CoalescingEnqueuer` 导入；始终 `new WindowPoolScheduler`）
- Modify: `src/server/app.ts`/routes（类型保持 `RunEnqueuer`）
- Modify: `tests/run-enqueuer.test.ts`（改为断言始终 pool）
- Modify: config（删除 `windowPool.enabled`；始终启用）与 `config.local.json` 清理无关
- Modify: docs/AGENTS
- Create/modify: `src/engine/window-pool.ts`（构造不再需要 enabled）

- [ ] 删除 `CoalescingEnqueuer` 类及其测试；保留 `RunEnqueuer`/`SessionTask` 类型。
- [ ] `AppDb` 删除 `claimDueRuns`/`countRunningProfiles` 等旧调度专用方法及测试；`claimQueuedRuns`、`hasDueRuns`、`listPending*` 保留。
- [ ] `src/app.ts` 始终构造 `WindowPoolScheduler`；去掉 `windowPool.enabled` 判断；`poolStatus` 始终注入；`Scheduler`/路由使用 `RunEnqueuer`。
- [ ] 删除 `execution.windowPool.enabled` 配置、config.local 字段、文档；面板池状态始终启用。
- [ ] 清理 `maxConcurrentWindows`/`meta.concurrency`/旧 claim 的所有残留引用（`rg` 搜索）。
- [ ] 验证：`npm run typecheck && npm test && npm run test:web`。
- [ ] Commit：`refactor: 窗口池成为唯一调度器`

---

### Task 4: 文档、配置与最终验收

**Files:**
- Modify: `docs/API-GUIDE.md`, `AGENTS.md`, `config/config.json`
- Modify: `docs/superpowers/specs/2026-10-22-window-pool-scheduler-design.md`（标记 Phase 3 完成）
- Tests: none or docs drift

- [ ] 文档删除旧全局并发/任务并发/启用开关说明，描述窗口池默认启用、面板/task:run 手动窗口、内存/健康门禁、窗口复用/轮转、幂等。
- [ ] 配置速查只保留 `windowPool`/`health` 与现有执行参数。
- [ ] 全量验证：`npm run typecheck`、`npm test`、`npm run test:web`。
- [ ] 真机冒烟：启动 dev，确认池状态正常、无旧调度日志；不重复开窗。
- [ ] Commit：`docs: 同步窗口池唯一调度模式`

## 验收标准

- `rg "maxConcurrentWindows|meta\.concurrency|CoalescingEnqueuer|windowPool\.enabled"` 无生产/测试/用户文档残留（历史 specs 可保留）。
- 窗口池是唯一调度器；手动/面板/task:run 仍可用；任务行为不变。
- `npm run typecheck`、`npm test`、`npm run test:web` 全绿。
- 真机启动无异常，池状态 enabled 正常。

# Minor Backlog 清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理 DB 队列/并发/错峰改造后的 Minor backlog，并落地已确认的 B 项行为边界。

**Architecture:** 不改任务执行主流程；主要集中在配置校验与启动告警、DB 队列辅助方法清理、停止/状态写入竞态、面板手动关窗取消标记、少量 API/文档/测试卫生。

**Tech Stack:** Node + TypeScript（严格模式）、libsql/SQLite、express、React + antd、vitest。

**依据：** 三个已提交改造的 final review Minor findings。

## Global Constraints

- 中文注释/文档；无分号、单引号、2 空格；TS 严格模式。
- TDD；每个任务跑 `npm run typecheck` 和相关测试。
- 不提交密钥/账号文件。
- commit 步骤仅在用户明确同意时执行。

---

### Task 1: 配置校验与启动告警

**Files:**
- Modify: `src/infrastructure/config.ts`
- Modify: `src/app.ts`
- Test: `tests/config.test.ts`

**Decisions:**
- `maxConcurrentWindows`：必须是正整数；非法或 0 → 回退 4，并记录 warning。
- `staggerMaxSec`：0–3600；非法 → 120，>3600 → 3600，并记录 warning。
- 旧 `circuitBreakerResetEveryHours` 仍存在 → 启动 warning（已废弃，忽略）。
- `loadConfig` 增加可选 `warnings?: string[]` 参数，app 用 logger.warn 输出。

**Steps:**
- [ ] 在 `tests/config.test.ts` 增加：非法 maxConcurrentWindows/0 → 4；staggerMaxSec 非法/>3600；旧 resetEveryHours 产生 warning。
- [ ] `LoadConfigOptions` 增加 `warnings?: string[]`；校验函数 push 中文告警。
- [ ] `app.ts` 创建 logger 后逐条 `logger.warn`。
- [ ] 跑 `npx vitest run tests/config.test.ts`、`npm run typecheck`。

---

### Task 2: 队列/DB 清理与未知任务结算

**Files:**
- Modify: `src/infrastructure/db.ts`
- Modify: `src/engine/queue.ts`
- Modify: `src/engine/scheduler.ts`
- Test: `tests/db.test.ts`、`tests/queue.test.ts`、`tests/queue-any-running.test.ts`

**Decisions:**
- 删除无生产调用：`listDueRuns`、`hasRunningRunsForProfile`、`hasTaskInFlight`、`anyRunning`；对应测试删除/改名。
- 抽取 `claimDueRuns` 与 due 查询共用的 SQL 片段，避免漂移。
- `enqueueRun` 遇到最新行为 `running` 时 no-op（不改 batch/not_before），queue 侧 warning。
- 新增 `settleUnregisteredRuns(date, nowMs, limits)`：把无 limit 的 due 行结算为 `skipped`/“任务未注册”；queue tick 调它并 logger.warn。
- `scheduler` enqueue 类型收紧为 `Promise<void>`。
- 补“昨天 running 的同任务仍占今天 task 额度”测试。

**Steps:**
- [ ] 更新测试（删除 dead API 用例，增加 running conflict/unknown task/cross-midnight task cap）。
- [ ] 删除 dead methods；抽取 due SQL 常量；`enqueueRun` running no-op；新增 `settleUnregisteredRuns`。
- [ ] queue tick 先结算未知任务再 claim；`enqueue` 对 running 返回 warning。
- [ ] 跑 `npx vitest run tests/db.test.ts tests/queue.test.ts tests/queue-any-running.test.ts tests/scheduler.test.ts`、`npm run typecheck`。

---

### Task 3: 停止/状态写入竞态与手动关窗

**Files:**
- Modify: `src/infrastructure/db.ts`
- Modify: `src/engine/window-runner.ts`
- Modify: `src/server/routes/profiles.ts`
- Modify: `src/app.ts`
- Test: `tests/windowRunner.test.ts`、`tests/web.test.ts`、`tests/task-stopper.test.ts`

**Decisions:**
- 新增 `updateRunIfRunning(profileId, taskKey, date, slot, status, patch)`：条件 `WHERE status='running'`；0 行时返回当前行（可能是 stop 写入的 skipped）。`runTask` 的成功/失败/retry_wait/skipped 写入改用它，避免 stop 被覆盖。
- `settleWindowSkip`：如果最新行已是 `skipped` 且 `failureKind='stopped'`/error `手动停止`，直接返回该行，不再新开 slot（消除重复 stopped 行）。
- 面板手动“关闭窗口”：若该窗口有 running 行，置 session 取消标记后再关窗；无 running 不置，避免泄漏。
- `breaker/reset` 响应：实际调用 `bitbrowser.isOpen` 返回准确 `open`，不再固定 false。
- 测试：stop 后 success 不覆盖 skipped；重复 skipped 不产生新 slot；手动关窗置 session 标记；reset 返回真实 open。

**Steps:**
- [ ] 写失败测试。
- [ ] 实现 `updateRunIfRunning` 并替换 runTask 终态写入。
- [ ] 修 `settleWindowSkip` 重复 stopped；profiles close 注入 `requestSession`；reset 探测 open。
- [ ] 跑相关测试、typecheck。

---

### Task 4: 测试卫生、文档与全量验证

**Files:**
- Modify: `tests/db.test.ts`、`tests/helpers/concurrent-claim.worker.mjs`、`tests/run-recovery.test.ts`
- Modify: `docs/API-GUIDE.md`、`AGENTS.md`
- Modify: `docs/superpowers/plans/2026-10-19-db-gates-and-stagger.md`（同步实现差异）

**Steps:**
- [ ] worker 测试主线程 watchdog、`Promise.race` 超时、finally terminate；临时目录按 process/run 唯一前缀；run-recovery 测试用本地日期。
- [ ] 补 API `notBeforeMs` 返回断言、ETA 组件渲染测试（可选）、rollback/no-partial claim 测试（能注入则做）。
- [ ] 文档：跨午夜错峰尾巴“跨日未执行”策略；ETA 是下界；dead API/注释同步。
- [ ] 修正 gates/stagger plan 中 date-scoped `countRunningProfiles(date)` 与 claim-before-profiles 的旧描述。
- [ ] 全量：`npm run typecheck`、`npm test`、`npm run test:web`。

---

## Acceptance

- 配置非法值有明确 fallback + 启动告警。
- 队列无 dead API；未知 taskKey 不留下 pending 行；running enqueue 不篡改批次。
- stop 不会被后续 success/retry 覆盖；重复 stopped 行消失；手动关窗能中止会话。
- reset 返回真实 open。
- 全量测试通过；文档与实现一致。

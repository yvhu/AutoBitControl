# DB 并发阀门 + 错峰算法 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务级/全局并发裁决搬到 `runs` 的 DB claim 事务；把错峰从纯随机改成均匀节奏 + 小抖动 + ETA。

**Architecture:** `claimDueRuns` 在一个 SQLite 写事务里查到期行、统计 `running` 窗口/任务数、按 limits 过滤并 claim；dispatcher 不再维护 `gates/globalActive/activeProfiles`。错峰由 `staggerNotBefore` 纯函数按“窗口序号/总数/总铺开时长/抖动”算出 `not_before_ms`，触发入口传入；重试只用 backoff。

**Tech Stack:** Node + TypeScript（严格模式）、libsql/SQLite、patchright、express、React + antd + react-query、vitest。

**设计依据：** `docs/superpowers/specs/2026-10-19-db-gates-and-stagger-design.md`

## Global Constraints

- 全部注释/文档/commit message 用中文。
- 无分号、单引号、2 空格缩进；TS 严格模式。
- TDD：每个任务先写失败测试，再写实现，再跑测试。
- 不提交 `config/.env`、`config/config.local.json`、`config/accounts.xlsx` 等密钥/账号文件。
- 本计划不改变任务执行、熔断、钱包、停止状态机。
- 每个任务至少跑 `npm run typecheck`；全部完成后跑 `npm test` 和 `npm run test:web`。
- commit 步骤只有用户明确同意提交时才执行。

---

## File Structure

### 新增

- `src/engine/stagger.ts`：`staggerNotBefore` 纯函数。
- `tests/stagger.test.ts`：错峰纯函数单测。

### 修改

- `src/infrastructure/db.ts`：`claimDueRuns`、running 计数、索引。
- `src/engine/queue.ts`：dispatcher 改用 `claimDueRuns`，删除内存 gates。
- `src/infrastructure/config.ts`：`staggerJitterPct` 配置与校验。
- `src/server/routes/tasks.ts`、`batches.ts`、`src/engine/scheduler.ts`：传 `notBeforeMs`。
- `src/app.ts`：传入 limits/stagger 配置。
- `web/src/api/schema.d.ts`、`web/src/pages/dashboard/format.ts`、`index.tsx`：ETA。
- 测试：`tests/db.test.ts`、`queue.test.ts`、`web.test.ts`、`scheduler.test.ts`、`web/src/pages/dashboard/format.test.ts`。
- `docs/API-GUIDE.md`、`AGENTS.md`。

---

### Task 1: DB `claimDueRuns` 与索引

**Files:**
- Modify: `src/infrastructure/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- `AppDb.claimDueRuns(opts: { date: string; nowMs: number; limits: Map<string, number>; maxConcurrentWindows: number }): Promise<RunRow[]>`
- `AppDb.countRunningProfiles(date: string): Promise<number>`

**Steps:**

- [ ] **写失败测试**

在 `tests/db.test.ts` 的队列 describe 内追加（复用临时文件 AppDb）：

```ts
it('claimDueRuns 遵守全局/任务级上限与窗口合并', async () => {
  const p1 = await qdb.upsertProfile('bb-g1', '窗口1')
  const p2 = await qdb.upsertProfile('bb-g2', '窗口2')
  await qdb.enqueueRun(p1.id, 'A', DATE, 1, 0)
  await qdb.enqueueRun(p1.id, 'B', DATE, 1, 0)
  await qdb.enqueueRun(p2.id, 'A', DATE, 2, 0)
  const limits = new Map([['A', 1], ['B', 1]])

  const first = await qdb.claimDueRuns({ date: DATE, nowMs: 1000, limits, maxConcurrentWindows: 1 })
  expect(first).toHaveLength(2)
  expect(new Set(first.map((r) => r.profileId))).toEqual(new Set([p1.id]))
  expect(first.map((r) => r.taskKey).sort()).toEqual(['A', 'B'])

  const second = await qdb.claimDueRuns({ date: DATE, nowMs: 1001, limits, maxConcurrentWindows: 2 })
  expect(second).toHaveLength(1)
  expect(second[0].profileId).toBe(p2.id)
  expect(second[0].taskKey).toBe('A')
})

it('claimDueRuns 不改写终态行', async () => {
  const p = await qdb.upsertProfile('bb-g3', '窗口')
  await qdb.upsertRun(p.id, 'A', DATE, 0, 'success')
  const claimed = await qdb.claimDueRuns({ date: DATE, nowMs: 1000, limits: new Map([['A', 1]]), maxConcurrentWindows: 1 })
  expect(claimed).toHaveLength(0)
  expect((await qdb.getRun(p.id, 'A', DATE, 0))?.status).toBe('success')
})
```

- [ ] **跑测试确认失败**

`npx vitest run tests/db.test.ts`

- [ ] **实现 `claimDueRuns`**

在一个 `client.transaction('write')` 中：

1. 查当天到期、最新 slot 的 pending/retry_wait（复用 `listDueRuns` 的 SQL）。
2. 查 `running` 的 `profile_id/task_key`，构建 `runningProfiles`、`taskActive`、`globalActive`。
3. 按 profile 分组；跳过已有 running 的窗口；`globalActive >= max` 停止；过滤 `taskActive < limits.get(taskKey)`。
4. 选中窗口的 eligible 行，更新 `globalActive/taskActive`。
5. 条件 UPDATE 选中行：

```sql
UPDATE runs
SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL
WHERE id IN (...)
  AND status IN ('pending','retry_wait')
```

6. `rowsAffected !== selected.length` → rollback 返回 `[]`。
7. 返回更新后的行（事务内 `SELECT_RUN WHERE id IN (...)`）。

- [ ] **增加索引**

在 `migrate()` 增加：

```sql
CREATE INDEX IF NOT EXISTS idx_runs_status_date_profile ON runs(status, date, profile_id);
CREATE INDEX IF NOT EXISTS idx_runs_status_date_task ON runs(status, date, task_key);
```

- [ ] **增加 `countRunningProfiles`**

```ts
async countRunningProfiles(date: string): Promise<number> {
  const rows = await this.exec(`SELECT COUNT(DISTINCT profile_id) AS c FROM runs WHERE date = ? AND status = 'running'`, [date])
  return Number(rows[0]?.c ?? 0)
}
```

- [ ] **跑测试与类型检查**

`npx vitest run tests/db.test.ts`、`npm run typecheck`

---

### Task 2: dispatcher 改用 `claimDueRuns`

**Files:**
- Modify: `src/engine/queue.ts`
- Test: `tests/queue.test.ts`、`tests/queue-any-running.test.ts`

**Interfaces:**
- `CoalescingEnqueuer(db, runner, logger, limits: Map<string, number>, maxConcurrentWindows, tickMs?)`
- `enqueue(profile, taskKey, opts?: { immediate?: boolean; batchId?: number; notBeforeMs?: number })`
- `tick()` 只调用 `claimDueRuns`，不再做内存 gate 过滤
- `anyRunning()` → `db.countRunningProfiles(today) > 0`

**Steps:**

- [ ] **改测试构造**

`tests/queue.test.ts` 的 `new CoalescingEnqueuer(...)` 改为传 `new Map([['t1', 2], ['t2', 2]])`，删除 `taskConcurrencyOf` 回调。增加：

```ts
it('两个 dispatcher 共享 DB 时不会同时突破全局上限', async () => {
  const db1 = await AppDb.open(fileUrl)
  const db2 = await AppDb.open(fileUrl)
  // 两个 p1/p2 pending；两个 q 各自 tick；总 claim 窗口数 <= 1
})
```

- [ ] **改 `tick`**

```ts
async tick(): Promise<void> {
  if (this.ticking || this.stopped) return
  this.ticking = true
  try {
    const date = todayStr()
    const claimed = await this.db.claimDueRuns({
      date,
      nowMs: Date.now(),
      limits: this.limits,
      maxConcurrentWindows: this.maxConcurrentWindows,
    })
    if (claimed.length === 0) return
    const profiles = new Map((await this.db.listProfiles(false)).map((p) => [p.id, p]))
    const groups = new Map<number, RunRow[]>()
    for (const row of claimed) {
      const list = groups.get(row.profileId) ?? []
      list.push(row)
      groups.set(row.profileId, list)
    }
    for (const [profileId, rows] of groups) {
      const profile = profiles.get(profileId)
      if (!profile) continue
      void this.runSession(profile, rows)
    }
  } catch (e) {
    this.logger.error({ err: (e as Error).message }, '队列调度异常')
  } finally {
    this.ticking = false
  }
}
```

- [ ] **删除内存 gates**

删除 `gates`、`globalActive`、`activeProfiles`、`gateFor`、`runSession` 的 gate 释放逻辑。`runSession`：

```ts
private async runSession(profile: ProfileRow, rows: RunRow[]): Promise<void> {
  const tasks = rows.map((r) => ({ taskKey: r.taskKey, date: r.date, ...(r.batchId == null ? {} : { batchId: r.batchId }) }))
  try {
    await this.runner.runWindowTasks(profile, tasks)
  } catch (e) {
    await this.safeRequeue(rows, (e as Error).message)
  } finally {
    this.requestDispatch()
  }
}
```

- [ ] **`enqueue` 使用 `notBeforeMs`**

```ts
async enqueue(profile, taskKey, opts = {}): Promise<void> {
  const date = todayStr()
  const notBeforeMs = opts.notBeforeMs ?? await this.pickNotBefore(profile.id, date)
  await this.db.enqueueRun(profile.id, taskKey, date, opts.batchId ?? null, notBeforeMs)
  this.requestDispatch()
}
```

`pickNotBefore` 保留“同窗口 pending 最早时间”，否则 `Date.now()`（错峰由调用方传入；不再在 queue 内随机）。

- [ ] **`app.ts` 传入 limits**

```ts
const limits = new Map([...tasks].map(([key, t]) => [key, t.meta.concurrency ?? DEFAULT_TASK_CONCURRENCY]))
enqueuer = new CoalescingEnqueuer(db, runner, logger, limits, cfg.execution.maxConcurrentWindows)
```

删除原来的 `(key) => tasks.get(key)?.meta.concurrency ?? DEFAULT_TASK_CONCURRENCY` 回调和 `staggerMaxSec` 参数（错峰由触发入口计算后传入）。

- [ ] **`anyRunning` 改 DB**

```ts
async anyRunning(): Promise<boolean> {
  return (await this.db.countRunningProfiles(todayStr())) > 0
}
```

调用方如有同步依赖，改为 `await`（当前无生产调用方）。

- [ ] **跑测试与类型检查**

`npx vitest run tests/queue.test.ts tests/queue-any-running.test.ts`、`npm run typecheck`

---

### Task 3: 错峰纯函数、配置与触发入口

**Files:**
- Create: `src/engine/stagger.ts`
- Create: `tests/stagger.test.ts`
- Modify: `src/infrastructure/config.ts`
- Modify: `src/engine/queue.ts`（`enqueue` 已支持 `notBeforeMs`）
- Modify: `src/server/routes/tasks.ts`、`src/server/routes/batches.ts`、`src/engine/scheduler.ts`、`src/app.ts`
- Test: `tests/web.test.ts`、`tests/scheduler.test.ts`、`tests/stagger.test.ts`

**Interfaces:**
- `staggerNotBefore(opts: { startMs: number; nowMs: number; index: number; count: number; spreadMs: number; jitterPct: number }): number`
- `ExecutionConfig.staggerJitterPct: number`

**Steps:**

- [ ] **写失败测试**

`tests/stagger.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { staggerNotBefore } from '../src/engine/stagger'

describe('staggerNotBefore', () => {
  it('count=1 或 spread=0 时不延迟', () => {
    expect(staggerNotBefore({ startMs: 1000, nowMs: 0, index: 0, count: 1, spreadMs: 120000, jitterPct: 15 })).toBe(1000)
    expect(staggerNotBefore({ startMs: 1000, nowMs: 0, index: 3, count: 10, spreadMs: 0, jitterPct: 15 })).toBe(1000)
  })

  it('均匀分布且不早于 now', () => {
    const base = { startMs: 1000, nowMs: 0, count: 5, spreadMs: 8000, jitterPct: 0 }
    expect(staggerNotBefore({ ...base, index: 0 })).toBe(1000)
    expect(staggerNotBefore({ ...base, index: 4 })).toBe(9000)
    expect(staggerNotBefore({ ...base, index: 4, nowMs: 20000 })).toBe(20000)
  })

  it('抖动在 spacing 的 ±jitterPct 内', () => {
    // 多次采样断言边界；或注入随机函数（推荐给函数增加 rng 可选参数）
  })
})
```

- [ ] **实现纯函数**

`src/engine/stagger.ts`：

```ts
export function staggerNotBefore(opts: {
  startMs: number
  nowMs: number
  index: number
  count: number
  spreadMs: number
  jitterPct: number
  rng?: () => number
}): number {
  if (opts.count <= 1 || opts.spreadMs <= 0) return Math.max(opts.nowMs, opts.startMs)
  const spacing = opts.spreadMs / (opts.count - 1)
  const even = opts.index * spacing
  const jitter = spacing * (opts.jitterPct / 100) * ((opts.rng ?? Math.random)() * 2 - 1)
  return Math.max(opts.nowMs, Math.round(opts.startMs + even + jitter))
}
```

- [ ] **配置 `staggerJitterPct`**

`ExecutionConfig` 增加 `staggerJitterPct: number`；默认 15；`loadConfig` 校验 0-50，非法回退 15。`config/config.json` 增加 `"staggerJitterPct": 15`。

- [ ] **触发入口传入 notBeforeMs**

任务路由：

```ts
const profiles = await deps.db.listProfiles(true)
const startMs = Date.now()
const count = profiles.length
for (let i = 0; i < profiles.length; i++) {
  const notBeforeMs = staggerNotBefore({ startMs, nowMs: Date.now(), index: i, count, spreadMs: deps.stagger.spreadSec * 1000, jitterPct: deps.stagger.jitterPct })
  await deps.enqueuer.enqueue(profiles[i], key, { batchId: batch.id, notBeforeMs })
}
```

手选窗口/失败重跑同理，用选中顺序。单窗口 `immediate` 传 `notBeforeMs: Date.now()`。

定时计划：在 `SchedulerDeps` 增加 `stagger: { spreadSec: number; jitterPct: number }`；`fire` 中**任务循环之前**取一次 `profiles = await listProfiles(true)`、`startMs = Date.now()`、`count = profiles.length`，所有任务共用同一组 plan。

- [ ] **跑测试与类型检查**

`npx vitest run tests/stagger.test.ts tests/web.test.ts tests/scheduler.test.ts`、`npm run typecheck`

---

### Task 4: ETA API 与面板

**Files:**
- Modify: `src/server/routes/batches.ts`（swagger）
- Modify: `web/src/api/schema.d.ts`
- Modify: `web/src/pages/dashboard/format.ts`
- Modify: `web/src/pages/dashboard/index.tsx`
- Test: `web/src/pages/dashboard/format.test.ts`

**Steps:**

- [ ] **API 字段**

`runs` 已经返回 `notBeforeMs`。在 batches 的两处 run schema 增加：

```yaml
notBeforeMs: { type: integer, nullable: true }
```

`web/src/api/schema.d.ts` 的两处 runs/unbatched 增加：

```ts
notBeforeMs?: number | null;
```

- [ ] **格式化函数**

`format.ts`：

```ts
export function formatEta(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
```

测试：null、非法值、固定时间。

- [ ] **看板列**

两处 runs 表增加：

```tsx
{
  title: '预计开始',
  dataIndex: 'notBeforeMs',
  width: 90,
  render: (ms: number | null | undefined, r) =>
    r.status === 'pending' || r.status === 'retry_wait' ? formatEta(ms) : '—',
},
```

- [ ] **跑测试与类型检查**

`npx vitest run web/src/pages/dashboard/format.test.ts`、`npm run test:web`、`npm run typecheck`

---

### Task 5: 文档与全量验证

**Files:**
- Modify: `docs/API-GUIDE.md`、`AGENTS.md`

**Steps:**

- [ ] **API-GUIDE**

补充：

```markdown
### 并发阀门与错峰

- 并发由数据库 claim 事务裁决：全局按 `running` 的 distinct 窗口数，任务级按 `running` 中该 task 的 distinct 窗口数。
- 同一窗口的多个任务共享一次会话；全局窗口额度只算 1。
- 错峰按窗口序号均匀铺开 `staggerMaxSec`，并叠加 `staggerJitterPct` 抖动；`pending/retry_wait` 行可在看板看到预计开始时间。
- 自动重试只使用 `backoffSec`，不叠加初始错峰。
```

- [ ] **AGENTS**

更新并发/错峰描述：

```markdown
- 并发阀门由 `claimDueRuns` DB 事务裁决（running 窗口/任务计数），dispatcher 不再维护内存 gates。
- 错峰为“均匀铺开 + 抖动”，`staggerMaxSec` 是本批总铺开时长；自动重试只用 backoff。
```

- [ ] **全量验证**

```powershell
npm run typecheck
npm test
npm run test:web
```

---

## Self-Review Checklist

- [ ] `queue.ts` 不再有 `gates/globalActive/activeProfiles`。
- [ ] `claimDueRuns` 在同一事务里完成计数 + 过滤 + claim。
- [ ] 两个 dispatcher 共享 DB 不会突破上限。
- [ ] 错峰是均匀节奏 + 抖动，不再是纯随机。
- [ ] 同窗口多任务共享 `not_before_ms`。
- [ ] 重试只用 backoff，不叠加初始错峰。
- [ ] `pending/retry_wait` 有 ETA。
- [ ] `task:run`、停止、跨日、熔断行为不变。
- [ ] 测试与文档同步。

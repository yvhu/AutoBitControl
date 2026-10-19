# 窗口级熔断健康状态机 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有“所有终态失败计数 + 每小时全量清零”的窗口熔断，改成“只计环境级失败 + 冷却/半开探测 + 开窗前拦截”的窗口健康状态机。

**Architecture:** `profiles` 表保存窗口健康状态（`closed/open/half_open`、失败计数、冷却时间、探测租约），`runs` 表保存每次尝试的 `failure_kind`。`WindowRunner` 在开窗前读取健康状态，`open` 未到探测时间直接落 `skipped`，`half_open` 用真实任务探测；任务成功关闭熔断，环境级终态失败按阈值打开熔断，任务级失败不影响窗口健康。

**Tech Stack:** Node + TypeScript（严格模式）、libsql/SQLite、patchright、express、React + antd + react-query、vitest。

**设计依据：** `docs/superpowers/specs/2026-10-19-window-circuit-breaker-design.md`

## Global Constraints

- 全部注释/文档/commit message 用中文。
- 无分号、单引号、2 空格缩进；TS 严格模式。
- TDD：每个任务先写失败测试，再写实现，再跑测试。
- 不提交 `config/.env`、`config/config.local.json`、`config/accounts.xlsx` 等密钥/账号文件。
- 改完每个任务至少跑一次 `npm run typecheck`；全量完成后跑 `npm test` 和 `npm run test:web`。
- 每个任务完成后的 commit 步骤**只有在用户明确同意提交时才执行**；未明确同意时跳过 `git commit`，但不要跳过测试。
- 配置当前值以 `config/config.json` 为准；本计划会把旧的 `circuitBreakerResetEveryHours` 替换为新配置。

---

## File Structure

### 新增

- `src/infrastructure/run-errors.ts`：失败分类枚举与错误类型（环境/任务/超时）。
- `src/engine/failure.ts`：`classifyFailure` 与窗口不健康消息模式。
- `tests/failure.test.ts`：失败分类单测。
- `web/src/pages/profiles/breaker.ts`：窗口熔断展示纯函数。
- `web/src/pages/profiles/breaker.test.ts`：展示纯函数单测。

### 修改

- `src/infrastructure/db.ts`：健康状态字段、迁移、`failure_kind`、健康状态读写方法。
- `src/engine/window-runner.ts`：开窗前健康门禁、失败分类落库、半开探测、`FORCE_BREAKER`。
- `src/engine/maintenance.ts`：只保留每日重置，调用 `resetAllWindowHealth`。
- `src/infrastructure/config.ts`：熔断配置新增/废弃。
- `config/config.json`：配置示例更新。
- `src/automation/wallet/actions.ts`：扩展缺失抛 `WindowUnavailableError`。
- `src/server/routes/profiles.ts`：窗口健康字段、重置语义、Swagger。
- `src/server/routes/settings.ts`：公开熔断配置字段。
- `src/server/routes/batches.ts`：失败重跑用健康状态阻塞、`failureKind` Swagger。
- `src/server/app.ts`：移除 `batchesRouter` 的 `circuitBreakerThreshold` 依赖。
- `web/src/api/schema.d.ts`：手补 profiles/settings/runs 字段。
- `web/src/pages/profiles/index.tsx`：熔断状态标签、重置按钮条件。
- `web/src/pages/profiles/hooks.ts`：`useBreakerSettings`、重置提示。
- `web/src/pages/settings/index.tsx`：展示熔断配置。
- `web/src/pages/dashboard/format.ts`：失败类型文案。
- `web/src/pages/dashboard/index.tsx`：运行明细增加失败类型列。
- `tests/db.test.ts`、`tests/windowRunner.test.ts`、`tests/config.test.ts`、`tests/maintenance.test.ts`、`tests/web.test.ts`。
- `docs/API-GUIDE.md`、`AGENTS.md`。

---

### Task 1: 数据库健康状态与 `failure_kind`

**Files:**
- Create: `src/infrastructure/run-errors.ts`
- Modify: `src/infrastructure/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: 现有 `AppDb`、`localWallNow`、`SCHEMA`、`SELECT_PROFILE`、`SELECT_RUN`。
- Produces:
  - `FailureKind` 类型
  - `CircuitBreakerState = 'closed' | 'open' | 'half_open'`
  - `WindowHealth`、`CircuitBreakerPolicy`
  - `AppDb.getWindowHealth(profileId: number): Promise<WindowHealth>`
  - `AppDb.recordWindowEnvironmentFailure(profileId: number, reason: string, policy: CircuitBreakerPolicy, nowMs?: number): Promise<WindowHealth>`
  - `AppDb.recordWindowSuccess(profileId: number): Promise<WindowHealth>`
  - `AppDb.claimWindowProbe(profileId: number, opts: { leaseMs: number; nowMs?: number }): Promise<boolean>`
  - `AppDb.releaseWindowProbe(profileId: number, outcome: 'retry' | 'aborted', nowMs?: number): Promise<void>`
  - `AppDb.resetWindowHealth(profileId: number): Promise<void>`
  - `AppDb.resetAllWindowHealth(): Promise<number>`

- [ ] **Step 1: 写失败测试**

在 `tests/db.test.ts` 的 `describe('AppDb')` 内追加：

```ts
describe('窗口健康状态', () => {
  const policy = { threshold: 2, cooldownMs: 1800_000, maxCooldownMs: 7200_000 }

  it('默认 closed，环境失败达到阈值后 open，成功重置', async () => {
    const p = await db.upsertProfile('bb-health', '窗口')
    expect((await db.getWindowHealth(p.id)).state).toBe('closed')

    let h = await db.recordWindowEnvironmentFailure(p.id, 'CDP 连接失败', policy, 1000)
    expect(h.state).toBe('closed')
    expect(h.failures).toBe(1)

    h = await db.recordWindowEnvironmentFailure(p.id, 'CDP 连接失败', policy, 2000)
    expect(h.state).toBe('open')
    expect(h.failures).toBe(2)
    expect(h.nextProbeMs).toBe(2000 + 1800_000)
    expect(h.reason).toBe('CDP 连接失败')

    h = await db.recordWindowSuccess(p.id)
    expect(h.state).toBe('closed')
    expect(h.failures).toBe(0)
    expect(h.nextProbeMs).toBeNull()
  })

  it('半开环境失败：等级 +1，冷却翻倍并封顶', async () => {
    const p = await db.upsertProfile('bb-health-half', '窗口')
    await db.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
    await db.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
    expect(await db.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: 2000 + 1800_000 })).toBe(true)

    const h = await db.recordWindowEnvironmentFailure(p.id, '探测失败', policy, 2000 + 1800_000 + 1)
    expect(h.state).toBe('open')
    expect(h.level).toBe(1)
    expect(h.nextProbeMs).toBe(2000 + 1800_000 + 1 + 3600_000)
  })

  it('探测租约：未过期不能重复抢占，retry 释放后保持 half_open', async () => {
    const p = await db.upsertProfile('bb-claim', '窗口')
    await db.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
    await db.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
    const due = 2000 + 1800_000
    expect(await db.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due })).toBe(true)
    expect(await db.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due + 1 })).toBe(false)

    await db.releaseWindowProbe(p.id, 'retry')
    const h = await db.getWindowHealth(p.id)
    expect(h.state).toBe('half_open')
    expect(h.probeStartedMs).toBeNull()
  })

  it('探测中断：退回 open 并 1 分钟后允许再探测', async () => {
    const p = await db.upsertProfile('bb-abort', '窗口')
    await db.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
    await db.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
    const due = 2000 + 1800_000
    await db.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due })
    await db.releaseWindowProbe(p.id, 'aborted', due + 10)
    const h = await db.getWindowHealth(p.id)
    expect(h.state).toBe('open')
    expect(h.nextProbeMs).toBe(due + 10 + 60_000)
  })

  it('resetAllWindowHealth 重置所有非 closed 或计数 > 0 的窗口', async () => {
    const a = await db.upsertProfile('bb-reset-a', 'A')
    const b = await db.upsertProfile('bb-reset-b', 'B')
    await db.recordWindowEnvironmentFailure(a.id, 'e1', policy, 1000)
    await db.recordWindowEnvironmentFailure(a.id, 'e2', policy, 2000)
    await db.recordWindowEnvironmentFailure(b.id, 'e1', policy, 1000)
    expect(await db.resetAllWindowHealth()).toBe(2)
    expect((await db.getWindowHealth(a.id)).state).toBe('closed')
    expect((await db.getWindowHealth(b.id)).failures).toBe(0)
  })
})

describe('runs.failureKind', () => {
  it('写入、读回并在成功时清空', async () => {
    const p = await db.upsertProfile('bb-kind', '窗口')
    const failed = await db.upsertRun(p.id, 't', '2026-10-19', 0, 'failed', { error: 'x', failureKind: 'environment' })
    expect(failed.failureKind).toBe('environment')
    expect((await db.getRunById(failed.id))?.failureKind).toBe('environment')

    const ok = await db.upsertRun(p.id, 't', '2026-10-19', 0, 'success', { failureKind: null })
    expect(ok.failureKind).toBeNull()
  })
})
```

再追加一个迁移测试（放在现有“老库无元数据列”测试附近）：

```ts
it('老库迁移补熔断健康列并一次性清零旧计数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc-breaker-legacy-'))
  const fileUrl = `file:${join(dir, 'legacy.db').split('\\').join('/')}`
  const raw = createClient({ url: fileUrl })
  await raw.execute(`CREATE TABLE profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bitbrowser_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    circuit_breaker_count INTEGER NOT NULL DEFAULT 0
  )`)
  await raw.execute(`CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    task_key TEXT NOT NULL,
    date TEXT NOT NULL,
    slot INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    screenshot TEXT,
    started_at TEXT,
    finished_at TEXT,
    batch_id INTEGER,
    diag_path TEXT,
    UNIQUE(profile_id, task_key, date, slot)
  )`)
  await raw.execute(`INSERT INTO profiles (bitbrowser_id, name, circuit_breaker_count) VALUES ('bb-old', '旧窗口', 2)`)
  raw.close()

  const opened = await AppDb.open(fileUrl)
  try {
    const p = (await opened.listProfiles())[0]
    expect(p.circuitBreakerCount).toBe(0)
    expect(p.circuitBreakerState).toBe('closed')
    expect((await opened.getWindowHealth(p.id)).state).toBe('closed')
    const kind = await opened.upsertRun(p.id, 't', '2026-10-19', 0, 'failed', { failureKind: 'task' })
    expect(kind.failureKind).toBe('task')
  } finally {
    opened.close()
  }
})
```

- [ ] **Step 2: 跑新增测试确认失败**

Run:

```powershell
npx vitest run tests/db.test.ts
```

Expected: FAIL，报 `getWindowHealth is not a function`、`failureKind` 不存在或列不存在。

- [ ] **Step 3: 创建失败分类类型文件**

`src/infrastructure/run-errors.ts`：

```ts
/**
 * 运行失败公共类型（infrastructure 层）：失败分类枚举，供 runs 与 engine 共用
 * 依赖方向：无业务依赖
 */
export type FailureKind = 'environment' | 'task' | 'timeout' | 'stopped' | 'captcha' | 'breaker'
```

- [ ] **Step 4: 扩展 `db.ts` 类型与表结构**

在 `src/infrastructure/db.ts` 顶部加：

```ts
import type { FailureKind } from './run-errors'
```

在 `ProfileRow` 内追加：

```ts
  circuitBreakerCount: number
  circuitBreakerState?: CircuitBreakerState
  circuitBreakerLevel?: number
  circuitBreakerNextProbeMs?: number | null
  circuitBreakerProbeStartedMs?: number | null
  circuitBreakerReason?: string | null
  circuitBreakerUpdatedAt?: string | null
```

在 `RunRow` 内追加：

```ts
  failureKind?: FailureKind | null
```

新增类型（放在 `RunStatus` 附近）：

```ts
/** 窗口熔断状态：closed 正常 / open 熔断 / half_open 探测中 */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

/** 窗口健康状态（窗口级环境熔断） */
export interface WindowHealth {
  state: CircuitBreakerState
  failures: number
  level: number
  nextProbeMs: number | null
  probeStartedMs: number | null
  reason: string | null
  updatedAt: string | null
}

/** 健康状态变更策略（来自 execution 配置） */
export interface CircuitBreakerPolicy {
  threshold: number
  cooldownMs: number
  maxCooldownMs: number
}
```

在 `localWallNow` 附近增加：

```ts
/** epoch 毫秒转本地墙钟字符串（与 localWallNow 同口径，供下次探测时间展示） */
export function localWallFromMs(ms: number): string {
  const d = new Date(ms)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace('T', ' ')
}
```

在 `SCHEMA` 的 `profiles` 表增加列（紧跟 `circuit_breaker_count`）：

```sql
    circuit_breaker_state TEXT NOT NULL DEFAULT 'closed',
    circuit_breaker_level INTEGER NOT NULL DEFAULT 0,
    circuit_breaker_next_probe_ms INTEGER,
    circuit_breaker_probe_started_ms INTEGER,
    circuit_breaker_reason TEXT,
    circuit_breaker_updated_at TEXT,
```

在 `SCHEMA` 的 `runs` 表增加：

```sql
    failure_kind TEXT,
```

在 `SCHEMA` 增加 `app_meta` 表（放在 `task_states` 附近）：

```sql
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
```

更新 `SELECT_PROFILE`：

```ts
const SELECT_PROFILE = `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, circuit_breaker_count AS circuitBreakerCount, circuit_breaker_state AS circuitBreakerState, circuit_breaker_level AS circuitBreakerLevel, circuit_breaker_next_probe_ms AS circuitBreakerNextProbeMs, circuit_breaker_probe_started_ms AS circuitBreakerProbeStartedMs, circuit_breaker_reason AS circuitBreakerReason, circuit_breaker_updated_at AS circuitBreakerUpdatedAt, remark, seq, last_ip AS lastIp, last_country AS lastCountry, core_version AS coreVersion FROM profiles`
```

更新 `SELECT_RUN`，在 `diag_path AS diagPath` 后加：

```ts
, r.failure_kind AS failureKind
```

- [ ] **Step 5: 更新 `upsertRun` 写 `failure_kind`**

把 `upsertRun` 的 INSERT 列表、VALUES、冲突更新和参数补上：

```ts
  async upsertRun(profileId: number, taskKey: string, date: string, slot: number, status: RunStatus, patch: Partial<RunRow> = {}): Promise<RunRow> {
    await this.exec(
      `INSERT INTO runs (profile_id, task_key, date, slot, status, attempts, error, screenshot, started_at, finished_at, batch_id, diag_path, failure_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, task_key, date, slot) DO UPDATE SET
         status = excluded.status,
         attempts = CASE WHEN excluded.attempts = 0 THEN runs.attempts ELSE excluded.attempts END,
         error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at),
         batch_id = COALESCE(excluded.batch_id, runs.batch_id),
         diag_path = COALESCE(excluded.diag_path, runs.diag_path),
         failure_kind = excluded.failure_kind`,
      [profileId, taskKey, date, slot, status, patch.attempts ?? 0, patch.error ?? null, patch.screenshot ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, patch.batchId ?? null, patch.diagPath ?? null, patch.failureKind ?? null],
    )
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ? AND r.slot = ?`, [profileId, taskKey, date, slot])
    return rows[0] as unknown as RunRow
  }
```

- [ ] **Step 6: 增加迁移补列与一次性清零**

在 `migrate()` 的 profiles 补列块后追加：

```ts
    const profileInfo2 = await this.client.execute(`PRAGMA table_info(profiles)`)
    const profileCols = new Set(profileInfo2.rows.map((r) => String(r.name)))
    const newProfileCols: Array<[string, string]> = [
      ['circuit_breaker_state', "TEXT NOT NULL DEFAULT 'closed'"],
      ['circuit_breaker_level', 'INTEGER NOT NULL DEFAULT 0'],
      ['circuit_breaker_next_probe_ms', 'INTEGER'],
      ['circuit_breaker_probe_started_ms', 'INTEGER'],
      ['circuit_breaker_reason', 'TEXT'],
      ['circuit_breaker_updated_at', 'TEXT'],
    ]
    for (const [col, type] of newProfileCols) {
      if (!profileCols.has(col)) await this.client.execute(`ALTER TABLE profiles ADD COLUMN ${col} ${type}`)
    }
```

在 `runs.diag_path` 补列后追加：

```ts
    const runsInfo4 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo4.rows.some((r) => String(r.name) === 'failure_kind')) {
      await this.client.execute(`ALTER TABLE runs ADD COLUMN failure_kind TEXT`)
    }
```

在 `migrate()` 末尾（空投种子之后）追加一次性迁移：

```ts
    await this.client.execute(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    const migrated = await this.client.execute({
      sql: 'SELECT value FROM app_meta WHERE key = ?',
      args: ['circuit_breaker_v2_migrated'],
    })
    if (migrated.rows.length === 0) {
      await this.client.execute(`UPDATE profiles SET circuit_breaker_count = 0, circuit_breaker_state = 'closed', circuit_breaker_level = 0, circuit_breaker_next_probe_ms = NULL, circuit_breaker_probe_started_ms = NULL, circuit_breaker_reason = NULL, circuit_breaker_updated_at = NULL`)
      await this.client.execute({
        sql: 'INSERT INTO app_meta (key, value) VALUES (?, ?)',
        args: ['circuit_breaker_v2_migrated', '1'],
      })
    }
```

- [ ] **Step 7: 增加健康状态读写方法**

在 `db.ts` 的熔断旧方法附近新增：

```ts
  private static toWindowHealth(r: Row | undefined): WindowHealth {
    if (!r) return { state: 'closed', failures: 0, level: 0, nextProbeMs: null, probeStartedMs: null, reason: null, updatedAt: null }
    return {
      state: String(r.state ?? 'closed') as CircuitBreakerState,
      failures: Number(r.failures ?? 0),
      level: Number(r.level ?? 0),
      nextProbeMs: r.nextProbeMs == null ? null : Number(r.nextProbeMs),
      probeStartedMs: r.probeStartedMs == null ? null : Number(r.probeStartedMs),
      reason: r.reason == null ? null : String(r.reason),
      updatedAt: r.updatedAt == null ? null : String(r.updatedAt),
    }
  }

  /** 读取窗口健康状态；窗口不存在时按 closed 处理 */
  async getWindowHealth(profileId: number): Promise<WindowHealth> {
    const rows = await this.exec(
      `SELECT circuit_breaker_state AS state, circuit_breaker_count AS failures, circuit_breaker_level AS level,
              circuit_breaker_next_probe_ms AS nextProbeMs, circuit_breaker_probe_started_ms AS probeStartedMs,
              circuit_breaker_reason AS reason, circuit_breaker_updated_at AS updatedAt
       FROM profiles WHERE id = ?`,
      [profileId],
    )
    return AppDb.toWindowHealth(rows[0])
  }

  /** 记录一次环境级失败；达到阈值或半开失败时打开熔断 */
  async recordWindowEnvironmentFailure(profileId: number, reason: string, policy: CircuitBreakerPolicy, nowMs = Date.now()): Promise<WindowHealth> {
    const tx = await this.client.transaction('write')
    try {
      const rows = await tx.execute({
        sql: `SELECT circuit_breaker_state AS state, circuit_breaker_count AS failures, circuit_breaker_level AS level,
                     circuit_breaker_next_probe_ms AS nextProbeMs, circuit_breaker_probe_started_ms AS probeStartedMs,
                     circuit_breaker_reason AS reason, circuit_breaker_updated_at AS updatedAt
              FROM profiles WHERE id = ?`,
        args: [profileId],
      })
      const current = AppDb.toWindowHealth(rows.rows[0])
      const failures = current.failures + 1
      let state: CircuitBreakerState = current.state
      let level = current.level
      let nextProbeMs = current.nextProbeMs
      let probeStartedMs = current.probeStartedMs

      if (current.state === 'half_open') {
        level = Math.min(level + 1, 2)
        state = 'open'
        nextProbeMs = nowMs + Math.min(policy.cooldownMs * 2 ** level, policy.maxCooldownMs)
        probeStartedMs = null
      } else if (failures >= policy.threshold) {
        state = 'open'
        level = 0
        nextProbeMs = nowMs + policy.cooldownMs
        probeStartedMs = null
      }

      const nextReason = state === 'open' ? reason : current.reason
      const updatedAt = localWallNow()
      await tx.execute({
        sql: `UPDATE profiles SET circuit_breaker_count = ?, circuit_breaker_state = ?, circuit_breaker_level = ?,
                     circuit_breaker_next_probe_ms = ?, circuit_breaker_probe_started_ms = ?,
                     circuit_breaker_reason = ?, circuit_breaker_updated_at = ? WHERE id = ?`,
        args: [failures, state, level, nextProbeMs, probeStartedMs, nextReason, updatedAt, profileId],
      })
      await tx.commit()
      return { state, failures, level, nextProbeMs, probeStartedMs, reason: nextReason, updatedAt }
    } catch (e) {
      await tx.rollback().catch(() => {})
      throw e
    }
  }

  /** 任务成功：关闭熔断并清空计数/等级/冷却 */
  async recordWindowSuccess(profileId: number): Promise<WindowHealth> {
    const updatedAt = localWallNow()
    await this.exec(
      `UPDATE profiles SET circuit_breaker_count = 0, circuit_breaker_state = 'closed', circuit_breaker_level = 0,
              circuit_breaker_next_probe_ms = NULL, circuit_breaker_probe_started_ms = NULL,
              circuit_breaker_reason = NULL, circuit_breaker_updated_at = ? WHERE id = ?`,
      [updatedAt, profileId],
    )
    return { state: 'closed', failures: 0, level: 0, nextProbeMs: null, probeStartedMs: null, reason: null, updatedAt }
  }

  /** 原子抢占探测租约；open 到期或 half_open 租约空闲时成功 */
  async claimWindowProbe(profileId: number, opts: { leaseMs: number; nowMs?: number }): Promise<boolean> {
    const now = opts.nowMs ?? Date.now()
    const staleBefore = now - opts.leaseMs
    const rs = await this.client.execute({
      sql: `UPDATE profiles SET circuit_breaker_state = 'half_open', circuit_breaker_probe_started_ms = ?, circuit_breaker_updated_at = ?
            WHERE id = ? AND (
              (circuit_breaker_state = 'open' AND (circuit_breaker_next_probe_ms IS NULL OR circuit_breaker_next_probe_ms <= ?))
              OR (circuit_breaker_state = 'half_open' AND (circuit_breaker_probe_started_ms IS NULL OR circuit_breaker_probe_started_ms <= ?))
            )`,
      args: [now, localWallNow(), profileId, now, staleBefore],
    })
    return Number(rs.rowsAffected) > 0
  }

  /** 释放探测租约：retry 保持 half_open；aborted 退回 open 并 1 分钟后重试 */
  async releaseWindowProbe(profileId: number, outcome: 'retry' | 'aborted', nowMs = Date.now()): Promise<void> {
    const updatedAt = localWallNow()
    if (outcome === 'retry') {
      await this.exec(
        `UPDATE profiles SET circuit_breaker_probe_started_ms = NULL, circuit_breaker_updated_at = ?
         WHERE id = ? AND circuit_breaker_state = 'half_open'`,
        [updatedAt, profileId],
      )
      return
    }
    await this.exec(
      `UPDATE profiles SET circuit_breaker_state = 'open', circuit_breaker_next_probe_ms = ?,
              circuit_breaker_probe_started_ms = NULL, circuit_breaker_updated_at = ?
       WHERE id = ? AND circuit_breaker_state = 'half_open'`,
      [nowMs + 60_000, updatedAt, profileId],
    )
  }

  /** 手动重置单个窗口健康状态 */
  async resetWindowHealth(profileId: number): Promise<void> {
    await this.exec(
      `UPDATE profiles SET circuit_breaker_count = 0, circuit_breaker_state = 'closed', circuit_breaker_level = 0,
              circuit_breaker_next_probe_ms = NULL, circuit_breaker_probe_started_ms = NULL,
              circuit_breaker_reason = NULL, circuit_breaker_updated_at = ? WHERE id = ?`,
      [localWallNow(), profileId],
    )
  }

  /** 每日重置所有窗口健康状态；返回变更行数 */
  async resetAllWindowHealth(): Promise<number> {
    const rs = await this.client.execute({
      sql: `UPDATE profiles SET circuit_breaker_count = 0, circuit_breaker_state = 'closed', circuit_breaker_level = 0,
                   circuit_breaker_next_probe_ms = NULL, circuit_breaker_probe_started_ms = NULL,
                   circuit_breaker_reason = NULL, circuit_breaker_updated_at = ?
            WHERE circuit_breaker_state <> 'closed' OR circuit_breaker_count > 0`,
      args: [localWallNow()],
    })
    return Number(rs.rowsAffected ?? 0)
  }
```

- [ ] **Step 8: 跑测试确认通过**

Run:

```powershell
npx vitest run tests/db.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 9: Commit**

```powershell
git add src/infrastructure/run-errors.ts src/infrastructure/db.ts tests/db.test.ts
git commit -m "feat: 窗口熔断健康状态存取与迁移"
```

---

### Task 2: 失败分类与环境错误类型

**Files:**
- Modify: `src/infrastructure/run-errors.ts`
- Create: `src/engine/failure.ts`
- Modify: `src/automation/wallet/actions.ts`
- Test: `tests/failure.test.ts`（新建）

**Interfaces:**
- Consumes: `FailureKind`（Task 1）
- Produces:
  - `WindowUnavailableError`、`TaskExecutionError`、`TaskTimeoutError`
  - `FailureStage = 'open' | 'connect' | 'task'`
  - `classifyFailure(stage: FailureStage, error: unknown): FailureKind`

- [ ] **Step 1: 写失败测试**

`tests/failure.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { classifyFailure } from '../src/engine/failure'
import { TaskExecutionError, TaskTimeoutError, WindowUnavailableError } from '../src/infrastructure/run-errors'

describe('classifyFailure', () => {
  it('显式窗口错误归为 environment', () => {
    expect(classifyFailure('task', new WindowUnavailableError('Target closed'))).toBe('environment')
  })

  it('显式任务错误归为 task', () => {
    expect(classifyFailure('task', new TaskExecutionError('选择器失效'))).toBe('task')
  })

  it('超时归为 timeout', () => {
    expect(classifyFailure('task', new TaskTimeoutError('任务超时'))).toBe('timeout')
  })

  it('开窗/CDP 阶段默认 environment', () => {
    expect(classifyFailure('open', new Error('open boom'))).toBe('environment')
    expect(classifyFailure('connect', new Error('connect boom'))).toBe('environment')
  })

  it('常见窗口/网络消息归为 environment', () => {
    for (const message of [
      'Protocol error',
      'Target closed',
      'session closed',
      '钱包扩展未加载',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'ECONNREFUSED',
    ]) {
      expect(classifyFailure('task', new Error(message))).toBe('environment')
    }
  })

  it('未知错误默认 task', () => {
    expect(classifyFailure('task', new Error('选择器没找到'))).toBe('task')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/failure.test.ts`

Expected: FAIL，模块/类不存在。

- [ ] **Step 3: 扩展错误类型**

把 `src/infrastructure/run-errors.ts` 改成：

```ts
/**
 * 运行失败公共类型（infrastructure 层）：失败分类枚举与错误类型
 * 依赖方向：无业务依赖；被 engine/automation 使用
 */
export type FailureKind = 'environment' | 'task' | 'timeout' | 'stopped' | 'captcha' | 'breaker'

export class WindowUnavailableError extends Error {
  readonly kind: FailureKind = 'environment'

  constructor(message: string) {
    super(message)
    this.name = 'WindowUnavailableError'
  }
}

export class TaskExecutionError extends Error {
  readonly kind: FailureKind = 'task'

  constructor(message: string) {
    super(message)
    this.name = 'TaskExecutionError'
  }
}

export class TaskTimeoutError extends Error {
  readonly kind: FailureKind = 'timeout'

  constructor(message: string) {
    super(message)
    this.name = 'TaskTimeoutError'
  }
}
```

- [ ] **Step 4: 增加分类函数**

`src/engine/failure.ts`：

```ts
/**
 * 任务失败分类（engine 层）：把一次失败归为环境/任务/超时
 * 依赖方向：依赖 infrastructure/run-errors；被 window-runner 使用
 */
import { TaskExecutionError, TaskTimeoutError, WindowUnavailableError, type FailureKind } from '../infrastructure/run-errors'

export type FailureStage = 'open' | 'connect' | 'task'

const WINDOW_UNHEALTHY_PATTERN = new RegExp(
  [
    'Protocol error',
    'session closed',
    'Target page',
    'Target closed',
    'target crashed',
    'browser has been closed',
    '钱包扩展未加载',
    '窗口 .* 已关闭',
    'net::ERR_PROXY',
    'net::ERR_TUNNEL',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NAME_NOT_RESOLVED',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'socket hang up',
  ].join('|'),
  'i',
)

/**
 * 分类一次失败：
 * 1. 显式错误类型优先；
 * 2. 开窗/CDP 阶段默认环境失败；
 * 3. 消息命中窗口/网络模式按环境失败；
 * 4. 其余默认任务失败（宁可漏熔断，不误熔断）。
 */
export function classifyFailure(stage: FailureStage, error: unknown): FailureKind {
  if (error instanceof WindowUnavailableError) return 'environment'
  if (error instanceof TaskTimeoutError) return 'timeout'
  if (error instanceof TaskExecutionError) return 'task'
  if (stage === 'open' || stage === 'connect') return 'environment'
  const message = error instanceof Error ? error.message : String(error)
  return WINDOW_UNHEALTHY_PATTERN.test(message) ? 'environment' : 'task'
}
```

- [ ] **Step 5: 扩展缺失抛窗口错误**

`src/automation/wallet/actions.ts` 顶部加：

```ts
import { WindowUnavailableError } from '../../infrastructure/run-errors'
```

把：

```ts
if (state === 'missing') throw new Error(`窗口 ${key} 钱包扩展未加载（重试将重启浏览器窗口）`)
```

改成：

```ts
if (state === 'missing') throw new WindowUnavailableError(`窗口 ${key} 钱包扩展未加载（重试将重启浏览器窗口）`)
```

- [ ] **Step 6: 跑测试确认通过**

Run:

```powershell
npx vitest run tests/failure.test.ts tests/wallet-actions.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add src/infrastructure/run-errors.ts src/engine/failure.ts src/automation/wallet/actions.ts tests/failure.test.ts
git commit -m "feat: 失败分类与环境错误类型"
```

---

### Task 3: WindowRunner 接入健康状态机

**Files:**
- Modify: `src/engine/window-runner.ts`
- Test: `tests/windowRunner.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AppDb` 健康方法、Task 2 的 `classifyFailure` / `TaskTimeoutError`。
- Produces:
  - `runWindowTasks` 开窗前健康门禁
  - `runTask` 写入 `failureKind`
  - `FORCE_BREAKER=1` 调试逃生
  - `settleWindowSkip(..., failureKind?)`

- [ ] **Step 1: 更新测试共享夹具**

在 `tests/windowRunner.test.ts` 顶部增加：

```ts
const closedHealth = { state: 'closed' as const, failures: 0, level: 0, nextProbeMs: null, probeStartedMs: null, reason: null, updatedAt: null }
```

在 `makeDb` 中增加：

```ts
    getWindowHealth: vi.fn().mockResolvedValue(closedHealth),
    claimWindowProbe: vi.fn().mockResolvedValue(true),
    releaseWindowProbe: vi.fn().mockResolvedValue(undefined),
    recordWindowEnvironmentFailure: vi.fn().mockResolvedValue(closedHealth),
    recordWindowSuccess: vi.fn().mockResolvedValue(closedHealth),
    resetWindowHealth: vi.fn().mockResolvedValue(undefined),
```

把 `upsertRun` 的默认假件改成返回可读的运行行（熔断判断依赖 `row.status` / `row.failureKind`）：

```ts
    upsertRun: vi.fn(async (profileId: number, taskKey: string, date: string, slot: number, status: string, patch: Record<string, unknown> = {}) => ({
      id: 1,
      profileId,
      taskKey,
      date,
      slot,
      status,
      attempts: Number(patch.attempts ?? 0),
      error: (patch.error as string | null | undefined) ?? null,
      screenshot: (patch.screenshot as string | null | undefined) ?? null,
      startedAt: (patch.startedAt as string | null | undefined) ?? null,
      finishedAt: (patch.finishedAt as string | null | undefined) ?? null,
      batchId: (patch.batchId as number | null | undefined) ?? null,
      diagPath: (patch.diagPath as string | null | undefined) ?? null,
      failureKind: (patch.failureKind as string | null | undefined) ?? null,
      profileName: '窗口1',
      bitbrowserId: 'bb-1',
    })),
```

如果个别用例覆盖 `upsertRun`，保留覆盖值；新增熔断用例需要真实返回行，不能再统一返回 `null`。

`bitbrowser` 共享假件增加：

```ts
  health: vi.fn().mockResolvedValue(true),
```

`cfg.execution` 增加：

```ts
circuitBreakerEnabled: true,
circuitBreakerCooldownSec: 1800,
circuitBreakerMaxCooldownSec: 7200,
```

把旧断言改成新方法：

- `expect(db.incrCircuitBreaker).toHaveBeenCalledWith(1)` 改为 `expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()`（`FailTask` 的 `boom` 是任务失败）。
- 其余 `expect(db.incrCircuitBreaker).not.toHaveBeenCalled()` 改为 `expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()`。
- 假库底部的 `resetCircuitBreaker` / `incrCircuitBreaker` 改为：

```ts
    resetWindowHealth: async () => undefined,
    recordWindowEnvironmentFailure: async () => closedHealth,
    recordWindowSuccess: async () => closedHealth,
```

- [ ] **Step 2: 增加 runner 新行为测试**

在 `describe('WindowRunner')` 内追加：

```ts
it('open 且未到探测时间：不开窗，任务落 skipped', async () => {
  const db = makeDb({
    getWindowHealth: vi.fn().mockResolvedValue({
      ...closedHealth,
      state: 'open',
      failures: 2,
      nextProbeMs: Date.now() + 60_000,
      reason: 'CDP 连接失败',
    }),
  })
  const runner = makeRunner({ db })
  await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
  expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
  const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
  expect(calls.at(-1)![4]).toBe('skipped')
  expect(calls.at(-1)![5].failureKind).toBe('breaker')
  expect(String(calls.at(-1)![5].error)).toContain('下次探测')
})

it('open 到期：抢占 half_open 并执行探测任务，成功后关闭熔断', async () => {
  const db = makeDb({
    getWindowHealth: vi.fn().mockResolvedValue({
      ...closedHealth,
      state: 'open',
      failures: 2,
      nextProbeMs: Date.now() - 1,
      reason: 'CDP 连接失败',
    }),
  })
  const runner = makeRunner({ db })
  await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
  expect(db.claimWindowProbe).toHaveBeenCalled()
  expect(db.recordWindowSuccess).toHaveBeenCalled()
  expect(bitbrowser.openBrowser).toHaveBeenCalled()
})

it('closed 下任务失败不计熔断；环境终态失败才计', async () => {
  const db = makeDb()
  const runner = makeRunner({ db })
  await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
  expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()

  class WindowFailTask implements SiteTask {
    meta = { key: 'window-fail', name: 'WF', url: 'https://x.io' }
    run = vi.fn().mockRejectedValue(new Error('Target closed'))
  }
  const db2 = makeDb({
    getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>),
    recordWindowEnvironmentFailure: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() + 60_000, reason: 'Target closed' }),
  })
  const runner2 = makeRunner({ db: db2, tasks: new Map([['window-fail', new WindowFailTask()]]) })
  await runner2.runWindowTasks(makeProfile(), [{ taskKey: 'window-fail' }])
  expect(db2.recordWindowEnvironmentFailure).toHaveBeenCalled()
})

it('half_open 环境失败进入 retry_wait：保持 half_open、释放 retry 租约、剩余任务跳过', async () => {
  const db = makeDb({
    getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'half_open', failures: 2, reason: 'Target closed' }),
  })
  class WindowFailTask implements SiteTask {
    meta = { key: 'window-fail', name: 'WF', url: 'https://x.io' }
    run = vi.fn().mockRejectedValue(new Error('Target closed'))
  }
  const ok = new OkTask()
  const runner = makeRunner({ db, tasks: new Map([['window-fail', new WindowFailTask()], ['ok-task', ok]]) })
  await runner.runWindowTasks(makeProfile(), [{ taskKey: 'window-fail' }, { taskKey: 'ok-task' }])
  expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
  expect(db.releaseWindowProbe).toHaveBeenCalledWith(1, 'retry')
  expect(ok.run).not.toHaveBeenCalled()
})

it('half_open 任务级失败视为窗口可用，关闭熔断', async () => {
  const db = makeDb({
    getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'half_open', failures: 2 }),
  })
  const runner = makeRunner({ db })
  await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
  expect(db.recordWindowSuccess).toHaveBeenCalled()
  expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
})

it('half_open 环境终态失败：打开熔断并跳过剩余任务', async () => {
  class WindowFailTask implements SiteTask {
    meta = { key: 'window-fail', name: 'WF', url: 'https://x.io' }
    run = vi.fn().mockRejectedValue(new Error('Target closed'))
  }
  const db = makeDb({
    getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'half_open', failures: 2 }),
    getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>),
    recordWindowEnvironmentFailure: vi.fn().mockResolvedValue({
      ...closedHealth,
      state: 'open',
      failures: 3,
      nextProbeMs: Date.now() + 60_000,
      reason: 'Target closed',
    }),
  })
  const ok = new OkTask()
  const runner = makeRunner({ db, tasks: new Map([['window-fail', new WindowFailTask()], ['ok-task', ok]]) })
  await runner.runWindowTasks(makeProfile(), [{ taskKey: 'window-fail' }, { taskKey: 'ok-task' }])
  expect(db.recordWindowEnvironmentFailure).toHaveBeenCalled()
  expect(ok.run).not.toHaveBeenCalled()
})

it('开窗失败：全局健康时记环境失败；全局不健康时不记', async () => {
  const unhealthyDb = makeDb()
  const unhealthyBb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')), health: vi.fn().mockResolvedValue(false) }
  const runner1 = makeRunner({ db: unhealthyDb, bitbrowser: unhealthyBb })
  await runner1.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
  expect(unhealthyDb.recordWindowEnvironmentFailure).not.toHaveBeenCalled()

  const healthyDb = makeDb()
  const healthyBb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')), health: vi.fn().mockResolvedValue(true) }
  const runner2 = makeRunner({ db: healthyDb, bitbrowser: healthyBb })
  await runner2.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
  expect(healthyDb.recordWindowEnvironmentFailure).toHaveBeenCalled()
})

it('FORCE_BREAKER=1 绕过 open 拦截', async () => {
  process.env.FORCE_BREAKER = '1'
  try {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() + 60_000 }),
    })
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bitbrowser.openBrowser).toHaveBeenCalled()
  } finally {
    delete process.env.FORCE_BREAKER
  }
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/windowRunner.test.ts`

Expected: FAIL，新增断言/方法未实现。

- [ ] **Step 4: 更新 import 与常量**

在 `src/engine/window-runner.ts` 顶部增加：

```ts
import { classifyFailure } from './failure'
import { localWallFromMs, type CircuitBreakerPolicy, type WindowHealth } from '../infrastructure/db'
import { TaskTimeoutError, type FailureKind } from '../infrastructure/run-errors'
```

删除 `shouldSkipAfterBreaker` 的 import（如未使用）。

在常量区增加：

```ts
const CLOSED_WINDOW_HEALTH: WindowHealth = {
  state: 'closed',
  failures: 0,
  level: 0,
  nextProbeMs: null,
  probeStartedMs: null,
  reason: null,
  updatedAt: null,
}
const DEFAULT_BREAKER_THRESHOLD = 2
const DEFAULT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000
const DEFAULT_BREAKER_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000
const PROBE_LEASE_EXTRA_MS = 5 * 60 * 1000
```

- [ ] **Step 5: 增加 runner 辅助方法**

在 `WindowRunner` 内增加：

```ts
  private breakerEnabled(): boolean {
    return this.deps.cfg.execution.circuitBreakerEnabled !== false
  }

  private forceBreaker(): boolean {
    return process.env.FORCE_BREAKER === '1'
  }

  private breakerPolicy(): CircuitBreakerPolicy {
    const e = this.deps.cfg.execution
    const threshold = Number.isInteger(e.circuitBreakerThreshold) && e.circuitBreakerThreshold >= 1
      ? e.circuitBreakerThreshold
      : DEFAULT_BREAKER_THRESHOLD
    const cooldownMs = Number.isFinite(e.circuitBreakerCooldownSec) && e.circuitBreakerCooldownSec >= 60
      ? e.circuitBreakerCooldownSec * 1000
      : DEFAULT_BREAKER_COOLDOWN_MS
    const maxCooldownMs = Number.isFinite(e.circuitBreakerMaxCooldownSec) && e.circuitBreakerMaxCooldownSec * 1000 >= cooldownMs
      ? e.circuitBreakerMaxCooldownSec * 1000
      : DEFAULT_BREAKER_MAX_COOLDOWN_MS
    return { threshold, cooldownMs, maxCooldownMs }
  }

  private probeLeaseMs(): number {
    return this.deps.cfg.execution.windowTimeoutMs + PROBE_LEASE_EXTRA_MS
  }

  private async bitbrowserHealthy(): Promise<boolean> {
    const fn = this.deps.bitbrowser.health
    if (typeof fn !== 'function') return true
    try {
      return await fn.call(this.deps.bitbrowser)
    } catch {
      return false
    }
  }

  private breakerSkipReason(health: WindowHealth): string {
    const next = health.nextProbeMs == null ? '待定' : localWallFromMs(health.nextProbeMs)
    return `窗口熔断：${health.reason ?? '环境失败'}（下次探测 ${next}）`
  }

  private async skipAllAsBreaker(profile: ProfileRow, tasks: SessionTask[], date: string, reason: string): Promise<Map<string, RunRow | null>> {
    const results = new Map<string, RunRow | null>()
    for (const t of tasks) {
      results.set(t.taskKey, await this.settleWindowSkip(profile, t.taskKey, date, 'skipped', reason, 'breaker'))
    }
    return results
  }

  private async recordWindowFailure(profile: ProfileRow, reason: string): Promise<WindowHealth | null> {
    if (!this.breakerEnabled() || this.forceBreaker()) return null
    return this.safeDb(() => this.deps.db.recordWindowEnvironmentFailure(profile.id, reason, this.breakerPolicy()), null)
  }
```

- [ ] **Step 6: 替换 `runWindowTasks` 的健康门禁与任务循环**

在预写 pending 之后、`let open: OpenResult | null = null` 之前插入：

```ts
    const breakerOn = this.breakerEnabled() && !this.forceBreaker()
    let health: WindowHealth = CLOSED_WINDOW_HEALTH
    let probeClaimed = false
    let probeRetryReleased = false
    if (breakerOn) {
      health = await this.safeDb(() => db.getWindowHealth(profile.id), CLOSED_WINDOW_HEALTH)
      if (health.state === 'open' && health.nextProbeMs != null && health.nextProbeMs > Date.now()) {
        return await this.skipAllAsBreaker(profile, runTasks, date, this.breakerSkipReason(health))
      }
      if (health.state === 'open' || health.state === 'half_open') {
        const claimed = await this.safeDb(() => db.claimWindowProbe(profile.id, { leaseMs: this.probeLeaseMs() }), false)
        if (!claimed) {
          return await this.skipAllAsBreaker(profile, runTasks, date, `窗口熔断：探测进行中（${health.reason ?? '环境异常'}）`)
        }
        probeClaimed = true
        health = { ...health, state: 'half_open' }
      }
    }
```

开窗 `catch` 块改为：

```ts
    } catch (e) {
      const message = `开窗失败: ${(e as Error).message}`
      if (breakerOn && await this.bitbrowserHealthy()) {
        health = (await this.recordWindowFailure(profile, message)) ?? health
      }
      for (const t of runTasks) {
        results.set(t.taskKey, await this.settleWindowSkip(profile, t.taskKey, date, 'skipped', message, 'environment'))
      }
      this.scheduleFallbackClose(profile.bitbrowserId)
      if (probeClaimed && !probeRetryReleased) {
        await this.safeDb(() => db.releaseWindowProbe(profile.id, 'aborted'), undefined)
        probeClaimed = false
      }
      logger.warn({ profile: profile.name }, '开窗重试耗尽，本轮跳过')
      return results
    }
```

CDP 连接 `catch` 改为：

```ts
      } catch (e) {
        const message = `CDP 连接失败: ${(e as Error).message}`
        if (breakerOn) health = (await this.recordWindowFailure(profile, message)) ?? health
        for (const t of runTasks) {
          results.set(t.taskKey, await this.settleWindowSkip(profile, t.taskKey, date, 'failed', message, 'environment'))
        }
        if (probeClaimed && !probeRetryReleased) {
          await this.safeDb(() => db.releaseWindowProbe(profile.id, 'aborted'), undefined)
          probeClaimed = false
        }
        logger.error({ profile: profile.name }, message)
        return results
      }
```

把任务循环替换为：

```ts
      for (let i = 0; i < runTasks.length; i++) {
        const key = runTasks[i].taskKey
        if (Date.now() >= deadline) {
          for (const rest of runTasks.slice(i)) {
            results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', '窗口超时', 'timeout'))
          }
          logger.warn({ profile: profile.name }, '窗口超时，剩余任务跳过')
          break
        }
        if (breakerOn && health.state === 'open') {
          for (const rest of runTasks.slice(i)) {
            results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', this.breakerSkipReason(health), 'breaker'))
          }
          break
        }
        const row = await this.runTask(profile, key, page, date, walletSession)
        results.set(key, row)
        if (!breakerOn || !row) continue

        if (row.status === 'success') {
          health = await this.safeDb(() => db.recordWindowSuccess(profile.id), health)
          continue
        }
        if (row.status === 'failed' && row.failureKind === 'environment') {
          health = (await this.recordWindowFailure(profile, row.error ?? '环境失败')) ?? health
        } else if (health.state === 'half_open' && (row.status === 'failed' || row.status === 'retry_wait') && (row.failureKind === 'task' || row.failureKind === 'timeout')) {
          health = await this.safeDb(() => db.recordWindowSuccess(profile.id), health)
        } else if (health.state === 'half_open' && row.status === 'retry_wait' && row.failureKind === 'environment') {
          await this.safeDb(() => db.releaseWindowProbe(profile.id, 'retry'), undefined)
          probeRetryReleased = true
          for (const rest of runTasks.slice(i + 1)) {
            results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', '窗口探测环境失败，等待重试', 'breaker'))
          }
          break
        }

        if (health.state === 'open') {
          for (const rest of runTasks.slice(i + 1)) {
            results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', this.breakerSkipReason(health), 'breaker'))
          }
          break
        }
      }
```

在 `finally` 末尾追加：

```ts
      if (probeClaimed && !probeRetryReleased) {
        await this.safeDb(() => db.releaseWindowProbe(profile.id, 'aborted'), undefined)
      }
```

- [ ] **Step 7: 更新 `runTask` 分类与 `failureKind`**

在 `runTask` 的 `catch (e)` 内、计算 `status` 前加：

```ts
        const failureKind = classifyFailure('task', e)
```

成功分支的 `upsertRun` 改为：

```ts
        const row = await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'success', { error: null, screenshot: shot, finishedAt, failureKind: null }), null)
```

并删除：

```ts
        await this.safeDb(() => db.resetCircuitBreaker(profile.id), undefined)
```

取消分支的 `upsertRun` 改为：

```ts
          const row = await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'skipped', { error: '手动停止', finishedAt: localWallNow(), failureKind: 'stopped' }), null)
```

未注册任务两处 `upsertRun` 的 patch 加：

```ts
failureKind: 'task'
```

重试预算耗尽分支的 patch 改为：

```ts
        return this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'failed', { error: '重试次数已耗尽', finishedAt: localWallNow(), failureKind: existing?.failureKind ?? 'task' }), null)
```

失败分支的 `upsertRun` 改为：

```ts
        const row = await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, status, { error: (e as Error).message, screenshot: shot, diagPath, finishedAt: localWallNow(), failureKind }), null)
```

删除：

```ts
        await this.safeDb(() => db.incrCircuitBreaker(profile.id), profile.circuitBreakerCount)
```

- [ ] **Step 8: 给 `settleWindowSkip` 增加 `failureKind`**

签名改为：

```ts
  private async settleWindowSkip(profile: ProfileRow, taskKey: string, date: string, status: 'skipped' | 'failed', error: string, failureKind?: FailureKind): Promise<RunRow | null> {
```

两处 `upsertRun` patch 加：

```ts
failureKind
```

- [ ] **Step 9: `withTimeout` 抛 `TaskTimeoutError`**

把：

```ts
timer = setTimeout(() => reject(new Error(message)), ms)
```

改为：

```ts
timer = setTimeout(() => reject(new TaskTimeoutError(message)), ms)
```

- [ ] **Step 10: 跑测试与类型检查**

Run:

```powershell
npx vitest run tests/windowRunner.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 11: Commit**

```powershell
git add src/engine/window-runner.ts tests/windowRunner.test.ts
git commit -m "feat: 窗口熔断状态机接入执行器"
```

---

### Task 4: 配置与每日重置

**Files:**
- Modify: `src/infrastructure/config.ts`
- Modify: `src/engine/maintenance.ts`
- Modify: `config/config.json`
- Test: `tests/config.test.ts`
- Test: `tests/maintenance.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resetAllWindowHealth`。
- Produces:
  - `ExecutionConfig.circuitBreakerEnabled`
  - `ExecutionConfig.circuitBreakerCooldownSec`
  - `ExecutionConfig.circuitBreakerMaxCooldownSec`
  - 移除 `circuitBreakerResetEveryHours`

- [ ] **Step 1: 更新配置测试**

在 `tests/config.test.ts` 中：

- 删除 `circuitBreakerResetEveryHours` 相关 3 个用例（默认 0、env 覆盖、非法值）。
- 增加：

```ts
it('熔断新配置默认值正确', () => {
  const cfg = loadConfig({ rootDir: dir })
  expect(cfg.execution.circuitBreakerEnabled).toBe(true)
  expect(cfg.execution.circuitBreakerThreshold).toBe(2)
  expect(cfg.execution.circuitBreakerCooldownSec).toBe(1800)
  expect(cfg.execution.circuitBreakerMaxCooldownSec).toBe(7200)
  expect(cfg.execution.circuitBreakerResetAt).toBe('23:59')
})
```

- [ ] **Step 2: 更新 maintenance 测试**

`tests/maintenance.test.ts`：

- 删除 `everyHours>0` 用例。
- 把 `resetMeltedCircuitBreakers` mock 改为 `resetAllWindowHealth`：

```ts
const db = { resetAllWindowHealth: vi.fn() } as never
```

```ts
const reset = vi.fn().mockResolvedValue(3)
const db = { resetAllWindowHealth: reset } as never
```

- [ ] **Step 3: 跑测试确认失败**

Run:

```powershell
npx vitest run tests/config.test.ts tests/maintenance.test.ts
```

Expected: FAIL，新字段/方法不存在。

- [ ] **Step 4: 修改 `ExecutionConfig` 与默认值**

`src/infrastructure/config.ts` 的 `ExecutionConfig`：

```ts
  circuitBreakerEnabled: boolean
  circuitBreakerThreshold: number
  circuitBreakerCooldownSec: number
  circuitBreakerMaxCooldownSec: number
  circuitBreakerResetAt: string
```

删除 `circuitBreakerResetEveryHours`。

默认值：

```ts
    circuitBreakerEnabled: true,
    circuitBreakerThreshold: 2,
    circuitBreakerCooldownSec: 1800,
    circuitBreakerMaxCooldownSec: 7200,
    circuitBreakerResetAt: '23:59',
```

删除默认值里的 `circuitBreakerResetEveryHours`。

- [ ] **Step 5: 配置校验**

在 `loadConfig` 的路径解析前加：

```ts
  const cb = cfg.execution
  if (typeof cb.circuitBreakerEnabled !== 'boolean') cb.circuitBreakerEnabled = true
  if (!Number.isInteger(cb.circuitBreakerThreshold) || cb.circuitBreakerThreshold < 1) cb.circuitBreakerThreshold = 2
  if (!Number.isFinite(cb.circuitBreakerCooldownSec) || cb.circuitBreakerCooldownSec < 60) cb.circuitBreakerCooldownSec = 1800
  if (!Number.isFinite(cb.circuitBreakerMaxCooldownSec) || cb.circuitBreakerMaxCooldownSec < cb.circuitBreakerCooldownSec) {
    cb.circuitBreakerMaxCooldownSec = Math.max(cb.circuitBreakerCooldownSec, 7200)
  }
```

删除 `CIRCUIT_BREAKER_RESET_EVERY_HOURS` 环境变量处理块。

- [ ] **Step 6: `maintenance.ts` 只保留每日重置**

把 `startCircuitBreakerResetSchedule` 改为：

```ts
export function startCircuitBreakerResetSchedule(cfg: AppConfig, db: AppDb, logger: Logger): { stop(): void } {
  const at = cfg.execution.circuitBreakerResetAt
  const tz = cfg.scheduler.timezone
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const reset = async (label: string): Promise<void> => {
    try {
      const n = await db.resetAllWindowHealth()
      logger.info({ reset: n }, `${label}完成`)
    } catch (e) {
      logger.warn({ err: (e as Error).message }, `${label}失败`)
    }
  }

  const scheduleDaily = (): void => {
    if (stopped || !at) return
    const ms = msUntilNext(at, tz)
    if (ms < 0) {
      logger.warn({ at }, 'circuitBreakerResetAt 非法，跳过一次重置排程')
      return
    }
    timer = setTimeout(() => {
      void (async () => {
        await reset('熔断每日重置')
        scheduleDaily()
      })()
    }, ms === 0 ? 1000 : ms)
  }

  if (at) scheduleDaily()
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
}
```

更新文件头注释，删除 `circuitBreakerResetEveryHours` 说明。

- [ ] **Step 7: 更新 `config/config.json`**

把：

```json
    "circuitBreakerResetEveryHours": 1,
```

替换为：

```json
    "circuitBreakerEnabled": true,
    "circuitBreakerCooldownSec": 1800,
    "circuitBreakerMaxCooldownSec": 7200,
    "circuitBreakerResetAt": "23:59",
```

- [ ] **Step 8: 跑测试与类型检查**

Run:

```powershell
npx vitest run tests/config.test.ts tests/maintenance.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 9: Commit**

```powershell
git add src/infrastructure/config.ts src/engine/maintenance.ts config/config.json tests/config.test.ts tests/maintenance.test.ts
git commit -m "feat: 熔断冷却配置与每日重置"
```

---

### Task 5: API 字段与失败重跑阻塞

**Files:**
- Modify: `src/server/routes/profiles.ts`
- Modify: `src/server/routes/settings.ts`
- Modify: `src/server/routes/batches.ts`
- Modify: `src/server/app.ts`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: Task 1 的健康字段与方法。
- Produces:
  - `GET /api/profiles` 返回 `breakerState`、`breakerNextProbeAt`、`breakerReason`、`breakerUpdatedAt`
  - `POST /api/profiles/:id/breaker/reset` 调 `resetWindowHealth`
  - `GET /api/settings` 返回熔断新配置
  - `rerun-failed` 用 `breakerState !== 'closed'` 阻塞

- [ ] **Step 1: 更新后端路由测试**

`tests/web.test.ts`：

- 把 mock 里的 `resetCircuitBreaker` 改为 `resetWindowHealth`。
- 把熔断阻塞夹具：

```ts
{ id: 4, bitbrowserId: 'bb-4', name: '窗口4', enabled: 1, circuitBreakerCount: 2 }
```

改为：

```ts
{ id: 4, bitbrowserId: 'bb-4', name: '窗口4', enabled: 1, circuitBreakerCount: 2, circuitBreakerState: 'open' }
```

- 重置断言：

```ts
expect(deps.db.resetWindowHealth).toHaveBeenCalledWith(1)
```

- 增加 profiles 返回字段断言：

```ts
it('GET /api/profiles 返回熔断健康字段', async () => {
  deps.db.listProfiles.mockResolvedValue([
    { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 2, circuitBreakerState: 'open', circuitBreakerNextProbeMs: 1760000000000, circuitBreakerReason: 'CDP 连接失败', circuitBreakerUpdatedAt: '2026-10-19 12:00:00.000' },
  ])
  const res = await request(app).get('/api/profiles')
  expect(res.body.data[0].breakerState).toBe('open')
  expect(res.body.data[0].breakerNextProbeAt).toContain('2025')
  expect(res.body.data[0].breakerReason).toBe('CDP 连接失败')
})
```

（按现有 `tests/web.test.ts` 的请求方式调整 `request(app)` 变量名。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web.test.ts`

Expected: FAIL，新字段/方法不存在。

- [ ] **Step 3: 修改 profiles 路由**

在 `src/server/routes/profiles.ts` 增加：

```ts
function probeAtText(ms: number | null | undefined): string | null {
  if (ms == null) return null
  const d = new Date(ms)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace('T', ' ')
}

function toProfileView(p: ProfileRow, open: boolean) {
  return {
    ...p,
    open,
    breakerState: p.circuitBreakerState ?? 'closed',
    breakerNextProbeAt: probeAtText(p.circuitBreakerNextProbeMs),
    breakerReason: p.circuitBreakerReason ?? null,
    breakerUpdatedAt: p.circuitBreakerUpdatedAt ?? null,
  }
}
```

`GET /profiles` 的结果类型和 push 改成：

```ts
    const result: Array<ReturnType<typeof toProfileView>> = []
    // ...
    result.push(toProfileView(p, alive))
```

`applyAction` 的 `resetBreaker` 分支：

```ts
    if (action === 'resetBreaker') {
      await deps.db.resetWindowHealth(profile.id)
      return {}
    }
```

单窗口重置路由改为返回最新视图：

```ts
  router.post('/profiles/:id/breaker/reset', asyncHandler(async (req, res) => {
    const profile = await find(Number(req.params.id))
    await applyAction(profile, 'resetBreaker')
    ok(res, toProfileView(await find(profile.id), false))
  }))
```

批量重置仍然走 `applyAction`，返回批量汇总。

Swagger `/api/profiles` 的 items 增加：

```yaml
 *                       breakerState: { type: string, enum: [closed, open, half_open] }
 *                       breakerNextProbeAt: { type: string, nullable: true }
 *                       breakerReason: { type: string, nullable: true }
 *                       breakerUpdatedAt: { type: string, nullable: true }
```

Swagger reset summary 改为“重置窗口熔断健康状态”。

- [ ] **Step 4: 修改 settings 路由**

`src/server/routes/settings.ts` 的 `PublicSettings` 增加：

```ts
  circuitBreakerEnabled: boolean
  circuitBreakerCooldownSec: number
  circuitBreakerMaxCooldownSec: number
```

Swagger data properties 增加同名字段。

返回对象增加：

```ts
      circuitBreakerEnabled: deps.cfg.execution.circuitBreakerEnabled,
      circuitBreakerCooldownSec: deps.cfg.execution.circuitBreakerCooldownSec,
      circuitBreakerMaxCooldownSec: deps.cfg.execution.circuitBreakerMaxCooldownSec,
```

- [ ] **Step 5: 修改 batches 路由**

`src/server/routes/batches.ts`：

- 从 `BatchesDeps` 删除 `circuitBreakerThreshold`。
- `rerun-candidates` 的 `blockedReason` 改为：

```ts
      const breakerBlocked = (profile.circuitBreakerState ?? 'closed') !== 'closed'
      const blockedReason = !profile
        ? 'profile-missing'
        : profile.enabled !== 1
          ? 'profile-disabled'
          : breakerBlocked
            ? 'circuit-breaker'
            : inFlight
              ? 'in-flight'
              : null
```

- `rerun-failed` 的熔断检查改为：

```ts
      if ((profile.circuitBreakerState ?? 'closed') !== 'closed') {
        blocked.push(`${profile.name} 熔断中`)
        continue
      }
```

- 两处 run schema 增加：

```yaml
 *                                     failureKind: { type: string, nullable: true, enum: [environment, task, timeout, stopped, captcha, breaker] }
```

- `src/server/app.ts` 的 `batchesRouter` 调用删除：

```ts
circuitBreakerThreshold: deps.cfg.execution.circuitBreakerThreshold
```

- [ ] **Step 6: 跑测试与类型检查**

Run:

```powershell
npx vitest run tests/web.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add src/server/routes/profiles.ts src/server/routes/settings.ts src/server/routes/batches.ts src/server/app.ts tests/web.test.ts
git commit -m "feat: 窗口健康状态 API 与失败重跑阻塞"
```

---

### Task 6: 前端展示与类型

**Files:**
- Modify: `web/src/api/schema.d.ts`
- Create: `web/src/pages/profiles/breaker.ts`
- Create: `web/src/pages/profiles/breaker.test.ts`
- Modify: `web/src/pages/profiles/index.tsx`
- Modify: `web/src/pages/profiles/hooks.ts`
- Modify: `web/src/pages/settings/index.tsx`
- Modify: `web/src/pages/dashboard/format.ts`
- Modify: `web/src/pages/dashboard/format.test.ts`
- Modify: `web/src/pages/dashboard/index.tsx`

**Interfaces:**
- Consumes: Task 5 的 API 字段。
- Produces:
  - `breakerView(profile, threshold, enabled)`
  - `failureKindLabel(kind)`
  - 窗口页/设置页/看板展示。

- [ ] **Step 1: 写展示纯函数测试**

`web/src/pages/profiles/breaker.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { breakerView, formatProbeTime } from './breaker'
import type { ProfileRow } from '../../types'

const profile = (over: Partial<ProfileRow> = {}): ProfileRow => ({
  id: 1,
  bitbrowserId: 'bb-1',
  name: '窗口1',
  enabled: 1,
  circuitBreakerCount: 0,
  breakerState: 'closed',
  breakerNextProbeAt: null,
  breakerReason: null,
  breakerUpdatedAt: null,
  ...over,
} as ProfileRow)

describe('breakerView', () => {
  it('关闭熔断配置时显示已关闭', () => {
    expect(breakerView(profile({ breakerState: 'open' }), 2, false)).toMatchObject({ color: 'default', text: '熔断已关闭' })
  })

  it('open 显示熔断中和探测时间', () => {
    const v = breakerView(profile({ breakerState: 'open', breakerNextProbeAt: '2026-10-19 14:30:00.000', breakerReason: 'CDP 连接失败' }), 2, true)
    expect(v.text).toBe('熔断中 · 14:30 探测')
    expect(v.title).toBe('CDP 连接失败')
  })

  it('half_open 显示探测中', () => {
    expect(breakerView(profile({ breakerState: 'half_open' }), 2, true).text).toBe('探测中')
  })

  it('closed 有计数时显示环境失败次数', () => {
    expect(breakerView(profile({ circuitBreakerCount: 1 }), 2, true).text).toBe('环境失败 1/2')
  })

  it('formatProbeTime 只取 HH:mm', () => {
    expect(formatProbeTime('2026-10-19 14:30:00.000')).toBe('14:30')
  })
})
```

`web/src/pages/dashboard/format.test.ts` 把顶部 import 改为：

```ts
import { formatDuration, formatDateTime, failureKindLabel } from './format'
```

并追加：

```ts
it('failureKindLabel 中文文案', () => {
  expect(failureKindLabel('environment')).toBe('环境失败')
  expect(failureKindLabel('task')).toBe('任务失败')
  expect(failureKindLabel('timeout')).toBe('超时')
  expect(failureKindLabel(null)).toBe('—')
})
```

- [ ] **Step 2: 跑前端测试确认失败**

Run: `npx vitest run web/src/pages/profiles/breaker.test.ts web/src/pages/dashboard/format.test.ts`

Expected: FAIL，模块/函数不存在。

- [ ] **Step 3: 手补 `schema.d.ts`**

`/api/profiles` 的 data item 在 `circuitBreakerCount` 后增加：

```ts
                                breakerState?: "closed" | "open" | "half_open";
                                breakerNextProbeAt?: string | null;
                                breakerReason?: string | null;
                                breakerUpdatedAt?: string | null;
```

`/api/settings` 的 data 在 `circuitBreakerThreshold` 后增加：

```ts
                                circuitBreakerEnabled?: boolean;
                                circuitBreakerCooldownSec?: number;
                                circuitBreakerMaxCooldownSec?: number;
```

`/api/batches` 的 `unbatched` 和 `/api/batches/{id}` 的 `runs` 在 `batchId` 后增加：

```ts
                                    failureKind?: "environment" | "task" | "timeout" | "stopped" | "captcha" | "breaker" | null;
```

- [ ] **Step 4: 增加展示纯函数**

`web/src/pages/profiles/breaker.ts`：

```ts
/**
 * 窗口熔断展示（web 层）：把健康状态转成 Tag 文案/颜色/tooltip
 * 依赖方向：仅依赖前端 ProfileRow 类型
 */
import type { ProfileRow } from '../../types'

export interface BreakerTagView {
  color: string
  text: string
  title?: string
}

/** 从本地墙钟字符串中取 HH:mm；解析不出原样返回 */
export function formatProbeTime(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /(\d{2}):(\d{2})/.exec(value)
  return match ? `${match[1]}:${match[2]}` : value
}

export function breakerView(profile: ProfileRow, threshold: number, enabled: boolean): BreakerTagView {
  if (!enabled) return { color: 'default', text: '熔断已关闭' }
  const state = profile.breakerState ?? 'closed'
  if (state === 'open') {
    const at = formatProbeTime(profile.breakerNextProbeAt)
    return {
      color: 'red',
      text: at ? `熔断中 · ${at} 探测` : '熔断中',
      title: profile.breakerReason ?? undefined,
    }
  }
  if (state === 'half_open') {
    return { color: 'gold', text: '探测中', title: profile.breakerReason ?? undefined }
  }
  const count = profile.circuitBreakerCount
  if (count > 0) return { color: 'gold', text: `环境失败 ${count}/${threshold}` }
  return { color: 'green', text: '正常' }
}
```

`web/src/pages/dashboard/format.ts` 追加：

```ts
/** 失败类型中文文案（未知/空为 —） */
export function failureKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'environment': return '环境失败'
    case 'task': return '任务失败'
    case 'timeout': return '超时'
    case 'stopped': return '手动停止'
    case 'captcha': return '验证码'
    case 'breaker': return '熔断跳过'
    default: return '—'
  }
}
```

- [ ] **Step 5: 窗口页改用新展示**

`web/src/pages/profiles/hooks.ts` 把 `useBreakerThreshold` 替换为：

```ts
/** 熔断展示配置（公开设置，与设置页共用 settings 缓存） */
export function useBreakerSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    select: (s) => ({ threshold: s.circuitBreakerThreshold, enabled: s.circuitBreakerEnabled }),
  })
}
```

重置提示改为：

```ts
      message.success('已重置窗口熔断状态')
```

`web/src/pages/profiles/index.tsx`：

- import 改为 `useBreakerSettings`。
- `const breakerQ = useBreakerSettings()`，`const breaker = breakerQ.data ?? { threshold: 2, enabled: true }`。
- 熔断列 render 改为：

```tsx
      render: (_, p) => {
        const count = p.circuitBreakerCount
        const view = breakerView(p, breaker.threshold, breaker.enabled)
        const pct = breaker.threshold > 0 ? Math.min(100, Math.round((count / breaker.threshold) * 100)) : 0
        return (
          <Space size="small">
            <Tag color={view.color} title={view.title}>
              {view.text}
            </Tag>
            <Progress
              percent={pct}
              size="small"
              showInfo={false}
              strokeColor={count > 0 ? '#faad14' : undefined}
              style={{ width: 64, margin: 0 }}
            />
          </Space>
        )
      },
```

- 重置按钮条件改为：

```tsx
            {(p.circuitBreakerCount > 0 || (p.breakerState && p.breakerState !== 'closed')) && (
```

- 增加 import：

```ts
import { breakerView } from './breaker'
```

- [ ] **Step 6: 设置页展示新配置**

`web/src/pages/settings/index.tsx` 的执行参数 items 改为：

```tsx
            { key: 'stagger', label: '错峰上限', children: `${s.staggerMaxSec} 秒` },
            { key: 'maxWin', label: '全局窗口上限', children: s.maxConcurrentWindows },
            { key: 'breakerEnabled', label: '熔断开关', children: s.circuitBreakerEnabled ? '开启' : '关闭' },
            { key: 'breaker', label: '熔断阈值', children: s.circuitBreakerThreshold },
            { key: 'breakerCooldown', label: '冷却 / 上限', children: `${s.circuitBreakerCooldownSec / 60} / ${s.circuitBreakerMaxCooldownSec / 60} 分钟` },
            { key: 'version', label: '版本', children: s.version },
```

- [ ] **Step 7: 看板增加失败类型列**

`web/src/pages/dashboard/index.tsx`：

- import `failureKindLabel`，并在两处 columns 的“状态”后插入：

```tsx
        { title: '失败类型', dataIndex: 'failureKind', width: 100, render: (k: RunRow['failureKind']) => (k ? failureKindLabel(k) : '—') },
```

- [ ] **Step 8: 跑前端测试与类型检查**

Run:

```powershell
npx vitest run web/src/pages/profiles/breaker.test.ts web/src/pages/dashboard/format.test.ts
npm run test:web
npm run typecheck
```

Expected: PASS。

- [ ] **Step 9: Commit**

```powershell
git add web/src/api/schema.d.ts web/src/pages/profiles/breaker.ts web/src/pages/profiles/breaker.test.ts web/src/pages/profiles/index.tsx web/src/pages/profiles/hooks.ts web/src/pages/settings/index.tsx web/src/pages/dashboard/format.ts web/src/pages/dashboard/format.test.ts web/src/pages/dashboard/index.tsx
git commit -m "feat: 面板展示窗口熔断健康状态"
```

---

### Task 7: 文档同步与全量验证

**Files:**
- Modify: `docs/API-GUIDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 API-GUIDE 第 6.4 节**

把“熔断触发与重置”整节改为：

```markdown
### 6.4 熔断触发与重置

- 熔断是**窗口级环境健康**保护：只统计环境级终态失败（开窗失败、CDP 失败、浏览器崩溃、钱包扩展未加载、代理/网络错误），任务业务失败、选择器失效、数据源错误、任务超时都不计入。
- 连续环境级终态失败达到 `execution.circuitBreakerThreshold`（默认 2）后进入 `open`：该窗口后续任务直接 `skipped`，**不会先开窗**。
- 冷却从 `execution.circuitBreakerCooldownSec`（默认 30 分钟）开始，每次半开探测再失败按 2 倍退避，最多 `execution.circuitBreakerMaxCooldownSec`（默认 2 小时）。
- 冷却到期进入 `half_open`，用真实任务探测：成功或任务级失败会关闭熔断；环境级失败会重新打开并延长冷却。
- 每日 `execution.circuitBreakerResetAt`（默认 `23:59`，配置时区）全量重置；任一任务成功或面板「重置熔断」也会清零。
- 面板窗口页显示“正常 / 环境失败 N 次 / 熔断中 · HH:mm 探测 / 探测中”；失败重跑会跳过熔断中的窗口。
```

- [ ] **Step 2: 更新 API-GUIDE 第 7 章配置行**

把 `execution` 行替换为：

```markdown
| `execution` | `staggerMaxSec`（120 秒）、`windowTimeoutMs`（900000）、`taskTimeoutMs`（180000）、`retryMax`（2）、`retryBackoffSec`（600）、`circuitBreakerEnabled`（`true`）、`circuitBreakerThreshold`（2）、`circuitBreakerCooldownSec`（1800）、`circuitBreakerMaxCooldownSec`（7200）、`circuitBreakerResetAt`（`"23:59"`）、`maxConcurrentWindows`（4） | 执行引擎全局默认值。`circuitBreakerThreshold` 为连续环境级终态失败阈值；`circuitBreakerCooldownSec` 为首次冷却秒数，半开失败按 2 倍指数退避到 `circuitBreakerMaxCooldownSec`；`circuitBreakerResetAt` 每日全量重置时刻（空串关闭，时区 `scheduler.timezone`）。`maxConcurrentWindows` 为全局开窗上限，与任务级 `concurrency` 双闸门取更严者。 |
```

删除第 7 章 `CIRCUIT_BREAKER_RESET_EVERY_HOURS` 环境变量行（如果存在）。

同时更新第 0 章术语表和第 6.1 节排错表中的旧描述：

- 术语表「熔断 / Circuit Breaker」改为“窗口连续环境级失败 N 次熔断；30 分钟起步指数退避到 2 小时；半开用真实任务探测；每日 23:59 全量重置”。
- 排错表「窗口熔断」的“默认每小时清零”改为“每日 23:59 全量重置；半开探测或面板手动重置”。


- [ ] **Step 3: 更新 API-GUIDE 第 8.3 节**

在 profiles 相关接口说明中补充：

```markdown
- `GET /api/profiles` 返回 `breakerState`（`closed/open/half_open`）、`breakerNextProbeAt`、`breakerReason`、`breakerUpdatedAt`。
- `POST /api/profiles/:id/breaker/reset` 重置窗口健康状态：`closed`、计数 0、等级 0、清空冷却与原因。
```

在 batches 相关说明中补充：

```markdown
- `GET /api/batches` 与 `GET /api/batches/:id` 的运行行增加 `failureKind`：`environment/task/timeout/stopped/captcha/breaker`。
- `rerun-failed` 会把 `open/half_open` 窗口标记为 `circuit-breaker` 不可执行。
```

- [ ] **Step 4: 更新 API-GUIDE 第 9 章与第 12 章**

第 9 章状态流转处补一句：

```markdown
- `runs.failure_kind` 记录每次尝试的失败分类；只有 `environment` 且终态失败才会计入窗口熔断，`task/timeout/stopped` 不计。
```

第 12 章真机经验追加：

```markdown
**13）环境失败与任务失败要分开看（2026-10-19 熔断改造）**

- 窗口熔断只认环境失败：开窗失败、CDP 失败、浏览器崩溃、扩展未加载、代理/网络错误。选择器失效、站点业务失败、数据源错误、任务超时属于任务问题，不会熔断窗口。
- 排障时先看 `runs.failure_kind`：`environment` 查窗口/代理/扩展；`task` 查站点/选择器/数据源；`timeout` 查任务等待预算。
- 窗口显示“熔断中 · HH:mm 探测”时，不要手动重跑；等半开探测或面板重置熔断。
```

- [ ] **Step 5: 更新 AGENTS.md 踩坑提醒**

把：

```markdown
- 窗口连续 2 任务失败触发熔断（该窗口剩余任务当日 skipped）；熔断每日 23:59 自动重置（`execution.circuitBreakerResetAt`，任一任务成功/面板手动也清零）；代理失效由任务自身失败暴露（已无前置 IP 校验）
```

改为：

```markdown
- 窗口连续 2 次**环境级**终态失败触发熔断（只计开窗/CDP/浏览器/扩展/网络类失败，任务业务失败不计；该窗口剩余任务 skipped）；熔断后 30 分钟起步指数退避到 2 小时，半开用真实任务探测；每日 23:59 全量重置（`execution.circuitBreakerResetAt`），任一任务成功/面板手动也清零；代理失效由任务自身失败暴露（已无前置 IP 校验）
```

把下一行“定时失败同样计入熔断”改为：

```markdown
- 定时触发与手动触发共享在途守卫与窗口熔断：定时失败同样按环境/任务分类，只有环境级终态失败计入熔断（连续 2 次后该窗口当日剩余任务 skipped，含手动）
```

- [ ] **Step 6: 全量验证**

Run:

```powershell
npm run typecheck
npm test
npm run test:web
```

Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```powershell
git add docs/API-GUIDE.md AGENTS.md
git commit -m "docs: 同步窗口熔断健康状态机说明"
```

---

## Self-Review Checklist

- [ ] 所有 spec 要求都有对应任务：状态机、失败分类、数据模型、迁移、runner、配置、API、UI、文档、测试。
- [ ] 没有 `TBD` / `TODO` / “稍后实现” / “类似 Task N”。
- [ ] 类型命名一致：`WindowHealth`、`CircuitBreakerPolicy`、`FailureKind`、`circuitBreakerState`、`failureKind`。
- [ ] 所有新增 DB 方法在 Task 1 定义、在 Task 3/4/5 使用。
- [ ] 所有新增前端字段在 Task 5 后端返回、在 Task 6 schema/UI 使用。
- [ ] 每个任务都有测试命令和预期结果。
- [ ] 旧 `incrCircuitBreaker` / `resetCircuitBreaker` / `resetMeltedCircuitBreakers` 的调用点已替换或删除；如果保留旧方法，确保没有生产代码继续调用。

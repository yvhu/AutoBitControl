# 间隔调度（每 N 小时）与毫秒时间统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持「每 N 小时执行一次」的间隔调度（4/8/12 或任意小时），锚点定在最近一次成功完成时刻（毫秒精度 + 60s 缓冲），runs 表支持一天多次执行不覆盖，并将项目全部时间口径统一为毫秒。

**Architecture:** 调度新增第三种形态 `{ everyHours: N }`；锚点存 `task_states.last_fired_at`（毫秒 ISO，成功时由 WindowRunner 单调回写）；调度器分钟 tick 判定到期后触发；runs 表唯一键改为 `(profile_id, task_key, date, slot)`，一天多轮各占一行；任务侧「冷却中」文案走失败重试、「已领取」文案走成功（文档约定，DAC 任务无需改动）。

**Tech Stack:** TypeScript / libsql(Turso) / croner / log4js / vitest / patchright

## Global Constraints

- Node 20.x；测试用 vitest（`npm test`）；类型检查 `npm run typecheck`，两个都要过
- 代码注释一律中文，风格跟随现有文件（JSDoc + 设计思路说明）
- 不新增依赖：libsql 的 `client.transaction()`、croner、log4js 全部现成
- 老库迁移幂等：`PRAGMA table_info` 查缺列、缺则补（profiles 补列已有先例）；runs 表因要改唯一键必须重建（SQLite 不支持 ALTER 删表级约束），重建必须走事务
- 提交信息用 conventional commits 中文/英文混合风格（见 git log：`feat: ...` / `fix: ...`）

---

### Task 1: 时间毫秒统一（日志 pattern + 打码记录）

**Files:**
- Modify: `src/infrastructure/logger.ts:41`（PLAIN_PATTERN）、`src/infrastructure/logger.ts:117`（终端彩色 pattern）
- Modify: `src/infrastructure/db.ts:261`（captcha_logs.created_at 截断长度）
- Test: `tests/logger.test.ts`（追加文件输出毫秒格式断言）

**Interfaces:**
- Consumes: 无（纯前置）
- Produces: 日志行格式 `[yyyy-MM-dd HH:mm:ss.SSS] 级别 消息`；`captcha_logs.created_at` 为 `yyyy-MM-dd HH:mm:ss.SSS` 本地墙钟字符串

- [ ] **Step 1: 写失败测试**

`tests/logger.test.ts` 文件头 import 改为：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { shutdown } from 'log4js'
import { formatArgs, createLogger } from '../src/infrastructure/logger'
```

在 `describe('formatArgs', ...)` 块之后追加：

```ts
describe('createLogger 毫秒时间戳', () => {
  it('文件与终端日志时间精确到毫秒（yyyy-MM-dd HH:mm:ss.SSS）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-log-ms-'))
    const logger = createLogger({
      storage: { logDir: dir, logLevel: 'info', prettyColorize: false, logRetainDays: 2 },
    } as never)
    logger.info('毫秒测试')
    await new Promise<void>((r) => shutdown(r))
    const line = readFileSync(join(dir, 'app.log'), 'utf-8').trim()
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO 毫秒测试$/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/logger.test.ts`
Expected: 新用例 FAIL（现有输出没有 `.SSS`）

- [ ] **Step 3: 改 logger.ts 两个 pattern**

```ts
/** 无颜色纯文本布局（文件与无色终端共用）：`[时间] 级别 消息`（毫秒精度） */
const PLAIN_PATTERN = '[%d{yyyy-MM-dd hh:mm:ss.SSS}] %p %m'
```

```ts
const patternStr = colorize ? `%[[%d{yyyy-MM-dd hh:mm:ss.SSS}]%] %[%p%] %m` : PLAIN_PATTERN
```

- [ ] **Step 4: 改 db.ts 打码记录毫秒**

`src/infrastructure/db.ts` `logCaptcha` 内：

```ts
const localWall = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace('T', ' ')
```

（注释「created_at 存本地墙钟时间字符串」后补一句「毫秒精度，与日期前缀过滤兼容」）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/logger.test.ts tests/db.test.ts`
Expected: PASS（db 测试不动任何断言，仅字段值变长）

- [ ] **Step 6: 提交**

```bash
git add src/infrastructure/logger.ts src/infrastructure/db.ts tests/logger.test.ts
git commit -m "feat: millisecond-precision timestamps in logs and captcha_logs"
```

---

### Task 2: db 层——runs.slot 重建 + task_states.last_fired_at

**Files:**
- Modify: `src/infrastructure/db.ts`（SCHEMA、migrate、RunRow、SELECT_RUN、upsertRun、getRun、新增 getLatestRun/nextRunSlot/setTaskFiredAt/getTaskFiredAt）
- Test: `tests/db.test.ts`（适配新签名 + 新增用例）

**Interfaces:**
- Consumes: 无
- Produces:
  - `upsertRun(profileId: number, taskKey: string, date: string, slot: number, status: RunStatus, patch?: Partial<RunRow>): Promise<RunRow>`
  - `getRun(profileId: number, taskKey: string, date: string, slot: number): Promise<RunRow | null>`
  - `getLatestRun(profileId: number, taskKey: string, date: string): Promise<RunRow | null>`（当日 slot 最大的一行）
  - `nextRunSlot(profileId: number, taskKey: string, date: string): Promise<number>`（当日 MAX(slot)+1，无行返回 0）
  - `getTaskFiredAt(taskKey: string): Promise<string | null>`（毫秒 ISO）
  - `setTaskFiredAt(taskKey: string, iso: string): Promise<void>`（只增不减，不覆盖 enabled 位）

- [ ] **Step 1: 写失败测试（先写新用例，旧用例下一并适配）**

`tests/db.test.ts` 顶部 import 补 `import { createClient } from '@libsql/client'`。

在现有 describe 内追加（先只加不跑的迁移用例与 slot 用例；旧用例签名适配放 Step 3 一起改，Step 2 只跑新用例看编译/运行失败）：

```ts
describe('runs slot 多轮次', () => {
  it('nextRunSlot 无记录返回 0，有记录返回 MAX+1', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
    const p = await db.upsertProfile('bb-slot', 'slot窗口')
    expect(await db.nextRunSlot(p.id, 't', '2026-08-31')).toBe(0)
    await db.upsertRun(p.id, 't', '2026-08-31', 0, 'running')
    await db.upsertRun(p.id, 't', '2026-08-31', 1, 'running')
    expect(await db.nextRunSlot(p.id, 't', '2026-08-31')).toBe(2)
    db.close()
  })

  it('同一天不同 slot 的行互不覆盖', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
    const p = await db.upsertProfile('bb-slot2', 'slot窗口2')
    await db.upsertRun(p.id, 't', '2026-08-31', 0, 'success')
    await db.upsertRun(p.id, 't', '2026-08-31', 1, 'failed', { error: 'e' })
    const latest = await db.getLatestRun(p.id, 't', '2026-08-31')
    expect(latest?.slot).toBe(1)
    expect(latest?.status).toBe('failed')
    const r0 = await db.getRun(p.id, 't', '2026-08-31', 0)
    expect(r0?.status).toBe('success')
    db.close()
  })
})

describe('task_states 间隔锚点', () => {
  it('setTaskFiredAt 只增不减且不覆盖 enabled', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
    await db.setTaskEnabled('t', false)
    await db.setTaskFiredAt('t', '2026-08-31T09:00:00.000Z')
    expect(await db.getTaskFiredAt('t')).toBe('2026-08-31T09:00:00.000Z')
    await db.setTaskFiredAt('t', '2026-08-31T08:00:00.000Z')
    expect(await db.getTaskFiredAt('t')).toBe('2026-08-31T09:00:00.000Z')
    expect(await db.getTaskEnabled('t', true)).toBe(false)
    db.close()
  })
})

describe('runs 老库迁移', () => {
  it('缺 slot 列的旧表重建后数据保留且 slot=0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-migrate-'))
    const file = join(dir, 'app.db')
    // 手工造旧版表（无 slot、无 last_fired_at）
    const raw = createClient({ url: `file:${file}` })
    await raw.execute(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, task_key TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, screenshot TEXT, started_at TEXT, finished_at TEXT, UNIQUE(profile_id, task_key, date))`)
    await raw.execute(`CREATE TABLE task_states (task_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`)
    await raw.execute(`INSERT INTO runs (profile_id, task_key, date, status) VALUES (1, 't', '2026-08-30', 'success')`)
    raw.close()
    const db = await AppDb.open({ url: `file:${file}`, authToken: '' })
    const info = await (db as unknown as { client: { execute: (sql: string) => Promise<{ rows: Array<{ name: string }> }> } }).client.execute(`PRAGMA table_info(runs)`)
    expect(info.rows.map((r) => r.name)).toContain('slot')
    const rows = await db.listRunsForDate('2026-08-30')
    expect(rows.length).toBe(1)
    expect(rows[0].slot).toBe(0)
    await db.setTaskFiredAt('t', '2026-08-31T09:00:00.000Z')
    db.close()
  })
})
```

（`mkdtempSync/join/tmpdir` 等 import 补在 db.test.ts 顶部）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/db.test.ts`
Expected: 编译失败（upsertRun/getRun 缺 slot 参数；AppDb 无 setTaskFiredAt 等方法）

- [ ] **Step 3: 改 db.ts**

3a. `RunRow` 接口加字段（`id` 之后）：

```ts
  /** 当日第几轮（0 起）：每日一次的任务恒为 0；间隔任务一天多轮各占一行 */
  slot: number
```

3b. `SCHEMA` 里 runs 建表改：

```ts
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    task_key TEXT NOT NULL,
    date TEXT NOT NULL,
    slot INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    screenshot TEXT,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE(profile_id, task_key, date, slot)
  )`,
```

`task_states` 建表改：

```ts
  `CREATE TABLE IF NOT EXISTS task_states (
    task_key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at TEXT
  )`,
```

3c. `migrate()` 在 profiles 补列块之后追加：

```ts
    // 老库补列：task_states.last_fired_at（间隔调度锚点，毫秒 ISO）
    const tsInfo = await this.client.execute(`PRAGMA table_info(task_states)`)
    if (!tsInfo.rows.some((r) => String(r.name) === 'last_fired_at')) {
      await this.client.execute(`ALTER TABLE task_states ADD COLUMN last_fired_at TEXT`)
    }
    // 老库重建：runs 表加 slot 列 + 唯一键改为 (profile_id, task_key, date, slot)——
    // SQLite 无法 ALTER 删除表级 UNIQUE 约束，必须建新表迁移数据（事务内完成，中断自动回滚）
    const runsInfo = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo.rows.some((r) => String(r.name) === 'slot')) {
      const tx = await this.client.transaction('write')
      try {
        await tx.execute(`ALTER TABLE runs RENAME TO runs_old`)
        await tx.execute(`CREATE TABLE runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          task_key TEXT NOT NULL,
          date TEXT NOT NULL,
          slot INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          screenshot TEXT,
          started_at TEXT,
          finished_at TEXT,
          UNIQUE(profile_id, task_key, date, slot)
        )`)
        await tx.execute(`INSERT INTO runs (id, profile_id, task_key, date, slot, status, attempts, error, screenshot, started_at, finished_at)
          SELECT id, profile_id, task_key, date, 0, status, attempts, error, screenshot, started_at, finished_at FROM runs_old`)
        await tx.execute(`DROP TABLE runs_old`)
        await tx.execute(`CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date)`)
        await tx.commit()
      } catch (e) {
        await tx.rollback().catch(() => {})
        throw e
      }
    }
```

3d. `SELECT_RUN` 改：

```ts
const SELECT_RUN = `SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.slot, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, p.name AS profileName FROM runs r JOIN profiles p ON p.id = r.profile_id`
```

3e. `upsertRun` 签名与 SQL 改：

```ts
  async upsertRun(profileId: number, taskKey: string, date: string, slot: number, status: RunStatus, patch: Partial<RunRow> = {}): Promise<RunRow> {
    await this.exec(
      `INSERT INTO runs (profile_id, task_key, date, slot, status, attempts, error, screenshot, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, task_key, date, slot) DO UPDATE SET
         status = excluded.status,
         attempts = CASE WHEN excluded.attempts = 0 THEN runs.attempts ELSE excluded.attempts END,
         error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at)`,
      [profileId, taskKey, date, slot, status, patch.attempts ?? 0, patch.error ?? null, patch.screenshot ?? null, patch.startedAt ?? null, patch.finishedAt ?? null],
    )
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ? AND r.slot = ?`, [profileId, taskKey, date, slot])
    return rows[0] as unknown as RunRow
  }
```

3f. `getRun` 改 + 新增 `getLatestRun`/`nextRunSlot`：

```ts
  /** 查询单条运行记录（按轮次；不存在返回 null） */
  async getRun(profileId: number, taskKey: string, date: string, slot: number): Promise<RunRow | null> {
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ? AND r.slot = ?`, [profileId, taskKey, date, slot])
    return (rows[0] as unknown as RunRow | undefined) ?? null
  }

  /** 查询当日最近一轮运行记录（slot 最大的一行；无记录返回 null——重试续跑与新增轮次判定用） */
  async getLatestRun(profileId: number, taskKey: string, date: string): Promise<RunRow | null> {
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ? ORDER BY r.slot DESC LIMIT 1`, [profileId, taskKey, date])
    return (rows[0] as unknown as RunRow | undefined) ?? null
  }

  /** 当日下一轮序号：MAX(slot)+1（无记录返回 0） */
  async nextRunSlot(profileId: number, taskKey: string, date: string): Promise<number> {
    const rows = await this.exec(`SELECT COALESCE(MAX(slot), -1) + 1 AS nextSlot FROM runs WHERE profile_id = ? AND task_key = ? AND date = ?`, [profileId, taskKey, date])
    return Number(rows[0]?.nextSlot ?? 0)
  }
```

3g. `task_states` 新方法（放在 `setTaskEnabled` 附近）：

```ts
  /** 读间隔调度锚点（最近一次成功 finished_at，毫秒 ISO；无记录 null） */
  async getTaskFiredAt(taskKey: string): Promise<string | null> {
    const rows = await this.exec(`SELECT last_fired_at AS lastFiredAt FROM task_states WHERE task_key = ?`, [taskKey])
    const v = rows[0]?.lastFiredAt
    return v ? String(v) : null
  }

  /**
   * 回写间隔调度锚点（毫秒 ISO）：只增不减（多窗口并发成功时取最晚时刻），
   * 不覆盖 enabled 位（首次写入补默认 enabled=1 行）
   */
  async setTaskFiredAt(taskKey: string, iso: string): Promise<void> {
    await this.exec(
      `INSERT INTO task_states (task_key, enabled, last_fired_at) VALUES (?, 1, ?)
       ON CONFLICT(task_key) DO UPDATE SET last_fired_at = CASE
         WHEN task_states.last_fired_at IS NULL OR excluded.last_fired_at > task_states.last_fired_at
         THEN excluded.last_fired_at ELSE task_states.last_fired_at END`,
      [taskKey, iso],
    )
  }
```

3h. `listRunsForDate` 不改（SELECT_RUN 已含 slot，自动多行返回）。

- [ ] **Step 4: 适配 db.test.ts 旧用例**

现有调用全部补 `0` 参数：
- `await db.upsertRun(p.id, 'task-a', '2026-08-28', 0, 'running')`
- `await db.upsertRun(p.id, 'task-a', '2026-08-28', 0, 'success', {...})`
- `await db.getRun(p.id, 'task-a', '2026-08-28', 0)`
- 其余 `upsertRun(p.id, 't', '2026-08-28', 0, ...)`、`getRun(p.id, 't', '2026-08-28', 0)` 同法

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS（含迁移用例）

- [ ] **Step 6: 提交**

```bash
git add src/infrastructure/db.ts tests/db.test.ts
git commit -m "feat: runs table slot column for multi-run days and task_states last_fired_at anchor (legacy migration)"
```

---

### Task 3: TaskMeta.schedule 扩展 + 调度器间隔调度

**Files:**
- Modify: `src/engine/task.ts`（schedule 类型 + isIntervalSchedule）
- Modify: `src/engine/scheduler.ts`（intervalDue、interval 任务注册、分钟 tick、stop/refreshTask 清理）
- Test: `tests/scheduler.test.ts`（intervalDue 用例 + interval 任务 start/tick 用例）

**Interfaces:**
- Consumes: `db.getTaskFiredAt(taskKey)`（Task 2）
- Produces:
  - `export function isIntervalSchedule(s: TaskMeta['schedule']): s is { everyHours: number }`
  - `export function intervalDue(lastFiredAt: string | null, everyHours: number, bufferMs: number, nowMs: number): boolean`
  - `Scheduler.tickIntervals(nowMs = Date.now()): Promise<void>`（public，测试注入 now）

- [ ] **Step 1: 写失败测试**

`tests/scheduler.test.ts` import 改为：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickRandomTimeInWindow, staggerToCron, Scheduler, intervalDue, isIntervalSchedule } from '../src/engine/scheduler'
```

追加：

```ts
describe('intervalDue', () => {
  it('无锚点视为到期（立即触发首轮）', () => {
    expect(intervalDue(null, 8, 60000, Date.now())).toBe(true)
  })

  it('锚点 + N 小时 + 缓冲之前未到期', () => {
    const now = Date.parse('2026-08-31T08:00:00.000Z')
    expect(intervalDue('2026-08-31T00:00:00.000Z', 8, 60000, now)).toBe(false)
  })

  it('锚点 + N 小时 + 缓冲之后到期', () => {
    const now = Date.parse('2026-08-31T08:01:01.000Z')
    expect(intervalDue('2026-08-31T00:00:00.000Z', 8, 60000, now)).toBe(true)
  })

  it('非法锚点按无锚点处理（到期）', () => {
    expect(intervalDue('not-a-date', 8, 60000, Date.now())).toBe(true)
  })
})

describe('isIntervalSchedule', () => {
  it('识别间隔形态与其它形态', () => {
    expect(isIntervalSchedule({ everyHours: 8 })).toBe(true)
    expect(isIntervalSchedule({ stagger: ['09:00', '11:00'] })).toBe(false)
    expect(isIntervalSchedule('0 8 * * *')).toBe(false)
    expect(isIntervalSchedule(undefined)).toBe(false)
    expect(isIntervalSchedule(null)).toBe(false)
  })
})

describe('Scheduler 间隔任务', () => {
  function makeIntervalDeps(getTaskFiredAt: ReturnType<typeof vi.fn>) {
    const db = {
      listProfiles: vi.fn().mockResolvedValue([]),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
      getTaskFiredAt,
    } as never
    const enqueue = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    const scheduler = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([
      ['iv', { meta: { key: 'iv', url: 'https://a.io', schedule: { everyHours: 8 } } }],
    ]) as never, { enqueue } as never, logger)
    return { db, enqueue, scheduler }
  }

  it('无锚点首轮 tick 触发，触发后 N 小时内不再触发', async () => {
    const { enqueue, scheduler } = makeIntervalDeps(vi.fn().mockResolvedValue(null))
    const t0 = Date.parse('2026-08-31T08:00:00.000Z')
    await scheduler.tickIntervals(t0)
    expect(enqueue).toHaveBeenCalledTimes(0) // listProfiles 为空窗口，fireNow 不入队
    // 用有窗口的库再验一次：触发行为由 fireNow 决定，这里直接验证 nextAllow 抑制逻辑
    const db2 = {
      listProfiles: vi.fn().mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }]),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
      getTaskFiredAt: vi.fn().mockResolvedValue(null),
    } as never
    const enqueue2 = vi.fn()
    const s2 = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db2, new Map([
      ['iv', { meta: { key: 'iv', url: 'https://a.io', schedule: { everyHours: 8 } } }],
    ]) as never, { enqueue: enqueue2 } as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    await s2.tickIntervals(t0)
    expect(enqueue2).toHaveBeenCalledTimes(1)
    await s2.tickIntervals(t0 + 3_600_000)
    expect(enqueue2).toHaveBeenCalledTimes(1) // 8 小时内不重复触发
    await s2.tickIntervals(t0 + 8 * 3_600_000 + 61_000)
    expect(enqueue2).toHaveBeenCalledTimes(2) // 到期后再次触发
    s2.stop()
  })

  it('锚点未到缓冲期不触发', async () => {
    const { enqueue, scheduler } = makeIntervalDeps(vi.fn().mockResolvedValue('2026-08-31T00:00:00.000Z'))
    await scheduler.tickIntervals(Date.parse('2026-08-31T08:00:30.000Z'))
    expect(enqueue).toHaveBeenCalledTimes(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: 编译失败（intervalDue/isIntervalSchedule 未导出；tickIntervals 不存在）

- [ ] **Step 3: 改 task.ts**

```ts
  /** 调度配置：cron 字符串（固定时间点）/ stagger（每日错峰窗口）/ everyHours（每 N 小时间隔，锚点=最近一次成功完成时刻） */
  schedule?: string | { stagger: [string, string] } | { everyHours: number }
```

文件尾部追加：

```ts
/** 是否间隔调度（每 N 小时）——调度器与窗口执行器共用判定 */
export function isIntervalSchedule(s: TaskMeta['schedule']): s is { everyHours: number } {
  return typeof s === 'object' && s !== null && 'everyHours' in s && typeof (s as { everyHours?: unknown }).everyHours === 'number'
}
```

- [ ] **Step 4: 改 scheduler.ts**

顶部 import 加 `import { isIntervalSchedule, type TaskMeta } from './task'`（TaskMeta 已有 type import，合并即可）。

`staggerToCron` 之后追加纯函数：

```ts
/** 间隔调度缓冲：到期判定在锚点+N 小时基础上再加 60s，吸收时钟抖动/代理延迟/多进程时间差 */
export const INTERVAL_BUFFER_MS = 60_000

/**
 * 间隔调度是否到期：无锚点（从未成功过）→ 立即触发；否则 now >= 锚点 + N 小时 + 缓冲
 * @param lastFiredAt 最近一次成功 finished_at（毫秒 ISO，可 null）
 */
export function intervalDue(lastFiredAt: string | null, everyHours: number, bufferMs: number, nowMs: number): boolean {
  if (!lastFiredAt) return true
  const anchor = new Date(lastFiredAt).getTime()
  if (Number.isNaN(anchor)) return true
  return nowMs >= anchor + everyHours * 3_600_000 + bufferMs
}
```

类字段区（`staggerRefreshers` 之后）加：

```ts
  /** 间隔任务（key → 每 N 小时）；分钟 tick 统一判定触发 */
  private intervalTasks = new Map<string, number>()
  /** 间隔任务下次允许触发时刻（毫秒时间戳）：触发后 N 小时内不重复触发（失败不重触发，等待任务级重试） */
  private intervalNextAllow = new Map<string, number>()
  /** 分钟 tick cron（存在间隔任务时注册一个，共用于全部间隔任务） */
  private intervalTick: Cron | null = null
```

`registerTask` 的 `if (typeof task.meta.schedule === 'string')` 分支之后补 else-if：

```ts
    } else if (isIntervalSchedule(task.meta.schedule)) {
      this.intervalTasks.set(task.meta.key, task.meta.schedule.everyHours)
      this.ensureIntervalTick()
      this.logger.info({ task: task.meta.key, everyHours: task.meta.schedule.everyHours }, '任务已调度（每 N 小时）')
    } else {
```

`refreshStagger` 方法之后追加：

```ts
  /** 确保分钟 tick cron 已注册（有间隔任务时共用同一个 tick，无间隔任务时无需注册） */
  private ensureIntervalTick(): void {
    if (this.intervalTick) return
    this.intervalTick = new Cron('* * * * *', { timezone: this.cfg.execution.timezone }, () => {
      void this.tickIntervals().catch((e) => this.logger.warn({ err: (e as Error).message }, '间隔任务 tick 异常'))
    })
  }

  /**
   * 间隔任务分钟 tick：逐个判定是否到期，到期则触发（public 供测试注入 nowMs）
   * 触发后把该任务 nextAllow 推后 N 小时——即使本轮失败也不会分钟级重复触发，
   * 失败补偿靠任务级重试；成功后锚点前移，nextAllow 到点后再按新锚点判定
   */
  async tickIntervals(nowMs = Date.now()): Promise<void> {
    for (const [key, hours] of this.intervalTasks) {
      if (nowMs < (this.intervalNextAllow.get(key) ?? 0)) continue
      const anchor = await this.db.getTaskFiredAt(key)
      if (!intervalDue(anchor, hours, INTERVAL_BUFFER_MS, nowMs)) continue
      this.intervalNextAllow.set(key, nowMs + hours * 3_600_000)
      void this.fireNow(key).catch((e) => this.logger.warn({ task: key, err: (e as Error).message }, '间隔任务触发失败'))
    }
  }
```

`refreshTask` 的清理段（`this.staggerRefreshKeys.delete(taskKey)` 之后）加：

```ts
        this.intervalTasks.delete(taskKey)
        this.intervalNextAllow.delete(taskKey)
        if (this.intervalTasks.size === 0 && this.intervalTick) {
          this.intervalTick.stop()
          this.intervalTick = null
        }
```

`stop()` 尾部加：

```ts
    if (this.intervalTick) { this.intervalTick.stop(); this.intervalTick = null }
    this.intervalTasks.clear()
    this.intervalNextAllow.clear()
```

注意：`start()` 的重入保护条件改为 `this.jobs.size > 0 || this.staggerJobs.size > 0 || this.intervalTasks.size > 0`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/engine/task.ts src/engine/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: everyHours interval scheduling anchored on last success with 60s buffer"
```

---

### Task 4: WindowRunner——slot 计算与成功锚点回写

**Files:**
- Modify: `src/engine/window-runner.ts`（runTask 与窗口级 skip/failed 分支的 slot 参数、成功回写 last_fired_at）
- Test: `tests/windowRunner.test.ts`（mock 适配 getLatestRun/nextRunSlot；状态列下标 c[3]→c[4]；新增成功回写锚点用例）

**Interfaces:**
- Consumes: `db.getLatestRun / nextRunSlot / setTaskFiredAt`（Task 2）、`isIntervalSchedule`（Task 3）
- Produces: 无（内部行为）

- [ ] **Step 1: 写失败测试**

`tests/windowRunner.test.ts` 顶部 makeDeps 的 db mock（约 line 14-18）改为：

```ts
  const db = {
    upsertRun: vi.fn().mockResolvedValue(null),
    getLatestRun: vi.fn().mockResolvedValue(null),
    nextRunSlot: vi.fn().mockResolvedValue(0),
    setTaskFiredAt: vi.fn().mockResolvedValue(undefined),
    ...其余字段不变
  }
```

（`getRun` 字段删除；其余原 mock 字段保留）

所有 `getRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: N })` 改为 `getLatestRun: ...` 且补 `slot: 0`。

状态列提取 helper 改：

```ts
  return (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[4])
```

（slot 插入到第 4 参，status 变成下标 4）

新增用例：

```ts
  it('间隔任务成功后回写锚点（只增不减）', async () => {
    const deps = makeDeps({ taskMeta: { key: 'iv', url: 'https://a.io', schedule: { everyHours: 8 } } })
    await runner.runWindowTasks(profile, ['iv'])
    expect(deps.db.setTaskFiredAt).toHaveBeenCalled()
  })

  it('非间隔任务成功不回写锚点', async () => {
    const deps = makeDeps({ taskMeta: { key: 'daily', url: 'https://a.io', schedule: { stagger: ['09:00', '11:00'] } } })
    await runner.runWindowTasks(profile, ['daily'])
    expect(deps.db.setTaskFiredAt).not.toHaveBeenCalled()
  })

  it('新轮次使用 nextRunSlot（终态行后开新轮），续跑沿用原 slot', async () => {
    const deps = makeDeps()
    deps.db.getLatestRun.mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 2 } as Partial<RunRow>)
    await runner.runWindowTasks(profile, ['t'])
    const calls = (deps.db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.every(c => c[3] === 2)).toBe(true) // 续跑沿用 slot=2
    expect(deps.db.nextRunSlot).not.toHaveBeenCalled()
  })
```

（makeDeps 的实际形状以现有文件为准，step 里只改上述差异点；`runner`/`profile` 变量沿用文件既有 fixture）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/windowRunner.test.ts`
Expected: 编译失败（getRun 不存在、upsertRun 参数个数）

- [ ] **Step 3: 改 window-runner.ts**

import 区补：`import { isIntervalSchedule } from './task'`（如已有 `import type { TaskRef } from './task'` 则合并为 `import { isIntervalSchedule, type TaskRef } from './task'`）。

新增私有 helper（放在 `probe` 方法之后）：

```ts
  /** 取某任务当日下一轮 slot（库失败兜底 0——不阻塞任务执行） */
  private async nextSlot(profile: ProfileRow, taskKey: string, date: string): Promise<number> {
    const n = await this.safeDb(() => this.deps.db.nextRunSlot(profile.id, taskKey, date), null)
    return typeof n === 'number' ? n : 0
  }
```

窗口级 skip/failed 分支（原 line 115/128/137/148/155）逐一改为先算 slot 再 upsert，例如 IP 探活失败分支：

```ts
        for (const key of taskKeys) {
          const slot = await this.nextSlot(profile, key, date)
          await this.safeDb(() => db.upsertRun(profile.id, key, date, slot, 'skipped', { error: 'IP 探活失败', finishedAt: new Date().toISOString() }), null)
        }
```

其余四个分支同法（开窗失败/CDP 连接失败/窗口超时/窗口熔断），各自计算 `const slot = await this.nextSlot(profile, key, date)`。

`runTask` 内（原 line 228-230）改：

```ts
    const existing = await this.safeDb(() => db.getLatestRun(profile.id, taskKey, date), null)
    const terminal = existing ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(existing.status) : false
    // 续跑沿用原 slot；新轮次（无记录或终态行）取当日 MAX(slot)+1
    const slot = existing && !terminal ? existing.slot : await this.nextSlot(profile, taskKey, date)
    const startAttempt = existing && !terminal ? (existing.attempts > 0 ? existing.attempts + 1 : 1) : 1
```

runTask 内全部 `db.upsertRun(profile.id, taskKey, date, ...)` 改为 `db.upsertRun(profile.id, taskKey, date, slot, ...)`（5 处：任务未注册/重试耗尽/截图目录失败/running/成功/失败）。

成功分支改：

```ts
        const finishedAt = new Date().toISOString()
        await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'success', { error: null, screenshot: shot, finishedAt }), null)
        // 间隔任务：成功完成时刻回写调度锚点（只增不减），下一轮 = 锚点 + N 小时 + 缓冲
        if (isIntervalSchedule(task.meta.schedule)) {
          await this.safeDb(() => db.setTaskFiredAt(taskKey, finishedAt), undefined)
        }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/windowRunner.test.ts`
Expected: PASS

- [ ] **Step 5: 全量回归**

Run: `npm run typecheck; if ($?) { npm test }`
Expected: 全绿（若 db.test/web.test 有遗漏签名处按报错补齐）

- [ ] **Step 6: 提交**

```bash
git add src/engine/window-runner.ts tests/windowRunner.test.ts
git commit -m "feat: per-run slot continuation and everyHours anchor writeback on success"
```

---

### Task 5: server 注解 + 面板展示（每 N 小时文案与多轮可见）

**Files:**
- Modify: `src/server/routes/dashboard.ts:57`（RunRow swagger 注解加 slot）
- Modify: `src/server/routes/tasks.ts:44`（schedule 注解文案补 everyHours）
- Modify: `web/src/pages/tasks/hooks.ts`（scheduleText）
- Modify: `web/src/pages/dashboard/index.tsx`（新增「开始时间」列）
- Modify: `web/src/api/schema.d.ts`（dashboard runs item 手工补 slot 字段）
- Test: `web/src/pages/tasks/hooks.test.ts`（scheduleText 新用例）

**Interfaces:**
- Consumes: RunRow.slot（Task 2 已加 SELECT_RUN）
- Produces: 面板任务卡片显示「每 N 小时」；dashboard 表格多轮可见（开始时间列）

- [ ] **Step 1: 写失败测试**

`web/src/pages/tasks/hooks.test.ts` 追加：

```ts
  it('每 N 小时间隔调度文案', () => {
    expect(scheduleText({ everyHours: 8 })).toBe('每 8 小时')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix web run test`
Expected: 新用例 FAIL（当前返回 cron undefined-undefined 错峰）

- [ ] **Step 3: 改 hooks.ts**

```ts
export function scheduleText(schedule: string | { [key: string]: unknown } | null): string {
  if (schedule === null) return '手动触发'
  if (typeof schedule === 'string') return `cron ${schedule}`
  const s = schedule as { stagger?: [string, string]; everyHours?: number }
  if (typeof s.everyHours === 'number') return `每 ${s.everyHours} 小时`
  return `cron ${s.stagger?.[0]}-${s.stagger?.[1]} 错峰`
}
```

- [ ] **Step 4: 改 dashboard 表格加开始时间列**

`web/src/pages/dashboard/index.tsx` 的 columns 数组，在「任务」列之后插入：

```tsx
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 130,
      render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—'),
    },
```

- [ ] **Step 5: 改 server 注解与 schema.d.ts**

`src/server/routes/dashboard.ts` runs 项注解（startedAt 附近）加一行：

```
 *                           slot: { type: number }
```

`src/server/routes/tasks.ts` schedule 注解改为：

```
 *                       schedule:
 *                         type: object
 *                         nullable: true
 *                         description: cron 字符串 / { stagger: [start, end] } 每日错峰 / { everyHours: N } 每 N 小时（锚点=最近一次成功完成时刻）
```

`web/src/api/schema.d.ts`：找到 dashboard 的 runs item 定义（含 startedAt 的 item 块），在 startedAt 旁补：

```ts
slot: number;
```

（生成文件手改一次即可，类型推导用它）

- [ ] **Step 6: 跑测试确认通过**

Run: `npm --prefix web run test` 然后 `npm --prefix web run build`
Expected: PASS + build 成功（tsc -b 校验 schema 改动）

- [ ] **Step 7: 提交**

```bash
git add src/server/routes/dashboard.ts src/server/routes/tasks.ts web/src/pages/tasks/hooks.ts web/src/pages/tasks/hooks.test.ts web/src/pages/dashboard/index.tsx web/src/api/schema.d.ts
git commit -m "feat: panel shows everyHours schedule text and run start-time column"
```

---

### Task 6: 文档——调度章节与间隔任务写法

**Files:**
- Modify: `docs/API-GUIDE.md`（第 7 章「调度」小节、第 9 章「任务的一生」runs 记录说明、TaskMeta 表格）

**Interfaces:**
- Consumes: 全部已落地
- Produces: 文档与实现一致

- [ ] **Step 1: 第 7 章「两种 schedule 写法」改「三种」**

在 `### 两种 schedule 写法`（约 line 834）标题改为 `### 三种 schedule 写法`，正文追加：

```markdown
3. **每 N 小时间隔**（`{ everyHours: N }`）：适合「每 8 小时可领一次」这类站点。
   - 下一次触发 = **最近一次成功完成时刻 + N 小时 + 60 秒缓冲**（锚点存云端 `task_states.last_fired_at`，毫秒 ISO，重启不丢）
   - 首次（从未成功过）启动后立即触发；触发后 N 小时内不重复触发，失败轮次靠任务级重试补偿
   - 写入方式：`schedule: { everyHours: 8 }`（4/8/12 或任意小时均可，不要求整除 24）
```

- [ ] **Step 2: 第 9 章补「冷却中 vs 已领取」判定约定**

在「签到成功 / 已签到」小节附近追加：

```markdown
### 冷却中 vs 已领取（间隔任务必看）

站点限频提示分两种语义，判定必须分开写：
- **已领取**（今日限额已用完，如 DAC 的 `Daily limit reached`）→ 直接成功返回
- **冷却中**（距上次领取未满 N 小时，如 `Please wait 30 minutes`）→ **抛错失败**，走任务重试退避
  （退避时间自然覆盖剩余冷却，成功后调度锚点重置，节奏自动对齐；千万不要把冷却中当成功，否则会整轮虚报）
```

- [ ] **Step 3: TaskMeta 表格补 schedule 与 slot 说明**

第 2 章 TaskMeta 参数表的 `schedule` 行改为：

```markdown
| `schedule` | `string \| {stagger:[string,string]} \| {everyHours:number}` | `undefined` | cron 字符串（固定点）/ stagger 每日错峰 / everyHours 每 N 小时（锚点=最近成功时刻）；无=仅手动 |
```

`runs` 相关说明处（第 9 章任务的一生）补一句：

```markdown
> 间隔任务一天多轮，`runs` 表按 `slot` 列（当日第几轮，0 起）各占一行互不覆盖；面板 dashboard 页「开始时间」列可区分轮次。
```

- [ ] **Step 4: 验证文档渲染**

Run: `git diff docs/API-GUIDE.md` 检查锚点链接与表格格式
Expected: 无破损锚点（`### 三种 schedule 写法` 的链接引用如存在一并更新）

- [ ] **Step 5: 提交**

```bash
git add docs/API-GUIDE.md
git commit -m "docs: everyHours scheduling, cooldown-vs-claimed rule and runs slot in API guide"
```

---

## Self-Review 结论

- 规格覆盖：Q1 三处毫秒（日志/打码/调度缓冲）→ Task 1/3；间隔调度任意 N 小时 → Task 3；锚点成功时刻+缓冲+失败不重触发（任务级重试兜底）→ Task 3/4；runs 多轮不覆盖 → Task 2/4；面板展示 → Task 5；已领取/冷却中约定 → Task 6
- 类型一致性：`isIntervalSchedule`/`intervalDue`/`INTERVAL_BUFFER_MS` 在 Task 3 定义、Task 4 消费；`getLatestRun/nextRunSlot/setTaskFiredAt/getTaskFiredAt` 在 Task 2 定义、Task 3/4 消费；RunRow.slot 在 Task 2 定义、Task 5 消费——签名一致
- 无占位符/TBD；所有步骤含完整代码与命令
- 边界已覆盖：老库迁移（事务重建）、多窗口并发成功锚点只增不减、重启后首轮判定、非法锚点容错

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'captcha_failed' | 'retry_wait' | 'skipped'

export interface ProfileRow {
  id: number
  bitbrowserId: string
  name: string
  enabled: number
  wallet: string | null
  walletPassword: string | null
  circuitBreakerCount: number
}

export interface RunRow {
  id: number
  profileId: number
  taskKey: string
  date: string
  status: RunStatus
  attempts: number
  error: string | null
  screenshot: string | null
  startedAt: string | null
  finishedAt: string | null
  profileName: string
}

export function todayStr(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bitbrowser_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  wallet TEXT,
  wallet_password TEXT,
  circuit_breaker_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  task_key TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  screenshot TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(profile_id, task_key, date)
);
CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date);
CREATE TABLE IF NOT EXISTS captcha_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER,
  task_key TEXT,
  kind TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export class AppDb {
  private constructor(private raw: Database.Database) {}

  static open(dbPath: string): AppDb {
    mkdirSync(dirname(dbPath), { recursive: true })
    const raw = new Database(dbPath)
    raw.pragma('journal_mode = WAL')
    const db = new AppDb(raw)
    db.migrate()
    return db
  }

  migrate(): void {
    this.raw.exec(SCHEMA)
  }

  close(): void {
    this.raw.close()
  }

  upsertProfile(bitbrowserId: string, name: string): ProfileRow {
    this.raw.prepare(
      `INSERT INTO profiles (bitbrowser_id, name) VALUES (?, ?)
       ON CONFLICT(bitbrowser_id) DO UPDATE SET name = excluded.name`
    ).run(bitbrowserId, name)
    return this.raw.prepare(`SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, wallet, wallet_password AS walletPassword, circuit_breaker_count AS circuitBreakerCount FROM profiles WHERE bitbrowser_id = ?`).get(bitbrowserId) as ProfileRow
  }

  listProfiles(enabledOnly = false): ProfileRow[] {
    const sql = enabledOnly
      ? `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, wallet, wallet_password AS walletPassword, circuit_breaker_count AS circuitBreakerCount FROM profiles WHERE enabled = 1 ORDER BY id`
      : `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, wallet, wallet_password AS walletPassword, circuit_breaker_count AS circuitBreakerCount FROM profiles ORDER BY id`
    return this.raw.prepare(sql).all() as ProfileRow[]
  }

  setProfileEnabled(id: number, enabled: boolean): void {
    this.raw.prepare('UPDATE profiles SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  setProfileWallet(id: number, wallet: string | null, walletPassword: string | null): void {
    this.raw.prepare('UPDATE profiles SET wallet = ?, wallet_password = ? WHERE id = ?').run(wallet, walletPassword, id)
  }

  incrCircuitBreaker(profileId: number): number {
    this.raw.prepare('UPDATE profiles SET circuit_breaker_count = circuit_breaker_count + 1 WHERE id = ?').run(profileId)
    const row = this.raw.prepare('SELECT circuit_breaker_count FROM profiles WHERE id = ?').get(profileId) as { circuit_breaker_count: number }
    return row.circuit_breaker_count
  }

  resetCircuitBreaker(profileId: number): void {
    this.raw.prepare('UPDATE profiles SET circuit_breaker_count = 0 WHERE id = ?').run(profileId)
  }

  upsertRun(profileId: number, taskKey: string, date: string, status: RunStatus, patch: Partial<RunRow> = {}): RunRow {
    const existing = this.raw.prepare(`SELECT id, profile_id AS profileId, task_key AS taskKey, date, status, attempts, error, screenshot, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE profile_id = ? AND task_key = ? AND date = ?`).get(profileId, taskKey, date) as RunRow | undefined
    const base: RunRow = existing ?? {
      id: 0, profileId, taskKey, date, status: 'pending', attempts: 0,
      error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '',
    }
    const merged = { ...base, ...patch, status, attempts: existing ? patch.attempts ?? existing.attempts : 0 }
    this.raw.prepare(
      `INSERT INTO runs (profile_id, task_key, date, status, attempts, error, screenshot, started_at, finished_at)
       VALUES (@profileId, @taskKey, @date, @status, @attempts, @error, @screenshot, @startedAt, @finishedAt)
       ON CONFLICT(profile_id, task_key, date) DO UPDATE SET
         status = excluded.status, attempts = excluded.attempts, error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at)`
    ).run(merged)
    return this.raw.prepare(`SELECT id, profile_id AS profileId, task_key AS taskKey, date, status, attempts, error, screenshot, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE profile_id = ? AND task_key = ? AND date = ?`).get(profileId, taskKey, date) as RunRow
  }

  getRun(profileId: number, taskKey: string, date: string): RunRow | null {
    return (this.raw.prepare(`SELECT id, profile_id AS profileId, task_key AS taskKey, date, status, attempts, error, screenshot, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE profile_id = ? AND task_key = ? AND date = ?`).get(profileId, taskKey, date) as RunRow | null) ?? null
  }

  listRunsForDate(date: string): RunRow[] {
    return this.raw.prepare(
      `SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, p.name AS profileName FROM runs r JOIN profiles p ON p.id = r.profile_id WHERE r.date = ? ORDER BY p.id, r.task_key`
    ).all(date) as RunRow[]
  }

  logCaptcha(profileId: number | null, taskKey: string | null, kind: string, cost: number, ok: boolean): void {
    this.raw.prepare('INSERT INTO captcha_logs (profile_id, task_key, kind, cost, ok) VALUES (?, ?, ?, ?, ?)').run(profileId, taskKey, kind, cost, ok ? 1 : 0)
  }

  captchaStats(date: string): { count: number; totalCost: number } {
    const row = this.raw.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(cost), 0) AS total FROM captcha_logs WHERE date(created_at) = ?`).get(date) as { count: number; total: number }
    return { count: row.count, totalCost: row.total }
  }
}

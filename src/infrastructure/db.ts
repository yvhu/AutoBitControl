/**
 * 持久层（infrastructure）：SQLite 数据访问（profiles 窗口 / runs 运行记录 / captcha_logs 打码日志）
 * 依赖方向：仅依赖 better-sqlite3，被 engine/server 层依赖；RunStatus 类型被全局引用
 * 设计思路：WAL 模式提升并发读写；UNIQUE(profile_id, task_key, date) 保证每窗口每天每任务一行；
 *           库内字段用 snake_case、读出时映射为 camelCase
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 运行状态（状态机转移规则见 engine/state.ts）：
 * pending 待执行 / running 执行中 / success 成功 / failed 失败（终态）
 * captcha_failed 验证码失败（终态）/ retry_wait 重试等待 / skipped 跳过（终态）
 */
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'captcha_failed' | 'retry_wait' | 'skipped'

/** profiles 表行：一个比特浏览器窗口 */
export interface ProfileRow {
  id: number
  bitbrowserId: string
  name: string
  /** 0/1（SQLite 无布尔，读出保持数字由调用方判断） */
  enabled: number
  walletPassword: string | null
  circuitBreakerCount: number
}

/** runs 表行：某窗口某任务某天的一次运行记录 */
export interface RunRow {
  id: number
  profileId: number
  taskKey: string
  /** 本地时区日期 YYYY-MM-DD（每日唯一键的一部分） */
  date: string
  status: RunStatus
  attempts: number
  error: string | null
  screenshot: string | null
  startedAt: string | null
  finishedAt: string | null
  /** JOIN profiles 得到的窗口名（面板矩阵直接展示） */
  profileName: string
}

/** 生成"今天"的日期字符串（本地时区，非 UTC——每日签到语义按用户所在时区） */
export function todayStr(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 幂等建表（IF NOT EXISTS），可在任意版本数据库上安全重复执行
const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bitbrowser_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
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
CREATE TABLE IF NOT EXISTS task_states (
  task_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);
`

/**
 * SQLite 数据访问门面：私有构造 + open 工厂，保证打开即迁移
 * 设计权衡：不用 ORM——表结构固定、查询简单，原生 SQL 更可控且无额外依赖
 */
export class AppDb {
  private constructor(private raw: Database.Database) {}

  /**
   * 打开数据库（自动创建目录、启用 WAL、执行迁移）
   * @param dbPath 数据库文件绝对路径
   * @returns 就绪的 AppDb 实例
   */
  static open(dbPath: string): AppDb {
    mkdirSync(dirname(dbPath), { recursive: true })
    const raw = new Database(dbPath)
    // WAL：写不阻塞读，配合面板轮询与调度器并发访问
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

  /**
   * 幂等写入窗口（比特浏览器同步列表时调用：存在则更新名称）
   * @returns 落库后的完整行
   */
  upsertProfile(bitbrowserId: string, name: string): ProfileRow {
    this.raw.prepare(
      `INSERT INTO profiles (bitbrowser_id, name) VALUES (?, ?)
       ON CONFLICT(bitbrowser_id) DO UPDATE SET name = excluded.name`
    ).run(bitbrowserId, name)
    return this.raw.prepare(`SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, wallet_password AS walletPassword, circuit_breaker_count AS circuitBreakerCount FROM profiles WHERE bitbrowser_id = ?`).get(bitbrowserId) as ProfileRow
  }

  /** 列出窗口；enabledOnly=true 时仅返回启用窗口（调度器触发用） */
  listProfiles(enabledOnly = false): ProfileRow[] {
    const sql = enabledOnly
      ? `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, wallet_password AS walletPassword, circuit_breaker_count AS circuitBreakerCount FROM profiles WHERE enabled = 1 ORDER BY id`
      : `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, wallet_password AS walletPassword, circuit_breaker_count AS circuitBreakerCount FROM profiles ORDER BY id`
    return this.raw.prepare(sql).all() as ProfileRow[]
  }

  /** 启用/停用窗口（面板开关） */
  setProfileEnabled(id: number, enabled: boolean): void {
    this.raw.prepare('UPDATE profiles SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  /** 设置窗口的钱包解锁密码（null 清除） */
  setProfileWalletPassword(id: number, walletPassword: string | null): void {
    this.raw.prepare('UPDATE profiles SET wallet_password = ? WHERE id = ?').run(walletPassword, id)
  }

  /** 熔断计数 +1，返回最新计数（window-runner 终态失败时调用） */
  incrCircuitBreaker(profileId: number): number {
    this.raw.prepare('UPDATE profiles SET circuit_breaker_count = circuit_breaker_count + 1 WHERE id = ?').run(profileId)
    const row = this.raw.prepare('SELECT circuit_breaker_count FROM profiles WHERE id = ?').get(profileId) as { circuit_breaker_count: number }
    return row.circuit_breaker_count
  }

  /** 熔断计数清零（任务成功或面板手动重置） */
  resetCircuitBreaker(profileId: number): void {
    this.raw.prepare('UPDATE profiles SET circuit_breaker_count = 0 WHERE id = ?').run(profileId)
  }

  /**
   * 幂等写入运行记录（无则插入、有则更新）
   * @param patch 可选字段补丁（error/screenshot/attempts 等）
   * @returns 合并后的最新行（含 profileName）
   * 设计权衡：ON CONFLICT 更新时 started_at/finished_at 用 COALESCE 保留——
   * started_at 取首次值（标记真正开始时刻），finished_at 保留已有值不被中间状态覆盖
   */
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
    return this.raw.prepare(`SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, p.name AS profileName FROM runs r JOIN profiles p ON p.id = r.profile_id WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ?`).get(profileId, taskKey, date) as RunRow
  }

  /** 查询单条运行记录（不存在返回 null） */
  getRun(profileId: number, taskKey: string, date: string): RunRow | null {
    return (this.raw.prepare(`SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, p.name AS profileName FROM runs r JOIN profiles p ON p.id = r.profile_id WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ?`).get(profileId, taskKey, date) as RunRow | null) ?? null
  }

  /** 某天的全部运行记录（面板矩阵/统计用，按窗口与任务排序） */
  listRunsForDate(date: string): RunRow[] {
    return this.raw.prepare(
      `SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, p.name AS profileName FROM runs r JOIN profiles p ON p.id = r.profile_id WHERE r.date = ? ORDER BY p.id, r.task_key`
    ).all(date) as RunRow[]
  }

  /** 记录一次打码事件（成功/失败都记，供成本统计与面板展示） */
  logCaptcha(profileId: number | null, taskKey: string | null, kind: string, cost: number, ok: boolean): void {
    this.raw.prepare('INSERT INTO captcha_logs (profile_id, task_key, kind, cost, ok) VALUES (?, ?, ?, ?, ?)').run(profileId, taskKey, kind, cost, ok ? 1 : 0)
  }

  /** 某天的打码统计：次数与总费用（点） */
  captchaStats(date: string): { count: number; totalCost: number } {
    const row = this.raw.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(cost), 0) AS total FROM captcha_logs WHERE date(created_at) = ?`).get(date) as { count: number; total: number }
    return { count: row.count, totalCost: row.total }
  }

  /** 读取任务开关：无覆盖记录时返回代码默认值（meta.enabled ?? true） */
  getTaskEnabled(taskKey: string, fallback: boolean): boolean {
    const row = this.raw.prepare('SELECT enabled FROM task_states WHERE task_key = ?').get(taskKey) as { enabled: number } | undefined
    return row === undefined ? fallback : row.enabled === 1
  }

  /** 写入任务开关（面板运行时覆盖，重启后保留） */
  setTaskEnabled(taskKey: string, enabled: boolean): void {
    this.raw.prepare('INSERT INTO task_states (task_key, enabled) VALUES (?, ?) ON CONFLICT(task_key) DO UPDATE SET enabled = excluded.enabled').run(taskKey, enabled ? 1 : 0)
  }
}

/**
 * 持久层（infrastructure）：Turso 云数据库数据访问（profiles 窗口 / runs 运行记录 / captcha_logs 打码日志）
 * 依赖方向：仅依赖 @libsql/client，被 engine/server 层依赖；RunStatus 类型被全局引用
 * 设计思路：全部数据层走云端（libsql 协议，file: URL 供测试使用本地引擎）；
 *           UNIQUE(profile_id, task_key, date) 保证每窗口每天每任务一行；
 *           库内字段用 snake_case、读出时映射为 camelCase
 */
import { createClient, type Client, type Row } from '@libsql/client'

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

/** AppDb.open 的参数（cloud 配置段；file: URL 为测试/本地引擎，无需 authToken） */
export interface AppDbOpenConfig {
  url: string
  authToken: string
}

// 幂等建表（IF NOT EXISTS）：云库首次启动自动建表，可重复执行
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bitbrowser_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    circuit_breaker_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date)`,
  `CREATE TABLE IF NOT EXISTS captcha_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER,
    task_key TEXT,
    kind TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_states (
    task_key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
  // 窗口打开状态登记表：主进程（面板打开/关闭）与 task:run 脚本跨进程共享，
  // 一行 = 一个已打开的窗口（http 调试地址供 CDP 复用）；pid 是否存活由调用方实测
  `CREATE TABLE IF NOT EXISTS open_windows (
    bitbrowser_id TEXT PRIMARY KEY,
    http TEXT NOT NULL,
    opened_at TEXT NOT NULL
  )`,
]

const SELECT_PROFILE = `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, circuit_breaker_count AS circuitBreakerCount FROM profiles`
const SELECT_RUN = `SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, p.name AS profileName FROM runs r JOIN profiles p ON p.id = r.profile_id`

/** libsql 支持的绑定值类型（undefined 不允许，调用前须归一为 null） */
type DbArg = null | string | number | bigint | Uint8Array | ArrayBuffer

/**
 * 云数据库访问门面：私有构造 + 异步 open 工厂，保证打开即迁移
 * 设计权衡：不用 ORM——表结构固定、查询简单，原生 SQL 更可控且无额外依赖
 */
export class AppDb {
  private constructor(private client: Client) {}

  /**
   * 打开数据库（创建 client 并执行建表迁移）
   * @param cfg 云配置（url + authToken）；file:/file::memory: 走本地引擎（测试用，无需 authToken）
   * @returns 就绪的 AppDb 实例（网络不通/凭据错误时抛错，由调用方处理退出）
   */
  static async open(cfg: AppDbOpenConfig): Promise<AppDb> {
    const local = cfg.url.startsWith('file:')
    const client = createClient(local ? { url: cfg.url } : { url: cfg.url, authToken: cfg.authToken })
    const db = new AppDb(client)
    await db.migrate()
    return db
  }

  async migrate(): Promise<void> {
    for (const stmt of SCHEMA) await this.client.execute(stmt)
  }

  close(): void {
    this.client.close()
  }

  /** 统一执行辅助：绑定参数形式执行 SQL（避免字符串拼接），返回结果行 */
  private async exec(sql: string, args: DbArg[] = []): Promise<Row[]> {
    const rs = await this.client.execute({ sql, args })
    return rs.rows
  }

  /**
   * 幂等写入窗口（比特浏览器同步列表时调用：存在则更新名称）
   * @returns 落库后的完整行
   */
  async upsertProfile(bitbrowserId: string, name: string): Promise<ProfileRow> {
    await this.exec(
      `INSERT INTO profiles (bitbrowser_id, name) VALUES (?, ?)
       ON CONFLICT(bitbrowser_id) DO UPDATE SET name = excluded.name`,
      [bitbrowserId, name],
    )
    const rows = await this.exec(`${SELECT_PROFILE} WHERE bitbrowser_id = ?`, [bitbrowserId])
    return rows[0] as unknown as ProfileRow
  }

  /** 列出窗口；enabledOnly=true 时仅返回启用窗口（调度器触发用） */
  async listProfiles(enabledOnly = false): Promise<ProfileRow[]> {
    const sql = enabledOnly
      ? `${SELECT_PROFILE} WHERE enabled = 1 ORDER BY id`
      : `${SELECT_PROFILE} ORDER BY id`
    return (await this.exec(sql)) as unknown as ProfileRow[]
  }

  /** 启用/停用窗口（面板开关） */
  async setProfileEnabled(id: number, enabled: boolean): Promise<void> {
    await this.exec('UPDATE profiles SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id])
  }

  /** 读取任务开关：无覆盖记录时返回代码默认值（meta.enabled ?? true） */
  async getTaskEnabled(taskKey: string, fallback: boolean): Promise<boolean> {
    const rows = await this.exec('SELECT enabled FROM task_states WHERE task_key = ?', [taskKey])
    if (rows.length === 0) return fallback
    return rows[0].enabled === 1
  }

  /** 写入任务开关（面板运行时覆盖，云端持久，跨机器生效） */
  async setTaskEnabled(taskKey: string, enabled: boolean): Promise<void> {
    await this.exec('INSERT INTO task_states (task_key, enabled) VALUES (?, ?) ON CONFLICT(task_key) DO UPDATE SET enabled = excluded.enabled', [taskKey, enabled ? 1 : 0])
  }

  /** 熔断计数 +1，返回最新计数（window-runner 终态失败时调用） */
  async incrCircuitBreaker(profileId: number): Promise<number> {
    await this.exec('UPDATE profiles SET circuit_breaker_count = circuit_breaker_count + 1 WHERE id = ?', [profileId])
    const rows = await this.exec('SELECT circuit_breaker_count FROM profiles WHERE id = ?', [profileId])
    return (rows[0]?.circuit_breaker_count as number | undefined) ?? 0
  }

  /** 熔断计数清零（任务成功或面板手动重置） */
  async resetCircuitBreaker(profileId: number): Promise<void> {
    await this.exec('UPDATE profiles SET circuit_breaker_count = 0 WHERE id = ?', [profileId])
  }

  /**
   * 幂等写入运行记录（无则插入、有则更新），单条 UPSERT 完成
   * @param patch 可选字段补丁（error/screenshot/attempts 等）
   * @returns 合并后的最新行（含 profileName）
   * 设计权衡：ON CONFLICT 更新时 started_at/finished_at 用 COALESCE 保留——
   * started_at 取首次值（标记真正开始时刻），finished_at 保留已有值不被中间状态覆盖
   */
  async upsertRun(profileId: number, taskKey: string, date: string, status: RunStatus, patch: Partial<RunRow> = {}): Promise<RunRow> {
    await this.exec(
      `INSERT INTO runs (profile_id, task_key, date, status, attempts, error, screenshot, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, task_key, date) DO UPDATE SET
         status = excluded.status,
         attempts = CASE WHEN excluded.attempts = 0 THEN runs.attempts ELSE excluded.attempts END,
         error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at)`,
      [profileId, taskKey, date, status, patch.attempts ?? 0, patch.error ?? null, patch.screenshot ?? null, patch.startedAt ?? null, patch.finishedAt ?? null],
    )
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ?`, [profileId, taskKey, date])
    return rows[0] as unknown as RunRow
  }

  /** 查询单条运行记录（不存在返回 null） */
  async getRun(profileId: number, taskKey: string, date: string): Promise<RunRow | null> {
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ?`, [profileId, taskKey, date])
    return (rows[0] as unknown as RunRow | undefined) ?? null
  }

  /** 某天的全部运行记录（面板矩阵/统计用，按窗口与任务排序） */
  async listRunsForDate(date: string): Promise<RunRow[]> {
    return (await this.exec(`${SELECT_RUN} WHERE r.date = ? ORDER BY p.id, r.task_key`, [date])) as unknown as RunRow[]
  }

  /** 记录一次打码事件（成功/失败都记，供成本统计与面板展示）；created_at 存本地墙钟时间字符串（与 runs.date 同口径） */
  async logCaptcha(profileId: number | null, taskKey: string | null, kind: string, cost: number, ok: boolean): Promise<void> {
    const now = new Date()
    const localWall = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ')
    await this.exec('INSERT INTO captcha_logs (profile_id, task_key, kind, cost, ok, created_at) VALUES (?, ?, ?, ?, ?, ?)', [profileId, taskKey, kind, cost, ok ? 1 : 0, localWall])
  }

  /** 某天的打码统计：次数与总费用（点）；created_at 为本地墙钟时间，直接按日期前缀过滤（与 todayStr 口径一致） */
  async captchaStats(date: string): Promise<{ count: number; totalCost: number }> {
    const rows = await this.exec(`SELECT COUNT(*) AS count, COALESCE(SUM(cost), 0) AS total FROM captcha_logs WHERE date(created_at) = ?`, [date])
    return { count: (rows[0]?.count as number | undefined) ?? 0, totalCost: (rows[0]?.total as number | undefined) ?? 0 }
  }

  /** 读窗口打开状态登记（无登记返回 null）；是否真实存活由调用方经比特浏览器 /browser/pids 实测 */
  async getOpenWindow(bitbrowserId: string): Promise<{ http: string } | null> {
    const rows = await this.exec('SELECT http FROM open_windows WHERE bitbrowser_id = ?', [bitbrowserId])
    return rows.length > 0 ? { http: String(rows[0].http) } : null
  }

  /** 登记/更新窗口打开状态（面板打开、task:run 复用探测等场景写入；同 id 覆盖 http 与打开时间） */
  async setOpenWindow(bitbrowserId: string, http: string): Promise<void> {
    await this.exec(
      `INSERT INTO open_windows (bitbrowser_id, http, opened_at) VALUES (?, ?, ?)
       ON CONFLICT(bitbrowser_id) DO UPDATE SET http = excluded.http, opened_at = excluded.opened_at`,
      [bitbrowserId, http, new Date().toISOString()],
    )
  }

  /** 清除窗口打开状态登记（窗口关闭或 pid 实测已死时调用） */
  async clearOpenWindow(bitbrowserId: string): Promise<void> {
    await this.exec('DELETE FROM open_windows WHERE bitbrowser_id = ?', [bitbrowserId])
  }
}

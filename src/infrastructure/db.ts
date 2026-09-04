/**
 * 持久层（infrastructure）：本地 SQLite 数据访问（profiles 窗口 / runs 运行记录 / captcha_logs 打码日志）
 * 依赖方向：仅依赖 @libsql/client，被 engine/server 层依赖；RunStatus 类型被全局引用
 * 设计思路：数据层走本地文件（libsql 本地引擎，file: URL；file::memory: 供测试使用）；
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

/** batches 表行：一次触发动作 */
export interface BatchRow {
  id: number
  kind: 'bulk' | 'single'
  taskKey: string
  source: string
  createdAt: string
}

/** 批次状态统计（列表接口聚合用；total 含全部行数） */
export interface BatchStats {
  total: number
  success: number
  failed: number
  captchaFailed: number
  skipped: number
  running: number
  pending: number
}

/** profiles 表行：一个比特浏览器窗口 */
export interface ProfileRow {
  id: number
  bitbrowserId: string
  name: string
  /** 0/1（SQLite 无布尔，读出保持数字由调用方判断） */
  enabled: number
  circuitBreakerCount: number
  /** 比特客户端窗口备注（同步 /browser/list 时更新） */
  remark?: string | null
  /** 比特客户端排序号 */
  seq?: number | null
  /** 最近探测 IP */
  lastIp?: string | null
  /** 最近探测国家 */
  lastCountry?: string | null
  /** 浏览器内核版本（如 150） */
  coreVersion?: string | null
}

/** runs 表行：某窗口某任务某天的一次运行记录 */
export interface RunRow {
  id: number
  profileId: number
  taskKey: string
  /** 本地时区日期 YYYY-MM-DD（每日唯一键的一部分） */
  date: string
  /** 当日第几轮（0 起）：每日一次的任务恒为 0；间隔任务一天多轮各占一行 */
  slot: number
  /** 所属批次 id（NULL = 老数据未分批） */
  batchId: number | null
  /** JOIN profiles 得到的窗口比特 id（行级执行用） */
  bitbrowserId: string
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

/**
 * 当前时刻的本地墙钟时间字符串（毫秒精度，`yyyy-MM-dd HH:mm:ss.SSS`）：
 * 所有落库时间统一此口径（与系统时区一致，避免 UTC ISO 比本地慢 8 小时的困惑）；
 * 固定宽度保证字典序 == 时间序，比较/排序均安全
 */
export function localWallNow(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace('T', ' ')
}

/** 本地路径转 file: URL：file: 前缀原样透传（测试 file::memory:），其余反斜杠转正斜杠后加 file: 前缀 */
function toFileUrl(p: string): string {
  if (p.startsWith('file:')) return p
  return `file:${p.replace(/\\/g, '/')}`
}

// 幂等建表（IF NOT EXISTS）：首次打开自动建表，可重复执行
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bitbrowser_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    circuit_breaker_count INTEGER NOT NULL DEFAULT 0,
    remark TEXT,
    seq INTEGER,
    last_ip TEXT,
    last_country TEXT,
    core_version TEXT
  )`,
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
    batch_id INTEGER,
    UNIQUE(profile_id, task_key, date, slot)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date)`,
  `CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    task_key TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batches_created_at ON batches(created_at)`,
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

const SELECT_PROFILE = `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, circuit_breaker_count AS circuitBreakerCount, remark, seq, last_ip AS lastIp, last_country AS lastCountry, core_version AS coreVersion FROM profiles`
const SELECT_RUN = `SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.slot, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, r.batch_id AS batchId, p.name AS profileName, p.bitbrowser_id AS bitbrowserId FROM runs r JOIN profiles p ON p.id = r.profile_id`

/** libsql 支持的绑定值类型（undefined 不允许，调用前须归一为 null） */
type DbArg = null | string | number | bigint | Uint8Array | ArrayBuffer

/**
 * 本地 SQLite 访问门面：私有构造 + 异步 open 工厂，保证打开即迁移
 * 设计权衡：不用 ORM——表结构固定、查询简单，原生 SQL 更可控且无额外依赖
 */
export class AppDb {
  private constructor(private client: Client) {}

  /**
   * 打开数据库（创建 client 并执行建表迁移）
   * @param dbPath 本地数据库文件路径（绝对或相对；file: 前缀原样透传）
   * @returns 就绪的 AppDb 实例（磁盘/权限错误时抛错，由调用方处理退出）
   */
  static async open(dbPath: string): Promise<AppDb> {
    const client = createClient({ url: toFileUrl(dbPath) })
    const db = new AppDb(client)
    await db.migrate()
    return db
  }

  async migrate(): Promise<void> {
    // WAL 日志模式：面板进程与 task:run 脚本可能同时开同一文件，读写不互锁（库级设置，幂等；
    // file::memory: 上执行无副作用）；busy_timeout 为连接级，写竞争时等待 5 秒而非立即报锁错
    await this.client.execute('PRAGMA journal_mode=WAL')
    await this.client.execute('PRAGMA busy_timeout=5000')
    for (const stmt of SCHEMA) await this.client.execute(stmt)
    // 老库补列：profiles 元数据列（remark/seq/last_ip/last_country/core_version）后加，CREATE TABLE 只保证新库自带；
    // PRAGMA table_info 查现有列，缺哪个补哪个（幂等，本地库与老库共享同一迁移逻辑）
    const info = await this.client.execute(`PRAGMA table_info(profiles)`)
    const existing = new Set(info.rows.map((r) => String(r.name)))
    const extraCols: Array<[string, string]> = [
      ['remark', 'TEXT'],
      ['seq', 'INTEGER'],
      ['last_ip', 'TEXT'],
      ['last_country', 'TEXT'],
      ['core_version', 'TEXT'],
    ]
    for (const [col, type] of extraCols) {
      if (!existing.has(col)) await this.client.execute(`ALTER TABLE profiles ADD COLUMN ${col} ${type}`)
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
    // 老库补列：runs.batch_id（批次归属，可空；不参与 UNIQUE，直接 ADD COLUMN 无需重建表）——
    // 仅老库需要补列（新库 CREATE TABLE 已自带）
    const runsInfo2 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo2.rows.some((r) => String(r.name) === 'batch_id')) {
      await this.client.execute(`ALTER TABLE runs ADD COLUMN batch_id INTEGER`)
    }
    // 索引放补列块外无条件幂等创建：ALTER 与建索引之间崩溃不会永久丢失索引
    await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_runs_batch_id ON runs(batch_id)`)
    // countInFlightRuns（任务/看板每次手动触发都查）用的复合索引
    await this.client.execute('CREATE INDEX IF NOT EXISTS idx_runs_task_date ON runs(task_key, date)')
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
   * 幂等写入窗口（比特浏览器同步列表时调用：存在则更新名称与元数据）
   * @param meta 比特客户端返回的窗口元数据（remark/seq/lastIp/lastCountry/coreVersion）
   * @returns 落库后的完整行
   */
  async upsertProfile(bitbrowserId: string, name: string, meta: { remark?: string | null; seq?: number | null; lastIp?: string | null; lastCountry?: string | null; coreVersion?: string | null } = {}): Promise<ProfileRow> {
    await this.exec(
      `INSERT INTO profiles (bitbrowser_id, name, remark, seq, last_ip, last_country, core_version) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bitbrowser_id) DO UPDATE SET name = excluded.name, remark = excluded.remark, seq = excluded.seq, last_ip = excluded.last_ip, last_country = excluded.last_country, core_version = excluded.core_version`,
      [bitbrowserId, name, meta.remark ?? null, meta.seq ?? null, meta.lastIp ?? null, meta.lastCountry ?? null, meta.coreVersion ?? null],
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

  /** 写入任务开关（面板运行时覆盖，本地持久，重启保留） */
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
  async upsertRun(profileId: number, taskKey: string, date: string, slot: number, status: RunStatus, patch: Partial<RunRow> = {}): Promise<RunRow> {
    await this.exec(
      `INSERT INTO runs (profile_id, task_key, date, slot, status, attempts, error, screenshot, started_at, finished_at, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, task_key, date, slot) DO UPDATE SET
         status = excluded.status,
         attempts = CASE WHEN excluded.attempts = 0 THEN runs.attempts ELSE excluded.attempts END,
         error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at),
         batch_id = COALESCE(excluded.batch_id, runs.batch_id)`,
      [profileId, taskKey, date, slot, status, patch.attempts ?? 0, patch.error ?? null, patch.screenshot ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, patch.batchId ?? null],
    )
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ? AND r.slot = ?`, [profileId, taskKey, date, slot])
    return rows[0] as unknown as RunRow
  }

  /** 创建批次（每次触发动作一行）；createdAt 缺省当前本地墙钟时间 */
  async createBatch(kind: 'bulk' | 'single', taskKey: string, source: string, createdAt = localWallNow()): Promise<BatchRow> {
    const rs = await this.client.execute({
      sql: 'INSERT INTO batches (kind, task_key, source, created_at) VALUES (?, ?, ?, ?)',
      args: [kind, taskKey, source, createdAt],
    })
    const rows = await this.exec('SELECT id, kind, task_key AS taskKey, source, created_at AS createdAt FROM batches WHERE id = ?', [Number(rs.lastInsertRowid)])
    return rows[0] as unknown as BatchRow
  }

  /** 按 id 查批次行（不存在返回 null） */
  async getBatch(id: number): Promise<BatchRow | null> {
    const rows = await this.exec('SELECT id, kind, task_key AS taskKey, source, created_at AS createdAt FROM batches WHERE id = ?', [id])
    return (rows[0] as unknown as BatchRow | undefined) ?? null
  }

  /** 时间段内的批次列表（含每批状态聚合）；createdAt 倒序；from=null 表示不设下界 */
  async listBatchesForRange(from: string | null, to: string): Promise<Array<BatchRow & { stats: BatchStats }>> {
    const rows = await this.exec(
      `SELECT b.id, b.kind, b.task_key AS taskKey, b.source, b.created_at AS createdAt, r.status, COUNT(r.id) AS c
       FROM batches b LEFT JOIN runs r ON r.batch_id = b.id
       WHERE date(b.created_at) >= COALESCE(date(?), '0000-01-01') AND date(b.created_at) <= date(?)
       GROUP BY b.id, r.status
       ORDER BY b.created_at DESC, b.id DESC`,
      [from, to],
    )
    const list: Array<BatchRow & { stats: BatchStats }> = []
    const byId = new Map<number, BatchRow & { stats: BatchStats }>()
    for (const r of rows) {
      const id = Number(r.id)
      let item = byId.get(id)
      if (!item) {
        item = {
          id,
          kind: String(r.kind) as 'bulk' | 'single',
          taskKey: String(r.taskKey),
          source: String(r.source),
          createdAt: String(r.createdAt),
          stats: { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0 },
        }
        byId.set(id, item)
        list.push(item)
      }
      const n = Number(r.c)
      item.stats.total += n
      const s = String(r.status) as RunStatus
      if (s === 'success') item.stats.success += n
      else if (s === 'failed') item.stats.failed += n
      else if (s === 'captcha_failed') item.stats.captchaFailed += n
      else if (s === 'skipped') item.stats.skipped += n
      else if (s === 'running' || s === 'retry_wait') item.stats.running += n
      else if (s === 'pending') item.stats.pending += n
    }
    return list
  }

  /** 某批次的全部 run 行（窗口明细；按窗口与任务排序） */
  async listRunsForBatch(batchId: number): Promise<RunRow[]> {
    return (await this.exec(`${SELECT_RUN} WHERE r.batch_id = ? ORDER BY p.id, r.task_key, r.slot`, [batchId])) as unknown as RunRow[]
  }

  /** 区间内未分批的 run 行（老数据 batch_id IS NULL）；from=null 不设下界 */
  async listUnbatchedRuns(from: string | null, to: string): Promise<RunRow[]> {
    return (await this.exec(
      `${SELECT_RUN} WHERE r.batch_id IS NULL AND date(r.date) >= COALESCE(?, '0000-01-01') AND date(r.date) <= date(?) ORDER BY p.id, r.task_key, r.slot`,
      [from, to],
    )) as unknown as RunRow[]
  }

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

  /** 某天的全部运行记录（面板矩阵/统计用，按窗口与任务排序） */
  async listRunsForDate(date: string): Promise<RunRow[]> {
    return (await this.exec(`${SELECT_RUN} WHERE r.date = ? ORDER BY p.id, r.task_key, r.slot`, [date])) as unknown as RunRow[]
  }

  /** 某任务当天在途 run 数（pending/running/retry_wait 计入，终态不计）；可选按窗口过滤（看板行级判定用） */
  async countInFlightRuns(taskKey: string, date: string, profileId?: number): Promise<number> {
    const base = `SELECT COUNT(*) AS c FROM runs WHERE task_key = ? AND date = ? AND status IN ('pending','running','retry_wait')`
    const rows = profileId === undefined
      ? await this.exec(base, [taskKey, date])
      : await this.exec(`${base} AND profile_id = ?`, [taskKey, date, profileId])
    return Number(rows[0]?.c ?? 0)
  }

  /** 记录一次打码事件（成功/失败都记，供成本统计与面板展示）；created_at 存本地墙钟时间字符串（与 runs.date 同口径），毫秒精度，与日期前缀过滤兼容 */
  async logCaptcha(profileId: number | null, taskKey: string | null, kind: string, cost: number, ok: boolean): Promise<void> {
    const now = new Date()
    const localWall = localWallNow()
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
      [bitbrowserId, http, localWallNow()],
    )
  }

  /** 清除窗口打开状态登记（窗口关闭或 pid 实测已死时调用） */
  async clearOpenWindow(bitbrowserId: string): Promise<void> {
    await this.exec('DELETE FROM open_windows WHERE bitbrowser_id = ?', [bitbrowserId])
  }

  /**
   * 清理超期历史数据（启动时调用）：runs.date 为 YYYY-MM-DD 文本，字典序安全直接比较；
   * batches/captcha_logs 的 created_at 为本地墙钟时间字符串，用 date() 提取日期比较。
   * runs.batch_id 无外键约束，先删 runs 再删 batches 安全。
   * @param retainDays 保留天数（0 = 仅清理今天之前的数据；负数会使 cutoff 落入未来（连当天数据也删），调用方不得传负数）
   * @returns 各表删除行数
   */
  async cleanupOld(retainDays: number): Promise<{ runs: number; batches: number; captcha: number }> {
    const now = new Date()
    const cutoff = todayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - retainDays))
    const r1 = await this.client.execute({ sql: 'DELETE FROM runs WHERE date < ?', args: [cutoff] })
    const r2 = await this.client.execute({ sql: 'DELETE FROM batches WHERE date(created_at) < date(?)', args: [cutoff] })
    const r3 = await this.client.execute({ sql: 'DELETE FROM captcha_logs WHERE date(created_at) < date(?)', args: [cutoff] })
    return { runs: Number(r1.rowsAffected), batches: Number(r2.rowsAffected), captcha: Number(r3.rowsAffected) }
  }
}

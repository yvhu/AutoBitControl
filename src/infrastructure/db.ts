/**
 * 持久层（infrastructure）：本地 SQLite 数据访问（profiles 窗口 / runs 运行记录）
 * 依赖方向：依赖 @libsql/client 的行类型与本地 sqlite-client（原生 libsql 封装），被 engine/server 层依赖；RunStatus 类型被全局引用
 * 设计思路：数据层走本地文件（file: URL；file::memory: 供测试使用），经 sqlite-client 单连接 + 语句缓存访问
 *           （不用 @libsql/client 本地 client：其每次 execute/transaction 都泄漏原生内存，长跑必崩）；
 *           UNIQUE(profile_id, task_key, date) 保证每窗口每天每任务一行；
 *           库内字段用 snake_case、读出时映射为 camelCase
 */
import type { Row } from '@libsql/client'
import { LocalSqliteClient } from './sqlite-client'
import type { FailureKind } from './run-errors'

/**
 * 运行状态（状态机转移规则见 engine/state.ts）：
 * pending 待执行 / running 执行中 / success 成功 / failed 失败（终态）
 * captcha_failed 验证码失败（终态）/ retry_wait 重试等待 / skipped 跳过（终态）
 */
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'captcha_failed' | 'retry_wait' | 'skipped'

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

/** batches 表 kind 联合类型 */
export type BatchKind = 'bulk' | 'single' | 'schedule'

/** schedules 表行：一个定时计划（config/taskKeys 为 JSON 原文，语义见 engine/schedule.ts） */
export interface ScheduleRow {
  id: number
  name: string
  /** 0/1（SQLite 无布尔，读出保持数字由调用方判断） */
  enabled: number
  mode: 'interval' | 'daily' | 'weekly' | 'monthly'
  /** JSON 原文：interval {everyHours} / daily {times} / weekly {weekdays,times} / monthly {days,times} */
  config: string
  /** JSON 原文：任务 key 字符串数组 */
  taskKeys: string
  /** 最近一次定时触发所在分钟（YYYY-MM-DD HH:mm）；用于进程重启后仍只触发一次 */
  lastFiredMinute: string | null
  createdAt: string
  updatedAt: string
}

/** batches 表行：一次触发动作 */
export interface BatchRow {
  id: number
  kind: BatchKind
  taskKey: string
  source: string
  createdAt: string
}

/** 批次状态统计（列表接口聚合用；total 含全部行数；retryWait 重试等待在途单独计，running 不再包含） */
export interface BatchStats {
  total: number
  success: number
  failed: number
  captchaFailed: number
  skipped: number
  running: number
  retryWait: number
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
  circuitBreakerState?: CircuitBreakerState
  circuitBreakerLevel?: number
  circuitBreakerNextProbeMs?: number | null
  circuitBreakerProbeStartedMs?: number | null
  circuitBreakerReason?: string | null
  circuitBreakerUpdatedAt?: string | null
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

/** 窗口生命周期状态：opening = 开窗中，open = 可复用，closing = 关闭中（不再参与窗口池） */
export type OpenWindowState = 'opening' | 'open' | 'closing'
/** 窗口归属：pool = 窗口池调度，manual = 面板手动打开，taskrun = 单任务调试脚本 */
export type OpenWindowOwnerKind = 'pool' | 'manual' | 'taskrun'

/**
 * open_windows 表行：窗口打开状态 + 归属进程（owner_pid 供孤儿回收判定归属进程是否存活）
 * 窗口池字段声明为可选，兼容只关心 bitbrowserId/http/ownerPid 的旧调用方夹具；
 * AppDb 的读取方法均返回 Required<OpenWindowRow>（字段一定存在）。
 */
export interface OpenWindowRow {
  bitbrowserId: string
  http: string
  ownerPid: number | null
  state?: OpenWindowState
  ownerKind?: OpenWindowOwnerKind
  lastUsedAt?: string | null
  tasksDone?: number
}

/** open_windows 完整行（AppDb 查询返回，窗口池字段保证存在） */
export type OpenWindowPoolRow = Required<OpenWindowRow>

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
  /** 失败诊断产物路径（NULL = 无诊断文件；失败时由框架写入） */
  diagPath: string | null
  /** 失败分类（NULL = 成功或未分类） */
  failureKind?: FailureKind | null
  /** 允许开始/重试的 epoch 毫秒（0 表示立即可调度） */
  notBeforeMs?: number
  /** 首次入队时间（本地墙钟，展示用） */
  queuedAt?: string | null
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

/** airdrop 优先级枚举（状态列/项目/子项共用） */
export type AirdropPriority = 'high' | 'mid' | 'low'

/** airdrop_statuses 表行：空投追踪看板的一个状态列 */
export interface AirdropStatusRow {
  id: number
  name: string
  sortOrder: number
  createdAt: string
}

/** airdrop_projects 表行：一个空投项目条目 */
export interface AirdropProjectRow {
  id: number
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: string | null
  link: string | null
  note: string | null
  /** 绑定的系统任务 key（可空；null=纯手动追踪项目）；唯一性由部分唯一索引保证 */
  taskKey: string | null
  createdAt: string
  updatedAt: string
}

/** airdrop_todos 表行：项目下的待办子项 */
export interface AirdropTodoRow {
  id: number
  projectId: number
  content: string
  /** 0/1（SQLite 无布尔） */
  done: number
  dueDate: string | null
  priority: AirdropPriority
  createdAt: string
}

/** 状态列视图（面板 GET /airdrop/statuses）：列 + 列下项目数 */
export interface AirdropStatusView extends AirdropStatusRow {
  projectCount: number
}

/** 项目视图（面板 GET /airdrop/projects）：项目 + 状态列名 + 子项数组 */
export interface AirdropProjectView extends AirdropProjectRow {
  statusName: string
  todos: AirdropTodoRow[]
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

/** epoch 毫秒转本地墙钟字符串（与 localWallNow 同口径，供下次探测时间展示） */
export function localWallFromMs(ms: number): string {
  const d = new Date(ms)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace('T', ' ')
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
    circuit_breaker_state TEXT NOT NULL DEFAULT 'closed',
    circuit_breaker_level INTEGER NOT NULL DEFAULT 0,
    circuit_breaker_next_probe_ms INTEGER,
    circuit_breaker_probe_started_ms INTEGER,
    circuit_breaker_reason TEXT,
    circuit_breaker_updated_at TEXT,
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
    diag_path TEXT,
    failure_kind TEXT,
    not_before_ms INTEGER NOT NULL DEFAULT 0,
    queued_at TEXT,
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
  `CREATE TABLE IF NOT EXISTS task_states (
    task_key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // 定时计划表：计划（时间配置 + 任务列表）与任务代码完全解耦，由面板「定时任务」栏目管理
  `CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL,
    config TEXT NOT NULL,
    task_keys TEXT NOT NULL,
    last_fired_minute TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // 窗口打开状态登记表：主进程（面板打开/关闭）与 task:run 脚本跨进程共享，
  // 一行 = 一个已打开的窗口（http 调试地址供 CDP 复用）；pid 是否存活由调用方实测；
  // owner_pid = 打开该窗口的进程号（孤儿回收用：仅 state=open 且归属进程已死的存活窗口会被回收；Phase 1 不回收无登记窗口）
  `CREATE TABLE IF NOT EXISTS open_windows (
    bitbrowser_id TEXT PRIMARY KEY,
    http TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    owner_pid INTEGER,
    state TEXT NOT NULL DEFAULT 'open',
    owner_kind TEXT NOT NULL DEFAULT 'manual',
    last_used_at TEXT,
    tasks_done INTEGER NOT NULL DEFAULT 0
  )`,
  // 空投追踪：状态列（看板列，可自定义）/ 项目 / 待办子项——长期台账，不参与历史清理
  `CREATE TABLE IF NOT EXISTS airdrop_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS airdrop_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status_id INTEGER NOT NULL REFERENCES airdrop_statuses(id),
    priority TEXT NOT NULL DEFAULT 'mid',
    deadline TEXT,
    link TEXT,
    note TEXT,
    task_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS airdrop_todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES airdrop_projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'mid',
    created_at TEXT NOT NULL
  )`,
]

const SELECT_PROFILE = `SELECT id, bitbrowser_id AS bitbrowserId, name, enabled, circuit_breaker_count AS circuitBreakerCount, circuit_breaker_state AS circuitBreakerState, circuit_breaker_level AS circuitBreakerLevel, circuit_breaker_next_probe_ms AS circuitBreakerNextProbeMs, circuit_breaker_probe_started_ms AS circuitBreakerProbeStartedMs, circuit_breaker_reason AS circuitBreakerReason, circuit_breaker_updated_at AS circuitBreakerUpdatedAt, remark, seq, last_ip AS lastIp, last_country AS lastCountry, core_version AS coreVersion FROM profiles`
const SELECT_RUN = `SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.slot, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, r.batch_id AS batchId, r.diag_path AS diagPath, r.failure_kind AS failureKind, r.not_before_ms AS notBeforeMs, r.queued_at AS queuedAt, p.name AS profileName, p.bitbrowser_id AS bitbrowserId FROM runs r JOIN profiles p ON p.id = r.profile_id`
/** 到期行统一口径：当天、待执行、已到期且为最新 slot（claim 与未注册任务结算共用，避免 SQL 漂移） */
const DUE_RUN_CONDITION = `r.date = ? AND r.status IN ('pending','retry_wait') AND r.not_before_ms <= ?
  AND NOT EXISTS (
    SELECT 1 FROM runs r2
    WHERE r2.profile_id = r.profile_id AND r2.task_key = r.task_key AND r2.date = r.date AND r2.slot > r.slot
  )`
const OPEN_WINDOW_COLUMNS = `bitbrowser_id AS bitbrowserId, http, owner_pid AS ownerPid, state, owner_kind AS ownerKind, last_used_at AS lastUsedAt, tasks_done AS tasksDone`
const SELECT_STATUS = `SELECT s.id, s.name, s.sort_order AS sortOrder, s.created_at AS createdAt, COUNT(p.id) AS projectCount FROM airdrop_statuses s LEFT JOIN airdrop_projects p ON p.status_id = s.id`
const SELECT_PROJECT = `SELECT p.id, p.name, p.status_id AS statusId, p.priority, p.deadline, p.link, p.note, p.task_key AS taskKey, p.created_at AS createdAt, p.updated_at AS updatedAt, s.name AS statusName FROM airdrop_projects p JOIN airdrop_statuses s ON s.id = p.status_id`
const SELECT_TODO = `SELECT id, project_id AS projectId, content, done, due_date AS dueDate, priority, created_at AS createdAt FROM airdrop_todos`
/** 子项排序：未完成在前 → due_date 近者在前（NULL 最后）→ 优先级高在前 → 创建顺序 */
const TODO_ORDER = `done, due_date IS NULL, due_date, CASE priority WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, created_at, id`

/** libsql 支持的绑定值类型（undefined 不允许，调用前须归一为 null） */
type DbArg = null | string | number | bigint | Uint8Array | ArrayBuffer

/** open_windows 查询行归一化（列别名与 OPEN_WINDOW_COLUMNS 对应） */
function toOpenWindowRow(r: Row): OpenWindowPoolRow {
  return {
    bitbrowserId: String(r.bitbrowserId),
    http: String(r.http ?? ''),
    ownerPid: r.ownerPid === null || r.ownerPid === undefined ? null : Number(r.ownerPid),
    state: String(r.state) as OpenWindowState,
    ownerKind: String(r.ownerKind) as OpenWindowOwnerKind,
    lastUsedAt: r.lastUsedAt === null || r.lastUsedAt === undefined ? null : String(r.lastUsedAt),
    tasksDone: Number(r.tasksDone ?? 0),
  }
}

/**
 * 本地 SQLite 访问门面：私有构造 + 异步 open 工厂，保证打开即迁移
 * 设计权衡：不用 ORM——表结构固定、查询简单，原生 SQL 更可控且无额外依赖
 */
export class AppDb {
  private constructor(private client: LocalSqliteClient) {}

  /**
   * 打开数据库（创建本地客户端并执行建表迁移）
   * @param dbPath 本地数据库文件路径（绝对或相对；file: 前缀原样透传）
   * @returns 就绪的 AppDb 实例（磁盘/权限错误时抛错，由调用方处理退出）
   */
  static async open(dbPath: string): Promise<AppDb> {
    // 单连接 + 5 秒 busy_timeout：多进程（task:run）共用同一库文件时写锁排队，不立即报 SQLITE_BUSY
    const client = new LocalSqliteClient(toFileUrl(dbPath), { timeoutMs: 5000 })
    const db = new AppDb(client)
    await db.migrate()
    return db
  }

  async migrate(): Promise<void> {
    // busy_timeout 由 LocalSqliteClient 的 Database timeout 选项统一承担（单连接，无事务连接丢失问题）
    // WAL 日志模式：面板进程与 task:run 脚本可能同时开同一文件，读写不互锁（库级设置，幂等；
    // file::memory: 上执行无副作用）
    await this.client.execute('PRAGMA journal_mode=WAL')
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
    // 老库补列：窗口熔断健康状态列（新库 CREATE TABLE 已自带）
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
    // 老库补列：open_windows 归属进程与窗口池状态（新库 CREATE TABLE 已自带；PRAGMA 查列后缺哪个补哪个）
    const owInfo = await this.client.execute(`PRAGMA table_info(open_windows)`)
    const owCols = new Set(owInfo.rows.map((r) => String(r.name)))
    const owNew: Array<[string, string]> = [
      ['owner_pid', 'INTEGER'],
      ['state', "TEXT NOT NULL DEFAULT 'open'"],
      ['owner_kind', "TEXT NOT NULL DEFAULT 'manual'"],
      ['last_used_at', 'TEXT'],
      ['tasks_done', 'INTEGER NOT NULL DEFAULT 0'],
    ]
    for (const [col, type] of owNew) {
      if (!owCols.has(col)) await this.client.execute(`ALTER TABLE open_windows ADD COLUMN ${col} ${type}`)
    }
    // 老库补列：schedules.last_fired_minute（定时触发分钟去重，重启后仍生效）
    const schInfo = await this.client.execute(`PRAGMA table_info(schedules)`)
    if (!schInfo.rows.some((r) => String(r.name) === 'last_fired_minute')) {
      await this.client.execute('ALTER TABLE schedules ADD COLUMN last_fired_minute TEXT')
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
          diag_path TEXT,
          UNIQUE(profile_id, task_key, date, slot)
        )`)
        await tx.execute(`INSERT INTO runs (id, profile_id, task_key, date, slot, status, attempts, error, screenshot, started_at, finished_at, diag_path)
          SELECT id, profile_id, task_key, date, 0, status, attempts, error, screenshot, started_at, finished_at, NULL FROM runs_old`)
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
    // 老库补列：runs.diag_path（失败诊断产物路径，可空；不参与 UNIQUE，直接 ADD COLUMN 无需重建表）
    const runsInfo3 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo3.rows.some((r) => String(r.name) === 'diag_path')) {
      await this.client.execute(`ALTER TABLE runs ADD COLUMN diag_path TEXT`)
    }
    // 老库补列：runs.failure_kind（失败分类，可空；不参与 UNIQUE，直接 ADD COLUMN 无需重建表）
    const runsInfo4 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo4.rows.some((r) => String(r.name) === 'failure_kind')) {
      await this.client.execute(`ALTER TABLE runs ADD COLUMN failure_kind TEXT`)
    }
    // 老库补列：runs.not_before_ms / runs.queued_at（队列调度字段；新库 CREATE TABLE 已自带）
    const runsInfo5 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo5.rows.some((r) => String(r.name) === 'not_before_ms')) {
      await this.client.execute('ALTER TABLE runs ADD COLUMN not_before_ms INTEGER NOT NULL DEFAULT 0')
    }
    const runsInfo6 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo6.rows.some((r) => String(r.name) === 'queued_at')) {
      await this.client.execute('ALTER TABLE runs ADD COLUMN queued_at TEXT')
    }
    // 索引放补列块外无条件幂等创建：ALTER 与建索引之间崩溃不会永久丢失索引
    await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_runs_batch_id ON runs(batch_id)`)
    await this.client.execute('CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(status, not_before_ms)')
    // countInFlightRuns（任务/看板每次手动触发都查）用的复合索引
    await this.client.execute('CREATE INDEX IF NOT EXISTS idx_runs_task_date ON runs(task_key, date)')
    // 运行状态查询索引：按 status+date 过滤窗口/任务运行行（跨午夜旧会话仍可按 status 命中）
    await this.client.execute('CREATE INDEX IF NOT EXISTS idx_runs_status_date_profile ON runs(status, date, profile_id)')
    await this.client.execute('CREATE INDEX IF NOT EXISTS idx_runs_status_date_task ON runs(status, date, task_key)')
    // 空投追踪默认状态列种子（INSERT OR IGNORE 幂等：用户自建/改名后重启不覆盖）
    const DEFAULT_AIRDROP_STATUSES = ['关注中', '待参与', '进行中', '已完成', '已放弃']
    for (let i = 0; i < DEFAULT_AIRDROP_STATUSES.length; i++) {
      await this.client.execute({
        sql: 'INSERT OR IGNORE INTO airdrop_statuses (name, sort_order, created_at) VALUES (?, ?, ?)',
        args: [DEFAULT_AIRDROP_STATUSES[i], i, localWallNow()],
      })
    }
    // 老库补列：airdrop_projects.task_key（系统任务绑定，可空）——
    // SQLite ALTER 无法加表级 UNIQUE，唯一性用部分唯一索引（NULL 不参与，手动项目不受限）
    const apInfo = await this.client.execute(`PRAGMA table_info(airdrop_projects)`)
    if (!apInfo.rows.some((r) => String(r.name) === 'task_key')) {
      await this.client.execute(`ALTER TABLE airdrop_projects ADD COLUMN task_key TEXT`)
    }
    await this.client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_airdrop_projects_task_key ON airdrop_projects(task_key) WHERE task_key IS NOT NULL`)
    // 一次性迁移：旧熔断计数语义废弃，首次升级到健康状态模型时清零全部旧计数（app_meta 打标记保证只执行一次）
    await this.client.execute(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    const migrated = await this.client.execute({
      sql: 'SELECT value FROM app_meta WHERE key = ?',
      args: ['circuit_breaker_v2_migrated'],
    })
    if (migrated.rows.length === 0) {
      await this.client.execute(`UPDATE profiles SET circuit_breaker_count = 0, circuit_breaker_state = 'closed', circuit_breaker_level = 0, circuit_breaker_next_probe_ms = NULL, circuit_breaker_probe_started_ms = NULL, circuit_breaker_reason = NULL, circuit_breaker_updated_at = NULL`)
      await this.client.execute({
        sql: 'INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)',
        args: ['circuit_breaker_v2_migrated', '1'],
      })
    }
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

  // ===== schedules 定时计划 CRUD（config/taskKeys 以 JSON 原文落库，语义解析在 engine/schedule.ts）=====

  /** 全部计划（按创建顺序）；引擎 tick 与面板列表共用 */
  async listSchedules(): Promise<ScheduleRow[]> {
    return (await this.exec(`SELECT id, name, enabled, mode, config, task_keys AS taskKeys, last_fired_minute AS lastFiredMinute, created_at AS createdAt, updated_at AS updatedAt FROM schedules ORDER BY id`)) as unknown as ScheduleRow[]
  }

  /** 按 id 查计划（不存在返回 null） */
  async getSchedule(id: number): Promise<ScheduleRow | null> {
    const rows = await this.exec(`SELECT id, name, enabled, mode, config, task_keys AS taskKeys, last_fired_minute AS lastFiredMinute, created_at AS createdAt, updated_at AS updatedAt FROM schedules WHERE id = ?`, [id])
    return (rows[0] as unknown as ScheduleRow | undefined) ?? null
  }

  /** 新建计划（enabled 默认 1）；createdAt/updatedAt 为本地墙钟时间（与 batches 同口径） */
  async createSchedule(input: { name: string; mode: string; config: string; taskKeys: string }): Promise<ScheduleRow> {
    const now = localWallNow()
    const rs = await this.client.execute({
      sql: `INSERT INTO schedules (name, enabled, mode, config, task_keys, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      args: [input.name, input.mode, input.config, input.taskKeys, now, now],
    })
    return (await this.getSchedule(Number(rs.lastInsertRowid)))!
  }

  /** 部分更新计划（缺省字段不动）；不存在返回 null */
  async updateSchedule(id: number, patch: { name?: string; enabled?: boolean; mode?: string; config?: string; taskKeys?: string }): Promise<ScheduleRow | null> {
    const current = await this.getSchedule(id)
    if (!current) return null
    await this.exec(
      `UPDATE schedules SET name = ?, enabled = ?, mode = ?, config = ?, task_keys = ?, updated_at = ? WHERE id = ?`,
      [patch.name ?? current.name, patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0, patch.mode ?? current.mode, patch.config ?? current.config, patch.taskKeys ?? current.taskKeys, localWallNow(), id],
    )
    return this.getSchedule(id)
  }

  /** 删除计划；返回是否存在过 */
  async deleteSchedule(id: number): Promise<boolean> {
    const rs = await this.client.execute({ sql: 'DELETE FROM schedules WHERE id = ?', args: [id] })
    return Number(rs.rowsAffected) > 0
  }

  /**
   * 原子认领计划触发分钟：仅当该计划尚未在 minuteKey 触发过时写入并返回 true。
   * 用于进程内 tick 去重之外的重启/多实例兜底（单实例锁下主要是重启）。
   */
  async claimScheduleMinute(id: number, minuteKey: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE schedules SET last_fired_minute = ?
            WHERE id = ? AND (last_fired_minute IS NULL OR last_fired_minute <> ?)`,
      args: [minuteKey, id, minuteKey],
    })
    return Number(rs.rowsAffected ?? 0) > 0
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

  /** 重置所有熔断计数 > 0 的窗口，返回被重置的行数 */
  async resetMeltedCircuitBreakers(): Promise<number> {
    const rs = await this.client.execute('UPDATE profiles SET circuit_breaker_count = 0 WHERE circuit_breaker_count > 0')
    return Number(rs.rowsAffected ?? 0)
  }

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

  /**
   * 启动恢复：过期（或无开始时间）的半开探测退回 open，并安排 1 分钟后重探；
   * 避免进程重启后把窗口永久卡在 half_open。返回变更行数
   */
  async recoverStaleWindowProbes(leaseMs: number, nowMs = Date.now()): Promise<number> {
    const staleBefore = nowMs - leaseMs
    const rs = await this.client.execute({
      sql: `UPDATE profiles
            SET circuit_breaker_state = 'open',
                circuit_breaker_probe_started_ms = NULL,
                circuit_breaker_next_probe_ms = ?,
                circuit_breaker_updated_at = ?
            WHERE circuit_breaker_state = 'half_open'
              AND (circuit_breaker_probe_started_ms IS NULL OR circuit_breaker_probe_started_ms <= ?)`,
      args: [nowMs + 60_000, localWallNow(), staleBefore],
    })
    return Number(rs.rowsAffected ?? 0)
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
      `INSERT INTO runs (profile_id, task_key, date, slot, status, attempts, error, screenshot, started_at, finished_at, batch_id, diag_path, failure_kind, not_before_ms, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, task_key, date, slot) DO UPDATE SET
         status = excluded.status,
         attempts = CASE WHEN excluded.attempts = 0 THEN runs.attempts ELSE excluded.attempts END,
         error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at),
         batch_id = COALESCE(excluded.batch_id, runs.batch_id),
         diag_path = COALESCE(excluded.diag_path, runs.diag_path),
         failure_kind = excluded.failure_kind,
         not_before_ms = excluded.not_before_ms,
         queued_at = COALESCE(excluded.queued_at, runs.queued_at)`,
      [profileId, taskKey, date, slot, status, patch.attempts ?? 0, patch.error ?? null, patch.screenshot ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, patch.batchId ?? null, patch.diagPath ?? null, patch.failureKind ?? null, patch.notBeforeMs ?? 0, patch.queuedAt ?? null],
    )
    const rows = await this.exec(`${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ? AND r.slot = ?`, [profileId, taskKey, date, slot])
    return rows[0] as unknown as RunRow
  }

  /**
   * 条件写入运行记录：仅当该轮次仍为 running 时更新（CAS），避免停止已结算的 skipped 行被覆盖
   * @returns 更新后的行；条件不满足（已终态/已被 stop 结算）时返回当前行（可能为 skipped）
   * patch 仅支持 error/screenshot/finishedAt/diagPath/failureKind/notBeforeMs/attempts；
   * startedAt/batchId/queuedAt 不会被修改（attempts=0 保留旧值，finishedAt/diagPath COALESCE）
   */
  async updateRunIfRunning(profileId: number, taskKey: string, date: string, slot: number, status: RunStatus, patch: Partial<RunRow> = {}): Promise<RunRow | null> {
    const attempts = patch.attempts ?? 0
    await this.exec(
      `UPDATE runs SET status = ?,
         attempts = CASE WHEN ? = 0 THEN attempts ELSE ? END,
         error = ?, screenshot = ?,
         finished_at = COALESCE(?, finished_at),
         diag_path = COALESCE(?, diag_path),
         failure_kind = ?, not_before_ms = ?
       WHERE profile_id = ? AND task_key = ? AND date = ? AND slot = ? AND status = 'running'`,
      [status, attempts, attempts, patch.error ?? null, patch.screenshot ?? null, patch.finishedAt ?? null, patch.diagPath ?? null, patch.failureKind ?? null, patch.notBeforeMs ?? 0, profileId, taskKey, date, slot],
    )
    return this.getRun(profileId, taskKey, date, slot)
  }

  /** 创建批次（每次触发动作一行）；createdAt 缺省当前本地墙钟时间 */
  async createBatch(kind: BatchKind, taskKey: string, source: string, createdAt = localWallNow()): Promise<BatchRow> {
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

  /** 时间段内的批次列表（每窗口只取批次内最新一轮；按最近活动时间倒序）；from=null 表示不设下界 */
  async listBatchesForRange(from: string | null, to: string): Promise<Array<BatchRow & { stats: BatchStats; lastFinishedAt: string | null; lastActivityAt: string }>> {
    // 最近活动时间取批次内最晚的排队/完成时刻（重跑排队与跑完都算活动），无行时退回创建时间
    const activitySql = `COALESCE((SELECT MAX(CASE
        WHEN r3.finished_at IS NULL THEN r3.queued_at
        WHEN r3.queued_at IS NULL THEN r3.finished_at
        WHEN r3.finished_at > r3.queued_at THEN r3.finished_at
        ELSE r3.queued_at
      END) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at)`
    const rows = await this.exec(
      `SELECT b.id, b.kind, b.task_key AS taskKey, b.source, b.created_at AS createdAt,
              r.status, COUNT(r.id) AS c, MAX(r.finished_at) AS lastFinishedAt,
              ${activitySql} AS lastActivityAt
       FROM batches b
       LEFT JOIN runs r ON r.batch_id = b.id
         AND r.id = (
           SELECT MAX(r2.id) FROM runs r2
           WHERE r2.batch_id = b.id AND r2.profile_id = r.profile_id
         )
       WHERE date(${activitySql}) >= COALESCE(date(?), '0000-01-01')
         AND date(${activitySql}) <= date(?)
       GROUP BY b.id, r.status
       ORDER BY ${activitySql} DESC, b.id DESC`,
      [from, to],
    )
    const list: Array<BatchRow & { stats: BatchStats; lastFinishedAt: string | null; lastActivityAt: string }> = []
    const byId = new Map<number, BatchRow & { stats: BatchStats; lastFinishedAt: string | null; lastActivityAt: string }>()
    for (const r of rows) {
      const id = Number(r.id)
      let item = byId.get(id)
      if (!item) {
        item = {
          id,
          kind: String(r.kind) as BatchKind,
          taskKey: String(r.taskKey),
          source: String(r.source),
          createdAt: String(r.createdAt),
          lastFinishedAt: r.lastFinishedAt === null || r.lastFinishedAt === undefined ? null : String(r.lastFinishedAt),
          lastActivityAt: String(r.lastActivityAt),
          stats: { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, retryWait: 0, pending: 0 },
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
      else if (s === 'running') item.stats.running += n
      else if (s === 'retry_wait') item.stats.retryWait += n
      else if (s === 'pending') item.stats.pending += n
      // lastFinishedAt：同批多状态分组的 MAX 取全局最大值（分组聚合不会跨组合并）
      const v = r.lastFinishedAt === null || r.lastFinishedAt === undefined ? null : String(r.lastFinishedAt)
      if (v && (item.lastFinishedAt === null || v > item.lastFinishedAt)) item.lastFinishedAt = v
    }
    return list
  }

  /** 某批次的全部 run 行（窗口明细；按窗口与追加顺序排序） */
  async listRunsForBatch(batchId: number): Promise<RunRow[]> {
    return (await this.exec(`${SELECT_RUN} WHERE r.batch_id = ? ORDER BY p.id, r.task_key, r.id`, [batchId])) as unknown as RunRow[]
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

  /** 按 run id 取值（不存在返回 null） */
  async getRunById(id: number): Promise<RunRow | null> {
    const rows = await this.exec(`${SELECT_RUN} WHERE r.id = ?`, [id])
    return (rows[0] as unknown as RunRow | undefined) ?? null
  }

  /**
   * 清空某窗口某任务某轮次的诊断路径（成功重试后调用）：
   * upsertRun 的 diag_path 走 COALESCE 保留旧值，失败轮次残留路径会让
   * GET /api/diagnostics/:runId 为 success 行返回失败诊断包，故成功时显式清空
   */
  async clearRunDiag(profileId: number, taskKey: string, date: string, slot: number): Promise<void> {
    await this.exec('UPDATE runs SET diag_path = NULL WHERE profile_id = ? AND task_key = ? AND date = ? AND slot = ?', [profileId, taskKey, date, slot])
  }

  /** 当日下一轮序号：MAX(slot)+1（无记录返回 0） */
  async nextRunSlot(profileId: number, taskKey: string, date: string): Promise<number> {
    const rows = await this.exec(`SELECT COALESCE(MAX(slot), -1) + 1 AS nextSlot FROM runs WHERE profile_id = ? AND task_key = ? AND date = ?`, [profileId, taskKey, date])
    return Number(rows[0]?.nextSlot ?? 0)
  }

  /** 入队：running no-op（原样返回，不篡改批次/时间）；无最新行或最新行已终态时新建 pending；retry_wait 提升为 pending；其余非终态复用/更新批次与时间 */
  async enqueueRun(profileId: number, taskKey: string, date: string, batchId: number | null, notBeforeMs: number): Promise<RunRow> {
    const tx = await this.client.transaction('write')
    try {
      const latestRows = await tx.execute({
        sql: `${SELECT_RUN} WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ? ORDER BY r.slot DESC LIMIT 1`,
        args: [profileId, taskKey, date],
      })
      const latest = latestRows.rows[0] as unknown as RunRow | undefined
      const terminal = latest ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(latest.status) : true
      if (latest && latest.status === 'running') {
        // 已在执行的会话持有该行：再入队不改批次/开始时间，原样返回由调用方提示
        await tx.commit()
        return latest
      }
      if (latest && latest.status === 'retry_wait') {
        // 重试到期重新入队：retry_wait 行必须提升回 pending，否则 dispatcher（只调度 pending）永远看不到
        await tx.execute({
          sql: `UPDATE runs SET status = 'pending', not_before_ms = ?, batch_id = COALESCE(?, batch_id),
                       queued_at = COALESCE(queued_at, ?), finished_at = NULL, failure_kind = NULL, error = NULL
                WHERE id = ?`,
          args: [notBeforeMs, batchId, localWallNow(), latest.id],
        })
        await tx.commit()
        return (await this.getRunById(latest.id))!
      }
      if (latest && !terminal) {
        await tx.execute({
          sql: `UPDATE runs SET not_before_ms = ?, batch_id = COALESCE(?, batch_id), queued_at = COALESCE(queued_at, ?) WHERE id = ?`,
          args: [notBeforeMs, batchId, localWallNow(), latest.id],
        })
        await tx.commit()
        return (await this.getRunById(latest.id))!
      }
      const slot = latest ? Number(latest.slot) + 1 : 0
      const queuedAt = localWallNow()
      const rs = await tx.execute({
        sql: `INSERT INTO runs (profile_id, task_key, date, slot, status, attempts, batch_id, not_before_ms, queued_at)
              VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        args: [profileId, taskKey, date, slot, batchId, notBeforeMs, queuedAt],
      })
      await tx.commit()
      return (await this.getRunById(Number(rs.lastInsertRowid)))!
    } catch (e) {
      await tx.rollback().catch(() => {})
      throw e
    }
  }

  /**
   * 原子认领排队行：把仍为 pending/retry_wait 的行置为 running（到期重试与排队共用同一入口），
   * 返回实际认领到的行；取消或已被其它 tick 认领的行不会出现在结果里
   */
  async claimQueuedRuns(runIds: number[], nowMs: number): Promise<RunRow[]> {
    if (runIds.length === 0) return []
    const placeholders = runIds.map(() => '?').join(',')
    const tx = await this.client.transaction('write')
    try {
      const claimed = await tx.execute({
        sql: `UPDATE runs SET status = 'running', error = NULL
              WHERE id IN (${placeholders}) AND status IN ('pending','retry_wait') AND not_before_ms <= ?
              RETURNING id`,
        args: [...runIds, nowMs],
      })
      const ids = claimed.rows.map((r) => Number(r.id))
      if (ids.length === 0) {
        await tx.commit()
        return []
      }
      const idPlaceholders = ids.map(() => '?').join(',')
      const rows = await tx.execute({
        sql: `${SELECT_RUN} WHERE r.id IN (${idPlaceholders}) ORDER BY r.profile_id, r.not_before_ms, r.id`,
        args: ids,
      })
      await tx.commit()
      return rows.rows as unknown as RunRow[]
    } catch (e) {
      await tx.rollback().catch(() => {})
      throw e
    }
  }

  /** 会话启动失败/调度器停止：把已认领的 running 行退回 pending，等待下次调度 */
  async requeueClaimedRuns(runIds: number[], error: string, nowMs: number): Promise<number> {
    if (runIds.length === 0) return 0
    const placeholders = runIds.map(() => '?').join(',')
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'pending', not_before_ms = ?, finished_at = NULL, error = ?, failure_kind = NULL
            WHERE id IN (${placeholders}) AND status = 'running'`,
      args: [nowMs, error, ...runIds],
    })
    return Number(rs.rowsAffected ?? 0)
  }

  /**
   * 环境级失败回收：窗口池会把「已终态但 failure_kind='environment'」的认领行退回 pending 并退避，
   * 避免比特 API/代理/断网等系统级问题把任务永久结算掉；任务级失败不匹配（保持终态）。
   * attempts 同时归零：环境重试不应消耗任务级重试预算（否则 retryMax 次后会被误判为任务失败）。
   * 返回是否确实退回了该行。
   */
  async requeueEnvironmentRun(runId: number, notBeforeMs: number, error: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE runs
            SET status = 'pending', not_before_ms = ?, attempts = 0, finished_at = NULL, failure_kind = NULL,
                error = ?, queued_at = COALESCE(queued_at, ?)
            WHERE id = ? AND failure_kind = 'environment' AND status IN ('failed','skipped')`,
      args: [notBeforeMs, error, localWallNow(), runId],
    })
    return Number(rs.rowsAffected ?? 0) > 0
  }

  /**
   * 结算到期但任务已不在注册表中的行：taskKeys 无对应 key 时永远不会被认领，
   * 直接置 skipped 避免永久 pending；只处理当天到期的最新增量行
   */
  async settleUnregisteredRuns(date: string, nowMs: number, taskKeys: Set<string>): Promise<number> {
    const due = (await this.exec(
      `${SELECT_RUN} WHERE ${DUE_RUN_CONDITION} ORDER BY r.profile_id, r.not_before_ms, r.id`,
      [date, nowMs],
    )) as unknown as RunRow[]
    const ids = due.filter((row) => !taskKeys.has(row.taskKey)).map((row) => row.id)
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'skipped', error = '任务未注册', finished_at = ?, failure_kind = NULL
            WHERE id IN (${placeholders}) AND status IN ('pending','retry_wait')`,
      args: [localWallNow(), ...ids],
    })
    return Number(rs.rowsAffected ?? 0)
  }

  /** 该窗口是否有 running 行（任意日期/任务；面板手动关窗前判定是否需要中止会话） */
  async hasRunningRun(profileId: number): Promise<boolean> {
    const rows = await this.exec(`SELECT 1 AS v FROM runs WHERE profile_id = ? AND status = 'running' LIMIT 1`, [profileId])
    return rows.length > 0
  }

  /**
   * 当天是否有到期待执行行（窗口池空转短路用）：
   * 用单行 EXISTS（底层走 .get，不会像多行查询那样每次分配原生结果数组），
   * 无到期行时窗口池直接返回，不读窗口列表、不写事务
   */
  async hasDueRuns(date: string, nowMs: number): Promise<boolean> {
    const row = await this.client.getFirst({
      sql: `SELECT EXISTS (SELECT 1 FROM runs r WHERE ${DUE_RUN_CONDITION}) AS v`,
      args: [date, nowMs],
    })
    return Number(row?.v ?? 0) === 1
  }

  /** 当天到期排队行数（面板池状态/暂停时统计用；单行 COUNT，不分配结果数组） */
  async countDueRuns(date: string, nowMs: number): Promise<number> {
    const row = await this.client.getFirst({
      sql: `SELECT COUNT(*) AS c FROM runs r WHERE ${DUE_RUN_CONDITION}`,
      args: [date, nowMs],
    })
    return Number(row?.c ?? 0)
  }

  /**
   * 当天有到期排队行的窗口（窗口池调度入口）：
   * 只统计最新 slot、已到期且仍为 pending/retry_wait 的行，按最早入队时间排序；
   * 到期/最新 slot 判定复用 DUE_RUN_CONDITION（别名与 r2 子查询均匹配分组查询）；
   * oldestQueuedAt 为该窗口到期行中最早的 queued_at（老数据可能为 null）
   */
  async listPendingWindowKeys(
    date: string,
    nowMs: number,
  ): Promise<Array<{ profileId: number; oldestQueuedAt: string | null }>> {
    return (await this.exec(
      `SELECT r.profile_id AS profileId, MIN(r.queued_at) AS oldestQueuedAt
       FROM runs r
       WHERE ${DUE_RUN_CONDITION}
       GROUP BY r.profile_id ORDER BY oldestQueuedAt, r.profile_id`,
      [date, nowMs],
    )) as unknown as Array<{ profileId: number; oldestQueuedAt: string | null }>
  }

  /** 某窗口当天到期的最新增量排队行（窗口池会话取任务用；与 DUE_RUN_CONDITION 同口径） */
  async listPendingRunsForWindow(profileId: number, date: string, nowMs: number): Promise<RunRow[]> {
    return (await this.exec(
      `${SELECT_RUN} WHERE r.profile_id = ? AND ${DUE_RUN_CONDITION} ORDER BY r.queued_at, r.id`,
      [profileId, date, nowMs],
    )) as unknown as RunRow[]
  }

  /**
   * 单行停止：仅当该行仍是 pending/retry_wait 时原子结算为 skipped。
   * 条件更新用于与调度器的 claimQueuedRuns 竞争——已被认领为 running 的行不会被覆盖；
   * 返回是否确实由本次调用结算（false 表示行已不存在或已进入其它状态）。
   */
  async stopQueuedRun(profileId: number, taskKey: string, date: string, slot: number): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'skipped', error = '手动停止', finished_at = ?, failure_kind = 'stopped'
            WHERE profile_id = ? AND task_key = ? AND date = ? AND slot = ? AND status IN ('pending','retry_wait')`,
      args: [localWallNow(), profileId, taskKey, date, slot],
    })
    return Number(rs.rowsAffected ?? 0) > 0
  }

  /**
   * 单行停止 running 行：仅当该行仍为 running 时原子结算为 skipped。
   * 与 runTask 的终态写入竞争：任务已成功/失败时返回 false，调用方不得覆盖终态。
   */
  async stopRunningRun(profileId: number, taskKey: string, date: string, slot: number): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'skipped', error = '手动停止', finished_at = ?, failure_kind = 'stopped'
            WHERE profile_id = ? AND task_key = ? AND date = ? AND slot = ? AND status = 'running'`,
      args: [localWallNow(), profileId, taskKey, date, slot],
    })
    return Number(rs.rowsAffected ?? 0) > 0
  }

  /** 批次停止：把排队中的 pending/retry_wait 结算为 skipped，返回行数 */
  async stopQueuedRuns(batchId: number): Promise<number> {
    const now = localWallNow()
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'skipped', error = '手动停止', finished_at = ?, failure_kind = 'stopped'
            WHERE batch_id = ? AND status IN ('pending','retry_wait')`,
      args: [now, batchId],
    })
    return Number(rs.rowsAffected ?? 0)
  }

  /** 跨日结算：旧日期仍在排队的 pending/retry_wait 行已无调度机会，直接 skipped */
  async settleOldQueuedRuns(today: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'skipped', error = '跨日未执行，已结算', finished_at = ?
            WHERE date < ? AND status IN ('pending','retry_wait')`,
      args: [localWallNow(), today],
    })
    return Number(rs.rowsAffected ?? 0)
  }

  /** 跨日结算：旧日期残留 running 行（新进程无法续跑）落 failed，避免永久阻塞窗口 */
  async settleOldRunningRuns(today: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'failed', error = '跨日崩溃残留', finished_at = ?, failure_kind = 'task'
            WHERE date < ? AND status = 'running'`,
      args: [localWallNow(), today],
    })
    return Number(rs.rowsAffected ?? 0)
  }

  /** 启动恢复：当天 running 行重置为 pending，等待调度器重新调度 */
  async requeueStaleRunning(date: string, nowMs: number): Promise<number> {
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'pending', not_before_ms = ?, finished_at = NULL, failure_kind = NULL,
                   error = '进程崩溃残留，重新排队'
            WHERE date = ? AND status = 'running'`,
      args: [nowMs, date],
    })
    return Number(rs.rowsAffected ?? 0)
  }

  /** 结算同一任务被更新 slot 取代的旧非终态行 */
  async settleSupersededRuns(date: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `UPDATE runs SET status = 'failed', error = '已被后续轮次取代', finished_at = ?, failure_kind = 'task'
            WHERE date = ? AND status IN ('pending','running','retry_wait')
              AND EXISTS (
                SELECT 1 FROM runs r2
                WHERE r2.profile_id = runs.profile_id AND r2.task_key = runs.task_key
                  AND r2.date = runs.date AND r2.slot > runs.slot
              )`,
      args: [localWallNow(), date],
    })
    return Number(rs.rowsAffected ?? 0)
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

  /** 读窗口打开状态登记（无登记返回 null）；是否真实存活由调用方经比特浏览器 /browser/pids 实测 */
  async getOpenWindow(bitbrowserId: string): Promise<{ http: string; state: OpenWindowState; ownerPid: number | null } | null> {
    const rows = await this.exec('SELECT http, state, owner_pid FROM open_windows WHERE bitbrowser_id = ?', [bitbrowserId])
    return rows.length > 0
      ? {
        http: String(rows[0].http),
        state: String(rows[0].state) as OpenWindowState,
        ownerPid: rows[0].owner_pid == null ? null : Number(rows[0].owner_pid),
      }
      : null
  }

  /** 读全部打开状态登记（含 owner_pid 与窗口池状态；孤儿回收用） */
  async listOpenWindows(): Promise<OpenWindowPoolRow[]> {
    const rows = await this.exec(`SELECT ${OPEN_WINDOW_COLUMNS} FROM open_windows`)
    return rows.map(toOpenWindowRow)
  }

  /** 读窗口池可用窗口（owner_kind = pool、生命周期 open 且已写入调试地址） */
  async listPoolWindows(): Promise<OpenWindowPoolRow[]> {
    const rows = await this.exec(
      `SELECT ${OPEN_WINDOW_COLUMNS} FROM open_windows WHERE owner_kind = 'pool' AND state = 'open' AND TRIM(http) <> ''`,
    )
    return rows.map(toOpenWindowRow)
  }

  /**
   * 预留窗口归属登记（开窗前调用）：先占位写 owner_pid，避免「窗口已开、登记未写」的竞态窗口
   * 被其它进程的孤儿回收误关；开成功后用 setOpenWindow 补 http，开失败用 clearOpenWindow 清除。
   * ownerKind 缺省 manual，保持既有 2 参调用语义。
   */
  async reserveOpenWindow(
    bitbrowserId: string,
    ownerPid: number,
    ownerKind: OpenWindowOwnerKind = 'manual',
  ): Promise<void> {
    await this.exec(
      `INSERT INTO open_windows (bitbrowser_id, http, opened_at, owner_pid, state, owner_kind)
       VALUES (?, '', ?, ?, 'opening', ?)
       ON CONFLICT(bitbrowser_id) DO UPDATE SET
         http = '', opened_at = excluded.opened_at, owner_pid = excluded.owner_pid,
         state = 'opening', owner_kind = excluded.owner_kind`,
      [bitbrowserId, localWallNow(), ownerPid, ownerKind],
    )
  }

  /**
   * 登记/更新窗口打开状态（面板打开、task:run 复用探测等场景写入；同 id 覆盖 http/时间/归属进程/状态）。
   * ownerKind 显式传入时写入/覆盖归属；省略时保持旧语义（新建默认 manual、冲突保留原归属）。
   * 开窗失败重试等场景登记行可能已被对账清理，必须带上归属重建，避免池窗口退化成 manual。
   */
  async setOpenWindow(
    bitbrowserId: string,
    http: string,
    ownerPid?: number,
    state: OpenWindowState = 'open',
    ownerKind?: OpenWindowOwnerKind,
  ): Promise<void> {
    const kind = ownerKind ?? null
    await this.exec(
      `INSERT INTO open_windows (bitbrowser_id, http, opened_at, owner_pid, state, owner_kind)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, 'manual'))
       ON CONFLICT(bitbrowser_id) DO UPDATE SET
         http = excluded.http, opened_at = excluded.opened_at,
         owner_pid = excluded.owner_pid, state = excluded.state,
         owner_kind = COALESCE(?, open_windows.owner_kind)`,
      [bitbrowserId, http, localWallNow(), ownerPid ?? null, state, kind, kind],
    )
  }

  /** 更新窗口生命周期状态（开窗完成/关闭中） */
  async setWindowState(bitbrowserId: string, state: OpenWindowState): Promise<void> {
    await this.exec('UPDATE open_windows SET state = ? WHERE bitbrowser_id = ?', [state, bitbrowserId])
  }

  /** 记录窗口最近使用时间与已完成任务数（窗口池淘汰依据） */
  async touchWindowUsed(bitbrowserId: string, tasksDone: number): Promise<void> {
    await this.exec('UPDATE open_windows SET last_used_at = ?, tasks_done = ? WHERE bitbrowser_id = ?', [
      localWallNow(),
      tasksDone,
      bitbrowserId,
    ])
  }

  /** 窗口每完成一个任务：tasks_done 原子 +1 并刷新最近使用时间（窗口池淘汰依据） */
  async incrementWindowUsage(bitbrowserId: string): Promise<void> {
    await this.exec(
      'UPDATE open_windows SET tasks_done = tasks_done + 1, last_used_at = ? WHERE bitbrowser_id = ?',
      [localWallNow(), bitbrowserId],
    )
  }

  /** 清除窗口打开状态登记（窗口关闭或 pid 实测已死时调用） */
  async clearOpenWindow(bitbrowserId: string): Promise<void> {
    await this.exec('DELETE FROM open_windows WHERE bitbrowser_id = ?', [bitbrowserId])
  }

  // ===== 空投追踪 CRUD（airdrop_statuses / airdrop_projects / airdrop_todos）=====

  /** 状态列清单（含项目数，按 sort_order） */
  async listAirdropStatuses(): Promise<AirdropStatusView[]> {
    return (await this.exec(`${SELECT_STATUS} GROUP BY s.id ORDER BY s.sort_order, s.id`)) as unknown as AirdropStatusView[]
  }

  /** 按 id 查状态列（不存在返回 null） */
  async getAirdropStatus(id: number): Promise<AirdropStatusRow | null> {
    const rows = await this.exec('SELECT id, name, sort_order AS sortOrder, created_at AS createdAt FROM airdrop_statuses WHERE id = ?', [id])
    return (rows[0] as unknown as AirdropStatusRow | undefined) ?? null
  }

  /** 新增状态列（sort_order 取 max+1）；重名返回 null（路由转 400） */
  async createAirdropStatus(name: string): Promise<AirdropStatusRow | null> {
    const dup = await this.exec('SELECT id FROM airdrop_statuses WHERE name = ?', [name])
    if (dup.length > 0) return null
    const max = await this.exec('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM airdrop_statuses')
    const rs = await this.client.execute({
      sql: 'INSERT INTO airdrop_statuses (name, sort_order, created_at) VALUES (?, ?, ?)',
      args: [name, Number(max[0]?.next ?? 0), localWallNow()],
    })
    return this.getAirdropStatus(Number(rs.lastInsertRowid))
  }

  /** 部分更新状态列（缺省字段不动）；不存在返回 null */
  async updateAirdropStatus(id: number, patch: { name?: string; sortOrder?: number }): Promise<AirdropStatusRow | null> {
    const current = await this.getAirdropStatus(id)
    if (!current) return null
    await this.exec('UPDATE airdrop_statuses SET name = ?, sort_order = ? WHERE id = ?', [patch.name ?? current.name, patch.sortOrder ?? current.sortOrder, id])
    return this.getAirdropStatus(id)
  }

  /** 删除状态列：不存在 not_found；列下仍有项目 not_empty（路由转 409）；成功 deleted */
  async deleteAirdropStatus(id: number): Promise<'deleted' | 'not_found' | 'not_empty'> {
    if (!(await this.getAirdropStatus(id))) return 'not_found'
    const cnt = await this.exec('SELECT COUNT(*) AS c FROM airdrop_projects WHERE status_id = ?', [id])
    if (Number(cnt[0]?.c ?? 0) > 0) return 'not_empty'
    await this.exec('DELETE FROM airdrop_statuses WHERE id = ?', [id])
    return 'deleted'
  }

  /**
   * 全部项目视图（含 statusName 与子项数组），已排序：
   * 列按 sort_order → 列内按优先级权重 → deadline 近者在前（NULL 最后）→ 创建时间
   */
  async listAirdropProjects(): Promise<AirdropProjectView[]> {
    const rows = await this.exec(
      `${SELECT_PROJECT} ORDER BY s.sort_order, s.id, CASE p.priority WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, p.deadline IS NULL, p.deadline, p.created_at, p.id`,
    )
    const todoRows = await this.exec(`${SELECT_TODO} ORDER BY ${TODO_ORDER}`)
    const views = rows.map((r) => ({ ...r, todos: [] as AirdropTodoRow[] })) as unknown as AirdropProjectView[]
    const byId = new Map(views.map((v) => [v.id, v]))
    for (const t of todoRows) {
      const v = byId.get(Number(t.projectId))
      if (v) v.todos.push(t as unknown as AirdropTodoRow)
    }
    return views
  }

  /** 提醒汇总数据源：全部项目 + 未完成且有期限的子项（数量级小全量取回，交给纯函数汇总） */
  async listReminderSources(): Promise<{ projects: AirdropProjectRow[]; todos: AirdropTodoRow[] }> {
    const projects = await this.exec(`SELECT id, name, status_id AS statusId, priority, deadline, link, note, task_key AS taskKey, created_at AS createdAt, updated_at AS updatedAt FROM airdrop_projects`)
    const todos = await this.exec(`${SELECT_TODO} WHERE done = 0 AND due_date IS NOT NULL`)
    return { projects: projects as unknown as AirdropProjectRow[], todos: todos as unknown as AirdropTodoRow[] }
  }

  /** 单个项目视图（含子项，按子项排序）；不存在返回 null */
  async getAirdropProject(id: number): Promise<AirdropProjectView | null> {
    const rows = await this.exec(`${SELECT_PROJECT} WHERE p.id = ?`, [id])
    if (rows.length === 0) return null
    const view = rows[0] as unknown as AirdropProjectView
    view.todos = (await this.exec(`${SELECT_TODO} WHERE project_id = ? ORDER BY ${TODO_ORDER}`, [id])) as unknown as AirdropTodoRow[]
    return view
  }

  /** 新建项目（statusId 存在性由路由校验）；返回完整视图 */
  async createAirdropProject(input: { name: string; statusId: number; priority: AirdropPriority; deadline?: string | null; link?: string | null; note?: string | null; taskKey?: string | null }): Promise<AirdropProjectView> {
    const now = localWallNow()
    const rs = await this.client.execute({
      sql: `INSERT INTO airdrop_projects (name, status_id, priority, deadline, link, note, task_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [input.name, input.statusId, input.priority, input.deadline ?? null, input.link ?? null, input.note ?? null, input.taskKey ?? null, now, now],
    })
    return (await this.getAirdropProject(Number(rs.lastInsertRowid)))!
  }

  /**
   * 部分更新项目（null 显式清空 deadline/link/note/taskKey，undefined 不动）；
   * statusId 流转（拖拽落列）走同一入口；不存在返回 null
   */
  async updateAirdropProject(id: number, patch: { name?: string; statusId?: number; priority?: AirdropPriority; deadline?: string | null; link?: string | null; note?: string | null; taskKey?: string | null }): Promise<AirdropProjectView | null> {
    const current = await this.getAirdropProject(id)
    if (!current) return null
    await this.exec(
      `UPDATE airdrop_projects SET name = ?, status_id = ?, priority = ?, deadline = ?, link = ?, note = ?, task_key = ?, updated_at = ? WHERE id = ?`,
      [
        patch.name ?? current.name,
        patch.statusId ?? current.statusId,
        patch.priority ?? current.priority,
        patch.deadline === undefined ? current.deadline : patch.deadline,
        patch.link === undefined ? current.link : patch.link,
        patch.note === undefined ? current.note : patch.note,
        patch.taskKey === undefined ? current.taskKey : patch.taskKey,
        localWallNow(),
        id,
      ],
    )
    return this.getAirdropProject(id)
  }

  /** 删除项目并级联删子项（不依赖外键 pragma，显式删）；返回是否存在过 */
  async deleteAirdropProject(id: number): Promise<boolean> {
    if (!(await this.getAirdropProject(id))) return false
    await this.exec('DELETE FROM airdrop_todos WHERE project_id = ?', [id])
    await this.exec('DELETE FROM airdrop_projects WHERE id = ?', [id])
    return true
  }

  /** 加子项（项目不存在返回 null）；done 恒为 0 */
  async createAirdropTodo(projectId: number, input: { content: string; dueDate?: string | null; priority: AirdropPriority }): Promise<AirdropTodoRow | null> {
    if (!(await this.getAirdropProject(projectId))) return null
    const rs = await this.client.execute({
      sql: 'INSERT INTO airdrop_todos (project_id, content, done, due_date, priority, created_at) VALUES (?, ?, 0, ?, ?, ?)',
      args: [projectId, input.content, input.dueDate ?? null, input.priority, localWallNow()],
    })
    return this.getAirdropTodo(Number(rs.lastInsertRowid))
  }

  /** 按 id 查子项（不存在返回 null） */
  async getAirdropTodo(id: number): Promise<AirdropTodoRow | null> {
    const rows = await this.exec(`${SELECT_TODO} WHERE id = ?`, [id])
    return (rows[0] as unknown as AirdropTodoRow | undefined) ?? null
  }

  /** 部分更新子项（勾选 done / 改 content / dueDate 传 null 清空）；不存在返回 null */
  async updateAirdropTodo(id: number, patch: { content?: string; done?: boolean; dueDate?: string | null; priority?: AirdropPriority }): Promise<AirdropTodoRow | null> {
    const current = await this.getAirdropTodo(id)
    if (!current) return null
    await this.exec(
      `UPDATE airdrop_todos SET content = ?, done = ?, due_date = ?, priority = ? WHERE id = ?`,
      [
        patch.content ?? current.content,
        patch.done === undefined ? current.done : patch.done ? 1 : 0,
        patch.dueDate === undefined ? current.dueDate : patch.dueDate,
        patch.priority ?? current.priority,
        id,
      ],
    )
    return this.getAirdropTodo(id)
  }

  /** 删子项；返回是否存在过 */
  async deleteAirdropTodo(id: number): Promise<boolean> {
    const rs = await this.client.execute({ sql: 'DELETE FROM airdrop_todos WHERE id = ?', args: [id] })
    return Number(rs.rowsAffected) > 0
  }

  /**
   * 清理超期历史数据（启动时调用）：runs.date 为 YYYY-MM-DD 文本，字典序安全直接比较；
   * batches 按批次最近活动时间（最后一条 run 的排队/完成时刻，无行为 created_at）判断超期，
   * 该时间为本地墙钟时间字符串，用 date() 提取日期比较。
   * runs.batch_id 无外键约束，先删 runs 再删 batches 安全。
   * @param retainDays 保留天数（0 = 仅清理今天之前的数据；负数按 0 处理：仅清理今天之前的数据）
   * @returns 各表删除行数
   */
  async cleanupOld(retainDays: number): Promise<{ runs: number; batches: number }> {
    const safeDays = Math.max(0, retainDays)
    const now = new Date()
    const cutoff = todayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - safeDays))
    const r1 = await this.client.execute({ sql: 'DELETE FROM runs WHERE date < ?', args: [cutoff] })
    const r2 = await this.client.execute({
      sql: `DELETE FROM batches
            WHERE date(COALESCE(
              (SELECT MAX(CASE
                WHEN finished_at IS NULL THEN queued_at
                WHEN queued_at IS NULL THEN finished_at
                WHEN finished_at > queued_at THEN finished_at
                ELSE queued_at
              END) FROM runs WHERE batch_id = batches.id),
              created_at
            )) < date(?)`,
      args: [cutoff],
    })
    return { runs: Number(r1.rowsAffected), batches: Number(r2.rowsAffected) }
  }
}

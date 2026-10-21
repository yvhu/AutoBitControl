/**
 * 本地 SQLite 客户端（infrastructure）：包装 libsql 原生绑定，单连接 + prepared statement 缓存 + 串行事务
 * 依赖方向：仅依赖 libsql 原生库，被 db.ts 使用；不依赖上层
 * 设计思路：不用 @libsql/client 的本地 client——实测它每次 execute 都新建 prepared statement 且不释放
 *           （约 3.8KB/条，10 万次查询 RSS 线性增长），transaction() 每次还会新开一条原生连接且从不关闭
 *           （约 180KB/次，2000 次事务后退出进程必现 0xC0000005）；改为单连接 + 语句缓存后，
 *           10 万次单行查询（get）RSS 持平（all() 每次仍有约 1KB 原生分配，高频单行查询走 getFirst）。
 *           所有操作经异步锁串行化，事务在连接上显式 BEGIN/COMMIT，避免嵌套事务与语句混入事务。
 */
import Database from 'libsql'
import type { Row } from '@libsql/client'

/** 单条 SQL 及绑定参数（参数仅用位置参数数组；对象形式兼容 better-sqlite3 命名参数） */
export interface LocalStatement {
  sql: string
  args?: unknown[] | Record<string, unknown>
}

/** 执行结果（与 @libsql/client 的 ResultSet 字段对齐：db.ts 只用到这三个属性） */
export interface LocalResultSet {
  rows: Row[]
  rowsAffected: number
  lastInsertRowid: number
}

/** 本地库打开参数 */
export interface LocalSqliteOptions {
  /** 跨进程写锁等待毫秒（映射 SQLite busy_timeout；多进程共用同一库文件时需要） */
  timeoutMs?: number
}

/** 缓存的原生语句（libsql 的 prepare 结果，better-sqlite3 兼容 API） */
type PreparedStatement = Database.Statement

/**
 * 本地 SQLite 客户端：语句缓存 + 异步锁
 * 所有方法虽为 async（保持调用方签名不变），内部走同步原生调用；锁只用于串行化事务与语句，
 * 保证事务期间不会混入其它语句、两个事务不会嵌套。
 */
export class LocalSqliteClient {
  private readonly db: Database.Database
  /** SQL 文本 -> 已 prepare 的语句（唯一 SQL 数量有限，缓存无上限风险） */
  private readonly statements = new Map<string, PreparedStatement>()
  /** 串行锁：当前操作完成后才轮到下一个 */
  private lock: Promise<void> = Promise.resolve()
  private closed = false

  constructor(filename: string, opts: LocalSqliteOptions = {}) {
    this.db = new Database(filename, { timeout: opts.timeoutMs ?? 5000 })
  }

  /** 执行单条 SQL（排队等待当前事务/语句结束；同一 SQL 只 prepare 一次） */
  execute(stmtOrSql: string | LocalStatement): Promise<LocalResultSet> {
    return this.runExclusive(() => this.runStatement(stmtOrSql))
  }

  /**
   * 只取首行（单行查询专用）：走原生 get 路径——libsql 的 all() 每次调用都会分配并泄漏
   * 约 1KB 原生内存（行数无关），高频单行查询（如 dispatcher 每秒的到期判断）必须用 get()
   */
  getFirst(stmtOrSql: string | LocalStatement): Promise<Row | null> {
    return this.runExclusive(() => this.runFirst(stmtOrSql))
  }

  /**
   * 开启事务：写事务用 BEGIN IMMEDIATE 提前拿写锁（多进程并发时尽快失败/等待，而非升级锁死锁），
   * 读事务用 BEGIN DEFERRED；返回的事务对象 commit/rollback/close 时释放锁。
   */
  async transaction(mode: 'write' | 'deferred' = 'write'): Promise<LocalTransaction> {
    const release = await this.acquire()
    try {
      this.db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED')
    } catch (e) {
      release()
      throw e
    }
    return new LocalTransaction(this, release)
  }

  /** 关闭连接（释放缓存的语句与打开的事务）；重复调用幂等 */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      if (this.db.inTransaction) this.db.exec('ROLLBACK')
    } catch {
      // 连接可能已失效，收尾失败不影响关闭
    }
    this.statements.clear()
    try {
      this.db.close()
    } catch {
      // 关闭失败时进程通常正在退出，吞掉避免影响收尾
    }
  }

  /** @internal 事务内部调用（调用方已持锁）；外部不得直接调用 */
  runStatement(stmtOrSql: string | LocalStatement): LocalResultSet {
    if (this.closed) throw new Error('本地数据库连接已关闭')
    const { sql, args } = normalize(stmtOrSql)
    const stmt = this.prepare(sql)
    const params = args === undefined ? [] : args
    // 结果集语句（SELECT/PRAGMA/...RETURNING）走 all；其余走 run 取 changes/lastInsertRowid
    if (stmt.reader) {
      const rows = (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as Row[]
      return { rows, rowsAffected: 0, lastInsertRowid: 0 }
    }
    const info = Array.isArray(params) ? stmt.run(...params) : stmt.run(params)
    return {
      rows: [],
      rowsAffected: Number(info.changes ?? 0),
      lastInsertRowid: Number(info.lastInsertRowid ?? 0),
    }
  }

  /** @internal 只取首行（调用方已持锁或处于事务中）：单行查询走 get 路径避免 all() 的原生内存增长 */
  runFirst(stmtOrSql: string | LocalStatement): Row | null {
    if (this.closed) throw new Error('本地数据库连接已关闭')
    const { sql, args } = normalize(stmtOrSql)
    const stmt = this.prepare(sql)
    const params = args === undefined ? [] : args
    const row = Array.isArray(params) ? stmt.get(...params) : stmt.get(params)
    return (row ?? null) as Row | null
  }

  /** @internal 事务提交/回滚用：执行控制语句（不经过锁，避免自锁） */
  execControl(sql: string): void {
    this.db.exec(sql)
  }

  /** 命中缓存则复用，避免每次查询新建原生语句造成持续泄漏 */
  private prepare(sql: string): PreparedStatement {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const stmt = this.db.prepare(sql)
    this.statements.set(sql, stmt)
    return stmt
  }

  /** 获取锁：返回释放函数（Promise 链保证 FIFO） */
  private async acquire(): Promise<() => void> {
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    return release
  }

  private async runExclusive<T>(fn: () => T): Promise<T> {
    const release = await this.acquire()
    try {
      return fn()
    } finally {
      release()
    }
  }
}

/** 显式事务：commit/rollback/close 均幂等，且无论如何都会释放串行锁 */
export class LocalTransaction {
  private settled = false

  /** @internal 由 LocalSqliteClient.transaction 创建 */
  constructor(
    private readonly client: LocalSqliteClient,
    private readonly release: () => void,
  ) {}

  /** 事务内执行（不重新抢锁，避免自锁） */
  async execute(stmtOrSql: string | LocalStatement): Promise<LocalResultSet> {
    this.ensureOpen()
    return this.client.runStatement(stmtOrSql)
  }

  async commit(): Promise<void> {
    this.finish('COMMIT')
  }

  async rollback(): Promise<void> {
    this.finish('ROLLBACK')
  }

  /** 未提交事务关闭时回滚（与旧 client 的 close 语义一致） */
  close(): void {
    if (this.settled) return
    this.finish('ROLLBACK', false)
  }

  private ensureOpen(): void {
    if (this.settled) throw new Error('事务已结束')
  }

  /** 执行 COMMIT/ROLLBACK 并释放锁；已结束则忽略（旧代码常在 catch 里重复 rollback） */
  private finish(sql: 'COMMIT' | 'ROLLBACK', rethrow = true): void {
    if (this.settled) return
    this.settled = true
    try {
      this.client.execControl(sql)
    } catch (e) {
      if (rethrow) throw e
    } finally {
      this.release()
    }
  }
}

/** 归一化语句入参 */
function normalize(stmtOrSql: string | LocalStatement): { sql: string; args?: unknown[] | Record<string, unknown> } {
  return typeof stmtOrSql === 'string' ? { sql: stmtOrSql } : stmtOrSql
}

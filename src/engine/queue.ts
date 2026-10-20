/**
 * 运行调度器（engine 层）：runs 表即队列，按 not_before_ms 调度窗口会话
 * 依赖方向：依赖 infrastructure/db 与 engine/window-runner 类型；被 app 装配、server 路由使用
 * 设计思路：enqueue 只写 DB；dispatcher 每秒用 DB claim 事务认领到期行，并发额度全部以 runs.status='running' 为准
 */
import { todayStr, type AppDb, type ProfileRow, type RunRow } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'

/** 窗口会话要跑的一个任务 */
export interface SessionTask {
  taskKey: string
  /** 已认领行所属日期（跨午夜按行日期落库，不再用 todayStr 重新推导） */
  date?: string
  batchId?: number
}

/** runner 拒绝后的回队退避：避免持久性故障导致 dispatcher 热循环 */
const REQUEUE_BACKOFF_MS = 30_000

export class CoalescingEnqueuer {
  private timer: ReturnType<typeof setInterval> | null = null
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private dispatchScheduled = false
  private stopped = false
  /** 最近一次调度日期：跨午夜时结算旧日期的排队行（running 行由各自会话按认领日期结算） */
  private lastDate: string | null = null
  private readonly maxConcurrentWindows: number
  private readonly tickMs: number

  constructor(
    private readonly db: AppDb,
    private readonly runner: { runWindowTasks(profile: ProfileRow, tasks: SessionTask[]): Promise<unknown> },
    private readonly logger: Logger,
    private readonly limits: Map<string, number>,
    maxConcurrentWindows = Number.POSITIVE_INFINITY,
    tickMs = 1000,
  ) {
    this.maxConcurrentWindows = Number.isFinite(maxConcurrentWindows) ? Math.max(1, maxConcurrentWindows) : Number.POSITIVE_INFINITY
    this.tickMs = tickMs
  }

  /** 启动 dispatcher 定时器（app 装配时调用） */
  start(): void {
    this.stopped = false
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref?.()
  }

  /** 停止 dispatcher：清理定时器并拒绝后续调度 */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer)
    this.dispatchTimer = null
    this.dispatchScheduled = false
  }

  /** 入队：写 pending 行；notBeforeMs 由触发入口计算（错峰），缺省沿用同窗口 pending 时间或立即 */
  async enqueue(
    profile: ProfileRow,
    taskKey: string,
    opts: { immediate?: boolean; batchId?: number; notBeforeMs?: number } = {},
  ): Promise<void> {
    const date = todayStr()
    const notBeforeMs = opts.notBeforeMs ?? (opts.immediate ? Date.now() : await this.pickNotBefore(profile.id, date))
    await this.db.enqueueRun(profile.id, taskKey, date, opts.batchId ?? null, notBeforeMs)
    this.requestDispatch()
  }

  /** 同一窗口已有 pending 时沿用最早时间；否则立即（错峰由调用方经 notBeforeMs 传入） */
  private async pickNotBefore(profileId: number, date: string): Promise<number> {
    const existing = await this.db.minPendingNotBefore(profileId, date)
    if (existing != null) return existing
    return Date.now()
  }

  /** 尽快跑一次 tick（合并多次 enqueue） */
  private requestDispatch(): void {
    if (this.stopped || this.dispatchScheduled) return
    this.dispatchScheduled = true
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null
      this.dispatchScheduled = false
      if (this.stopped) return
      void this.tick()
    }, 0)
    this.dispatchTimer.unref?.()
  }

  /** 调度 tick：DB 事务认领到期行，按窗口分组启动会话 */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const date = todayStr()
      // 进程跨午夜运行：旧日期的 pending/retry_wait 已不可能再被调度，直接结算；
      // running 行不动——它们由正在执行的会话按认领日期自行落终态
      if (this.lastDate !== date) {
        try {
          const settled = await this.db.settleOldQueuedRuns(date)
          this.lastDate = date
          if (settled > 0) this.logger.warn({ count: settled, date }, '已结算跨日未执行的排队行')
        } catch (e) {
          this.logger.warn({ err: (e as Error).message, date }, '跨日排队行结算失败（下轮重试）')
        }
      }
      if (this.stopped) return
      // 先取窗口列表：读取失败时尚未认领任何行，不会留下无人执行的 running 行
      const profiles = new Map((await this.db.listProfiles(false)).map((p) => [p.id, p]))
      if (this.stopped) return
      // 到期查询 + 额度统计 + 条件认领在同一写事务内完成，多 dispatcher 共享库也不会突破上限
      const claimed = await this.db.claimDueRuns({
        date,
        nowMs: Date.now(),
        limits: this.limits,
        maxConcurrentWindows: this.maxConcurrentWindows,
      })
      if (claimed.length === 0) return
      if (this.stopped) {
        // 认领后恰逢 stop：退回 pending，避免留下无人结算的 running 行
        await this.requeueRows(claimed, '调度器已停止', Date.now(), '停止时认领行回队失败')
        return
      }
      const groups = new Map<number, RunRow[]>()
      for (const row of claimed) {
        const list = groups.get(row.profileId) ?? []
        list.push(row)
        groups.set(row.profileId, list)
      }
      const handledProfiles = new Set<number>()
      const orphanRows: RunRow[] = []
      for (const [profileId, rows] of groups) {
        if (this.stopped) break
        const profile = profiles.get(profileId)
        if (!profile) {
          orphanRows.push(...rows)
          continue
        }
        handledProfiles.add(profileId)
        void this.runSession(profile, rows)
      }
      if (orphanRows.length > 0) {
        await this.requeueRows(orphanRows, '窗口不存在', Date.now() + REQUEUE_BACKOFF_MS, '认领行回队失败')
      }
      if (this.stopped) {
        const rest = claimed.filter((row) => !handledProfiles.has(row.profileId) && !orphanRows.includes(row))
        await this.requeueRows(rest, '调度器已停止', Date.now(), '停止时认领行回队失败')
      }
    } catch (e) {
      this.logger.error({ err: (e as Error).message }, '队列调度异常')
    } finally {
      this.ticking = false
    }
  }

  /** 跑一次窗口会话；异常时把认领行按退避回队 */
  private async runSession(profile: ProfileRow, rows: RunRow[]): Promise<void> {
    // 每行带上认领日期，runner 不再用 todayStr 重新推导（跨午夜时旧日期行会写错日期）
    const tasks: SessionTask[] = rows.map((r) => ({
      taskKey: r.taskKey,
      date: r.date,
      ...(r.batchId == null ? {} : { batchId: r.batchId }),
    }))
    try {
      await this.runner.runWindowTasks(profile, tasks)
    } catch (e) {
      const err = (e as Error).message
      this.logger.error({ err, profile: profile.name }, '窗口任务执行异常')
      await this.safeRequeue(rows, err)
    } finally {
      this.requestDispatch()
    }
  }

  /** runner 拒绝后的回队：带退避，交由周期 tick 到期拾取，避免热循环 */
  private async safeRequeue(rows: RunRow[], error: string): Promise<void> {
    await this.requeueRows(rows, error, Date.now() + REQUEUE_BACKOFF_MS, '认领行回队失败')
  }

  /** 把已认领的 running 行退回 pending */
  private async requeueRows(rows: RunRow[], error: string, notBeforeMs: number, logMessage: string): Promise<void> {
    if (rows.length === 0) return
    try {
      await this.db.requeueClaimedRuns(rows.map((row) => row.id), error, notBeforeMs)
    } catch (e) {
      this.logger.warn({ err: (e as Error).message }, logMessage)
    }
  }

  /** 某任务是否在途（DB 唯一口径） */
  async hasTaskInFlight(taskKey: string, profileId?: number): Promise<boolean> {
    return (await this.db.countInFlightRuns(taskKey, todayStr(), profileId)) > 0
  }

  /** 是否有活跃窗口会话（DB 唯一口径，含跨午夜旧会话与 task:run 直接认领的行） */
  async anyRunning(): Promise<boolean> {
    return (await this.db.countRunningProfiles()) > 0
  }

  /** 取消批次中仍在排队的行，返回结算数量 */
  async cancelBatch(batchId: number): Promise<number> {
    return this.db.stopQueuedRuns(batchId)
  }
}

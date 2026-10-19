/**
 * 运行调度器（engine 层）：runs 表即队列，按 not_before_ms 调度窗口会话
 * 依赖方向：依赖 infrastructure/db 与 engine/window-runner 类型；被 app 装配、server 路由使用
 * 设计思路：enqueue 只写 DB；dispatcher 每秒拾取到期行；内存只保留活跃窗口与并发计数
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

/** 任务级并发额度（本阶段仍保留内存 gates） */
interface Gate {
  concurrency: number
  active: number
}

export class CoalescingEnqueuer {
  private timer: ReturnType<typeof setInterval> | null = null
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private dispatchScheduled = false
  private stopped = false
  private readonly activeProfiles = new Set<number>()
  /** 最近一次调度日期：跨午夜时结算旧日期的排队行（running 行由各自会话按认领日期结算） */
  private lastDate: string | null = null
  private readonly gates = new Map<string, Gate>()
  private globalActive = 0
  private readonly globalMax: number
  private readonly tickMs: number

  constructor(
    private readonly db: AppDb,
    private readonly runner: { runWindowTasks(profile: ProfileRow, tasks: SessionTask[]): Promise<unknown> },
    private readonly logger: Logger,
    private readonly taskConcurrencyOf: (taskKey: string) => number,
    private readonly staggerMaxSec = 0,
    maxConcurrentWindows = Number.POSITIVE_INFINITY,
    tickMs = 1000,
  ) {
    this.globalMax = Number.isFinite(maxConcurrentWindows) ? Math.max(1, maxConcurrentWindows) : Number.POSITIVE_INFINITY
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

  /** 入队：写 pending 行；immediate 立即，否则按当前窗口 pending 时间或随机错峰 */
  async enqueue(profile: ProfileRow, taskKey: string, opts: { immediate?: boolean; batchId?: number } = {}): Promise<void> {
    const date = todayStr()
    const notBeforeMs = opts.immediate ? Date.now() : await this.pickNotBefore(profile.id, date)
    await this.db.enqueueRun(profile.id, taskKey, date, opts.batchId ?? null, notBeforeMs)
    this.requestDispatch()
  }

  /** 同一窗口已有 pending 时沿用最早时间；否则随机错峰 */
  private async pickNotBefore(profileId: number, date: string): Promise<number> {
    const existing = await this.db.minPendingNotBefore(profileId, date)
    if (existing != null) return existing
    return Date.now() + Math.floor(Math.random() * this.staggerMaxSec * 1000)
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

  /** 调度 tick：到期行按窗口分组，检查 gates/global 后启动会话 */
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
      // 到期 pending/retry_wait 统一调度：两条路径都带 not_before_ms
      const due = await this.db.listDueRuns(date, Date.now())
      if (this.stopped) return
      if (due.length === 0) return
      const profiles = new Map((await this.db.listProfiles(false)).map((p) => [p.id, p]))
      if (this.stopped) return
      const groups = new Map<number, RunRow[]>()
      for (const row of due) {
        const list = groups.get(row.profileId) ?? []
        list.push(row)
        groups.set(row.profileId, list)
      }
      for (const [profileId, rows] of groups) {
        if (this.stopped) return
        if (this.globalActive >= this.globalMax) break
        if (this.activeProfiles.has(profileId)) continue
        const hasRunning = await this.db.hasRunningRunsForProfile(profileId, date)
        if (this.stopped) return
        if (hasRunning) continue
        const profile = profiles.get(profileId)
        if (!profile) continue
        const eligible = rows.filter((row) => {
          const gate = this.gateFor(row.taskKey)
          return gate.active < gate.concurrency
        })
        if (eligible.length === 0) continue
        // 原子认领：只启动仍为 pending/retry_wait 的行，避免与批次取消/其它 tick 竞态
        const claimed = await this.db.claimQueuedRuns(eligible.map((row) => row.id), Date.now())
        if (this.stopped) {
          // 认领后恰逢 stop：退回 pending，避免留下无人结算的 running 行
          if (claimed.length > 0) {
            await this.db.requeueClaimedRuns(claimed.map((row) => row.id), '调度器已停止', Date.now()).catch(() => 0)
          }
          return
        }
        if (claimed.length === 0) continue
        this.activeProfiles.add(profileId)
        this.globalActive++
        for (const row of claimed) this.gateFor(row.taskKey).active++
        void this.runSession(profile, claimed)
      }
    } catch (e) {
      this.logger.error({ err: (e as Error).message }, '队列调度异常')
    } finally {
      this.ticking = false
    }
  }

  /** 跑一次窗口会话并释放额度 */
  private async runSession(profile: ProfileRow, rows: RunRow[]): Promise<void> {
    // 每行带上认领日期，runner 不再用 todayStr 重新推导（跨午夜时旧日期行会写错日期）
    const tasks: SessionTask[] = rows.map((r) => ({
      taskKey: r.taskKey,
      date: r.date,
      ...(r.batchId == null ? {} : { batchId: r.batchId }),
    }))
    let requeued = false
    try {
      await this.runner.runWindowTasks(profile, tasks)
    } catch (e) {
      const err = (e as Error).message
      this.logger.error({ err, profile: profile.name }, '窗口任务执行异常')
      try {
        // 回队加退避：持久故障不能立刻重新认领形成热循环；交由周期 tick 到期拾取
        const count = await this.db.requeueClaimedRuns(rows.map((row) => row.id), err, Date.now() + REQUEUE_BACKOFF_MS)
        requeued = count > 0
      } catch (re) {
        this.logger.warn({ err: (re as Error).message, profile: profile.name }, '认领行回队失败')
      }
    } finally {
      for (const row of rows) {
        const gate = this.gateFor(row.taskKey)
        gate.active = Math.max(0, gate.active - 1)
      }
      this.globalActive = Math.max(0, this.globalActive - 1)
      this.activeProfiles.delete(profile.id)
      // 成功/正常结束立即尝试下一批；失败回队则等 not_before_ms 到期（不热循环）
      if (!requeued) this.requestDispatch()
    }
  }

  /** 取（或懒创建）任务额度 */
  private gateFor(taskKey: string): Gate {
    let gate = this.gates.get(taskKey)
    if (!gate) {
      gate = { concurrency: Math.max(1, this.taskConcurrencyOf(taskKey)), active: 0 }
      this.gates.set(taskKey, gate)
    }
    return gate
  }

  /** 某任务是否在途（DB 唯一口径） */
  async hasTaskInFlight(taskKey: string, profileId?: number): Promise<boolean> {
    return (await this.db.countInFlightRuns(taskKey, todayStr(), profileId)) > 0
  }

  /** 是否有活跃窗口会话（代理切换等在途守卫） */
  anyRunning(): boolean {
    return this.globalActive > 0
  }

  /** 取消批次中仍在排队的行，返回结算数量 */
  async cancelBatch(batchId: number): Promise<number> {
    return this.db.stopQueuedRuns(batchId)
  }
}

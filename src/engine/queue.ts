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

/** 入队器契约：面板触发与调度器只依赖此接口，便于替换实现 */
export interface RunEnqueuer {
  enqueue(
    profile: ProfileRow,
    taskKey: string,
    opts?: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean },
  ): Promise<void>
  cancelBatch(batchId: number): Promise<number>
  start(): void
  stop(): void
}

export class CoalescingEnqueuer implements RunEnqueuer {
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
    /** 是否执行 skipIfSuccess 幂等跳过（默认 false 保持旧调度/路由行为；窗口池自身处理幂等） */
    private readonly honorSkipIfSuccess = false,
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

  /**
   * 入队：写 pending 行；notBeforeMs 缺省立即到期（只用于重试退避/排队到期，触发不再按窗口铺开）。
   * honorSkipIfSuccess=true 时，skipIfSuccess 且该窗口当天该任务最新行已成功则直接返回（定时/批量触发幂等）；
   * 默认关闭以保持旧调度器/路由行为，窗口池调度器自行处理 skipIfSuccess。
   */
  async enqueue(
    profile: ProfileRow,
    taskKey: string,
    opts: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean } = {},
  ): Promise<void> {
    const date = todayStr()
    if (opts.skipIfSuccess && this.honorSkipIfSuccess) {
      const latest = await this.db.getLatestRun(profile.id, taskKey, date)
      if (latest?.status === 'success') {
        this.logger.debug({ profile: profile.name, task: taskKey }, '今日已成功，跳过重复入队')
        return
      }
    }
    const notBeforeMs = opts.notBeforeMs ?? Date.now()
    const row = await this.db.enqueueRun(profile.id, taskKey, date, opts.batchId ?? null, notBeforeMs)
    if (row.status === 'running') {
      this.logger.warn({ profile: profile.name, task: taskKey }, '任务已在运行，本次入队忽略')
    }
    this.requestDispatch()
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
      const nowMs = Date.now()
      // 空转短路：绝大多数 tick 没有到期行，先用单行 EXISTS 判断（不分配多行结果、不开写事务），
      // 避免每秒一次的全窗口读取与事务在长时间运行中累积原生内存
      if (!(await this.db.hasDueRuns(date, nowMs))) return
      // 任务从注册表移除后其到期行永远不会被认领：claim 前先结算，避免永久 pending
      try {
        const settled = await this.db.settleUnregisteredRuns(date, nowMs, this.limits)
        if (settled > 0) this.logger.warn({ count: settled, date }, '已结算未注册任务的到期行')
      } catch (e) {
        this.logger.warn({ err: (e as Error).message, date }, '未注册任务结算失败（下轮重试）')
      }
      if (this.stopped) return
      // 先取窗口列表：读取失败时尚未认领任何行，不会留下无人执行的 running 行
      const profiles = new Map((await this.db.listProfiles(false)).map((p) => [p.id, p]))
      if (this.stopped) return
      // 到期查询 + 额度统计 + 条件认领在同一写事务内完成，多 dispatcher 共享库也不会突破上限
      const claimed = await this.db.claimDueRuns({
        date,
        nowMs,
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

  /** 取消批次中仍在排队的行，返回结算数量 */
  async cancelBatch(batchId: number): Promise<number> {
    return this.db.stopQueuedRuns(batchId)
  }
}

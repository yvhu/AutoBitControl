/**
 * 调度器（engine 层）：把 TaskMeta.schedule 转为 cron 定时触发
 * 依赖方向：依赖 croner 与基础设施类型，被 app 顶层装配
 * 设计思路：cron 字符串原样使用；stagger 窗口在启动时随机定一个分钟再生成 cron
 * （重启会重新随机，多个窗口实例错开可分散站点压力）
 */
import { Cron } from 'croner'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { AppDb, ProfileRow } from '../infrastructure/db'
import { isIntervalSchedule, type TaskMeta } from './task'
import type { CoalescingEnqueuer } from './queue'

export { isIntervalSchedule }

/**
 * 在 [start, end] 分钟区间内随机取一分钟（含两端），返回"今天"该时刻的 Date
 * endMin < startMin 视为跨天窗口（如 23:00-01:00）：随机点取 [startMin, 1440) ∪ [0, endMin]（均匀），
 * 落点早于 startMin 时日期加一天（即次日凌晨）；start === end 时退化为固定点 startMin（非全时段随机）
 */
export function pickRandomTimeInWindow(start: string, end: string, now = new Date()): Date {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  const crossDay = endMin < startMin
  let picked: number
  if (crossDay) {
    // 跨天：[startMin, 1440) 与 [0, endMin] 两段连续拼接后均匀随机
    const total = (1440 - startMin) + (endMin + 1)
    picked = startMin + Math.floor(Math.random() * total)
    if (picked >= 1440) picked -= 1440
  } else {
    picked = startMin + Math.floor(Math.random() * (endMin - startMin + 1))
  }
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(picked / 60), picked % 60, 0, 0)
  if (crossDay && picked < startMin) date.setDate(date.getDate() + 1)
  return date
}

/** 把错峰窗口转成 croner 五段式 "分 时 * * *"（随机分钟固化在进程生命周期内） */
export function staggerToCron(start: string, end: string): string {
  const t = pickRandomTimeInWindow(start, end)
  return `${t.getMinutes()} ${t.getHours()} * * *`
}

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

/**
 * 调度器：start() 遍历任务注册表建 cron，stop() 全部停止（进程退出时调用）
 * 跳过规则（与 docs/API-GUIDE.md「跳过规则」一致）：
 * deprecated 任务 → 告警跳过；url 为空（文档示例）→ 告警跳过；无 schedule → 仅手动触发
 */
export class Scheduler {
  /** 普通 cron 任务的 job（taskKey → cron），refreshTask 按 key 精确停/注册 */
  private jobs = new Map<string, Cron>()
  /** stagger 任务的当日错峰 cron（key → cron），日更刷新时先停旧的再重建 */
  private staggerJobs = new Map<string, Cron>()
  /** 已注册日更刷新器的任务 key 集合（防止重复注册 00:01 cron） */
  private staggerRefreshKeys = new Set<string>()
  /** 日更刷新 cron（taskKey → cron，00:01 触发，为每个 stagger 任务重选当日时间） */
  private staggerRefreshers = new Map<string, Cron>()
  /** 间隔任务（key → 每 N 小时）；分钟 tick 统一判定触发 */
  private intervalTasks = new Map<string, number>()
  /** 间隔任务下次允许触发时刻（毫秒时间戳）：触发后 N 小时内不重复触发（失败不重触发，等待任务级重试） */
  private intervalNextAllow = new Map<string, number>()
  /** 分钟 tick cron（存在间隔任务时注册一个，共用于全部间隔任务） */
  private intervalTick: Cron | null = null

  constructor(
    private cfg: AppConfig,
    private db: AppDb,
    private tasks: Map<string, { meta: TaskMeta }>,
    private enqueuer: CoalescingEnqueuer,
    private logger: Logger,
  ) {}

  /**
   * 重建单个 stagger 任务的当日错峰 cron：停旧 cron → 随机新时间 → 注册新 cron；
   * 首次调用同时为该任务注册 00:01 的日更刷新器（每日重选错峰时间，分散站点压力）
   * 幂等安全：未知任务/非 stagger 任务静默返回，重复调用不抛错
   */
  refreshStagger(taskKey: string): void {
    const task = this.tasks.get(taskKey)
    const schedule = task?.meta.schedule
    if (!schedule || typeof schedule === 'string' || isIntervalSchedule(schedule)) return
    const [start, end] = schedule.stagger
    const cron = staggerToCron(start, end)
    const old = this.staggerJobs.get(taskKey)
    if (old) old.stop()
    const job = new Cron(cron, { timezone: this.cfg.execution.timezone }, () => this.fireSafely(taskKey))
    this.staggerJobs.set(taskKey, job)
    if (!this.staggerRefreshKeys.has(taskKey)) {
      this.staggerRefreshKeys.add(taskKey)
      const refresher = new Cron('1 0 * * *', { timezone: this.cfg.execution.timezone }, () => this.refreshStagger(taskKey))
      this.staggerRefreshers.set(taskKey, refresher)
    }
    this.logger.info({ task: taskKey, cron }, '任务已调度')
  }

  /** 确保分钟 tick cron 已注册（有间隔任务时共用同一个 tick，无间隔任务时无需注册） */
  private ensureIntervalTick(): void {
    if (this.intervalTick) return
    this.intervalTick = new Cron('* * * * *', { timezone: this.cfg.execution.timezone }, () => {
      void this.tickIntervals().catch((e) => this.logger.warn({ err: (e as Error).message }, '间隔任务 tick 异常'))
    })
  }

  /**
   * 间隔任务分钟 tick：逐个判定是否到期，到期则触发（public 供测试注入 nowMs）
   * 候选集取自任务注册表（间隔形态，跳过 deprecated/无 url 任务，停用守卫在 fireNow 内），
   * 触发后把该任务 nextAllow 推后 N 小时——即使本轮失败也不会分钟级重复触发，
   * 失败补偿靠任务级重试；成功后锚点前移，nextAllow 到点后再按新锚点判定
   */
  async tickIntervals(nowMs = Date.now()): Promise<void> {
    for (const task of this.tasks.values()) {
      const schedule = task.meta.schedule
      if (!isIntervalSchedule(schedule)) continue
      if (task.meta.deprecated || !task.meta.url) continue
      const key = task.meta.key
      if (nowMs < (this.intervalNextAllow.get(key) ?? 0)) continue
      const anchor = await this.db.getTaskFiredAt(key)
      if (!intervalDue(anchor, schedule.everyHours, INTERVAL_BUFFER_MS, nowMs)) continue
      this.intervalNextAllow.set(key, nowMs + schedule.everyHours * 3_600_000)
      await this.fireNow(key).catch((e) => this.logger.warn({ task: key, err: (e as Error).message }, '间隔任务触发失败'))
    }
  }

  /**
   * 注册单个任务的 cron（start() 遍历调用与 refreshTask 开关恢复时复用）
   * 跳过规则与 start() 一致：deprecated / 云端停用 / url 空 / 无 schedule
   */
  private async registerTask(task: { meta: TaskMeta }): Promise<void> {
    if (task.meta.deprecated) {
      this.logger.warn({ task: task.meta.key }, '任务已标记失效，跳过调度')
      return
    }
    if (!(await this.db.getTaskEnabled(task.meta.key, task.meta.enabled ?? true))) {
      this.logger.warn({ task: task.meta.key }, '任务已停用，跳过调度')
      return
    }
    if (!task.meta.url) {
      this.logger.warn({ task: task.meta.key }, '任务未配置 url，跳过调度')
      return
    }
    if (!task.meta.schedule) return
    if (typeof task.meta.schedule === 'string') {
      const cron = task.meta.schedule
      const job = new Cron(cron, { timezone: this.cfg.execution.timezone }, () => this.fireSafely(task.meta.key))
      this.jobs.set(task.meta.key, job)
      this.logger.info({ task: task.meta.key, cron }, '任务已调度')
    } else if (isIntervalSchedule(task.meta.schedule)) {
      this.intervalTasks.set(task.meta.key, task.meta.schedule.everyHours)
      this.ensureIntervalTick()
      this.logger.info({ task: task.meta.key, everyHours: task.meta.schedule.everyHours }, '任务已调度（每 N 小时）')
    } else {
      this.refreshStagger(task.meta.key)
    }
  }

  /**
   * 任务开关变更后刷新该任务的调度：先按 key 停掉普通 cron、错峰 cron 与 00:01 日更刷新器，
   * 再重新注册（停用任务跳过注册）——面板切换开关即时生效，无需重启
   */
  refreshTask(taskKey: string): void {
    void (async () => {
      try {
        const job = this.jobs.get(taskKey)
        if (job) { job.stop(); this.jobs.delete(taskKey) }
        const stagger = this.staggerJobs.get(taskKey)
        if (stagger) { stagger.stop(); this.staggerJobs.delete(taskKey) }
        const refresher = this.staggerRefreshers.get(taskKey)
        if (refresher) { refresher.stop(); this.staggerRefreshers.delete(taskKey) }
        this.staggerRefreshKeys.delete(taskKey)
        this.intervalTasks.delete(taskKey)
        this.intervalNextAllow.delete(taskKey)
        if (this.intervalTasks.size === 0 && this.intervalTick) {
          this.intervalTick.stop()
          this.intervalTick = null
        }
        const task = this.tasks.get(taskKey)
        if (task) await this.registerTask(task)
      } catch (e) {
        this.logger.warn({ task: taskKey, err: (e as Error).message }, '刷新任务调度失败')
      }
    })()
  }

  /** 为每个任务建 cron 定时器 */
  async start(): Promise<void> {
    // 重入保护：已注册过任务时先停旧任务再重新注册（保证可重入且不产生重复 cron）
    if (this.jobs.size > 0 || this.staggerJobs.size > 0 || this.intervalTasks.size > 0) {
      this.logger.warn('调度器已启动，先停止旧任务再重新注册')
      this.stop()
    }
    for (const task of this.tasks.values()) {
      await this.registerTask(task)
    }
  }

  /** 停止全部 cron（SIGINT/SIGTERM 时调用）：普通任务 + stagger 任务 + 日更刷新器 */
  stop(): void {
    for (const j of this.jobs.values()) j.stop()
    this.jobs.clear()
    for (const j of this.staggerJobs.values()) j.stop()
    this.staggerJobs.clear()
    this.staggerRefreshKeys.clear()
    for (const r of this.staggerRefreshers.values()) r.stop()
    this.staggerRefreshers.clear()
    if (this.intervalTick) { this.intervalTick.stop(); this.intervalTick = null }
    this.intervalTasks.clear()
    this.intervalNextAllow.clear()
  }

  /**
   * 立即触发某任务：推给所有启用窗口（cron 到点与代码内触发共用此入口）
   * 守卫：任务未注册静默忽略；任务已停用（云端开关或 meta.enabled === false）告警跳过，
   * 保证已注册 cron 在关停后到点也不会执行
   * @param taskKey 任务 key
   */
  async fireNow(taskKey: string): Promise<void> {
    const task = this.tasks.get(taskKey)
    if (!task) return
    if (!(await this.db.getTaskEnabled(taskKey, task.meta.enabled ?? true))) {
      this.logger.warn({ task: taskKey }, '任务已停用，跳过本次触发')
      return
    }
    const profiles: ProfileRow[] = await this.db.listProfiles(true)
    for (const p of profiles) {
      this.enqueuer.enqueue(p, taskKey)
    }
    this.logger.info({ task: taskKey, profiles: profiles.length }, '触发任务')
  }

  /** cron 回调入口：fireNow 异步化后统一捕获云库异常，不抛向定时器 */
  private fireSafely(taskKey: string): void {
    void this.fireNow(taskKey).catch(e => {
      this.logger.warn({ task: taskKey, err: (e as Error).message }, '触发任务失败（数据库读取异常）')
    })
  }
}

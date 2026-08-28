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
import type { TaskMeta } from './task'
import type { CoalescingEnqueuer } from './queue'

/**
 * 在 [start, end] 分钟区间内随机取一分钟（含两端），返回"今天"该时刻的 Date
 * 注意：返回的是今天的时间，跨零点窗口（如 23:00-01:00）不在此支持范围
 */
export function pickRandomTimeInWindow(start: string, end: string, now = new Date()): Date {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  const picked = startMin + Math.floor(Math.random() * (endMin - startMin + 1))
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(picked / 60), picked % 60, 0, 0)
}

/** 把错峰窗口转成 croner 五段式 "分 时 * * *"（随机分钟固化在进程生命周期内） */
export function staggerToCron(start: string, end: string): string {
  const t = pickRandomTimeInWindow(start, end)
  return `${t.getMinutes()} ${t.getHours()} * * *`
}

/**
 * 调度器：start() 遍历任务注册表建 cron，stop() 全部停止（进程退出时调用）
 * 跳过规则（与 docs/API-GUIDE.md「跳过规则」一致）：
 * deprecated 任务 → 告警跳过；url 为空（文档示例）→ 告警跳过；无 schedule → 仅手动触发
 */
export class Scheduler {
  private jobs: Cron[] = []

  constructor(
    private cfg: AppConfig,
    private db: AppDb,
    private tasks: Map<string, { meta: TaskMeta }>,
    private enqueuer: CoalescingEnqueuer,
    private logger: Logger,
  ) {}

  /** 解析任务的调度表达式：cron 字符串直接用；stagger 转成错峰 cron */
  private scheduleOf(meta: TaskMeta): string | null {
    if (!meta.schedule) return null
    if (typeof meta.schedule === 'string') return meta.schedule
    return staggerToCron(meta.schedule.stagger[0], meta.schedule.stagger[1])
  }

  /** 为每个任务建 cron 定时器 */
  start(): void {
    // 重入保护：已注册过任务时先停旧任务再重新注册（保证可重入且不产生重复 cron）
    if (this.jobs.length > 0) {
      this.logger.warn('调度器已启动，先停止旧任务再重新注册')
      this.stop()
    }
    for (const task of this.tasks.values()) {
      if (task.meta.deprecated) {
        this.logger.warn({ task: task.meta.key }, '任务已标记失效，跳过调度')
        continue
      }
      if (!this.db.getTaskEnabled(task.meta.key, task.meta.enabled ?? true)) {
        this.logger.warn({ task: task.meta.key }, '任务已停用，跳过调度')
        continue
      }
      if (!task.meta.url) {
        this.logger.warn({ task: task.meta.key }, '任务未配置 url，跳过调度')
        continue
      }
      const cron = this.scheduleOf(task.meta)
      if (!cron) continue
      const job = new Cron(cron, { timezone: this.cfg.execution.timezone }, () => this.fireNow(task.meta.key))
      this.jobs.push(job)
      this.logger.info({ task: task.meta.key, cron }, '任务已调度')
    }
  }

  /** 停止全部 cron（SIGINT/SIGTERM 时调用） */
  stop(): void {
    for (const j of this.jobs) j.stop()
    this.jobs = []
  }

  /**
   * 立即触发某任务：推给所有启用窗口（cron 到点与代码内触发共用此入口）
   * 守卫：任务未注册静默忽略；任务已停用（含面板运行时关停）告警跳过，
   * 保证已注册 cron 在关停后到点也不会执行
   * @param taskKey 任务 key
   */
  fireNow(taskKey: string): void {
    const task = this.tasks.get(taskKey)
    if (!task) return
    if (!this.db.getTaskEnabled(taskKey, task.meta.enabled ?? true)) {
      this.logger.warn({ task: taskKey }, '任务已停用，跳过本次触发')
      return
    }
    const profiles: ProfileRow[] = this.db.listProfiles(true)
    for (const p of profiles) {
      this.enqueuer.enqueue(p, taskKey)
    }
    this.logger.info({ task: taskKey, profiles: profiles.length }, '触发任务')
  }
}

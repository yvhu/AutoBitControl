/**
 * 定时调度器（engine 层）：自研 tick 调度（每 tickMs 扫一次启用计划）
 * 依赖方向：依赖 infrastructure 类型与 engine/schedule.ts 纯函数，不依赖 tasks 层；
 *           被 src/app.ts 装配、被 server 路由经 runNow 调用
 * 设计思路：无 cron 库——到点判断走 schedule.ts 的墙上时钟匹配；
 * 错过即跳过（无锚点持久化，重启后从当前时间自然重算）；
 * 每分钟去重 Map（内存态，重启同分钟可能重复触发一次，由队列合并与在途守卫兜底）；
 * 触发路径与手动批量触发同构：createBatch('schedule') → 全部启用窗口 enqueue（不带 immediate 沿用全局错峰）
 */
import type { BatchRow, ProfileRow, ScheduleRow } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'
import type { TaskMeta } from './task'
import { wallClockIn, isDueMinute, type ScheduleConfig, type ScheduleMode } from './schedule'

/** 一次触发的任务级结果（面板「立即运行」与日志共用） */
export interface RunNowResult {
  /** 实际入队的任务 key */
  taskKeys: string[]
  /** 被跳过任务的明细 */
  skipped: Array<{ taskKey: string; reason: 'unknown-task' | 'task-disabled' | 'in-flight' }>
}

export interface SchedulerDeps {
  db: {
    listSchedules(): Promise<ScheduleRow[]>
    getTaskEnabled(taskKey: string, fallback: boolean): Promise<boolean>
    countInFlightRuns(taskKey: string, date: string): Promise<number>
    createBatch(kind: 'schedule', taskKey: string, source: string): Promise<BatchRow>
    listProfiles(enabledOnly: boolean): Promise<ProfileRow[]>
  }
  enqueuer: {
    enqueue(profile: ProfileRow, taskKey: string, opts?: { immediate?: boolean; batchId?: number }): void
    hasTaskInFlight(taskKey: string, profileId?: number): boolean
  }
  /** 任务注册表最小视图（engine 不得 import tasks 层，SiteTask 结构兼容） */
  tasks: Map<string, { meta: TaskMeta }>
  logger: Logger
  /** 固定时区（配置 scheduler.timezone） */
  timezone: string
  /** tick 间隔（毫秒，默认 15000） */
  tickMs?: number
  /** 当前时间来源（测试注入固定时钟；默认 Date.now） */
  now?: () => Date
}

/**
 * 自研 tick 定时调度器
 * tick：扫描启用计划 → 到点（墙上时钟匹配）且该分钟未触发 → fire；
 * fire：对计划内每个任务做守卫（注册/开关/在途）后建批次并全窗口入队；
 * runNow：面板「立即运行」入口，跳过时间与去重判断（守卫保留）
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 每分钟去重：计划 id → 'YYYY-MM-DD HH:mm' */
  private lastFired = new Map<number, string>()

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick().catch((e) => {
        this.deps.logger.warn({ err: (e as Error).message }, '调度 tick 异常（下轮重试）')
      })
    }, this.deps.tickMs ?? 15000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 扫描启用计划并触发到点者（对外暴露便于测试直调） */
  async tick(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))()
    const wc = wallClockIn(this.deps.timezone, now)
    const minuteKey = `${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')} ${String(wc.hour).padStart(2, '0')}:${String(wc.minute).padStart(2, '0')}`
    for (const s of await this.deps.db.listSchedules()) {
      if (s.enabled !== 1) continue
      if (this.lastFired.get(s.id) === minuteKey) continue
      const cfg = parseConfig(s, this.deps.logger)
      if (!cfg) continue
      if (!isDueMinute(s.mode as ScheduleMode, cfg, wc)) continue
      this.lastFired.set(s.id, minuteKey)
      await this.fire(s)
    }
  }

  /** 立即运行一个计划（面板「立即运行」；停用校验在路由层） */
  async runNow(schedule: ScheduleRow): Promise<RunNowResult> {
    return this.fire(schedule)
  }

  /** 触发计划内全部任务（任务级守卫逐个判定，不互相影响） */
  private async fire(schedule: ScheduleRow): Promise<RunNowResult> {
    const result: RunNowResult = { taskKeys: [], skipped: [] }
    let keys: unknown
    try {
      keys = JSON.parse(schedule.taskKeys)
    } catch {
      this.deps.logger.warn({ id: schedule.id }, '计划任务列表 JSON 非法，跳过整个计划')
      return result
    }
    for (const key of keys as string[]) {
      const skip = async (reason: RunNowResult['skipped'][number]['reason']) => {
        this.deps.logger.warn({ schedule: schedule.name, task: key, reason }, '定时触发跳过任务')
        result.skipped.push({ taskKey: key, reason })
      }
      const t = this.deps.tasks.get(key)
      if (!t) { await skip('unknown-task'); continue }
      // 面板运行时开关（task_states 覆盖 meta.enabled）与手动触发守卫同语义
      if (!(await this.deps.db.getTaskEnabled(key, t.meta.enabled ?? true))) { await skip('task-disabled'); continue }
      if ((await this.deps.db.countInFlightRuns(key, todayLocal())) > 0 || this.deps.enqueuer.hasTaskInFlight(key)) { await skip('in-flight'); continue }
      const batch = await this.deps.db.createBatch('schedule', key, `计划#${schedule.id} ${schedule.name}`)
      for (const p of await this.deps.db.listProfiles(true)) {
        this.deps.enqueuer.enqueue(p, key, { batchId: batch.id })
      }
      result.taskKeys.push(key)
      this.deps.logger.info({ schedule: schedule.name, task: key }, `定时触发已入队`)
    }
    return result
  }
}

/** 解析计划 config JSON；非法时告警并返回 null（跳过该计划） */
function parseConfig(s: ScheduleRow, logger: Logger): ScheduleConfig | null {
  try {
    return JSON.parse(s.config) as ScheduleConfig
  } catch {
    logger.warn({ id: s.id, name: s.name }, '计划配置 JSON 非法，跳过')
    return null
  }
}

/** 本地时区「今天」（与 db.countInFlightRuns 的 date 口径一致） */
function todayLocal(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

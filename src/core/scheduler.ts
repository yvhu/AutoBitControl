import { Cron } from 'croner'
import type { AppConfig } from './config'
import type { Logger } from './logger'
import type { AppDb, ProfileRow } from './db'
import type { SiteTask, TaskMeta } from '../tasks/base'
import type { CoalescingEnqueuer } from './queue'

export function pickRandomTimeInWindow(start: string, end: string, now = new Date()): Date {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  const picked = startMin + Math.floor(Math.random() * (endMin - startMin + 1))
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(picked / 60), picked % 60, 0, 0)
}

export function staggerToCron(start: string, end: string): string {
  const t = pickRandomTimeInWindow(start, end)
  return `${t.getMinutes()} ${t.getHours()} * * *`
}

export class Scheduler {
  private jobs: Cron[] = []

  constructor(
    private cfg: AppConfig,
    private db: AppDb,
    private tasks: Map<string, SiteTask>,
    private enqueuer: CoalescingEnqueuer,
    private logger: Logger,
  ) {}

  private scheduleOf(meta: TaskMeta): string | null {
    if (!meta.schedule) return null
    if (typeof meta.schedule === 'string') return meta.schedule
    return staggerToCron(meta.schedule.stagger[0], meta.schedule.stagger[1])
  }

  start(): void {
    for (const task of this.tasks.values()) {
      const cron = this.scheduleOf(task.meta)
      if (!cron) continue
      const job = new Cron(cron, { timezone: this.cfg.execution.timezone }, () => this.fireNow(task.meta.key))
      this.jobs.push(job)
      this.logger.info({ task: task.meta.key, cron }, '任务已调度')
    }
  }

  stop(): void {
    for (const j of this.jobs) j.stop()
    this.jobs = []
  }

  fireNow(taskKey: string): void {
    const task = this.tasks.get(taskKey)
    if (!task) return
    const profiles: ProfileRow[] = this.db.listProfiles(true)
    for (const p of profiles) {
      this.enqueuer.enqueue(p, taskKey)
    }
    this.logger.info({ task: taskKey, profiles: profiles.length }, '触发任务')
  }
}

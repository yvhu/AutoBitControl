import PQueue from 'p-queue'
import type { ProfileRow } from './db'
import type { Logger } from './logger'

export class TaskQueue {
  private q: PQueue

  constructor(concurrency: number) {
    this.q = new PQueue({ concurrency })
  }

  add(fn: () => Promise<void>): Promise<void> {
    return this.q.add(fn)
  }

  onIdle(): Promise<void> {
    return this.q.onIdle()
  }

  get size(): number {
    return this.q.size + this.q.pending
  }
}

interface Entry {
  profile: ProfileRow
  taskKeys: Set<string>
}

export class CoalescingEnqueuer {
  private pending = new Map<number, Entry>()
  private running = new Set<number>()
  private followUp = new Map<number, Entry>()

  constructor(
    private queue: TaskQueue,
    private runner: { runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<void> },
    private logger: Logger,
  ) {}

  enqueue(profile: ProfileRow, taskKey: string): void {
    if (this.running.has(profile.id)) {
      const fu = this.followUp.get(profile.id) ?? { profile, taskKeys: new Set<string>() }
      fu.taskKeys.add(taskKey)
      this.followUp.set(profile.id, fu)
      return
    }
    const entry = this.pending.get(profile.id)
    if (entry) {
      entry.taskKeys.add(taskKey)
      return
    }
    const fresh: Entry = { profile, taskKeys: new Set([taskKey]) }
    this.pending.set(profile.id, fresh)
    void this.queue.add(async () => {
      await Promise.resolve()
      this.pending.delete(profile.id)
      this.running.add(profile.id)
      try {
        await this.runner.runWindowTasks(fresh.profile, [...fresh.taskKeys])
      } catch (e) {
        this.logger.error({ err: (e as Error).message }, '窗口任务执行异常')
      }
      this.running.delete(profile.id)
      const fu = this.followUp.get(profile.id)
      if (fu) {
        this.followUp.delete(profile.id)
        for (const k of fu.taskKeys) this.enqueue(fu.profile, k)
      }
    })
  }
}

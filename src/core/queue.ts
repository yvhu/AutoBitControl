import PQueue from 'p-queue'
import type { ProfileRow } from './db'

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

export class CoalescingEnqueuer {
  private pending = new Map<number, { profile: ProfileRow; taskKeys: Set<string> }>()

  constructor(private queue: TaskQueue, private runner: { runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<void> }) {}

  enqueue(profile: ProfileRow, taskKey: string): void {
    const entry = this.pending.get(profile.id)
    if (entry) {
      entry.taskKeys.add(taskKey)
      return
    }
    const fresh = { profile, taskKeys: new Set([taskKey]) }
    this.pending.set(profile.id, fresh)
    void this.queue.add(async () => {
      await Promise.resolve()
      this.pending.delete(profile.id)
      await this.runner.runWindowTasks(fresh.profile, [...fresh.taskKeys])
    })
  }
}

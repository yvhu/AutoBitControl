import { describe, it, expect, vi } from 'vitest'
import { TaskQueue, CoalescingEnqueuer } from '../src/core/queue'

describe('TaskQueue', () => {
  it('并发上限内执行', async () => {
    const q = new TaskQueue(2)
    let active = 0
    let peak = 0
    const fn = () => {
      active++
      peak = Math.max(peak, active)
      return new Promise<void>(r => setTimeout(() => { active--; r() }, 50))
    }
    await Promise.all([q.add(fn), q.add(fn), q.add(fn), q.add(fn)])
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('CoalescingEnqueuer', () => {
  it('同一窗口多次 enqueue 合并为一次执行', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, walletPassword: null, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    enq.enqueue(profile, 'task-b')
    enq.enqueue(profile, 'task-c')
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual(['task-a', 'task-b', 'task-c'])
  })

  it('不同窗口分别执行', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never)
    const mk = (id: number, bb: string) => ({ id, bitbrowserId: bb, name: bb, enabled: 1, walletPassword: null, circuitBreakerCount: 0 })
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(2)
  })
})

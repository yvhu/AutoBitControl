import { describe, it, expect, vi } from 'vitest'
import { TaskQueue, CoalescingEnqueuer } from '../src/engine/queue'

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
  const logger = { info: () => {}, warn: () => {}, error: () => {} } as never

  it('同一窗口多次 enqueue 合并为一次执行', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
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
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const mk = (id: number, bb: string) => ({ id, bitbrowserId: bb, name: bb, enabled: 1, circuitBreakerCount: 0 })
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('运行中再次 enqueue 排队为第二批且不与第一批并发', async () => {
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>(r => { releaseFirst = r })
    const run = vi.fn((profile: { id: number }, taskKeys: string[]) => {
      if (profile.id === 1 && run.mock.calls.length === 1) return firstGate.then(() => undefined)
      return Promise.resolve(undefined)
    })
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    await new Promise(r => setTimeout(r, 10))
    expect(run).toHaveBeenCalledTimes(1)
    enq.enqueue(profile, 'task-b')
    await new Promise(r => setTimeout(r, 10))
    expect(run).toHaveBeenCalledTimes(1)
    releaseFirst()
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual(['task-b'])
  })

  it('runner 抛错不会产生未处理的 rejection', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

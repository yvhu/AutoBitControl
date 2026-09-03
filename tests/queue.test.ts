import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  it('hasTaskInFlight：running 会话与 pending 条目均判在途', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const run = vi.fn((_profile: { id: number }, _taskKeys: string[]) => gate.then(() => undefined))
    const q = new TaskQueue(1)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const p1 = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    const p2 = { id: 2, bitbrowserId: 'bb-2', name: 'B', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(p1, 'task-a')
    await new Promise(r => setTimeout(r, 10))
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
    enq.enqueue(p2, 'task-b')
    await new Promise(r => setTimeout(r, 10))
    expect(enq.hasTaskInFlight('task-b')).toBe(true)
    release()
    await q.onIdle()
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
  })

  it('hasTaskInFlight 指定窗口只看该窗口', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const run = vi.fn((_profile: { id: number }, _taskKeys: string[]) => gate.then(() => undefined))
    const q = new TaskQueue(2)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger)
    const p1 = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    const p2 = { id: 2, bitbrowserId: 'bb-2', name: 'B', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(p1, 'task-a')
    await new Promise(r => setTimeout(r, 10))
    expect(enq.hasTaskInFlight('task-a', 1)).toBe(true)
    expect(enq.hasTaskInFlight('task-a', 2)).toBe(false)
    release()
    await q.onIdle()
  })
})

describe('CoalescingEnqueuer 随机错峰', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} } as never

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('staggerMaxSec > 0：窗口会话延迟到期才投递开窗', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // 120s * 0.5 = 60s
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('等待期内同窗口任务继续合并为一次会话', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    enq.enqueue(profile, 'task-b')
    await vi.advanceTimersByTimeAsync(60_000)
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual(['task-a', 'task-b'])
  })

  it('不同窗口各自独立条目、各自延迟投递', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75)
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const mk = (id: number, bb: string) => ({ id, bitbrowserId: bb, name: bb, enabled: 1, circuitBreakerCount: 0 })
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await vi.advanceTimersByTimeAsync(90_000)
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('等待期间 hasTaskInFlight 判在途，会话结束后解除', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(2)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const p1 = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(p1, 'task-a')
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    await q.onIdle()
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
  })

  it('immediate 入口跳过错峰立即投递', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a', { immediate: true })
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoalescingEnqueuer } from '../src/engine/queue'

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never

function makeEnq(
  run: ReturnType<typeof vi.fn>,
  concurrencyOf: (key: string) => number = () => 4,
  staggerMaxSec = 0,
) {
  return new CoalescingEnqueuer({ runWindowTasks: run } as never, logger, concurrencyOf, staggerMaxSec)
}

const mk = (id: number, bb: string) => ({ id, bitbrowserId: bb, name: bb, enabled: 1, circuitBreakerCount: 0 })

const tick = () => new Promise<void>(r => setTimeout(r, 10))

describe('CoalescingEnqueuer 任务级并发', () => {
  it('并发额度内窗口立即执行，超额窗口等待释放后滚动续跑', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 2)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(3, 'bb-3'), 'task-a')
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].id).toBe(3)
    releases[2]()
    releases[3]()
    await tick()
  })

  it('任务额度相互独立：A 排队不影响 B 立即执行', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, (key) => (key === 'task-a' ? 1 : 4))
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(3, 'bb-3'), 'task-b')
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual([{ taskKey: 'task-b' }])
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].id).toBe(2)
    releases[2]()
    releases[3]()
    await tick()
  })

  it('同一窗口多任务合并为一次会话（各占各自任务额度）', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run)
    const p = mk(1, 'bb-1')
    enq.enqueue(p, 'task-a')
    enq.enqueue(p, 'task-b', { batchId: 7 })
    enq.enqueue(p, 'task-c')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual([{ taskKey: 'task-a' }, { taskKey: 'task-b', batchId: 7 }, { taskKey: 'task-c' }])
  })

  it('batchId 随 enqueue 透传并在 followUp 重入队时保留', async () => {
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((r) => { releaseFirst = r })
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => {
      if (run.mock.calls.length === 1) return firstGate.then(() => undefined)
      return Promise.resolve(undefined)
    })
    const enq = makeEnq(run)
    const profile = mk(1, 'bb-1')
    enq.enqueue(profile, 'task-a')
    await tick()
    enq.enqueue(profile, 'task-b', { batchId: 9 })
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    releaseFirst()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual([{ taskKey: 'task-b', batchId: 9 }])
  })

  it('pendingCount 返回错峰等待中的窗口数', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 1000)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    expect(enq.pendingCount()).toBe(2)
    await tick()
  })

  it('运行中再次 enqueue 排队为第二批且不与第一批并发', async () => {
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>(r => { releaseFirst = r })
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => {
      if (profile.id === 1 && run.mock.calls.length === 1) return firstGate.then(() => undefined)
      return Promise.resolve(undefined)
    })
    const enq = makeEnq(run)
    const profile = mk(1, 'bb-1')
    enq.enqueue(profile, 'task-a')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    enq.enqueue(profile, 'task-b')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    releaseFirst()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual([{ taskKey: 'task-b' }])
  })

  it('runner 抛错不会产生未处理的 rejection', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const enq = makeEnq(run)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('释放额度时窗口正被其他任务会话占用：转入 followUp 不并发开窗', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, (key) => (key === 'task-a' ? 1 : 4))
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-b')
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    releases[2]()
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].id).toBe(2)
    expect(run.mock.calls[2][1]).toEqual([{ taskKey: 'task-a' }])
    releases[2]()
    await tick()
  })

  it('hasTaskInFlight：pending/running/waiting 均判在途', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 1)
    const p1 = mk(1, 'bb-1')
    const p2 = mk(2, 'bb-2')
    enq.enqueue(p1, 'task-a')
    await tick()
    enq.enqueue(p2, 'task-a')
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    expect(enq.hasTaskInFlight('task-a', 1)).toBe(true)
    expect(enq.hasTaskInFlight('task-a', 2)).toBe(true)
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
    releases[1]()
    await tick()
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    releases[2]()
    await tick()
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
  })

  it('followUp 追加任务判在途', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const run = vi.fn((_profile: { id: number }, _tasks: Array<{ taskKey: string }>) => gate.then(() => undefined))
    const enq = makeEnq(run)
    const p1 = mk(1, 'bb-1')
    enq.enqueue(p1, 'task-a')
    await tick()
    enq.enqueue(p1, 'task-b')
    expect(enq.hasTaskInFlight('task-b')).toBe(true)
    expect(enq.hasTaskInFlight('task-b', 1)).toBe(true)
    release()
    await tick()
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
  })
})

describe('CoalescingEnqueuer 随机错峰', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('staggerMaxSec > 0：窗口会话延迟到期才开窗', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 120)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('等待期内同窗口任务继续合并为一次会话', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 120)
    const profile = mk(1, 'bb-1')
    enq.enqueue(profile, 'task-a')
    enq.enqueue(profile, 'task-b')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual([{ taskKey: 'task-a' }, { taskKey: 'task-b' }])
  })

  it('不同窗口各自独立随机延迟', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 120)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('pending 期间同窗口同任务重复 enqueue 去重：不双跑且额度不泄漏', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 1, 120)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0].id).toBe(2)
  })

  it('等待期间 hasTaskInFlight 判在途，会话结束后解除', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 2, 120)
    const p1 = mk(1, 'bb-1')
    enq.enqueue(p1, 'task-a')
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
  })

  it('immediate 单窗口入口跳过错峰立即投递', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 120)
    enq.enqueue(mk(1, 'bb-1'), 'task-a', { immediate: true })
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('immediate 在额度满排队转 followUp 后重排仍跳过错峰立即执行', async () => {
    // 第一次 random 取 0：task-b 错峰延迟为 0 立即开窗；之后取 0.5：无 immediate 时错峰 60s，用于证明重排确实跳过了定时器
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValue(0.5)
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, (key) => (key === 'task-a' ? 1 : 4), 120)
    enq.enqueue(mk(1, 'bb-1'), 'task-a', { immediate: true })
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    enq.enqueue(mk(2, 'bb-2'), 'task-a', { immediate: true })
    enq.enqueue(mk(2, 'bb-2'), 'task-b')
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual([{ taskKey: 'task-b' }])
    releases[1]()
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(2)
    releases[2]()
    await Promise.resolve()
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].id).toBe(2)
    expect(run.mock.calls[2][1]).toEqual([{ taskKey: 'task-a' }])
    expect(vi.getTimerCount()).toBe(0)
    releases[2]()
    await Promise.resolve()
  })
})

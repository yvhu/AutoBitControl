import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AutoOptimizer } from '../src/tools/clash/auto-optimizer'
import type { ClashService } from '../src/tools/clash/optimizer'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

/** fake service：按场景预设 test/optimize 行为 */
function makeService(testImpl: () => Promise<unknown>, optimizeImpl: () => Promise<unknown>) {
  return {
    isBusy: false,
    test: vi.fn(testImpl),
    optimize: vi.fn(optimizeImpl),
  } as unknown as ClashService
}

const allOk = () => Promise.resolve({ group: 'GLOBAL', currentNode: 'A', currentUsable: true, nodes: [{ name: 'A', urls: [], score: 100, usable: true }] })
const currentDown = () => Promise.resolve({ group: 'GLOBAL', currentNode: 'A', currentUsable: false, nodes: [{ name: 'B', urls: [], score: 50, usable: true }] })
const switched = () => Promise.resolve({ chosen: 'B', switched: true, nodes: [] })

describe('AutoOptimizer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalMin=0 → start 不启动', () => {
    const svc = makeService(allOk, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 0, fastMin: 2 } })
    a.start()
    expect(svc.test).not.toHaveBeenCalled()
  })

  it('全部可用 → 只测速不切换，正常节奏', async () => {
    const svc = makeService(allOk, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.test).toHaveBeenCalledTimes(1)
    expect(svc.optimize).not.toHaveBeenCalled()
    expect(a.status().pace).toBe('normal')
    a.stop()
  })

  it('当前节点不可用 → 自动切换 → 恢复正常节奏', async () => {
    const svc = makeService(currentDown, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.optimize).toHaveBeenCalledTimes(1)
    expect(a.status().pace).toBe('normal')
    a.stop()
  })

  it('全网挂且切换未成功 → 快速节奏', async () => {
    const svc = makeService(currentDown, () => Promise.resolve({ chosen: null, switched: false, nodes: [], switchNote: '全网不可用' }))
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.status().pace).toBe('fast')
    a.stop()
  })

  it('任务在途 → 不切换并计数，连续 3 次告警', async () => {
    const svc = makeService(currentDown, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => true, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.optimize).not.toHaveBeenCalled()
    expect(a.status().deferredSwitches).toBe(1)
    expect(a.status().pace).toBe('fast')
    // 快速节奏 2 分钟一轮，连跑 3 轮
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(a.status().deferredSwitches).toBe(3)
    expect(logger.warn).toHaveBeenCalled()
    a.stop()
  })

  it('恢复后 deferredSwitches 清零', async () => {
    const svc = makeService(currentDown, switched)
    let running = true
    const a = new AutoOptimizer({ service: svc, anyRunning: () => running, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.status().deferredSwitches).toBe(1)
    running = false
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(svc.optimize).toHaveBeenCalledTimes(1)
    expect(a.status().deferredSwitches).toBe(0)
    a.stop()
  })

  it('test 抛错不中断循环（下一轮继续）', async () => {
    const svc = makeService(() => Promise.reject(new Error('boom')), switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(logger.warn).toHaveBeenCalled()
    // 正常节奏下一轮 30 分钟后仍在跑
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(svc.test).toHaveBeenCalledTimes(2)
    a.stop()
  })

  it('stop 后不再调度', async () => {
    const svc = makeService(allOk, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    a.stop()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(svc.test).toHaveBeenCalledTimes(1)
  })
})

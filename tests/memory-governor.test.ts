import { describe, it, expect } from 'vitest'
import { computeEffectivePool, MemoryGovernor } from '../src/engine/memory-governor'

describe('computeEffectivePool', () => {
  it('硬上限优先；空闲不足按每窗口内存降级', () => {
    expect(computeEffectivePool({ freeMb: 12600, actualOpen: 0, maxOpenWindows: 4, perWindowMb: 1024, reserveMb: 100 })).toBe(4)
    expect(computeEffectivePool({ freeMb: 2048, actualOpen: 0, maxOpenWindows: 4, perWindowMb: 1024, reserveMb: 100 })).toBe(1)
    expect(computeEffectivePool({ freeMb: 1000, actualOpen: 0, maxOpenWindows: 4, perWindowMb: 1024, reserveMb: 100 })).toBe(0)
  })
})

describe('MemoryGovernor', () => {
  it('normal → critical → recover 迟滞', () => {
    const g = new MemoryGovernor({ reserveMb: 100, perWindowMb: 1024, criticalFreeMb: 1024, resumeFreeMb: 2048, checkCount: 3 })
    expect(g.update({ freeMb: 8000, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('normal')
    expect(g.update({ freeMb: 900, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('critical')
    expect(g.update({ freeMb: 2500, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('critical')
    expect(g.update({ freeMb: 2500, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('critical')
    expect(g.update({ freeMb: 2500, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('normal')
  })

  it('开窗实测内存差更新 perWindowMb（EWMA，夹在 512–2048）', () => {
    const g = new MemoryGovernor({ reserveMb: 100, perWindowMb: 1024, criticalFreeMb: 1024, resumeFreeMb: 2048, checkCount: 1 })
    g.recordOpenDelta(3000)
    expect(g.update({ freeMb: 8000, actualOpen: 0, maxOpenWindows: 4 }).perWindowMb).toBe(1617)
    g.recordOpenDelta(100)
    expect(g.update({ freeMb: 8000, actualOpen: 0, maxOpenWindows: 4 }).perWindowMb).toBeGreaterThanOrEqual(512)
  })
})

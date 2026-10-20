import { describe, it, expect } from 'vitest'
import { staggerNotBefore } from '../src/engine/stagger'

describe('staggerNotBefore', () => {
  it('count=1 或 spread=0 时不延迟', () => {
    expect(staggerNotBefore({ startMs: 1000, nowMs: 0, index: 0, count: 1, spreadMs: 120000, jitterPct: 15 })).toBe(1000)
    expect(staggerNotBefore({ startMs: 1000, nowMs: 0, index: 3, count: 10, spreadMs: 0, jitterPct: 15 })).toBe(1000)
  })

  it('均匀分布且不早于 now', () => {
    const base = { startMs: 1000, nowMs: 0, count: 5, spreadMs: 8000, jitterPct: 0 }
    expect(staggerNotBefore({ ...base, index: 0 })).toBe(1000)
    expect(staggerNotBefore({ ...base, index: 4 })).toBe(9000)
    expect(staggerNotBefore({ ...base, index: 4, nowMs: 20000 })).toBe(20000)
  })

  it('抖动在 spacing 的 ±jitterPct 内', () => {
    const base = { startMs: 10_000, nowMs: 0, index: 2, count: 5, spreadMs: 8_000, jitterPct: 15 }
    // spacing=2000，抖动幅度=2000*15%=300
    expect(staggerNotBefore({ ...base, rng: () => 0 })).toBe(13_700)
    expect(staggerNotBefore({ ...base, rng: () => 1 })).toBe(14_300)
    expect(staggerNotBefore({ ...base, rng: () => 0.5 })).toBe(14_000)
  })
})

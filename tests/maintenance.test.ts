import { describe, it, expect, vi } from 'vitest'
import { msUntilNext, startCircuitBreakerResetSchedule } from '../src/engine/maintenance'

describe('msUntilNext 计算到下一次 HH:mm 的毫秒', () => {
  // 2026-01-01 04:00:00 UTC = 12:00:00 Asia/Shanghai（UTC+8，无 DST）
  const noon = Date.UTC(2026, 0, 1, 4, 0, 0)

  it('目标在当天稍后：返回正差值', () => {
    expect(msUntilNext('12:30', 'Asia/Shanghai', noon)).toBe(30 * 60 * 1000)
  })

  it('目标已过：滚到次日', () => {
    expect(msUntilNext('11:30', 'Asia/Shanghai', noon)).toBe(23.5 * 60 * 60 * 1000)
  })

  it('目标正好当前分钟：滚到次日（避免 0 毫秒立即触发）', () => {
    expect(msUntilNext('12:00', 'Asia/Shanghai', noon)).toBe(24 * 60 * 60 * 1000)
  })

  it('非法 hh:mm 返回 -1', () => {
    for (const bad of ['', 'abc', '25:00', '12:60', '1:00', '12:5', '12']) {
      expect(msUntilNext(bad, 'Asia/Shanghai', noon)).toBe(-1)
    }
  })

  it('非法时区不抛错，降级返回 -1', () => {
    expect(() => msUntilNext('12:30', 'Not/AZone', noon)).not.toThrow()
    expect(msUntilNext('12:30', 'Not/AZone', noon)).toBe(-1)
  })

  // 2026-01-01 00:30 Shanghai = 2025-12-31 16:30 UTC（验证午夜时段 hourCycle h23 修复）
  const midnightHalf = Date.UTC(2025, 11, 31, 16, 30, 0)

  it('午夜时段（now 00:30）目标 00:15：返回正差值而非负数', () => {
    const ms = msUntilNext('00:15', 'Asia/Shanghai', midnightHalf)
    expect(ms).toBe(23.75 * 60 * 60 * 1000)
    expect(ms).toBeGreaterThan(0)
  })

  it('午夜时段（now 00:30）目标 00:00：返回正差值', () => {
    const ms = msUntilNext('00:00', 'Asia/Shanghai', midnightHalf)
    expect(ms).toBe(23.5 * 60 * 60 * 1000)
    expect(ms).toBeGreaterThan(0)
  })

  it('午夜时段（now 00:30）目标 00:45：当天稍后为正差值', () => {
    expect(msUntilNext('00:45', 'Asia/Shanghai', midnightHalf)).toBe(15 * 60 * 1000)
  })
})

describe('maintenance 熔断每日重置', () => {
  it('关闭配置时不排程', () => {
    const db = { resetMeltedCircuitBreakers: vi.fn() } as never
    const cfg = { execution: { circuitBreakerResetAt: '' }, scheduler: { timezone: 'Asia/Shanghai' } } as never
    const h = startCircuitBreakerResetSchedule(cfg, db, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    expect(typeof h.stop).toBe('function')
    h.stop()
  })

  it('到点执行一次并重置（fake timers + 注入 now）', async () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)) })
    try {
      const reset = vi.fn().mockResolvedValue(3)
      const db = { resetMeltedCircuitBreakers: reset } as never
      const cfg = { execution: { circuitBreakerResetAt: '08:30' }, scheduler: { timezone: 'Asia/Shanghai' } } as never
      const info = vi.fn()
      const h = startCircuitBreakerResetSchedule(cfg, db, { info, warn: vi.fn(), error: vi.fn() } as never)
      expect(reset).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalled()
      h.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

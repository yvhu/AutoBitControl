import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickRandomTimeInWindow, staggerToCron, Scheduler } from '../src/engine/scheduler'

describe('pickRandomTimeInWindow', () => {
  it('随机时间落在窗口内', () => {
    const base = new Date(2026, 7, 28, 0, 0, 0)
    for (let i = 0; i < 100; i++) {
      const t = pickRandomTimeInWindow('09:00', '11:00', base)
      const minutes = t.getHours() * 60 + t.getMinutes()
      expect(minutes).toBeGreaterThanOrEqual(9 * 60)
      expect(minutes).toBeLessThanOrEqual(11 * 60)
      expect(t.getDate()).toBe(28)
    }
  })

  it('跨天窗口（end<start）随机时间落在午夜两侧且落点加一天', () => {
    const base = new Date(2026, 7, 28, 0, 0, 0)
    for (let i = 0; i < 200; i++) {
      const t = pickRandomTimeInWindow('23:00', '01:00', base)
      const minutes = t.getHours() * 60 + t.getMinutes()
      const inLate = minutes >= 23 * 60
      const inEarly = minutes <= 1 * 60
      expect(inLate || inEarly).toBe(true)
      if (inEarly) {
        // 落点在午夜前（< startMin）视为次日
        expect(t.getDate()).toBe(29)
      } else {
        expect(t.getDate()).toBe(28)
      }
    }
  })

  it('等值窗口（start===end）退化为固定点而非全时段随机', () => {
    const base = new Date(2026, 7, 28, 0, 0, 0)
    for (let i = 0; i < 50; i++) {
      const t = pickRandomTimeInWindow('09:30', '09:30', base)
      expect(t.getHours()).toBe(9)
      expect(t.getMinutes()).toBe(30)
      expect(t.getDate()).toBe(28)
    }
  })
})

describe('staggerToCron', () => {
  it('生成合法 cron 表达式', () => {
    expect(staggerToCron('09:00', '09:30')).toMatch(/^\d+ \d+ \* \* \*$/)
  })
})

describe('Scheduler', () => {
  it('fireNow 将启用窗口的任务入队', () => {
    const rows = [
      { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 },
      { id: 2, bitbrowserId: 'bb-2', name: 'B', enabled: 0, circuitBreakerCount: 0 },
    ]
    const db = {
      listProfiles: vi.fn().mockImplementation((enabledOnly: boolean) => (enabledOnly ? rows.filter(r => r.enabled === 1) : rows)),
      getTaskEnabled: vi.fn().mockReturnValue(true),
    } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const task = { meta: { key: 't1', name: 'T1', url: '', schedule: '0 9 * * *' }, run: async () => {} }
    const sched = new Scheduler({} as never, db, new Map([['t1', task]]), enq, { info: () => {} } as never)
    sched.fireNow('t1')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][0].id).toBe(1)
    expect(enqueue.mock.calls[0][1]).toBe('t1')
  })

  it('fireNow 对未注册任务安全返回', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const sched = new Scheduler({} as never, db, new Map(), enq, { info: () => {} } as never)
    sched.fireNow('nope')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('deprecated 任务不调度', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const warn = vi.fn()
    const deprecated = { meta: { key: 'old', name: '旧任务', url: 'https://x.io', schedule: '0 9 * * *', deprecated: true } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['old', deprecated]]), enq, { info: vi.fn(), warn, error: vi.fn() } as never)
    sched.start()
    expect(warn).toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    sched.stop()
  })

  it('停用任务不调度', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockReturnValue(false) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() } as never
    const task = { meta: { key: 'off', name: '停用任务', url: 'https://x.io', schedule: '0 9 * * *' } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['off', task]]), enq, logger)
    sched.start()
    expect(warn).toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    sched.stop()
  })

  it('fireNow 对 deprecated 任务仍可手动触发', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([{ id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }]), getTaskEnabled: vi.fn().mockReturnValue(true) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['old', { meta: { key: 'old', name: '旧任务', url: 'https://x.io', deprecated: true } }]]), enq, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    sched.fireNow('old')
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('fireNow 对停用任务不触发', () => {
    const db = { listProfiles: vi.fn(), getTaskEnabled: vi.fn().mockReturnValue(false) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['off', { meta: { key: 'off', name: '停用', url: 'https://x.io' } }]]), enq, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    sched.fireNow('off')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('start 重入保护：再次调用先停旧任务再重新注册', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockReturnValue(true) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const warn = vi.fn()
    const info = vi.fn()
    const logger = { info, warn, error: vi.fn() } as never
    const task = { meta: { key: 't1', name: 'T1', url: 'https://x.io', schedule: '0 9 * * *' } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['t1', task]]), enq, logger)
    sched.start()
    const scheduled = () => info.mock.calls.filter(c => c[1] === '任务已调度').length
    expect(scheduled()).toBe(1)
    // 再次 start：先 stop 旧 cron（warn 提示）再注册一次，无重复 cron
    sched.start()
    expect(warn).toHaveBeenCalled()
    expect(scheduled()).toBe(2)
    sched.stop()
  })

  it('stagger 任务注册日更刷新器且 refreshStagger 可重复调用', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockReturnValue(true) } as never
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() } as never
    const task = { meta: { key: 'st', name: '错峰', url: 'https://x.io', schedule: { stagger: ['23:00', '01:00'] as [string, string] } } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['st', task]]), { enqueue: vi.fn() } as never, logger)
    sched.start()
    expect(info.mock.calls.some(c => c[1] === '任务已调度')).toBe(true)
    // 重复刷新/未知任务都不抛错（幂等安全）
    expect(() => sched.refreshStagger('st')).not.toThrow()
    expect(() => sched.refreshStagger('st')).not.toThrow()
    expect(() => sched.refreshStagger('nope')).not.toThrow()
    sched.stop()
    expect(() => sched.stop()).not.toThrow()
  })
})

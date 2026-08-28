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
})

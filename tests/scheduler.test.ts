import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickRandomTimeInWindow, staggerToCron, Scheduler, intervalDue, isIntervalSchedule } from '../src/engine/scheduler'

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
  it('fireNow 将启用窗口的任务入队', async () => {
    const rows = [
      { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 },
      { id: 2, bitbrowserId: 'bb-2', name: 'B', enabled: 0, circuitBreakerCount: 0 },
    ]
    const db = {
      listProfiles: vi.fn().mockImplementation(async (enabledOnly: boolean) => (enabledOnly ? rows.filter(r => r.enabled === 1) : rows)),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
    } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const task = { meta: { key: 't1', name: 'T1', url: '', schedule: '0 9 * * *' }, run: async () => {} }
    const sched = new Scheduler({} as never, db, new Map([['t1', task]]), enq, { info: () => {} } as never)
    await sched.fireNow('t1')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][0].id).toBe(1)
    expect(enqueue.mock.calls[0][1]).toBe('t1')
  })

  it('fireNow 对未注册任务安全返回', async () => {
    const db = { listProfiles: vi.fn().mockResolvedValue([]) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const sched = new Scheduler({} as never, db, new Map(), enq, { info: () => {} } as never)
    await sched.fireNow('nope')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('deprecated 任务不调度', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockResolvedValue(true) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const warn = vi.fn()
    const deprecated = { meta: { key: 'old', name: '旧任务', url: 'https://x.io', schedule: '0 9 * * *', deprecated: true } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['old', deprecated]]), enq, { info: vi.fn(), warn, error: vi.fn() } as never)
    await sched.start()
    expect(warn).toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    sched.stop()
  })

  it('停用任务不调度（云端开关覆盖为 false）', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockResolvedValue(false) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() } as never
    const task = { meta: { key: 'off', name: '停用任务', url: 'https://x.io', schedule: '0 9 * * *', enabled: false } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['off', task]]), enq, logger)
    await sched.start()
    expect(warn).toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    sched.stop()
  })

  it('fireNow 对 deprecated 任务仍可手动触发', async () => {
    const db = { listProfiles: vi.fn().mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }]), getTaskEnabled: vi.fn().mockResolvedValue(true) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['old', { meta: { key: 'old', name: '旧任务', url: 'https://x.io', deprecated: true } }]]), enq, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    await sched.fireNow('old')
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('fireNow 对停用任务不触发（云端开关覆盖为 false）', async () => {
    const db = { listProfiles: vi.fn(), getTaskEnabled: vi.fn().mockResolvedValue(false) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['off', { meta: { key: 'off', name: '停用', url: 'https://x.io', enabled: false } }]]), enq, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    await sched.fireNow('off')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('start 重入保护：再次调用先停旧任务再重新注册', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockResolvedValue(true) } as never
    const enqueue = vi.fn()
    const enq = { enqueue } as never
    const warn = vi.fn()
    const info = vi.fn()
    const logger = { info, warn, error: vi.fn() } as never
    const task = { meta: { key: 't1', name: 'T1', url: 'https://x.io', schedule: '0 9 * * *' } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['t1', task]]), enq, logger)
    await sched.start()
    const scheduled = () => info.mock.calls.filter(c => c[1] === '任务已调度').length
    expect(scheduled()).toBe(1)
    // 再次 start：先 stop 旧 cron（warn 提示）再注册一次，无重复 cron
    await sched.start()
    expect(warn).toHaveBeenCalled()
    expect(scheduled()).toBe(2)
    sched.stop()
  })

  it('stagger 任务注册日更刷新器且 refreshStagger 可重复调用', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockResolvedValue(true) } as never
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() } as never
    const task = { meta: { key: 'st', name: '错峰', url: 'https://x.io', schedule: { stagger: ['23:00', '01:00'] as [string, string] } } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['st', task]]), { enqueue: vi.fn() } as never, logger)
    await sched.start()
    expect(info.mock.calls.some(c => c[1] === '任务已调度')).toBe(true)
    // 重复刷新/未知任务都不抛错（幂等安全）
    expect(() => sched.refreshStagger('st')).not.toThrow()
    expect(() => sched.refreshStagger('st')).not.toThrow()
    expect(() => sched.refreshStagger('nope')).not.toThrow()
    sched.stop()
    expect(() => sched.stop()).not.toThrow()
  })

  it('refreshTask 停用任务不注册 cron', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockResolvedValue(false) } as never
    const info = vi.fn()
    const warn = vi.fn()
    const logger = { info, warn, error: vi.fn() } as never
    const task = { meta: { key: 't1', name: 'T1', url: 'https://x.io', schedule: '0 9 * * *' } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['t1', task]]), { enqueue: vi.fn() } as never, logger)
    await sched.refreshTask('t1')
    expect(warn).toHaveBeenCalledWith({ task: 't1' }, '任务已停用，跳过调度')
    expect(info).not.toHaveBeenCalled()
    sched.stop()
  })

  it('refreshTask 启用任务立即注册 cron', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockResolvedValue(true) } as never
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() } as never
    const task = { meta: { key: 't1', name: 'T1', url: 'https://x.io', schedule: '0 9 * * *' } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['t1', task]]), { enqueue: vi.fn() } as never, logger)
    await sched.refreshTask('t1')
    expect(info).toHaveBeenCalledWith({ task: 't1', cron: '0 9 * * *' }, '任务已调度')
    sched.stop()
  })

  it('refreshTask 对已注册任务先停旧 cron 再重注册（不产生重复）', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockResolvedValue(true) } as never
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() } as never
    const task = { meta: { key: 't1', name: 'T1', url: 'https://x.io', schedule: '0 9 * * *' } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['t1', task]]), { enqueue: vi.fn() } as never, logger)
    await sched.start()
    await sched.refreshTask('t1')
    const scheduled = () => info.mock.calls.filter(c => c[1] === '任务已调度').length
    expect(scheduled()).toBe(2)
    sched.stop()
    expect(() => sched.stop()).not.toThrow()
  })

  it('refreshTask 开关切换即时停/恢复 stagger 任务的错峰 cron 与日更刷新器', async () => {
    let enabled = true
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockImplementation(async () => enabled) } as never
    const info = vi.fn()
    const warn = vi.fn()
    const logger = { info, warn, error: vi.fn() } as never
    const task = { meta: { key: 'st', name: '错峰', url: 'https://x.io', schedule: { stagger: ['23:00', '01:00'] as [string, string] } } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['st', task]]), { enqueue: vi.fn() } as never, logger)
    await sched.start()
    const scheduled = () => info.mock.calls.filter(c => c[1] === '任务已调度').length
    expect(scheduled()).toBe(1)
    // 停用：错峰 cron 与日更刷新器按 key 停掉，不再注册
    enabled = false
    await sched.refreshTask('st')
    expect(warn).toHaveBeenCalledWith({ task: 'st' }, '任务已停用，跳过调度')
    expect(scheduled()).toBe(1)
    // 重新启用：即时重注册（含 00:01 日更刷新器）
    enabled = true
    await sched.refreshTask('st')
    expect(scheduled()).toBe(2)
    sched.stop()
    expect(() => sched.stop()).not.toThrow()
  })

  it('refreshTask 云库读取失败时自吞错并告警（不抛向调用方）', async () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]), getTaskEnabled: vi.fn().mockRejectedValue(new Error('cloud blip')) } as never
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() } as never
    const task = { meta: { key: 't1', name: 'T1', url: 'https://x.io', schedule: '0 9 * * *' } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['t1', task]]), { enqueue: vi.fn() } as never, logger)
    expect(() => sched.refreshTask('t1')).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledWith({ task: 't1', err: 'cloud blip' }, '刷新任务调度失败')
    sched.stop()
  })
})

describe('intervalDue', () => {
  it('无锚点视为到期（立即触发首轮）', () => {
    expect(intervalDue(null, 8, 60000, Date.now())).toBe(true)
  })

  it('锚点 + N 小时 + 缓冲之前未到期', () => {
    const now = Date.parse('2026-08-31T08:00:00.000Z')
    expect(intervalDue('2026-08-31T00:00:00.000Z', 8, 60000, now)).toBe(false)
  })

  it('锚点 + N 小时 + 缓冲之后到期', () => {
    const now = Date.parse('2026-08-31T08:01:01.000Z')
    expect(intervalDue('2026-08-31T00:00:00.000Z', 8, 60000, now)).toBe(true)
  })

  it('非法锚点按无锚点处理（到期）', () => {
    expect(intervalDue('not-a-date', 8, 60000, Date.now())).toBe(true)
  })
})

describe('isIntervalSchedule', () => {
  it('识别间隔形态与其它形态', () => {
    expect(isIntervalSchedule({ everyHours: 8 })).toBe(true)
    expect(isIntervalSchedule({ stagger: ['09:00', '11:00'] })).toBe(false)
    expect(isIntervalSchedule('0 8 * * *')).toBe(false)
    expect(isIntervalSchedule(undefined)).toBe(false)
    expect(isIntervalSchedule(null)).toBe(false)
  })
})

describe('Scheduler 间隔任务', () => {
  function makeIntervalDeps(getTaskFiredAt: ReturnType<typeof vi.fn>) {
    const db = {
      listProfiles: vi.fn().mockResolvedValue([]),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
      getTaskFiredAt,
    } as never
    const enqueue = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    const scheduler = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([
      ['iv', { meta: { key: 'iv', url: 'https://a.io', schedule: { everyHours: 8 } } }],
    ]) as never, { enqueue } as never, logger)
    return { db, enqueue, scheduler }
  }

  it('无锚点首轮 tick 触发，触发后 N 小时内不再触发', async () => {
    const { enqueue, scheduler } = makeIntervalDeps(vi.fn().mockResolvedValue(null))
    const t0 = Date.parse('2026-08-31T08:00:00.000Z')
    await scheduler.tickIntervals(t0)
    expect(enqueue).toHaveBeenCalledTimes(0) // listProfiles 为空窗口，fireNow 不入队
    // 用有窗口的库再验一次：触发行为由 fireNow 决定，这里直接验证 nextAllow 抑制逻辑
    const db2 = {
      listProfiles: vi.fn().mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }]),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
      getTaskFiredAt: vi.fn().mockResolvedValue(null),
    } as never
    const enqueue2 = vi.fn()
    const s2 = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db2, new Map([
      ['iv', { meta: { key: 'iv', url: 'https://a.io', schedule: { everyHours: 8 } } }],
    ]) as never, { enqueue: enqueue2 } as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    await s2.tickIntervals(t0)
    expect(enqueue2).toHaveBeenCalledTimes(1)
    await s2.tickIntervals(t0 + 3_600_000)
    expect(enqueue2).toHaveBeenCalledTimes(1) // 8 小时内不重复触发
    await s2.tickIntervals(t0 + 8 * 3_600_000 + 61_000)
    expect(enqueue2).toHaveBeenCalledTimes(2) // 到期后再次触发
    s2.stop()
  })

  it('锚点未到缓冲期不触发', async () => {
    const { enqueue, scheduler } = makeIntervalDeps(vi.fn().mockResolvedValue('2026-08-31T00:00:00.000Z'))
    await scheduler.tickIntervals(Date.parse('2026-08-31T08:00:30.000Z'))
    expect(enqueue).toHaveBeenCalledTimes(0)
  })
})

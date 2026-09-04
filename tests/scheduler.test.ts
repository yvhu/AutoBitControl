import { describe, it, expect, vi, afterEach } from 'vitest'
import { wallClockIn, isDueMinute, modeLabel, ruleText, nextRunText, validateScheduleConfig } from '../src/engine/schedule'
import { Scheduler, type SchedulerDeps } from '../src/engine/scheduler'
import type { ScheduleRow } from '../src/infrastructure/db'

const TZ = 'Asia/Shanghai'

describe('wallClockIn（Intl 读配置时区墙上时钟）', () => {
  it('UTC 时间转 Asia/Shanghai 墙上时钟（+8）', () => {
    // 2026-09-04T01:00:00Z = 上海 2026-09-04 09:00 周五
    const wc = wallClockIn(TZ, new Date('2026-09-04T01:00:00Z'))
    expect(wc).toEqual({ year: 2026, month: 9, day: 4, weekday: 5, hour: 9, minute: 0 })
  })

  it('午夜边界：hour 不出现 24', () => {
    // 2026-09-03T16:00:00Z = 上海 2026-09-04 00:00
    const wc = wallClockIn(TZ, new Date('2026-09-03T16:00:00Z'))
    expect(wc.hour).toBe(0)
    expect(wc.day).toBe(4)
  })
})

describe('isDueMinute（四种模式到点匹配）', () => {
  const wc = (h: number, m: number, weekday = 5, day = 4) => ({ year: 2026, month: 9, day, weekday, hour: h, minute: m })

  it('interval：每 6 小时，06:00/12:00/18:00 命中，00:00 不命中', () => {
    const cfg = { everyHours: 6 }
    expect(isDueMinute('interval', cfg, wc(6, 0))).toBe(true)
    expect(isDueMinute('interval', cfg, wc(12, 0))).toBe(true)
    expect(isDueMinute('interval', cfg, wc(18, 0))).toBe(true)
    expect(isDueMinute('interval', cfg, wc(0, 0))).toBe(false)
    expect(isDueMinute('interval', cfg, wc(9, 5))).toBe(false)
  })

  it('daily：时间点命中，其它分钟不命中', () => {
    const cfg = { times: ['09:00', '15:00'] }
    expect(isDueMinute('daily', cfg, wc(9, 0))).toBe(true)
    expect(isDueMinute('daily', cfg, wc(15, 0))).toBe(true)
    expect(isDueMinute('daily', cfg, wc(9, 1))).toBe(false)
  })

  it('weekly：指定星期命中，其它星期不命中', () => {
    const cfg = { weekdays: [1, 3, 5], times: ['09:00'] }
    expect(isDueMinute('weekly', cfg, wc(9, 0, 1))).toBe(true)
    expect(isDueMinute('weekly', cfg, wc(9, 0, 3))).toBe(true)
    expect(isDueMinute('weekly', cfg, wc(9, 0, 7))).toBe(false)
  })

  it('monthly：指定日期命中，其它日期不命中', () => {
    const cfg = { days: [1, 15], times: ['09:00'] }
    expect(isDueMinute('monthly', cfg, wc(9, 0, 5, 15))).toBe(true)
    expect(isDueMinute('monthly', cfg, wc(9, 0, 5, 16))).toBe(false)
  })
})

describe('modeLabel / ruleText', () => {
  it('四种模式标签与摘要', () => {
    expect(modeLabel('interval')).toBe('每 N 小时')
    expect(modeLabel('daily')).toBe('每日')
    expect(modeLabel('weekly')).toBe('每周')
    expect(modeLabel('monthly')).toBe('每月')
    expect(ruleText('interval', { everyHours: 6 })).toBe('每 6 小时一次')
    expect(ruleText('daily', { times: ['09:00', '15:00'] })).toBe('09:00 / 15:00')
    expect(ruleText('weekly', { weekdays: [1, 3, 5], times: ['09:00'] })).toBe('周一、周三、周五 09:00')
    expect(ruleText('monthly', { days: [1, 15], times: ['10:30'] })).toBe('1、15 号 10:30')
  })
})

describe('nextRunText（下次执行墙上时间文本）', () => {
  it('daily：今天剩余时间点，已过则明天', () => {
    expect(nextRunText('daily', { times: ['09:00', '15:00'] }, TZ, new Date('2026-09-04T00:00:00Z'))).toBe('今天 09:00')
    expect(nextRunText('daily', { times: ['09:00', '15:00'] }, TZ, new Date('2026-09-04T08:30:00Z'))).toBe('明天 09:00')
  })

  it('interval：午夜对齐且排除 00:00', () => {
    expect(nextRunText('interval', { everyHours: 6 }, TZ, new Date('2026-09-03T23:59:00Z'))).toBe('今天 12:00')
    expect(nextRunText('interval', { everyHours: 6 }, TZ, new Date('2026-09-04T11:00:00Z'))).toBe('明天 06:00')
    expect(nextRunText('interval', { everyHours: 6 }, TZ, new Date('2026-09-03T16:00:00Z'))).toBe('今天 06:00')
  })

  it('weekly：扫描未来 7 天第一个匹配', () => {
    // 2026-09-04T02:00:00Z = 上海 周五 10:00（09:00 已过 → 今天不命中）
    expect(nextRunText('weekly', { weekdays: [1, 3, 5], times: ['09:00'] }, TZ, new Date('2026-09-04T02:00:00Z'))).toBe('周一 09:00')
    expect(nextRunText('weekly', { weekdays: [4], times: ['09:00'] }, TZ, new Date('2026-09-04T02:00:00Z'))).toBe('周四 09:00')
  })

  it('monthly：扫描未来 62 天；31 号在小月自动落到下月', () => {
    expect(nextRunText('monthly', { days: [1, 15], times: ['09:00'] }, TZ, new Date('2026-09-04T02:00:00Z'))).toBe('9月15日 09:00')
    // 2026-04-05 10:00（4 月无 31 号 → 5月31日，间隔 56 天，62 天扫描覆盖）
    expect(nextRunText('monthly', { days: [31], times: ['09:00'] }, TZ, new Date('2026-04-05T02:00:00Z'))).toBe('5月31日 09:00')
  })
})

describe('validateScheduleConfig', () => {
  it('四种合法配置返回 null', () => {
    expect(validateScheduleConfig('interval', { everyHours: 6 })).toBeNull()
    expect(validateScheduleConfig('daily', { times: ['09:00'] })).toBeNull()
    expect(validateScheduleConfig('weekly', { weekdays: [1, 7], times: ['09:00'] })).toBeNull()
    expect(validateScheduleConfig('monthly', { days: [1, 31], times: ['00:00'] })).toBeNull()
  })

  it('非法配置返回错误文案', () => {
    expect(validateScheduleConfig('interval', { everyHours: 0 })).toBeTruthy()
    expect(validateScheduleConfig('interval', { everyHours: 24 })).toBeTruthy()
    expect(validateScheduleConfig('daily', { times: [] })).toBeTruthy()
    expect(validateScheduleConfig('daily', { times: ['9:00'] })).toBeTruthy()
    expect(validateScheduleConfig('daily', { times: ['24:00'] })).toBeTruthy()
    expect(validateScheduleConfig('weekly', { weekdays: [], times: ['09:00'] })).toBeTruthy()
    expect(validateScheduleConfig('weekly', { weekdays: [8], times: ['09:00'] })).toBeTruthy()
    expect(validateScheduleConfig('monthly', { days: [32], times: ['09:00'] })).toBeTruthy()
  })
})

// ===== Scheduler 类（假 db/enqueuer，注入固定 now，不经真定时器）=====

const TZ2 = 'Asia/Shanghai'

function makeSchedule(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 1, name: '每日签到', enabled: 1, mode: 'daily',
    config: '{"times":["09:00"]}', taskKeys: '["task-a"]',
    createdAt: '2026-09-04 00:00:00.000', updatedAt: '2026-09-04 00:00:00.000',
    ...over,
  }
}

type Mock = ReturnType<typeof vi.fn>

/** 用例要断言 mock 调用：db/enqueuer 成员保留 vi.fn 的 Mock 类型（与 web.test.ts 的 MockDeps 同款） */
interface MockDeps extends SchedulerDeps {
  db: {
    listSchedules: Mock
    getTaskEnabled: Mock
    countInFlightRuns: Mock
    createBatch: Mock
    listProfiles: Mock
  }
  enqueuer: { enqueue: Mock; hasTaskInFlight: Mock }
}

function makeDeps(over: Partial<MockDeps> = {}): MockDeps {
  const deps: MockDeps = {
    db: {
      listSchedules: vi.fn().mockResolvedValue([]),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
      countInFlightRuns: vi.fn().mockResolvedValue(0),
      createBatch: vi.fn().mockResolvedValue({ id: 88, kind: 'schedule', taskKey: 'task-a', source: '', createdAt: '' }),
      listProfiles: vi.fn().mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }]),
    },
    enqueuer: { enqueue: vi.fn(), hasTaskInFlight: vi.fn().mockReturnValue(false) },
    tasks: new Map([['task-a', { meta: { key: 'task-a', name: '任务A', url: '' } }]]),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    timezone: TZ2,
    now: () => new Date('2026-09-04T01:00:30Z'), // 上海 09:00:30，命中 09:00
    ...over,
  }
  return deps
}

afterEach(() => vi.restoreAllMocks())

describe('Scheduler', () => {
  it('到点触发：建 schedule 批次并按启用窗口入队（不带 immediate）', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    const s = new Scheduler(deps)
    await s.tick()
    expect(deps.db.createBatch).toHaveBeenCalledWith('schedule', 'task-a', '计划#1 每日签到')
    expect(deps.enqueuer.enqueue).toHaveBeenCalledWith({ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }, 'task-a', { batchId: 88 })
  })

  it('同一分钟只触发一次（去重 Map）', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    const s = new Scheduler(deps)
    await s.tick()
    await s.tick()
    expect(deps.db.createBatch).toHaveBeenCalledTimes(1)
  })

  it('分钟不匹配不触发', async () => {
    const deps = makeDeps({ now: () => new Date('2026-09-04T01:59:00Z') }) // 上海 09:59
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    const s = new Scheduler(deps)
    await s.tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })

  it('停用计划跳过', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule({ enabled: 0 })])
    await new Scheduler(deps).tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })

  it('任务 key 未注册 → 跳过并告警', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule({ taskKeys: '["ghost"]' })])
    const s = new Scheduler(deps)
    await s.tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('任务开关关闭（getTaskEnabled=false）→ 跳过', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    await new Scheduler(deps).tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })

  it('在途守卫（DB 有在途 run 或队列在途）→ 跳过', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    deps.db.countInFlightRuns.mockResolvedValue(1)
    await new Scheduler(deps).tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()

    // 队列在途分支用独立实例（避免与上一个实例的去重 Map 冲突）
    const deps2 = makeDeps()
    deps2.db.listSchedules.mockResolvedValue([makeSchedule()])
    deps2.enqueuer.hasTaskInFlight.mockReturnValue(true)
    await new Scheduler(deps2).tick()
    expect(deps2.db.createBatch).not.toHaveBeenCalled()
  })

  it('runNow 不受时间与去重限制，直接触发', async () => {
    const deps = makeDeps({ now: () => new Date('2026-09-04T01:59:00Z') }) // 09:59 不到点
    const s = new Scheduler(deps)
    const result = await s.runNow(makeSchedule())
    expect(result.taskKeys).toEqual(['task-a'])
    expect(deps.db.createBatch).toHaveBeenCalledTimes(1)
    await s.runNow(makeSchedule())
    expect(deps.db.createBatch).toHaveBeenCalledTimes(2)
  })

  it('runNow 汇总跳过原因（停用任务）', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    const result = await new Scheduler(deps).runNow(makeSchedule())
    expect(result.taskKeys).toEqual([])
    expect(result.skipped).toEqual([{ taskKey: 'task-a', reason: 'task-disabled' }])
  })

  it('start/stop 挂载与清除定时器', () => {
    const deps = makeDeps()
    const s = new Scheduler(deps)
    const setSpy = vi.spyOn(global, 'setInterval').mockReturnValue(123 as unknown as ReturnType<typeof setInterval>)
    const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {})
    s.start()
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 15000)
    s.stop()
    expect(clearSpy).toHaveBeenCalledWith(123)
  })

  it('某计划 fire 抛错不中断其它计划', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule({ id: 1 }), makeSchedule({ id: 2 })])
    deps.db.createBatch.mockRejectedValueOnce(new Error('db down'))
    const s = new Scheduler(deps)
    await s.tick()
    expect(deps.db.createBatch).toHaveBeenCalledTimes(2)
    expect(deps.db.createBatch).toHaveBeenCalledWith('schedule', 'task-a', '计划#2 每日签到')
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('taskKeys 非字符串数组形状 → 跳过整个计划', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule({ taskKeys: '"not-array"' })])
    await new Scheduler(deps).tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
    expect(deps.logger.warn).toHaveBeenCalled()
  })
})

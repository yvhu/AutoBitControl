import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from '../src/server/app'
import { buildBitbrowserDeps } from '../src/app'

type Mock = ReturnType<typeof vi.fn>

interface MockDeps {
  db: {
    listRunsForDate: Mock
    listProfiles: Mock
    captchaStats: Mock
    setProfileEnabled: Mock
    resetCircuitBreaker: Mock
    getTaskEnabled: Mock
    setTaskEnabled: Mock
    getOpenWindow: Mock
    setOpenWindow: Mock
    clearOpenWindow: Mock
    countInFlightRuns: Mock
    createBatch: Mock
    getBatch: Mock
    listBatchesForRange: Mock
    listRunsForBatch: Mock
    listUnbatchedRuns: Mock
    listSchedules: Mock
    getSchedule: Mock
    createSchedule: Mock
    updateSchedule: Mock
    deleteSchedule: Mock
  }
  enqueuer: { enqueue: Mock; hasTaskInFlight: Mock; pendingCount: Mock }
  scheduler: { runNow: Mock }
  tasks: Map<string, { meta: { key: string; name: string; url: string; wallet: string; enabled?: boolean; concurrency?: number } }>
  cfg: {
    web: { port: number }
    storage: { screenshotDir: string }
    bitbrowser: { apiBase: string }
    execution: { staggerMaxSec: number; circuitBreakerThreshold: number; probeUrl: string }
    scheduler: { timezone: string }
    captcha: { clientKey: string }
  }
  bitbrowser: { health: Mock; sync: Mock; openBrowser: Mock; closeBrowser: Mock; isOpen: Mock; openPids: Mock }
  captchaBalance: Mock
  datasource: {
    summary: Mock
    reload: Mock
    available: boolean
    error: string
    path: string
  }
}

function makeDeps(): MockDeps {
  return {
    db: {
      listRunsForDate: vi.fn().mockResolvedValue([
        { id: 1, profileId: 1, taskKey: 't1', date: '2026-08-28', status: 'success', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口1' },
        { id: 2, profileId: 1, taskKey: 't2', date: '2026-08-28', status: 'failed', attempts: 2, error: 'boom', screenshot: 's.png', startedAt: null, finishedAt: null, profileName: '窗口1' },
      ]),
      listProfiles: vi.fn().mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 1 }]),
      captchaStats: vi.fn().mockResolvedValue({ count: 5, totalCost: 230 }),
      setProfileEnabled: vi.fn().mockResolvedValue(undefined),
      resetCircuitBreaker: vi.fn().mockResolvedValue(undefined),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
      setTaskEnabled: vi.fn().mockResolvedValue(undefined),
      getOpenWindow: vi.fn().mockResolvedValue(null),
      setOpenWindow: vi.fn().mockResolvedValue(undefined),
      clearOpenWindow: vi.fn().mockResolvedValue(undefined),
      countInFlightRuns: vi.fn().mockResolvedValue(0),
      createBatch: vi.fn().mockResolvedValue({ id: 88, kind: 'bulk', taskKey: 't1', source: 'trigger-all', createdAt: '2026-09-04 09:00:00.000' }),
      getBatch: vi.fn().mockResolvedValue({ id: 2, kind: 'bulk', taskKey: 't1', source: 'trigger-all', createdAt: '2026-09-04 09:00:00.000' }),
      listBatchesForRange: vi.fn().mockResolvedValue([]),
      listRunsForBatch: vi.fn().mockResolvedValue([]),
      listUnbatchedRuns: vi.fn().mockResolvedValue([]),
      listSchedules: vi.fn().mockResolvedValue([]),
      getSchedule: vi.fn().mockResolvedValue(null),
      createSchedule: vi.fn().mockResolvedValue(null),
      updateSchedule: vi.fn().mockResolvedValue(null),
      deleteSchedule: vi.fn().mockResolvedValue(true),
    },
    enqueuer: { enqueue: vi.fn(), hasTaskInFlight: vi.fn().mockReturnValue(false), pendingCount: vi.fn().mockReturnValue(0) },
    scheduler: { runNow: vi.fn().mockResolvedValue({ taskKeys: ['t1'], skipped: [] }) },
    tasks: new Map([['t1', { meta: { key: 't1', name: '任务1', url: '', wallet: 'metamask' } }]]),
    cfg: {
      web: { port: 3000 },
      storage: { screenshotDir: 'D:/StudySpace/AutoBitControl/data/screenshots' },
      bitbrowser: { apiBase: 'http://127.0.0.1:9999' },
      execution: { staggerMaxSec: 120, circuitBreakerThreshold: 2, probeUrl: 'https://probe.io' },
      scheduler: { timezone: 'Asia/Shanghai' },
      captcha: { clientKey: 'test-secret-key-abc123' },
    },
    bitbrowser: {
      health: vi.fn().mockResolvedValue(true),
      sync: vi.fn().mockResolvedValue(3),
      openBrowser: vi.fn().mockResolvedValue({ http: '127.0.0.1:61234', ws: '' }),
      closeBrowser: vi.fn().mockResolvedValue(undefined),
      isOpen: vi.fn().mockResolvedValue(false),
      openPids: vi.fn().mockResolvedValue(new Set()),
    },
    captchaBalance: vi.fn().mockResolvedValue({ points: 98210 }),
    datasource: {
      summary: vi.fn().mockReturnValue({ rows: 2, columns: ['窗口', '邮箱'] }),
      reload: vi.fn().mockResolvedValue(undefined),
      available: true,
      error: '',
      path: 'D:/StudySpace/AutoBitControl/config/accounts.xlsx',
    },
  }
}

describe('server API（RESTful + envelope）', () => {
  describe('batches API', () => {
    it('GET /api/batches 返回批次列表与全局数字', async () => {
      const deps = makeDeps()
      deps.db.listBatchesForRange.mockResolvedValue([
        { id: 2, kind: 'bulk', taskKey: 't1', source: 'trigger-all', createdAt: '2026-09-04 09:00:00.000', stats: { total: 2, success: 1, failed: 1, captchaFailed: 0, skipped: 0, running: 0, pending: 0 } },
      ])
      deps.db.listUnbatchedRuns.mockResolvedValue([{ id: 9, profileId: 1, taskKey: 't2', date: '2026-09-04', slot: 0, status: 'success', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, batchId: null, profileName: '窗口1', bitbrowserId: 'bb-1' }])
      deps.db.countInFlightRuns.mockResolvedValue(3)
      const res = await request(createApp(deps as never)).get('/api/batches?range=today')
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(0)
      expect(res.body.data.batches).toHaveLength(1)
      expect(res.body.data.batches[0].id).toBe(2)
      expect(res.body.data.batches[0].stats.failed).toBe(1)
      expect(res.body.data.unbatched).toHaveLength(1)
      expect(res.body.data.running).toBeGreaterThan(0)
      expect(res.body.data.captchaToday).toEqual({ count: 5, totalCost: 230 })
      expect(res.body.data.taskNames).toEqual({ t1: '任务1' })
    })

    it('GET /api/batches 默认 range=today', async () => {
      const deps = makeDeps()
      await request(createApp(deps as never)).get('/api/batches')
      expect(deps.db.listBatchesForRange).toHaveBeenCalledWith(expect.any(String), expect.any(String))
    })

    it('GET /api/batches?range=7d 与 all 计算不同下界', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-04T12:00:00'))
      try {
        const deps = makeDeps()
        await request(createApp(deps as never)).get('/api/batches?range=7d')
        // 7d = 6 天前（非今天）：2026-09-04 往前 6 天为 2026-08-29（本地日历运算，与时区无关）
        expect(deps.db.listBatchesForRange.mock.calls[0][0]).toBe('2026-08-29')
        await request(createApp(deps as never)).get('/api/batches?range=all')
        expect(deps.db.listBatchesForRange.mock.calls[1][0]).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('GET /api/batches/:id 返回批次明细并附加 durationSec/inFlight', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([
        { id: 1, profileId: 1, taskKey: 't1', date: '2026-09-04', slot: 0, status: 'success', attempts: 1, error: null, screenshot: null, startedAt: '2026-09-04 09:00:00.000', finishedAt: '2026-09-04 09:01:05.000', batchId: 2, profileName: '窗口1', bitbrowserId: 'bb-1' },
      ])
      deps.db.countInFlightRuns.mockResolvedValue(0)
      const res = await request(createApp(deps as never)).get('/api/batches/2')
      expect(res.status).toBe(200)
      expect(res.body.data.runs[0].durationSec).toBe(65)
      expect(res.body.data.runs[0].inFlight).toBe(false)
      expect(res.body.data.runs[0].bitbrowserId).toBe('bb-1')
    })

    it('GET /api/batches/abc 返回 400（业务码 40000）', async () => {
      const res = await request(createApp(makeDeps() as never)).get('/api/batches/abc')
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(40000)
      expect(res.body.message).toBe('批次 id 必须为正整数')
    })

    it('GET /api/batches/999 批次不存在返回 404（业务码 40405）', async () => {
      const deps = makeDeps()
      deps.db.getBatch.mockResolvedValue(null)
      const res = await request(createApp(deps as never)).get('/api/batches/999')
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(40405)
    })
  })

  describe('schedules API', () => {
    const row = {
      id: 1, name: '每日签到', enabled: 1, mode: 'daily' as const,
      config: '{"times":["09:00"]}', taskKeys: '["t1"]',
      createdAt: '2026-09-04 00:00:00.000', updatedAt: '2026-09-04 00:00:00.000',
    }

    it('GET /api/schedules 返回视图（taskNames/ruleText/nextRun 已计算）', async () => {
      const deps = makeDeps()
      deps.db.listSchedules.mockResolvedValue([row])
      const res = await request(createApp(deps as never)).get('/api/schedules')
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(0)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0]).toMatchObject({ id: 1, name: '每日签到', enabled: true, mode: 'daily', taskKeys: ['t1'], taskNames: ['任务1'], ruleText: '09:00' })
      expect(res.body.data[0].nextRun).toBeTruthy()
    })

    it('POST /api/schedules 合法配置创建成功', async () => {
      const deps = makeDeps()
      deps.db.createSchedule.mockResolvedValue(row)
      const res = await request(createApp(deps as never))
        .post('/api/schedules')
        .send({ name: '每日签到', mode: 'daily', config: { times: ['09:00'] }, taskKeys: ['t1'] })
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(0)
      expect(deps.db.createSchedule).toHaveBeenCalledWith({ name: '每日签到', mode: 'daily', config: '{"times":["09:00"]}', taskKeys: '["t1"]' })
    })

    it('POST /api/schedules 非法配置/未知任务 400', async () => {
      const deps = makeDeps()
      const cases = [
        { name: '', mode: 'daily', config: { times: ['09:00'] }, taskKeys: ['t1'] },
        { name: 'x', mode: 'daily', config: { times: ['25:00'] }, taskKeys: ['t1'] },
        { name: 'x', mode: 'daily', config: { times: ['09:00'] }, taskKeys: ['ghost'] },
        { name: 'x', mode: 'bogus', config: { times: ['09:00'] }, taskKeys: ['t1'] },
      ]
      for (const body of cases) {
        const res = await request(createApp(deps as never)).post('/api/schedules').send(body)
        expect(res.status).toBe(400)
        expect(res.body.code).toBe(40000)
      }
      expect(deps.db.createSchedule).not.toHaveBeenCalled()
    })

    it('PATCH /api/schedules/:id 部分更新；不存在 404（40406）', async () => {
      const deps = makeDeps()
      deps.db.getSchedule.mockResolvedValue(row)
      deps.db.updateSchedule.mockResolvedValue({ ...row, enabled: 0 })
      const res = await request(createApp(deps as never)).patch('/api/schedules/1').send({ enabled: false })
      expect(res.status).toBe(200)
      expect(res.body.data.enabled).toBe(false)
      expect(deps.db.updateSchedule).toHaveBeenCalledWith(1, { enabled: false })

      deps.db.getSchedule.mockResolvedValue(null)
      const miss = await request(createApp(deps as never)).patch('/api/schedules/99').send({ enabled: true })
      expect(miss.status).toBe(404)
      expect(miss.body.code).toBe(40406)
    })

    it('DELETE /api/schedules/:id 成功与 404', async () => {
      const deps = makeDeps()
      deps.db.deleteSchedule.mockResolvedValue(true)
      const ok = await request(createApp(deps as never)).delete('/api/schedules/1')
      expect(ok.status).toBe(200)
      expect(ok.body.code).toBe(0)

      deps.db.deleteSchedule.mockResolvedValue(false)
      const miss = await request(createApp(deps as never)).delete('/api/schedules/99')
      expect(miss.status).toBe(404)
      expect(miss.body.code).toBe(40406)
    })

    it('POST /api/schedules/:id/run 成功转发 runNow；停用 409（40903）', async () => {
      const deps = makeDeps()
      deps.db.getSchedule.mockResolvedValue(row)
      const ok = await request(createApp(deps as never)).post('/api/schedules/1/run').send({})
      expect(ok.status).toBe(200)
      expect(deps.scheduler.runNow).toHaveBeenCalledWith(row)

      deps.db.getSchedule.mockResolvedValue({ ...row, enabled: 0 })
      const disabled = await request(createApp(deps as never)).post('/api/schedules/1/run').send({})
      expect(disabled.status).toBe(409)
      expect(disabled.body.code).toBe(40903)
    })
  })

  it('GET /api/tasks 返回任务元信息列表', async () => {    const res = await request(createApp(makeDeps() as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    expect(res.body.data[0].key).toBe('t1')
    expect(res.body.data[0].wallet).toBe('metamask')
  })

  it('GET /api/tasks 返回任务级并发（meta 未写时缺省 4）', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    expect(res.body.data[0].concurrency).toBe(4)
  })

  it('GET /api/tasks meta 显式写并发时透传该值', async () => {
    const deps = makeDeps()
    deps.tasks.set('t2', { meta: { key: 't2', name: '任务2', url: '', wallet: 'petra', concurrency: 2 } })
    const res = await request(createApp(deps as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    const t2 = res.body.data.find((t: { key: string }) => t.key === 't2')
    expect(t2.concurrency).toBe(2)
  })

  it('POST /api/tasks/:key/trigger 创建批次并入队（带 batchId）', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(deps.db.createBatch).toHaveBeenCalledWith('bulk', 't1', 'trigger-all')
    expect(deps.enqueuer.enqueue).toHaveBeenCalled()
    expect(deps.enqueuer.enqueue.mock.calls[0][2]).toEqual({ batchId: 88 })
  })

  it('单窗口触发创建 single 批次', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ bitbrowserId: 'bb-1' })
    expect(res.status).toBe(200)
    expect(deps.db.createBatch).toHaveBeenCalledWith('single', 't1', 'trigger-single')
    expect(deps.enqueuer.enqueue.mock.calls[0][2]).toEqual({ immediate: true, batchId: 88 })
  })

  it('触发任务存在在途 run 返回 409（业务码 40902）', async () => {
    const deps = makeDeps()
    deps.db.countInFlightRuns.mockResolvedValue(1)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(40902)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('触发任务队列内存态在途返回 409', async () => {
    const deps = makeDeps()
    deps.enqueuer.hasTaskInFlight.mockReturnValue(true)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('单窗口触发该窗口在途返回 409', async () => {
    const deps = makeDeps()
    deps.db.countInFlightRuns.mockImplementation((_k: string, _d: string, pid?: number) => Promise.resolve(pid === 1 ? 1 : 0))
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ bitbrowserId: 'bb-1' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(40902)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('GET /api/tasks 附加 inFlight（DB 在途与队列在途任一命中）', async () => {
    const deps = makeDeps()
    deps.db.countInFlightRuns.mockResolvedValue(2)
    const res = await request(createApp(deps as never)).get('/api/tasks')
    expect(res.body.data[0].inFlight).toBe(true)
    deps.db.countInFlightRuns.mockResolvedValue(0)
    deps.enqueuer.hasTaskInFlight.mockReturnValue(true)
    const res2 = await request(createApp(deps as never)).get('/api/tasks')
    expect(res2.body.data[0].inFlight).toBe(true)
  })

  it('POST /api/tasks/:key/trigger 缺参数 404 或 400', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/tasks/nope/trigger').send({})
    expect([400, 404]).toContain(res.status)
    expect(res.body.code).not.toBe(0)
  })

  it('PATCH /api/tasks/:key 写入本地库任务开关并返回 key/enabled', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/tasks/t1').send({ enabled: false })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ key: 't1', enabled: false })
    expect(deps.db.setTaskEnabled).toHaveBeenCalledWith('t1', false)
  })

  it('PATCH /api/tasks/:key 非布尔 enabled 返回 400', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/tasks/t1').send({ enabled: 'no' })
    expect(res.status).toBe(400)
    expect(res.body.code).not.toBe(0)
  })

  it('PATCH /api/tasks/:key 未知任务返回 404', async () => {
    const res = await request(createApp(makeDeps() as never)).patch('/api/tasks/nope').send({ enabled: true })
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
  })

  it('停用任务触发返回 409（本地库开关覆盖为 false）', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(res.body.message).toContain('停用')
  })

  it('PATCH /api/profiles/:id 修改启用状态', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/profiles/1').send({ enabled: false })
    expect(res.body.code).toBe(0)
    expect(deps.db.setProfileEnabled).toHaveBeenCalledWith(1, false)
  })

  it('PATCH /api/profiles/:id 忽略 password 字段（仅处理 enabled）', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/profiles/1').send({ password: 'secret' })
    expect(res.body.code).toBe(0)
    expect(deps.db.setProfileEnabled).not.toHaveBeenCalled()
  })

  it('POST /api/profiles/:id/breaker/reset 重置熔断', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/1/breaker/reset')
    expect(res.body.code).toBe(0)
    expect(deps.db.resetCircuitBreaker).toHaveBeenCalledWith(1)
  })

  it('GET /api/profiles 返回 open 字段（批量 pid 探测，无登记为 false）', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).get('/api/profiles')
    expect(res.body.code).toBe(0)
    expect(res.body.data[0].open).toBe(false)
    expect(deps.bitbrowser.openPids).toHaveBeenCalledWith(['bb-1'])
  })

  it('GET /api/profiles 登记且 pid 存活返回 open=true', async () => {
    const deps = makeDeps()
    deps.db.getOpenWindow.mockResolvedValue({ http: '127.0.0.1:61234' })
    deps.bitbrowser.openPids.mockResolvedValue(new Set(['bb-1']))
    const res = await request(createApp(deps as never)).get('/api/profiles')
    expect(res.body.data[0].open).toBe(true)
    expect(deps.db.clearOpenWindow).not.toHaveBeenCalled()
  })

  it('GET /api/profiles 登记但 pid 已死自动清行并返回 false', async () => {
    const deps = makeDeps()
    deps.db.getOpenWindow.mockResolvedValue({ http: '127.0.0.1:61234' })
    const res = await request(createApp(deps as never)).get('/api/profiles')
    expect(res.body.data[0].open).toBe(false)
    expect(deps.db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('POST /api/profiles/:id/open 调 openBrowser 并登记 open_windows', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/1/open')
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ already: false })
    expect(deps.bitbrowser.openBrowser).toHaveBeenCalledWith('bb-1')
    expect(deps.db.setOpenWindow).toHaveBeenCalledWith('bb-1', '127.0.0.1:61234')
  })

  it('POST /api/profiles/:id/open 已打开返回 already 且不重复开窗', async () => {
    const deps = makeDeps()
    deps.db.getOpenWindow.mockResolvedValue({ http: '127.0.0.1:61234' })
    deps.bitbrowser.isOpen.mockResolvedValue(true)
    const res = await request(createApp(deps as never)).post('/api/profiles/1/open')
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ already: true })
    expect(deps.bitbrowser.openBrowser).not.toHaveBeenCalled()
  })

  it('POST /api/profiles/:id/open 未知窗口 404', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/999/open')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40402)
  })

  it('POST /api/profiles/:id/close 清登记并调 closeBrowser', async () => {
    const deps = makeDeps()
    deps.db.getOpenWindow.mockResolvedValue({ http: '127.0.0.1:61234' })
    const res = await request(createApp(deps as never)).post('/api/profiles/1/close')
    expect(res.body.code).toBe(0)
    expect(deps.bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(deps.db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('POST /api/profiles/:id/close 无登记也调一次 closeBrowser', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/1/close')
    expect(res.body.code).toBe(0)
    expect(deps.bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(deps.db.clearOpenWindow).not.toHaveBeenCalled()
  })

  it('POST /api/bitbrowser/test 返回连接状态', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/bitbrowser/test')
    expect(res.body.code).toBe(0)
    expect(res.body.data.ok).toBe(true)
  })

  it('POST /api/bitbrowser/sync 返回同步数量', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/bitbrowser/sync')
    expect(res.body.code).toBe(0)
    expect(res.body.data.count).toBe(3)
    expect(deps.bitbrowser.sync).toHaveBeenCalledTimes(1)
  })

  it('buildBitbrowserDeps.sync 拉取窗口列表并逐窗口 upsert', async () => {
    const db = { upsertProfile: vi.fn() }
    const client = {
      health: vi.fn().mockResolvedValue(true),
      listBrowsers: vi.fn().mockResolvedValue([
        { id: 'b1', name: '窗口1' },
        { id: 'b2', name: '窗口2' },
        { id: 'b3', name: '窗口3' },
      ]),
    }
    const deps = buildBitbrowserDeps(client as never, db as never)
    expect(await deps.sync()).toBe(3)
    expect(client.listBrowsers).toHaveBeenCalledWith(0, 100)
    expect(db.upsertProfile).toHaveBeenCalledTimes(3)
    expect(db.upsertProfile).toHaveBeenCalledWith('b1', '窗口1', { id: 'b1', name: '窗口1' })
    expect(await deps.health()).toBe(true)
  })

  it('buildBitbrowserDeps.sync 超过一页时翻页同步直到不足整页', async () => {
    const db = { upsertProfile: vi.fn() }
    const page0 = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, name: `窗口${i}` }))
    const page1 = Array.from({ length: 7 }, (_, i) => ({ id: `b${100 + i}`, name: `窗口${100 + i}` }))
    const client = {
      health: vi.fn().mockResolvedValue(true),
      listBrowsers: vi.fn().mockResolvedValueOnce(page0).mockResolvedValueOnce(page1),
    }
    const deps = buildBitbrowserDeps(client as never, db as never)
    expect(await deps.sync()).toBe(107)
    expect(client.listBrowsers).toHaveBeenNthCalledWith(1, 0, 100)
    expect(client.listBrowsers).toHaveBeenNthCalledWith(2, 1, 100)
    expect(db.upsertProfile).toHaveBeenCalledTimes(107)
  })

  it('GET /api/captcha/balance 返回点数', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/captcha/balance')
    expect(res.body.code).toBe(0)
    expect(res.body.data.points).toBe(98210)
    expect(res.body.data.yuan).toBeCloseTo(98.21)
  })

  it('GET /api/settings 返回非敏感配置且不含 clientKey', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).get('/api/settings')
    expect(res.body.code).toBe(0)
    expect(res.body.data.bitbrowserApiBase).toBeTruthy()
    expect(res.body.data.circuitBreakerThreshold).toBeTypeOf('number')
    expect(JSON.stringify(res.body.data)).not.toContain('clientKey')
    expect(JSON.stringify(res.body.data)).not.toContain('test-secret-key-abc123')
    expect(JSON.stringify(res.body.data)).not.toContain('password')
  })

  it('GET /api/settings 含 datasource 字段（available/error/path/rows/columns）', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).get('/api/settings')
    expect(res.body.code).toBe(0)
    expect(res.body.data.datasource.available).toBe(true)
    expect(res.body.data.datasource.error).toBe('')
    expect(res.body.data.datasource.path).toContain('accounts.xlsx')
    expect(res.body.data.datasource.rows).toBe(2)
    expect(res.body.data.datasource.columns).toEqual(['窗口', '邮箱'])
    expect(deps.datasource.summary).toHaveBeenCalled()
  })

  it('POST /api/datasource/reload 调用 reload 并返回最新摘要', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/datasource/reload')
    expect(res.body.code).toBe(0)
    expect(deps.datasource.reload).toHaveBeenCalledTimes(1)
    expect(res.body.data.available).toBe(true)
    expect(res.body.data.rows).toBe(2)
    expect(res.body.data.columns).toEqual(['窗口', '邮箱'])
  })

  it('GET /api/screenshots 拒绝目录穿越', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/screenshots').query({ path: 'C:/windows/win.ini' })
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
  })

  it('GET /api/screenshots 拒绝符号链接逃逸（realpath 前缀校验）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-shots-'))
    try {
      const root = join(dir, 'screenshots')
      const outside = join(dir, 'outside')
      mkdirSync(root)
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      // junction：Windows 下无需管理员权限的目录符号链接，指向截图根目录之外
      symlinkSync(outside, join(root, 'link'), 'junction')
      const deps = makeDeps()
      deps.cfg.storage.screenshotDir = root
      const res = await request(createApp(deps as never)).get('/api/screenshots').query({ path: join(root, 'link', 'secret.txt') })
      expect(res.status).toBe(404)
      expect(res.body.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('GET /api/docs/guide 返回手册 markdown', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/guide')
    expect(res.body.code).toBe(0)
    expect(res.body.data.content).toContain('# AutoBitControl API 使用手册')
  })

  it('GET /api/docs/examples 返回示例清单', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/examples')
    expect(res.body.code).toBe(0)
    expect(res.body.data.length).toBeGreaterThanOrEqual(3)
  })

  it('GET /api/docs/examples/:name 返回源码', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/examples/example-checkin.ts')
    expect(res.body.code).toBe(0)
    expect(res.body.data.content).toContain('class')
  })

  it('GET /api/docs/examples/:name 白名单拒绝穿越', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/examples/..%2F..%2Fpackage.json')
    expect([400, 404]).toContain(res.status)
    expect(res.body.code).not.toBe(0)
  })

  it('GET / 返回 404（后端只出 API，面板由 Vite dev server 提供）', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/')
    expect(res.status).toBe(404)
  })

  it('未知路由 404 统一 envelope', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/no-such')
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
    expect(res.body.message).toBeTruthy()
  })
})

describe('OpenAPI 文档与统一错误码', () => {
  it('GET /api/docs/openapi.json 返回合法 OpenAPI spec', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/openapi.json')
    expect(res.status).toBe(200)
    expect(res.body.openapi).toMatch(/^3\.0/)
    expect(res.body.info.title).toBe('AutoBitControl API')
    expect(Object.keys(res.body.paths)).toContain('/api/tasks')
  })

  it('openapi.json 覆盖全部业务接口路径', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/openapi.json')
    const paths = Object.keys(res.body.paths)
    const expected = [
      '/api/batches',
      '/api/batches/{id}',
      '/api/tasks',
      '/api/tasks/{key}',
      '/api/tasks/{key}/trigger',
      '/api/profiles',
      '/api/profiles/{id}',
      '/api/profiles/{id}/open',
      '/api/profiles/{id}/close',
      '/api/profiles/{id}/breaker/reset',
      '/api/captcha/balance',
      '/api/bitbrowser/test',
      '/api/bitbrowser/sync',
      '/api/settings',
      '/api/datasource/reload',
      '/api/screenshots',
      '/api/docs/guide',
      '/api/docs/examples',
      '/api/docs/examples/{name}',
    ]
    for (const p of expected) expect(paths).toContain(p)
  })

  it('GET /api-docs/ 返回 swagger-ui 页面', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api-docs/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('swagger-ui')
  })

  it('任务不存在返回业务码 40401', async () => {
    const res = await request(createApp(makeDeps() as never)).patch('/api/tasks/nope').send({ enabled: true })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40401)
  })

  it('窗口不存在返回业务码 40402', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/profiles/999/open')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40402)
  })

  it('停用任务触发返回业务码 40901', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(40901)
  })

  it('截图缺失返回业务码 40403', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/screenshots').query({ path: 'no-such.png' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40403)
  })

  it('示例白名单外返回业务码 40404', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/examples/nope.ts')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40404)
  })

  it('未知路由 404 返回业务码 40400', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/no-such')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40400)
  })
})

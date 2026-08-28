import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server/app'

type Mock = ReturnType<typeof vi.fn>

interface MockDeps {
  db: {
    listRunsForDate: Mock
    listProfiles: Mock
    captchaStats: Mock
    setProfileEnabled: Mock
    setProfileWalletPassword: Mock
    resetCircuitBreaker: Mock
  }
  enqueuer: { enqueue: Mock }
  tasks: Map<string, { meta: { key: string; name: string; url: string; wallet: string; schedule: string } }>
  cfg: { web: { port: number }; storage: { screenshotDir: string } }
  bitbrowser: { health: Mock }
  captchaBalance: Mock
}

function makeDeps(): MockDeps {
  return {
    db: {
      listRunsForDate: vi.fn().mockReturnValue([
        { id: 1, profileId: 1, taskKey: 't1', date: '2026-08-28', status: 'success', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口1' },
        { id: 2, profileId: 1, taskKey: 't2', date: '2026-08-28', status: 'failed', attempts: 2, error: 'boom', screenshot: 's.png', startedAt: null, finishedAt: null, profileName: '窗口1' },
      ]),
      listProfiles: vi.fn().mockReturnValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 1 }]),
      captchaStats: vi.fn().mockReturnValue({ count: 5, totalCost: 230 }),
      setProfileEnabled: vi.fn(),
      setProfileWalletPassword: vi.fn(),
      resetCircuitBreaker: vi.fn(),
    },
    enqueuer: { enqueue: vi.fn() },
    tasks: new Map([['t1', { meta: { key: 't1', name: '任务1', url: '', wallet: 'metamask', schedule: '0 9 * * *' } }]]),
    cfg: { web: { port: 3000 }, storage: { screenshotDir: 'D:/StudySpace/AutoBitControl/data/screenshots' } },
    bitbrowser: { health: vi.fn().mockResolvedValue(true) },
    captchaBalance: vi.fn().mockResolvedValue({ points: 98210 }),
  }
}

describe('server API（RESTful + envelope）', () => {
  it('GET /api/dashboard 返回 {code:0,data:{stats,runs,profiles,...}}', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/dashboard?date=2026-08-28')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.stats.success).toBe(1)
    expect(res.body.data.stats.failed).toBe(1)
    expect(res.body.data.runs).toHaveLength(2)
    expect(res.body.data.captcha.totalCost).toBe(230)
  })

  it('GET /api/tasks 返回任务元信息列表', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    expect(res.body.data[0].key).toBe('t1')
    expect(res.body.data[0].wallet).toBe('metamask')
  })

  it('POST /api/tasks/:key/trigger 入队', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ bitbrowserId: 'bb-1' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(deps.enqueuer.enqueue).toHaveBeenCalled()
  })

  it('POST /api/tasks/:key/trigger 缺参数 404 或 400', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/tasks/nope/trigger').send({})
    expect([400, 404]).toContain(res.status)
    expect(res.body.code).not.toBe(0)
  })

  it('PATCH /api/profiles/:id 修改启用状态', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/profiles/1').send({ enabled: false })
    expect(res.body.code).toBe(0)
    expect(deps.db.setProfileEnabled).toHaveBeenCalledWith(1, false)
  })

  it('PATCH /api/profiles/:id 保存钱包密码', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/profiles/1').send({ password: 'secret' })
    expect(res.body.code).toBe(0)
    expect(deps.db.setProfileWalletPassword).toHaveBeenCalledWith(1, 'secret')
  })

  it('POST /api/profiles/:id/run 入队全部任务', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/1/run')
    expect(res.body.code).toBe(0)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 't1')
  })

  it('POST /api/profiles/:id/breaker/reset 重置熔断', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/1/breaker/reset')
    expect(res.body.code).toBe(0)
    expect(deps.db.resetCircuitBreaker).toHaveBeenCalledWith(1)
  })

  it('POST /api/runs/rerun-failed 重跑失败', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/runs/rerun-failed').send({ date: '2026-08-28' })
    expect(res.body.code).toBe(0)
    expect(res.body.data.count).toBe(1)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
  })

  it('POST /api/bitbrowser/test 返回连接状态', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/bitbrowser/test')
    expect(res.body.code).toBe(0)
    expect(res.body.data.ok).toBe(true)
  })

  it('GET /api/captcha/balance 返回点数', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/captcha/balance')
    expect(res.body.code).toBe(0)
    expect(res.body.data.points).toBe(98210)
    expect(res.body.data.yuan).toBeCloseTo(98.21)
  })

  it('GET /api/screenshots 拒绝目录穿越', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/screenshots').query({ path: 'C:/windows/win.ini' })
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
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

  it('GET / 返回面板页面', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('AutoBitControl')
  })

  it('未知路由 404 统一 envelope', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/no-such')
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
    expect(res.body.message).toBeTruthy()
  })
})

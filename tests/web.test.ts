import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/web/server'

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
  cfg: { web: { port: number }, storage: { screenshotDir: string } }
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
      captchaStats: vi.fn().mockReturnValue({ count: 5, totalCost: 0.23 }),
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

describe('web panel API', () => {
  it('GET /api/dashboard 返回统计与矩阵数据', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).get('/api/dashboard?date=2026-08-28')
    expect(res.status).toBe(200)
    expect(res.body.stats.success).toBe(1)
    expect(res.body.stats.failed).toBe(1)
    expect(res.body.stats.total).toBe(2)
    expect(res.body.runs).toHaveLength(2)
    expect(res.body.captcha.totalCost).toBeCloseTo(0.23)
    expect(res.body.profilesEnabled).toBe(1)
  })

  it('POST /api/trigger 入队执行', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/trigger').send({ taskKey: 't1', bitbrowserId: 'bb-1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(deps.enqueuer.enqueue).toHaveBeenCalled()
  })

  it('POST /api/trigger 缺参数返回 400', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).post('/api/trigger').send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/profile/:id/toggle 切换启用', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/toggle').send({ enabled: false })
    expect(res.status).toBe(200)
    expect(deps.db.setProfileEnabled).toHaveBeenCalledWith(1, false)
  })

  it('POST /api/profile/:id/run 将该窗口全部任务入队', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/run')
    expect(res.status).toBe(200)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 't1')
  })

  it('POST /api/profile/:id/password 保存解锁密码', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/password').send({ password: 'secret' })
    expect(res.status).toBe(200)
    expect(deps.db.setProfileWalletPassword).toHaveBeenCalledWith(1, 'secret')
  })

  it('POST /api/profile/:id/reset-breaker 重置熔断', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/reset-breaker')
    expect(res.status).toBe(200)
    expect(deps.db.resetCircuitBreaker).toHaveBeenCalledWith(1)
  })

  it('POST /api/bitbrowser/test 返回连接状态', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).post('/api/bitbrowser/test')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('GET /api/captcha/balance 返回点数', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).get('/api/captcha/balance')
    expect(res.status).toBe(200)
    expect(res.body.points).toBe(98210)
    expect(res.body.yuan).toBeCloseTo(98.21)
  })

  it('GET /api/screenshot 拒绝目录穿越', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).get('/api/screenshot').query({ path: 'C:/windows/win.ini' })
    expect(res.status).toBe(404)
  })

  it('GET / 返回面板页面', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('AutoBitControl')
    expect(res.text).toContain('窗口管理')
  })
})

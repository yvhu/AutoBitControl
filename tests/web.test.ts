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
  }
  enqueuer: { enqueue: Mock }
  tasks: Map<string, { meta: { key: string; name: string; url: string; wallet: string; schedule: string; enabled?: boolean } }>
  cfg: {
    web: { port: number }
    storage: { screenshotDir: string }
    bitbrowser: { apiBase: string }
    execution: { timezone: string; concurrency: number; circuitBreakerThreshold: number; probeUrl: string }
    captcha: { clientKey: string }
  }
  bitbrowser: { health: Mock; sync: Mock }
  captchaBalance: Mock
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
    },
    enqueuer: { enqueue: vi.fn() },
    tasks: new Map([['t1', { meta: { key: 't1', name: '任务1', url: '', wallet: 'metamask', schedule: '0 9 * * *' } }]]),
    cfg: {
      web: { port: 3000 },
      storage: { screenshotDir: 'D:/StudySpace/AutoBitControl/data/screenshots' },
      bitbrowser: { apiBase: 'http://127.0.0.1:9999' },
      execution: { timezone: 'Asia/Shanghai', concurrency: 6, circuitBreakerThreshold: 2, probeUrl: 'https://probe.io' },
      captcha: { clientKey: 'test-secret-key-abc123' },
    },
    bitbrowser: { health: vi.fn().mockResolvedValue(true), sync: vi.fn().mockResolvedValue(3) },
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

  it('PATCH /api/tasks/:key 已移除（任务开关改为纯代码）', async () => {
    const res = await request(createApp(makeDeps() as never)).patch('/api/tasks/t1').send({ enabled: false })
    expect(res.status).toBe(404)
  })

  it('停用任务触发返回 409', async () => {
    const deps = makeDeps()
    deps.tasks.set('t1', { meta: { key: 't1', name: '任务1', url: '', wallet: 'metamask', schedule: '0 9 * * *', enabled: false } })
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(res.body.message).toContain('停用')
  })

  it('窗口立即跑排除停用任务', async () => {
    const deps = makeDeps()
    deps.tasks.set('t1', { meta: { key: 't1', name: '任务1', url: '', wallet: 'metamask', schedule: '0 9 * * *', enabled: false } })
    const res = await request(createApp(deps as never)).post('/api/profiles/1/run')
    expect(res.body.code).toBe(0)
    expect(res.body.data.count).toBe(0)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
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

  it('POST /api/runs/rerun-failed 重跑失败（failed 行入队一次）', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/runs/rerun-failed').send({ date: '2026-08-28' })
    expect(res.body.code).toBe(0)
    expect(res.body.data.count).toBe(1)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
  })

  it('POST /api/runs/rerun-failed 无失败记录返回 count 0', async () => {
    const deps = makeDeps()
    ;(deps.db.listRunsForDate as Mock).mockResolvedValue([
      { id: 1, profileId: 1, taskKey: 't1', date: '2026-08-28', status: 'success', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口1' },
    ])
    const res = await request(createApp(deps as never)).post('/api/runs/rerun-failed').send({ date: '2026-08-28' })
    expect(res.body.code).toBe(0)
    expect(res.body.data.count).toBe(0)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
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
    expect(db.upsertProfile).toHaveBeenCalledWith('b1', '窗口1')
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

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
  bitbrowser: { health: Mock; sync: Mock; openBrowser: Mock; closeBrowser: Mock; isOpen: Mock; openPids: Mock }
  captchaBalance: Mock
  datasource: {
    summary: Mock
    reload: Mock
    available: boolean
    error: string
    path: string
  }
  onToggle: Mock
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
    onToggle: vi.fn(),
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

  it('PATCH /api/tasks/:key 写入云端任务开关并返回 key/enabled', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/tasks/t1').send({ enabled: false })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ key: 't1', enabled: false })
    expect(deps.db.setTaskEnabled).toHaveBeenCalledWith('t1', false)
    expect(deps.onToggle).toHaveBeenCalledWith('t1', false)
  })

  it('PATCH /api/tasks/:key 非布尔 enabled 返回 400', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/tasks/t1').send({ enabled: 'no' })
    expect(res.status).toBe(400)
    expect(res.body.code).not.toBe(0)
    expect(deps.onToggle).not.toHaveBeenCalled()
  })

  it('PATCH /api/tasks/:key 未知任务返回 404', async () => {
    const res = await request(createApp(makeDeps() as never)).patch('/api/tasks/nope').send({ enabled: true })
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
  })

  it('停用任务触发返回 409（云端开关覆盖为 false）', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(409)
    expect(res.body.message).toContain('停用')
  })

  it('窗口立即跑排除停用任务（云端开关覆盖为 false）', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
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
      '/api/dashboard',
      '/api/tasks',
      '/api/tasks/{key}',
      '/api/tasks/{key}/trigger',
      '/api/profiles',
      '/api/profiles/{id}',
      '/api/profiles/{id}/run',
      '/api/profiles/{id}/open',
      '/api/profiles/{id}/close',
      '/api/profiles/{id}/breaker/reset',
      '/api/runs/rerun-failed',
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
    const res = await request(createApp(makeDeps() as never)).post('/api/profiles/999/run')
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

import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { toolsRouter } from '../src/server/routes/tools'
import { errorHandler } from '../src/server/http/error'
import { ToolError } from '../src/tools/errors'
import type { Logger } from '../src/infrastructure/logger'

const statusData = {
  detected: true,
  kernel: 'mihomo',
  mixedPort: 7890,
  apiBase: 'http://127.0.0.1:9090',
  capability: { listProxies: true, delay: true, switchNode: true, providers: false, switchProfile: false },
  group: 'GLOBAL',
  currentNode: 'HK-01',
  groups: [{ name: 'GLOBAL', now: 'HK-01' }],
  subscriptions: [],
}

const testData = { group: 'GLOBAL', currentNode: 'HK-01', currentUsable: true, nodes: [] }
const optimizeData = { chosen: 'HK-02', switched: true, nodes: [] }

function makeApp() {
  const app = express()
  app.use(express.json())
  const clash = {
    service: {
      status: vi.fn().mockResolvedValue(statusData),
      test: vi.fn().mockResolvedValue(testData),
      optimize: vi.fn().mockResolvedValue(optimizeData),
      subscriptions: vi.fn().mockResolvedValue([]),
      updateSubscription: vi.fn().mockResolvedValue(undefined),
      setGroup: vi.fn(),
      profileFiles: vi.fn().mockReturnValue(['a.yaml', 'b.yaml']),
      switchProfile: vi.fn().mockResolvedValue(undefined),
    },
    auto: { status: () => ({ pace: 'normal' as const, lastCheckAt: null, allDown: false, deferredSwitches: 0 }) },
    saveGroup: vi.fn().mockResolvedValue(undefined),
    anyRunning: () => false,
  }
  const datasource = { reload: vi.fn().mockResolvedValue(undefined), summary: vi.fn().mockReturnValue({ rows: 0, columns: [] }) }
  app.use('/api', toolsRouter({ xlsxPath: 'x', datasource, clash }))
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {} } as unknown as Logger))
  return { app, clash }
}

describe('GET /api/tools', () => {
  it('工具清单含代理网络', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools')
    expect(res.body.data.tools).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'clash' })]))
  })
})

describe('GET /api/tools/clash/status', () => {
  it('返回探测状态 + 自动优化器状态', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools/clash/status')
    expect(res.body.code).toBe(0)
    expect(res.body.data.detected).toBe(true)
    expect(res.body.data.auto.pace).toBe('normal')
    expect(res.body.data.anyRunning).toBe(false)
  })
})

describe('POST /api/tools/clash/test', () => {
  it('返回测速结果', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/tools/clash/test').send({})
    expect(res.body.code).toBe(0)
    expect(res.body.data.group).toBe('GLOBAL')
  })

  it('ToolError 映射为统一失败响应', async () => {
    const { app, clash } = makeApp()
    clash.service.test.mockRejectedValueOnce(new ToolError(500, 50002, '内核不支持 delay 测速接口'))
    const res = await request(app).post('/api/tools/clash/test').send({})
    expect(res.status).toBe(500)
    expect(res.body.code).toBe(50002)
  })
})

describe('POST /api/tools/clash/optimize', () => {
  it('返回切换结果', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/tools/clash/optimize').send({})
    expect(res.body.data.switched).toBe(true)
    expect(res.body.data.chosen).toBe('HK-02')
  })
})

describe('GET /api/tools/clash/subscriptions', () => {
  it('返回订阅列表', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools/clash/subscriptions')
    expect(res.body.data.subscriptions).toEqual([])
  })
})

describe('POST /api/tools/clash/subscriptions/:name/update', () => {
  it('触发订阅更新', async () => {
    const { app, clash } = makeApp()
    const res = await request(app).post('/api/tools/clash/subscriptions/sub1/update').send({})
    expect(res.body.code).toBe(0)
    expect(clash.service.updateSubscription).toHaveBeenCalledWith('sub1')
  })
})

describe('POST /api/tools/clash/group', () => {
  it('写回配置并更新运行时分组', async () => {
    const { app, clash } = makeApp()
    const res = await request(app).post('/api/tools/clash/group').send({ group: 'GLOBAL' })
    expect(res.body.code).toBe(0)
    expect(clash.saveGroup).toHaveBeenCalledWith('GLOBAL')
    expect(clash.service.setGroup).toHaveBeenCalledWith('GLOBAL')
  })

  it('参数非法 → 400/40000', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/tools/clash/group').send({ group: '' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })
})

describe('GET /api/tools/clash/profiles', () => {
  it('返回配置目录下的订阅文件', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools/clash/profiles')
    expect(res.body.data.files).toEqual(['a.yaml', 'b.yaml'])
  })
})

describe('POST /api/tools/clash/profiles/switch', () => {
  it('切换订阅文件', async () => {
    const { app, clash } = makeApp()
    const res = await request(app).post('/api/tools/clash/profiles/switch').send({ file: 'a.yaml' })
    expect(res.body.code).toBe(0)
    expect(clash.service.switchProfile).toHaveBeenCalledWith('a.yaml')
  })
})

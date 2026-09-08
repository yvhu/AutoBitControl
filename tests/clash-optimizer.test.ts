import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClashService, scoreNode } from '../src/tools/clash/optimizer'
import type { ClashConfig } from '../src/infrastructure/config'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function makeCfg(over: Partial<ClashConfig> = {}): ClashConfig {
  return {
    enabled: true,
    apiBase: 'http://127.0.0.1:9090',
    apiSecret: '',
    group: 'GLOBAL',
    testUrls: ['https://a.com', 'https://b.com'],
    weights: [2, 1],
    maxNodes: 20,
    testConcurrency: 2,
    testTimeoutMs: 5000,
    minGainMs: 100,
    autoCheck: { enabled: true, normalIntervalMin: 30, fastIntervalMin: 2 },
    configPath: '',
    ...over,
  }
}

/** fake adapter：delay 按节点名映射返回值，switchNode/groups 记录调用 */
function makeAdapter(delayMap: Record<string, Array<{ reachable: boolean; delayMs: number }>>, opts: { groups?: unknown; switchError?: Error } = {}) {
  const switchCalls: Array<[string, string]> = []
  const adapter = {
    apiBase: 'http://127.0.0.1:9090',
    get delaySupported() { return true },
    delay: vi.fn(async (name: string, url: string) => {
      const list = delayMap[name]
      if (!list) return { supported: true, reachable: false, delayMs: 0 }
      const item = list[url === 'https://a.com' ? 0 : 1] ?? { reachable: false, delayMs: 0 }
      return { supported: true, ...item }
    }),
    switchNode: vi.fn(async (group: string, name: string) => {
      switchCalls.push([group, name])
      if (opts.switchError) throw opts.switchError
    }),
    groups: vi.fn(async () => opts.groups ?? [{ name: 'GLOBAL', now: 'HK-01', all: ['HK-01', 'HK-02'] }]),
    providers: vi.fn(async () => []),
    updateProvider: vi.fn(async () => undefined),
  }
  return { adapter, switchCalls }
}

function makeService(adapter: never, cfg: ClashConfig) {
  return new ClashService({ adapter, getCfg: () => cfg, logger: logger as never })
}

describe('scoreNode', () => {
  it('全部不可达 → 不可用，得分按惩罚计', () => {
    const urls = [
      { url: 'a', delayMs: 0, reachable: false },
      { url: 'b', delayMs: 0, reachable: false },
    ]
    expect(scoreNode(urls, [2, 1], 5000)).toEqual({ score: 15000, usable: false })
  })

  it('部分可达（白名单机场）→ 可用，得分加权', () => {
    const urls = [
      { url: 'a', delayMs: 100, reachable: true },
      { url: 'b', delayMs: 0, reachable: false },
    ]
    expect(scoreNode(urls, [2, 1], 5000)).toEqual({ score: 5200, usable: true })
  })
})

describe('ClashService.test', () => {
  it('按并发测速并按得分升序返回', async () => {
    const { adapter } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 200 }],
      'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }],
    })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.test()
    expect(r.group).toBe('GLOBAL')
    expect(r.currentNode).toBe('HK-01')
    expect(r.currentUsable).toBe(true)
    expect(r.nodes.map((n) => n.name)).toEqual(['HK-02', 'HK-01'])
    expect(r.nodes[0].score).toBeLessThan(r.nodes[1].score)
  })

  it('分组不存在 → CLASH_GROUP_NOT_FOUND', async () => {
    const { adapter } = makeAdapter({})
    const svc = makeService(adapter as never, makeCfg({ group: 'NOPE' }))
    await expect(svc.test()).rejects.toMatchObject({ status: 400, code: 40008 })
  })

  it('busy 锁：进行中再次调用 409', async () => {
    const { adapter } = makeAdapter({ 'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 200 }] })
    const svc = makeService(adapter as never, makeCfg())
    const first = svc.test()
    await expect(svc.test()).rejects.toMatchObject({ status: 409, code: 40904 })
    await first
  })
})

describe('ClashService.optimize', () => {
  it('全网不可用 → 不切换，chosen=null', async () => {
    const { adapter, switchCalls } = makeAdapter({ 'HK-01': [{ reachable: false, delayMs: 0 }, { reachable: false, delayMs: 0 }] })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.optimize()
    expect(r.switched).toBe(false)
    expect(r.chosen).toBeNull()
    expect(r.switchNote).toBe('全网不可用')
    expect(switchCalls).toHaveLength(0)
  })

  it('选出更优节点 → 切换成功', async () => {
    const { adapter, switchCalls } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 800 }, { reachable: true, delayMs: 800 }],
      'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }],
    })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.optimize()
    expect(r.chosen).toBe('HK-02')
    expect(r.switched).toBe(true)
    expect(switchCalls).toEqual([['GLOBAL', 'HK-02']])
  })

  it('当选者优势不足 minGainMs → 不切换', async () => {
    const { adapter, switchCalls } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 100 }],
      'HK-02': [{ reachable: true, delayMs: 80 }, { reachable: true, delayMs: 80 }],
    })
    const svc = makeService(adapter as never, makeCfg({ minGainMs: 100 }))
    const r = await svc.optimize()
    expect(r.switched).toBe(false)
    expect(r.switchNote).toContain('优势不足')
    expect(switchCalls).toHaveLength(0)
  })

  it('切换失败自动回滚原节点', async () => {
    const { adapter, switchCalls } = makeAdapter(
      { 'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }], 'HK-01': [{ reachable: true, delayMs: 800 }, { reachable: true, delayMs: 800 }] },
      { switchError: new Error('API 挂了') },
    )
    const svc = makeService(adapter as never, makeCfg())
    await expect(svc.optimize()).rejects.toMatchObject({ status: 500, code: 50004 })
    expect(switchCalls).toEqual([['GLOBAL', 'HK-02'], ['GLOBAL', 'HK-01']])
  })

  it('传入 prev 跳过重测（自动检测路径）', async () => {
    const { adapter, switchCalls } = makeAdapter({})
    const svc = makeService(adapter as never, makeCfg())
    const prev = {
      group: 'GLOBAL',
      currentNode: 'HK-01',
      currentUsable: false,
      nodes: [{ name: 'HK-02', urls: [{ url: 'https://a.com', delayMs: 50, reachable: true }], score: 100, usable: true }],
    }
    const r = await svc.optimize(prev)
    expect(r.switched).toBe(true)
    expect(switchCalls).toEqual([['GLOBAL', 'HK-02']])
    expect(adapter.delay).not.toHaveBeenCalled()
  })
})

describe('ClashService.subscriptions/updateSubscription', () => {
  it('providers 接口异常 → 空数组容错', async () => {
    const { adapter } = makeAdapter({})
    adapter.providers = vi.fn(async () => { throw new Error('boom') })
    const svc = makeService(adapter as never, makeCfg())
    expect(await svc.subscriptions()).toEqual([])
  })

  it('更新订阅失败 → CLASH_API_FAILED', async () => {
    const { adapter } = makeAdapter({})
    adapter.updateProvider = vi.fn(async () => { throw new Error('boom') })
    const svc = makeService(adapter as never, makeCfg())
    await expect(svc.updateSubscription('sub1')).rejects.toMatchObject({ status: 500, code: 50002 })
  })
})

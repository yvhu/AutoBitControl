import { describe, it, expect } from 'vitest'
import { ClashAdapter } from '../src/tools/clash/adapter'
import { HttpError } from '../src/infrastructure/http'

/** fake request：按注册表返回预设响应，记录调用 */
function fakeRequest(responses: Array<{ method: string; path: string; respond: () => unknown }>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const request = (opts: { method: 'GET' | 'PUT'; path: string; body?: unknown }) => {
    calls.push(opts)
    const hit = responses.find((r) => r.method === opts.method && opts.path === r.path)
    if (!hit) return Promise.reject(new HttpError(500, '未注册的路径'))
    return Promise.resolve(hit.respond())
  }
  return { request, calls }
}

describe('ClashAdapter', () => {
  it('groups 解析 Selector 分组的 now/all', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/proxies', respond: () => ({ proxies: { GLOBAL: { type: 'Selector', now: 'HK-01', all: ['HK-01', 'HK-02'] }, DIRECT: { type: 'Direct' } } }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    const groups = await a.groups()
    expect(groups).toEqual([{ name: 'GLOBAL', now: 'HK-01', all: ['HK-01', 'HK-02'] }])
  })

  it('delay 可达返回延迟；异常节点返回不可达', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/proxies/HK-01/delay?url=https%3A%2F%2Fa.com&timeout=5000', respond: () => ({ delay: 233 }) },
      { method: 'GET', path: '/proxies/DEAD/delay?url=https%3A%2F%2Fa.com&timeout=5000', respond: () => ({ delay: 0, message: 'error' }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.delay('HK-01', 'https://a.com')).toEqual({ supported: true, reachable: true, delayMs: 233 })
    expect(await a.delay('DEAD', 'https://a.com')).toEqual({ supported: true, reachable: false, delayMs: 0 })
  })

  it('delay 404 后降级：supported=false 且不再调用', async () => {
    const { request, calls } = fakeRequest([
      { method: 'GET', path: '/proxies/A/delay?url=https%3A%2F%2Fa.com&timeout=5000', respond: () => { throw new HttpError(404, 'not found') } },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.delay('A', 'https://a.com')).toEqual({ supported: false, reachable: false, delayMs: 0 })
    expect(a.delaySupported).toBe(false)
    expect(await a.delay('A', 'https://a.com')).toEqual({ supported: false, reachable: false, delayMs: 0 })
    expect(calls).toHaveLength(1)
  })

  it('switchNode 发 PUT /proxies/{group} {name}', async () => {
    const { request, calls } = fakeRequest([
      { method: 'PUT', path: '/proxies/GLOBAL', respond: () => ({}) },
    ])
    const a = new ClashAdapter('http://x', 'secret', 5000, request)
    await a.switchNode('GLOBAL', 'HK-02')
    expect(calls[0]).toEqual({ method: 'PUT', path: '/proxies/GLOBAL', body: { name: 'HK-02' } })
  })

  it('providers 解析订阅列表', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/providers/proxies', respond: () => ({ providers: { sub1: { vehicleType: 'HTTP', updatedAt: '2026-09-01', proxies: [{}, {}] } } }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.providers()).toEqual([{ name: 'sub1', vehicleType: 'HTTP', updatedAt: '2026-09-01', proxiesCount: 2 }])
  })

  it('providers 过滤 Compatible 分组条目（分组筛选的产物不是订阅）', async () => {
    const { request } = fakeRequest([
      {
        method: 'GET', path: '/providers/proxies',
        respond: () => ({
          providers: {
            AutoSelection: { vehicleType: 'Compatible', type: 'Proxy', proxies: [{}] },
            sub1: { vehicleType: 'HTTP', updatedAt: '2026-09-01', proxies: [{}, {}] },
          },
        }),
      },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.providers()).toEqual([{ name: 'sub1', vehicleType: 'HTTP', updatedAt: '2026-09-01', proxiesCount: 2 }])
  })

  it('mixedPort 兼容 mixed-port/mixedPort/port 三种字段', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/configs', respond: () => ({ 'mixed-port': 7890 }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.mixedPort()).toBe(7890)
  })

  it('mixedPort 兼容 mixedPort/port 字段名', async () => {
    const camel = new ClashAdapter('http://x', '', 5000, fakeRequest([
      { method: 'GET', path: '/configs', respond: () => ({ mixedPort: 7891 }) },
    ]).request)
    expect(await camel.mixedPort()).toBe(7891)
    const port = new ClashAdapter('http://x', '', 5000, fakeRequest([
      { method: 'GET', path: '/configs', respond: () => ({ port: 7892 }) },
    ]).request)
    expect(await port.mixedPort()).toBe(7892)
  })
})

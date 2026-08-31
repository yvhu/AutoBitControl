import { describe, it, expect, afterEach, vi } from 'vitest'
import { BitBrowserClient } from '../src/integrations/bitbrowser'

afterEach(() => { vi.unstubAllGlobals() })

function mockFetchOnce(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(handler))
}

describe('BitBrowserClient', () => {
  const client = new BitBrowserClient({ apiBase: 'http://127.0.0.1:54345', timeoutMs: 5000 })

  it('openBrowser 解析 data.http 与 ws', async () => {
    mockFetchOnce((url, init) => {
      expect(url).toBe('http://127.0.0.1:54345/browser/open')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body)).id).toBe('abc')
      return new Response(JSON.stringify({ success: true, data: { ws: 'ws://127.0.0.1:50106/devtools/browser/x', http: '127.0.0.1:50106' } }), { status: 200 })
    })
    const r = await client.openBrowser('abc')
    expect(r.http).toBe('127.0.0.1:50106')
    expect(r.ws).toContain('ws://')
  })

  it('openBrowser 兼容旧版 debugPort 字段', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: true, data: { ws: 'ws://x', debugPort: 61234 } }), { status: 200 }))
    const r = await client.openBrowser('abc')
    expect(r.http).toBe('127.0.0.1:61234')
  })

  it('openBrowser 业务失败抛异常（success=false）', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: false, msg: '浏览器不存在' }), { status: 200 }))
    await expect(client.openBrowser('nope')).rejects.toThrow('浏览器不存在')
  })

  it('openBrowser 兼容旧版 code 约定', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ code: -1, msg: '旧版错误' }), { status: 200 }))
    await expect(client.openBrowser('nope')).rejects.toThrow('旧版错误')
  })

  it('closeBrowser 调用正确端点', async () => {
    let called = false
    mockFetchOnce((url, init) => {
      called = true
      expect(url).toBe('http://127.0.0.1:54345/browser/close')
      expect(JSON.parse(String(init.body)).id).toBe('abc')
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    await client.closeBrowser('abc')
    expect(called).toBe(true)
  })

  it('listBrowsers 为 POST 且 page 从 0 开始', async () => {
    mockFetchOnce((url, init) => {
      expect(url).toContain('/browser/list')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({ page: 0, pageSize: 100 })
      return new Response(JSON.stringify({ success: true, data: { list: [{ id: 'a1', name: '窗口1' }, { id: 'a2', name: '窗口2' }] } }), { status: 200 })
    })
    const list = await client.listBrowsers(0, 100)
    expect(list).toEqual([{ id: 'a1', name: '窗口1' }, { id: 'a2', name: '窗口2' }])
  })

  it('health 返回 true', async () => {
    mockFetchOnce((url) => {
      expect(url).toContain('/health')
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    expect(await client.health()).toBe(true)
  })

  it('health 网络失败返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await client.health()).toBe(false)
  })

  it('isOpen pid 存在且真值返回 true（map 结构）', async () => {
    mockFetchOnce((url, init) => {
      expect(url).toContain('/browser/pids')
      expect(JSON.parse(String(init.body))).toEqual({ ids: ['abc'] })
      return new Response(JSON.stringify({ success: true, data: { abc: 12345 } }), { status: 200 })
    })
    expect(await client.isOpen('abc')).toBe(true)
  })

  it('isOpen pid 为 0/缺失返回 false', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: true, data: { abc: 0 } }), { status: 200 }))
    expect(await client.isOpen('abc')).toBe(false)
  })

  it('isOpen 兼容数组结构（{id,pid} 对象数组）', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: true, data: [{ id: 'abc', pid: 777 }] }), { status: 200 }))
    expect(await client.isOpen('abc')).toBe(true)
  })

  it('isOpen 请求失败返回 false（不抛错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await client.isOpen('abc')).toBe(false)
  })

  it('openPids 批量一次请求返回存活 id 集合（map 结构）', async () => {
    mockFetchOnce((url, init) => {
      expect(url).toContain('/browser/pids')
      expect(JSON.parse(String(init.body))).toEqual({ ids: ['a', 'b', 'c'] })
      return new Response(JSON.stringify({ success: true, data: { a: 1, b: 0, c: 999 } }), { status: 200 })
    })
    expect(await client.openPids(['a', 'b', 'c'])).toEqual(new Set(['a', 'c']))
  })

  it('openPids 空 ids 不发请求直接返回空集合', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await client.openPids([])).toEqual(new Set())
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

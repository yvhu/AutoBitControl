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
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({ page: 0, pageSize: 100 })
      return new Response(JSON.stringify({ success: true, data: { list: [{ id: 'a1', name: '窗口1' }, { id: 'a2', name: '窗口2' }] } }), { status: 200 })
    })
    const list = await client.listBrowsers(0, 100)
    expect(list).toEqual([{ id: 'a1', name: '窗口1' }, { id: 'a2', name: '窗口2' }])
  })

  it('health 返回 true', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: true }), { status: 200 }))
    expect(await client.health()).toBe(true)
  })

  it('health 网络失败返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await client.health()).toBe(false)
  })
})

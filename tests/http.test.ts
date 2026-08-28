import { describe, it, expect, afterEach, vi } from 'vitest'
import { httpJson, HttpError } from '../src/infrastructure/http'

afterEach(() => { vi.unstubAllGlobals() })

describe('httpJson', () => {
  it('POST JSON 并解析响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://x.io/api/ping')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
      expect(JSON.parse(String(init.body))).toEqual({ a: 1 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))
    const r = await httpJson<{ ok: boolean }>({ baseUrl: 'http://x.io', path: '/api/ping', method: 'POST', body: { a: 1 } })
    expect(r.ok).toBe(true)
  })

  it('非 2xx 抛 HttpError 含状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 502 })))
    await expect(httpJson({ baseUrl: 'http://x.io', path: '/x' })).rejects.toSatisfy((e: Error) => e instanceof HttpError && (e as HttpError).status === 502)
  })

  it('JSON 解析失败抛 HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>err</html>', { status: 200 })))
    await expect(httpJson({ baseUrl: 'http://x.io', path: '/x' })).rejects.toBeInstanceOf(HttpError)
  })

  it('GET 不带 body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
      return new Response(JSON.stringify({}), { status: 200 })
    }))
    await httpJson({ baseUrl: 'http://x.io', path: '/x' })
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { request, HttpError } from './client'

describe('client envelope', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('正常解包 data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ code: 0, message: 'ok', data: { hello: 'world' } }),
    }))
    const data = await request<{ hello: string }>('/api/foo')
    expect(data).toEqual({ hello: 'world' })
    expect(fetch).toHaveBeenCalledWith('/api/foo', expect.objectContaining({ method: 'GET' }))
  })

  it('code 非 0 抛 HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ code: 40001, message: '任务不存在', data: null }),
    }))
    await expect(request('/api/foo')).rejects.toThrow(HttpError)
    await expect(request('/api/foo')).rejects.toMatchObject({ code: 40001, message: '任务不存在' })
  })

  it('响应解析失败（非 JSON）抛 HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    }))
    await expect(request('/api/foo')).rejects.toMatchObject({ code: 500, message: '请求失败' })
  })
})

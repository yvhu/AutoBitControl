import { describe, it, expect } from 'vitest'
import { detectClash } from '../src/tools/clash/client-detector'
import { HttpError } from '../src/infrastructure/http'
import { ClashAdapter, type ClashRequest } from '../src/tools/clash/adapter'

/** 构造带固定响应的 ClashAdapter 替身（注入 fake request，覆盖 detector 用到的接口） */
function stubAdapter(responses: { version?: unknown; configs?: unknown; versionError?: Error }) {
  const request: ClashRequest = (opts) => {
    if (opts.path === '/version') {
      if (responses.versionError) return Promise.reject(responses.versionError)
      return Promise.resolve(responses.version)
    }
    return Promise.resolve(responses.configs)
  }
  return new ClashAdapter('http://x', '', 5000, request)
}

describe('detectClash', () => {
  it('meta:true → mihomo 内核 + 混合口', async () => {
    const a = stubAdapter({ version: { meta: true, version: 'v1.19.0' }, configs: { 'mixed-port': 7890 } })
    const r = await detectClash(a)
    expect(r).toEqual({ detected: true, kernel: 'mihomo', mixedPort: 7890 })
  })

  it('无 meta → generic 内核', async () => {
    const a = stubAdapter({ version: { version: '1.2.3' }, configs: {} })
    const r = await detectClash(a)
    expect(r).toEqual({ detected: true, kernel: 'generic', mixedPort: null })
  })

  it('连接失败 → detected=false', async () => {
    const a = stubAdapter({ versionError: new HttpError(0, '连接失败') })
    const r = await detectClash(a)
    expect(r).toEqual({ detected: false, kernel: null, mixedPort: null })
  })

  it('401 → 抛 CLASH_AUTH_FAILED', async () => {
    const a = stubAdapter({ versionError: new HttpError(401, 'unauthorized') })
    await expect(detectClash(a)).rejects.toMatchObject({ status: 400, code: 40007 })
  })
})

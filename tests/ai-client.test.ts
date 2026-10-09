import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiClient } from '../src/integrations/ai'
vi.mock('../src/infrastructure/http', () => ({ httpJson: vi.fn() }))
import { httpJson } from '../src/infrastructure/http'

describe('ai client', () => {
  beforeEach(() => vi.mocked(httpJson).mockReset())
  it('无 key 抛错', async () => {
    const c = createAiClient({ apiBase: 'https://x', model: 'm', apiKey: '', timeoutMs: 1000 })
    await expect(c.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('AI 未配置')
  })
  it('正常返回 content', async () => {
    vi.mocked(httpJson).mockResolvedValue({ choices: [{ message: { content: ' B ' } }] } as never)
    const c = createAiClient({ apiBase: 'https://x', model: 'm', apiKey: 'k', timeoutMs: 1000 })
    expect(await c.chat([{ role: 'user', content: 'q' }])).toBe('B')
    expect(vi.mocked(httpJson).mock.calls[0][0]).toMatchObject({ path: '/chat/completions', method: 'POST' })
  })
})

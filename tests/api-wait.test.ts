import { describe, it, expect, vi } from 'vitest'
import { waitFor, race, waitResponse } from '../src/api'

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    page: {
      getByText: (t: string) => ({ count: async () => (over['text_visible'] === t ? 1 : 0), first() { return this }, waitFor: async () => {} }),
      locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true, waitFor: async () => {} }) }),
      waitForTimeout: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      url: () => 'https://x/',
      ...over,
    },
    log: { info: vi.fn(), warn: vi.fn() },
  } as never
}

describe('api/wait', () => {
  it('waitFor：文案命中返回 true', async () => {
    const ctx = makeCtx({ text_visible: 'OK' })
    expect(await waitFor(ctx, { text: 'OK' }, { budgetMs: 500 })).toBe(true)
  })
  it('waitFor：超时 assert → 抛错', async () => {
    const ctx = makeCtx()
    await expect(waitFor(ctx, { text: 'NO' }, { budgetMs: 200, assert: true })).rejects.toThrow()
  })
  it('race：命中键返回', async () => {
    const ctx = makeCtx({ text_visible: 'A' })
    expect(await race(ctx, [['a', { text: 'A' }], ['b', { text: 'B' }]], 500)).toBe('a')
  })
  it('waitResponse：命中返回 { status, body }', async () => {
    const ctx = makeCtx({ waitForResponse: async () => ({ status: () => 200, json: async () => ({ ok: true }) }) })
    const r = await waitResponse(ctx, { urlPart: '/x', predicate: (s) => s === 200 }, { timeoutMs: 500 })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })
})

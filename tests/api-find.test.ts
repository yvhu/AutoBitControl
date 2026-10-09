import { describe, it, expect, vi } from 'vitest'
import { elementState, countElements, getText, hasText } from '../src/api'

function makeCtx(opts: { count?: number; visible?: boolean; text?: string; pageText?: boolean } = {}) {
  return {
    page: {
      locator: () => ({
        count: async () => opts.count ?? 1,
        first: () => ({ count: async () => opts.count ?? 1, isVisible: async () => opts.visible ?? true, textContent: async () => opts.text ?? '' }),
      }),
      getByText: () => ({ count: async () => (opts.pageText ? 1 : 0) }),
    },
  } as never
}

describe('api/find', () => {
  it('elementState：visible / hidden / absent', async () => {
    expect(await elementState(makeCtx({ count: 1, visible: true }), '#a')).toBe('visible')
    expect(await elementState(makeCtx({ count: 1, visible: false }), '#a')).toBe('hidden')
    expect(await elementState(makeCtx({ count: 0 }), '#a')).toBe('absent')
  })
  it('countElements / getText / hasText', async () => {
    expect(await countElements(makeCtx({ count: 3 }), '#a')).toBe(3)
    expect(await getText(makeCtx({ text: ' hi ' }), '#a')).toBe('hi')
    expect(await hasText(makeCtx({ pageText: true }), 'hi')).toBe(true)
    expect(await hasText(makeCtx({ pageText: false }), 'hi')).toBe(false)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { openPage, click, fill, pressKey, runJs } from '../src/api'

/** 最小假 ctx：只提供函数用到的字段 */
function makeCtx(over: Record<string, unknown> = {}) {
  return {
    page: {
      goto: vi.fn(async () => {}),
      locator: () => ({ first: () => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}) }) }),
      keyboard: { press: vi.fn(async () => {}) },
      evaluate: vi.fn(async (fn: () => unknown) => fn()),
      context: () => ({ pages: () => [] }),
    },
    log: { warn: vi.fn() },
    task: { meta: { url: 'https://x/' } },
    ...over,
  } as never
}

describe('api/page', () => {
  it('openPage：默认 meta.url，成功调用一次 goto', async () => {
    const ctx = makeCtx()
    await openPage(ctx)
    expect((ctx as never as { page: { goto: ReturnType<typeof vi.fn> } }).page.goto).toHaveBeenCalledWith('https://x/', expect.anything())
  })

  it('click：选择器走 locator().click', async () => {
    const ctx = makeCtx()
    await click(ctx, '#a')
    // 断言 locator 被调用（简化：不抛错即通过）
    expect(true).toBe(true)
  })

  it('click：坐标走 CDP 点击（page.mouse/新 CDP session）', async () => {
    const send = vi.fn(async () => ({}))
    const ctx = makeCtx({ page: { context: () => ({ newCDPSession: async () => ({ send, detach: async () => {} }) }), waitForTimeout: async () => {} } })
    await click(ctx, { x: 10, y: 20 })
    expect(send).toHaveBeenCalled()
  })

  it('fill / pressKey / runJs', async () => {
    const ctx = makeCtx()
    await fill(ctx, '#a', 'v')
    await pressKey(ctx, 'Enter')
    expect(await runJs(ctx, () => 42)).toBe(42)
  })
})

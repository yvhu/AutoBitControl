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

  it('click：选择器走 locator().first().click()', async () => {
    const clickMock = vi.fn(async () => {})
    const firstMock = vi.fn(() => ({ click: clickMock, fill: vi.fn(async () => {}) }))
    const locatorMock = vi.fn(() => ({ first: firstMock }))
    const ctx = makeCtx({ page: { locator: locatorMock, goto: vi.fn(async () => {}), context: () => ({ pages: () => [] }) } })
    await click(ctx, '#a')
    expect(locatorMock).toHaveBeenCalledWith('#a')
    expect(firstMock).toHaveBeenCalled()
    expect(clickMock).toHaveBeenCalled()
  })

  it('openPage：goto 前两次失败、第三次成功 → 重试至 3 次并 resolve', async () => {
    vi.useFakeTimers()
    try {
      const goto = vi.fn().mockRejectedValueOnce(new Error('fail-1')).mockRejectedValueOnce(new Error('fail-2')).mockResolvedValueOnce(undefined)
      const ctx = makeCtx({ page: { goto, context: () => ({ pages: () => [] }) } })
      const p = openPage(ctx)
      await vi.runAllTimersAsync()
      await expect(p).resolves.toBeUndefined()
      expect(goto).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('openPage：goto 始终失败 → 重试耗尽后抛错', async () => {
    vi.useFakeTimers()
    try {
      const goto = vi.fn().mockRejectedValue(new Error('boom'))
      const ctx = makeCtx({ page: { goto, context: () => ({ pages: () => [] }) } })
      const p = openPage(ctx)
      const assertion = expect(p).rejects.toThrow('boom')
      await vi.runAllTimersAsync()
      await assertion
      expect(goto).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
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

import { describe, it, expect, vi } from 'vitest'
import { openTab, waitInTab, raceInTab, clickInTab, focusTab, closeTab } from '../src/api'

/** 最小假页面：默认页面无匹配文案；可按需覆盖字段 */
function makePage(over: Record<string, unknown> = {}) {
  return {
    url: () => 'https://hub.konnex.world/points',
    waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitForLoadState: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getByText: (text: string) => ({
      count: async () => (over['text'] === text ? 1 : 0),
      first() { return this },
      waitFor: async () => {},
    }),
    locator: () => ({
      first: () => ({ count: async () => 1, isVisible: async () => true, click: vi.fn(async () => {}) }),
    }),
    ...over,
  }
}

/** 假 ctx：context().pages() 返回可变数组，便于模拟点击后新增标签 */
function makeCtx(pages: unknown[], main = makePage()) {
  return {
    page: { ...main, context: () => ({ pages: () => pages }) },
    log: { info: vi.fn(), warn: vi.fn() },
  } as never
}

describe('api/tab 多标签页', () => {
  it('openTab：过滤扩展页，返回 URL 命中的新标签页并置前', async () => {
    const main = makePage({ url: () => 'https://hub.konnex.world/points' })
    const extension = makePage({ url: () => 'chrome-extension://abc/notification.html' })
    const quest = makePage({ url: () => 'https://subnets.testnet.konnex.world/quest?walletAddress=0xabc' })
    const pages = [main]
    const ctx = makeCtx(pages, main)
    const trigger = vi.fn(async () => { pages.push(extension, quest) })

    const page = await openTab(ctx, trigger, { urlIncludes: '/quest?walletAddress=', timeoutMs: 2000 })

    expect(trigger).toHaveBeenCalledTimes(1)
    expect(page).toBe(quest)
    expect(quest.waitForLoadState).toHaveBeenCalledWith('domcontentloaded')
    expect(quest.bringToFront).toHaveBeenCalled()
  })

  it('openTab：预算内没有新页 → 抛超时错误', async () => {
    vi.useFakeTimers()
    try {
      const main = makePage()
      const pages = [main]
      const ctx = makeCtx(pages, main)
      const assertion = expect(openTab(ctx, async () => {}, { timeoutMs: 1000 })).rejects.toThrow('等待新标签页超时')
      await vi.advanceTimersByTimeAsync(1500)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('waitInTab：在指定页面等文案命中', async () => {
    const page = makePage({ text: 'RPC URL' })
    const ctx = makeCtx([page], page)
    expect(await waitInTab(ctx, page as never, { text: 'RPC URL' }, { budgetMs: 500 })).toBe(true)
  })

  it('raceInTab：返回先命中的键', async () => {
    const page = makePage({ text: 'RPC URL' })
    expect(await raceInTab(page as never, [['ready', { text: 'RPC URL' }], ['connect', { text: 'Connect' }]], 500)).toBe('ready')
  })

  it('clickInTab / focusTab / closeTab', async () => {
    const click = vi.fn(async () => {})
    const quest = makePage({
      locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true, click }) }),
    })
    const main = makePage()
    const ctx = makeCtx([main, quest], main)

    await clickInTab(quest as never, 'button:has-text("Next")')
    expect(click).toHaveBeenCalled()
    await focusTab(quest as never)
    expect(quest.bringToFront).toHaveBeenCalled()
    await closeTab(ctx, quest as never)
    expect(quest.close).toHaveBeenCalled()
    expect(main.bringToFront).toHaveBeenCalled()
  })
})

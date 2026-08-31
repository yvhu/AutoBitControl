import { describe, it, expect } from 'vitest'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { PetraAdapter } from '../src/automation/wallet/petra'
import { WalletRegistry, type PopupPage, type PopupLocator } from '../src/automation/wallet/types'
import { matchesWalletUrl, waitForPopup } from '../src/automation/wallet/popup'

function makeLocator(over: Partial<PopupLocator> = {}): PopupLocator {
  return {
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    count: async () => 1,
    waitFor: async () => {},
    first() { return this },
    ...over,
  }
}

function makePopup(over: Partial<PopupPage> = {}): PopupPage {
  return {
    url: () => 'chrome-extension://abc/home.html',
    getByRole: () => makeLocator(),
    getByTestId: () => makeLocator(),
    locator: () => makeLocator(),
    waitForEvent: async () => {},
    isClosed: () => false,
    ...over,
  }
}

describe('matchesWalletUrl', () => {
  it('按正则匹配扩展 URL', () => {
    expect(matchesWalletUrl('chrome-extension://xyz/home.html#connect', ['chrome-extension://.*/home.html'])).toBe(true)
    expect(matchesWalletUrl('https://site.io', ['chrome-extension://.*/home.html'])).toBe(false)
  })
})

describe('waitForPopup', () => {
  function makeContext(pages: Array<{ url(): string }>, onPage: (fn: (p: unknown) => void) => void) {
    return {
      pages: () => pages as never,
      on: (event: string, fn: (p: unknown) => void) => { if (event === 'page') onPage(fn) },
      off: () => {},
    } as never
  }

  it('页面在订阅后才出现也能被轮询发现', async () => {
    const pages: Array<{ url(): string }> = []
    let handler: ((p: unknown) => void) | null = null
    const context = makeContext(pages, fn => { handler = fn })
    const promise = waitForPopup(context, ['chrome-extension://.*/home.html'], 2000)
    setTimeout(() => { pages.push({ url: () => 'chrome-extension://abc/home.html' }) }, 150)
    const popup = await promise
    expect(popup).not.toBeNull()
  })

  it('超时返回 null', async () => {
    const context = makeContext([], () => {})
    const popup = await waitForPopup(context, ['chrome-extension://.*/home.html'], 300)
    expect(popup).toBeNull()
  })

  it('弹窗开在其它 browser context 也能被发现', async () => {
    const popupPage = { url: () => 'chrome-extension://abc/notification.html' }
    let handler: ((p: unknown) => void) | null = null
    const otherCtx = {
      pages: () => [popupPage],
      on: () => {},
      off: () => {},
    }
    const context = {
      pages: () => [] as Array<{ url(): string }>,
      on: (event: string, fn: (p: unknown) => void) => { if (event === 'page') handler = fn },
      off: () => {},
      browser: () => ({ contexts: () => [context, otherCtx] }),
    } as never
    const popup = await waitForPopup(context, ['chrome-extension://.*/notification.html'], 2000)
    expect(popup).not.toBeNull()
  })
})

describe('MetaMaskAdapter 解锁轮询', () => {
  it('解锁框立即渲染：填密码提交后等解锁页消失即成功', async () => {
    const adapter = new MetaMaskAdapter()
    const filled: string[] = []
    const clicked: string[] = []
    const popup = makePopup({
      getByTestId: (id: string) => {
        if (id === 'unlock-password') return makeLocator({ fill: async (t: string) => { filled.push(t) } })
        if (id === 'unlock-page') return makeLocator({ waitFor: async () => {} })
        if (id === 'unlock-submit') return makeLocator({ click: async () => { clicked.push(id) } })
        return makeLocator({ count: async () => 0 })
      },
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual(['secret123'])
    expect(clicked).toEqual(['unlock-submit'])
  })

  it('解锁框延迟渲染：轮询等到出现后解锁成功', async () => {
    const adapter = new MetaMaskAdapter()
    const filled: string[] = []
    let renders = 0
    const popup = makePopup({
      getByTestId: (id: string) => {
        if (id === 'unlock-password') {
          return makeLocator({
            count: async () => { renders++; return renders > 5 ? 1 : 0 },
            fill: async (t: string) => { filled.push(t) },
          })
        }
        if (id === 'unlock-page') return makeLocator({ waitFor: async () => {} })
        return makeLocator({ count: async () => 0 })
      },
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual(['secret123'])
  })

  it('弹窗直接是连接确认页（已解锁）：等 confirm-btn 出现后跳过解锁', async () => {
    const adapter = new MetaMaskAdapter()
    let renders = 0
    const popup = makePopup({
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ count: async () => { renders++; return renders > 3 ? 1 : 0 } })
        : makeLocator({ count: async () => 0 }),
    })
    await adapter.unlock!(popup, 'secret123')
  })

  it('解锁密码错误：解锁页未离开则抛错', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: (id: string) => {
        if (id === 'unlock-page') return makeLocator({ waitFor: async () => { throw new Error('仍在解锁页') } })
        return makeLocator()
      },
    })
    await expect(adapter.unlock!(popup, 'bad')).rejects.toThrow(/解锁失败/)
  })

  it('20s 无任何状态抛错', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({ getByTestId: () => makeLocator({ count: async () => 0 }) })
    await expect(adapter.unlock!(popup, 'secret123')).rejects.toThrow(/弹窗状态未出现/)
  })

  it('弹窗已关闭：立即返回', async () => {
    const adapter = new MetaMaskAdapter()
    const filled: string[] = []
    const popup = makePopup({
      isClosed: () => true,
      getByTestId: () => makeLocator({ count: async () => 1, fill: async (t: string) => { filled.push(t) } }),
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual([])
  })
})

describe('MetaMaskAdapter 连接确认', () => {
  it('确认按钮延迟渲染：等到出现点击，弹窗关闭即成功', async () => {
    const adapter = new MetaMaskAdapter()
    let clicks = 0
    let renders = 0
    const popup = makePopup({
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ count: async () => { renders++; return renders > 2 ? 1 : 0 }, click: async () => { clicks++ } })
        : makeLocator({ count: async () => 0 }),
      // 角色名兜底不生效：confirm-btn 延迟渲染期间没有可点按钮
      getByRole: () => makeLocator({ count: async () => 0 }),
      waitForEvent: async () => {},
    })
    await adapter.ensureConnected(popup)
    expect(clicks).toBe(1)
  })

  it('close 事件不来但连接页消失也判成功（先存在后消失）', async () => {
    const adapter = new MetaMaskAdapter()
    let cpCounts = 0
    const popup = makePopup({
      getByTestId: (id: string) => {
        if (id === 'confirm-btn') return makeLocator({ count: async () => 1, click: async () => {} })
        if (id === 'connect-page') return makeLocator({ count: async () => { cpCounts++; return 1 }, waitFor: async () => {} })
        return makeLocator({ count: async () => 0 })
      },
      waitForEvent: async () => { throw new Error('close 事件永不触发') },
    })
    await adapter.ensureConnected(popup)
    // 守卫语义：detached 判定前必须先 count 确认连接页存在（守卫被绕过时 count 不被调用，用例失败）
    expect(cpCounts).toBeGreaterThan(0)
  })

  it('3 轮无确认按钮抛错', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: () => makeLocator({ count: async () => 0 }),
      getByRole: () => makeLocator({ count: async () => 0 }),
    })
    await expect(adapter.ensureConnected(popup)).rejects.toThrow(/连接确认未完成/)
  })
})

describe('ensureConnected 重试循环', () => {
  it('testid 确认按钮：弹窗未关闭时多次点击直到关闭', async () => {
    const adapter = new MetaMaskAdapter()
    let clicks = 0
    let closes = 0
    const popup = makePopup({
      // testid 路径命中（confirm-btn 存在且可点），getByRole 不应被使用
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ click: async () => { clicks++ } })
        : makeLocator({ count: async () => 0, waitFor: async () => { throw new Error('连接页未消失') } }),
      waitForEvent: async () => {
        closes++
        if (closes < 2) throw new Error('未关闭')
      },
    })
    await adapter.ensureConnected(popup)
    expect(clicks).toBe(2)
  })

  it('testid 不存在时回退按角色名（中文文案）点击', async () => {
    const adapter = new MetaMaskAdapter()
    let roleClicks = 0
    const popup = makePopup({
      // 全部 testid 候选均不存在（count=0）
      getByTestId: () => makeLocator({ count: async () => 0 }),
      getByRole: () => makeLocator({ count: async () => 1, click: async () => { roleClicks++ } }),
      waitForEvent: async () => {},
    })
    await adapter.ensureConnected(popup)
    expect(roleClicks).toBeGreaterThan(0)
  })

  it('3 次耗尽（弹窗始终不关闭）后抛错', async () => {
    const adapter = new MetaMaskAdapter()
    let clicks = 0
    const popup = makePopup({
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ click: async () => { clicks++ } })
        : makeLocator({ count: async () => 0, waitFor: async () => { throw new Error('连接页未消失') } }),
      waitForEvent: async () => { throw new Error('永不关闭') },
    })
    await expect(adapter.ensureConnected(popup)).rejects.toThrow(/连接确认未完成/)
    expect(clicks).toBe(3)
  })
})

describe('MetaMaskAdapter', () => {
  it('ensureConnected 点击确认按钮', async () => {
    const clicked = { count: 0 }
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ click: async () => { clicked.count++ } })
        : makeLocator({ count: async () => 0 }),
      waitForEvent: async () => {},
    })
    await adapter.ensureConnected(popup)
    expect(clicked.count).toBeGreaterThan(0)
  })
})

describe('PetraAdapter', () => {
  it('ensureConnected 点击连接按钮', async () => {
    const clicked = { count: 0 }
    const adapter = new PetraAdapter()
    const popup = makePopup({
      getByRole: () => makeLocator({ click: async () => { clicked.count++ } }),
    })
    await adapter.ensureConnected(popup)
    expect(clicked.count).toBeGreaterThan(0)
  })
})

describe('WalletRegistry', () => {
  it('注册与查找', () => {
    const reg = new WalletRegistry()
    reg.register(new MetaMaskAdapter())
    reg.register(new PetraAdapter())
    expect(reg.has('metamask')).toBe(true)
    expect(reg.has('petra')).toBe(true)
    expect(() => reg.get('nope')).toThrow(/未注册/)
  })
})

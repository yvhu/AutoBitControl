import { describe, it, expect } from 'vitest'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { PetraAdapter } from '../src/automation/wallet/petra'
import { WalletRegistry, type PopupPage, type PopupLocator } from '../src/automation/wallet/types'
import { matchesWalletUrl, waitForPopup } from '../src/automation/wallet/popup'

function makeLocator(over: Partial<PopupLocator> = {}): PopupLocator {
  return { click: async () => {}, fill: async () => {}, press: async () => {}, first() { return this }, ...over }
}

function makePopup(over: Partial<PopupPage> = {}): PopupPage {
  return {
    url: () => 'chrome-extension://abc/home.html',
    getByRole: () => makeLocator(),
    getByTestId: () => makeLocator(),
    locator: () => makeLocator(),
    waitForEvent: async () => {},
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
})

describe('ensureConnected 重试循环', () => {
  it('弹窗未关闭时多次点击直到关闭', async () => {
    const adapter = new MetaMaskAdapter()
    let clicks = 0
    let closes = 0
    const popup = makePopup({
      getByRole: () => makeLocator({ click: async () => { clicks++ } }),
      waitForEvent: async () => {
        closes++
        if (closes < 2) throw new Error('未关闭')
      },
    })
    await adapter.ensureConnected(popup)
    expect(clicks).toBe(2)
  })
})

describe('MetaMaskAdapter', () => {
  it('unlock 填写密码并提交', async () => {
    const filled: string[] = []
    const clicked = { count: 0 }
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: (id: string) => id === 'unlock-password'
        ? makeLocator({ fill: async (t: string) => { filled.push(t) } })
        : makeLocator({ click: async () => { clicked.count++ } }),
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual(['secret123'])
    expect(clicked.count).toBe(1)
  })

  it('ensureConnected 点击确认按钮', async () => {
    const clicked = { count: 0 }
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByRole: () => makeLocator({ click: async () => { clicked.count++ } }),
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

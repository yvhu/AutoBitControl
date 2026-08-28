import { describe, it, expect } from 'vitest'
import { MetaMaskAdapter } from '../src/core/wallet/metamask'
import { PetraAdapter } from '../src/core/wallet/petra'
import { WalletRegistry, type PopupPage, type PopupLocator } from '../src/core/wallet/types'
import { matchesWalletUrl } from '../src/core/wallet/popup'

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

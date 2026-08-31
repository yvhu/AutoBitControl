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
  it('testid 确认按钮：弹窗未关闭时多次点击直到关闭', async () => {
    const adapter = new MetaMaskAdapter()
    let clicks = 0
    let closes = 0
    const popup = makePopup({
      // testid 路径命中（confirm-btn 存在且可点），getByRole 不应被使用
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ click: async () => { clicks++ } })
        : makeLocator({ click: async () => { throw new Error('不可点') } }),
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
      getByRole: () => makeLocator({ click: async () => { roleClicks++ } }),
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
        : makeLocator({ count: async () => 0 }),
      waitForEvent: async () => { throw new Error('永不关闭') },
    })
    await expect(adapter.ensureConnected(popup)).rejects.toThrow(/连接确认未完成/)
    expect(clicks).toBe(3)
  })
})

describe('MetaMaskAdapter', () => {
  it('unlock 填写密码并提交（解锁后弹窗关闭）', async () => {
    const filled: string[] = []
    const clicked = { count: 0 }
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: (id: string) => id === 'unlock-password'
        ? makeLocator({ fill: async (t: string) => { filled.push(t) } })
        : makeLocator({ click: async () => { clicked.count++ } }),
      // 弹窗关闭即解锁成功
      waitForEvent: async () => {},
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual(['secret123'])
    expect(clicked.count).toBe(1)
  })

  it('unlock 弹窗不关闭时等解锁页消失即成功（新版切连接确认页）', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: () => makeLocator({ waitFor: async () => {} }),
      waitForEvent: async () => { throw new Error('未关闭') },
    })
    await adapter.unlock!(popup, 'secret123')
  })

  it('unlock 密码错误解锁页未离开则抛错', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: () => makeLocator({ waitFor: async () => { throw new Error('仍在解锁页') } }),
      waitForEvent: async () => { throw new Error('未关闭') },
    })
    await expect(adapter.unlock!(popup, 'bad')).rejects.toThrow(/解锁失败/)
  })

  it('unlock 钱包已解锁（无密码框）直接跳过', async () => {
    const adapter = new MetaMaskAdapter()
    const filled: string[] = []
    const popup = makePopup({
      getByTestId: () => makeLocator({ count: async () => 0, fill: async (t: string) => { filled.push(t) } }),
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual([])
  })

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

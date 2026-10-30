import { describe, it, expect } from 'vitest'
import { createConfigWalletAdapter } from '../src/automation/wallet/config-adapter'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { PetraAdapter } from '../src/automation/wallet/petra'
import type { PopupPage, PopupLocator } from '../src/automation/wallet/types'

/**
 * 假定位器：exists 控制 count（0/1），visible 控制 isVisible（默认同 exists），
 * click/fill 记录到共享数组，让用例能断言「命中了哪个选择器」「密码是否被填入」。
 */
function makeLocator(exists: boolean, clicks: string[], selector: string, fills?: string[], visible = exists): PopupLocator {
  return {
    click: async () => { if (exists) clicks.push(selector) },
    fill: async (t: string) => { fills?.push(t) },
    press: async () => {},
    count: async () => (exists ? 1 : 0),
    isVisible: async () => visible,
    first() { return this },
    waitFor: async () => {},
  }
}

/**
 * 假弹窗：按「可见/隐藏文案、可见/隐藏 testid」区分存在与可见性。
 * texts/testids = 存在且可见；hiddenTexts/hiddenTestids = 存在但隐藏（count>0、isVisible=false）。
 * locator('button:has-text("X")') 按 X 文案命中；locator('input[type=password]') 命中 password。
 */
function makePopup(opts: {
  texts?: string[]
  hiddenTexts?: string[]
  testids?: string[]
  hiddenTestids?: string[]
  password?: boolean
  hiddenPassword?: boolean
  url?: string
  clicks: string[]
  fills?: string[]
}): PopupPage {
  const texts = opts.texts ?? []
  const hiddenTexts = opts.hiddenTexts ?? []
  const testids = opts.testids ?? []
  const hiddenTestids = opts.hiddenTestids ?? []
  return {
    url: () => opts.url ?? 'chrome-extension://abc/popup.html',
    getByRole: () => makeLocator(false, opts.clicks, 'role'),
    getByTestId: (id: string) =>
      makeLocator(testids.includes(id) || hiddenTestids.includes(id), opts.clicks, id, opts.fills, testids.includes(id)),
    locator: (selector: string) => {
      if (selector.includes('input[type=password]') || selector.includes('input[type="password"]')) {
        return makeLocator(!!opts.password || !!opts.hiddenPassword, opts.clicks, selector, opts.fills, !!opts.password)
      }
      const m = /has-text\("([^"]+)"\)/.exec(selector)
      const text = m?.[1] ?? ''
      return makeLocator(texts.includes(text) || hiddenTexts.includes(text), opts.clicks, selector, undefined, texts.includes(text))
    },
    waitForEvent: async () => {},
    isClosed: () => false,
  }
}

/** 无 isVisible 的假弹窗：只有 count，用于验证「mock 无可见性 API 时回退 count 且 tx 先于 sign」 */
function makePopupCountOnly(texts: string[], testids: string[], clicks: string[]): PopupPage {
  const loc = (exists: boolean, sel: string): PopupLocator => ({
    click: async () => { if (exists) clicks.push(sel) },
    fill: async () => {},
    first() { return this },
    count: async () => (exists ? 1 : 0),
  })
  return {
    url: () => 'chrome-extension://abc/popup.html',
    getByRole: () => loc(false, 'role'),
    getByTestId: (id: string) => loc(testids.includes(id), id),
    locator: (selector: string) => {
      if (selector.includes('password')) return loc(false, selector)
      const m = /has-text\("([^"]+)"\)/.exec(selector)
      return loc(!!m && texts.includes(m[1]), selector)
    },
    waitForEvent: async () => {},
    isClosed: () => false,
  }
}

describe('createConfigWalletAdapter 分类与登录处理', () => {
  const adapter = createConfigWalletAdapter({ key: 'foo', displayName: 'Foo' })

  it('connect 候选可见 → classify connect，handleLoginPopup 点击并返回 true', async () => {
    const clicks: string[] = []
    const popup = makePopup({ texts: ['Connect'], clicks })
    expect(await adapter.classifyPopup(popup)).toBe('connect')
    expect(await adapter.handleLoginPopup(popup)).toBe(true)
    expect(clicks).toEqual(['button:has-text("Connect")'])
  })

  it('sign 候选可见 → classify sign，handleLoginPopup 点击并返回 true', async () => {
    const clicks: string[] = []
    const popup = makePopup({ texts: ['Sign'], clicks })
    expect(await adapter.classifyPopup(popup)).toBe('sign')
    expect(await adapter.handleLoginPopup(popup)).toBe(true)
    expect(clicks).toEqual(['button:has-text("Sign")'])
  })

  it('tx 候选可见 → classify tx，handleLoginPopup 不处理返回 false（绝不自动确认交易）', async () => {
    const clicks: string[] = []
    const popup = makePopup({ texts: ['Approve'], clicks })
    expect(await adapter.classifyPopup(popup)).toBe('tx')
    expect(await adapter.handleLoginPopup(popup)).toBe(false)
    expect(clicks).toEqual([])
  })

  it('隐藏 Sign + 可见 Confirm → classify tx（用可见性区分，不误判为 sign），handleLoginPopup 不处理', async () => {
    const clicks: string[] = []
    const popup = makePopup({ texts: ['Confirm'], hiddenTexts: ['Sign'], clicks })
    expect(await adapter.classifyPopup(popup)).toBe('tx')
    expect(await adapter.handleLoginPopup(popup)).toBe(false)
    expect(clicks).toEqual([])
  })

  it('隐藏密码框 + 可见 Connect → classify connect（isVisible 优先于 count，不误判 unlock）', async () => {
    const clicks: string[] = []
    const popup = makePopup({ texts: ['Connect'], hiddenPassword: true, clicks })
    expect(await adapter.classifyPopup(popup)).toBe('connect')
  })

  it('无 isVisible（仅 count）：Sign 与 Confirm 同时存在 → tx 先于 sign，不自动处理', async () => {
    const clicks: string[] = []
    const popup = makePopupCountOnly(['Sign', 'Confirm'], [], clicks)
    expect(await adapter.classifyPopup(popup)).toBe('tx')
    expect(await adapter.handleLoginPopup(popup)).toBe(false)
    expect(clicks).toEqual([])
  })

  it('无候选 → classify unknown，handleLoginPopup 返回 false', async () => {
    const clicks: string[] = []
    const popup = makePopup({ texts: [], clicks })
    expect(await adapter.classifyPopup(popup)).toBe('unknown')
    expect(await adapter.handleLoginPopup(popup)).toBe(false)
    expect(clicks).toEqual([])
  })

  it('unlock：密码框 + 解锁候选 → 填入密码并提交', async () => {
    const clicks: string[] = []
    const fills: string[] = []
    const popup = makePopup({ password: true, texts: ['Unlock'], clicks, fills })
    expect(await adapter.classifyPopup(popup)).toBe('unlock')
    expect(await adapter.handleLoginPopup(popup, 'pw123')).toBe(true)
    expect(fills).toEqual(['pw123'])
    expect(clicks).toEqual(['button:has-text("Unlock")'])
  })

  it('unlock 但未提供密码 → 返回 false，不点击', async () => {
    const clicks: string[] = []
    const popup = makePopup({ password: true, texts: ['Unlock'], clicks })
    expect(await adapter.classifyPopup(popup)).toBe('unlock')
    expect(await adapter.handleLoginPopup(popup)).toBe(false)
    expect(clicks).toEqual([])
  })

  it('自定义 buttons 覆盖内置候选', async () => {
    const custom = createConfigWalletAdapter({ key: 'bar', displayName: 'Bar', buttons: { connect: ['button:has-text("连接钱包")'] } })
    const clicks: string[] = []
    const popup = makePopup({ texts: ['连接钱包'], clicks })
    expect(await custom.classifyPopup(popup)).toBe('connect')
    expect(await custom.handleLoginPopup(popup)).toBe(true)
    expect(clicks).toEqual(['button:has-text("连接钱包")'])
  })

  it('displayName 必填，extensionId 可缺省', () => {
    const a = createConfigWalletAdapter({ key: 'foo', displayName: 'Foo' })
    expect(a.displayName).toBe('Foo')
    expect(a.extensionId).toBeUndefined()
    expect(a.extensionUrlPatterns.length).toBeGreaterThan(0)
    const b = createConfigWalletAdapter({ key: 'bar', displayName: 'Bar', extensionId: 'abcdefghijklmnopabcdefghijklmnop' })
    expect(b.extensionId).toBe('abcdefghijklmnopabcdefghijklmnop')
  })
})

describe('MetaMaskAdapter classifyPopup', () => {
  it('密码框可见 → unlock', async () => {
    const popup = makePopup({ testids: ['unlock-password'], clicks: [] })
    expect(await new MetaMaskAdapter().classifyPopup(popup)).toBe('unlock')
  })

  it('连接页可见 → connect', async () => {
    const popup = makePopup({ testids: ['connect-page'], clicks: [] })
    expect(await new MetaMaskAdapter().classifyPopup(popup)).toBe('connect')
  })

  it('签名请求可见 → sign', async () => {
    const popup = makePopup({ testids: ['signature-request'], clicks: [] })
    expect(await new MetaMaskAdapter().classifyPopup(popup)).toBe('sign')
  })

  it('交易确认按钮（无连接/签名标记）→ tx，且 handleLoginPopup 返回 false 不点击', async () => {
    const clicks: string[] = []
    const popup = makePopup({ testids: ['confirm-footer-button'], clicks })
    const adapter = new MetaMaskAdapter()
    expect(await adapter.classifyPopup(popup)).toBe('tx')
    expect(await adapter.handleLoginPopup(popup, 'pw')).toBe(false)
    expect(clicks).toEqual([])
  })

  it('隐藏签名标记 + 可见交易确认 → tx（isVisible 区分隐藏，绝不误判 sign 自动点击）', async () => {
    const clicks: string[] = []
    const popup = makePopup({ testids: ['confirm-footer-button'], hiddenTestids: ['signature-request'], clicks })
    const adapter = new MetaMaskAdapter()
    expect(await adapter.classifyPopup(popup)).toBe('tx')
    expect(await adapter.handleLoginPopup(popup, 'pw')).toBe(false)
    expect(clicks).toEqual([])
  })

  it('签名页 URL + 共用确认按钮 → sign（登录签名不再被 tx 抢占）', async () => {
    const clicks: string[] = []
    const popup = makePopup({
      url: 'chrome-extension://abc/notification.html#/confirm-transaction/1/signature-request',
      testids: ['confirm-footer-button'],
      clicks,
    })
    const adapter = new MetaMaskAdapter()
    expect(await adapter.classifyPopup(popup)).toBe('sign')
    expect(await adapter.handleLoginPopup(popup, 'pw')).toBe(true)
    expect(clicks.length).toBeGreaterThan(0)
  })

  it('普通 URL + 可见确认按钮 → tx（URL 判定不放宽交易边界）', async () => {
    const clicks: string[] = []
    const popup = makePopup({
      url: 'chrome-extension://abc/notification.html#/confirm-transaction/1',
      testids: ['confirm-footer-button'],
      clicks,
    })
    expect(await new MetaMaskAdapter().classifyPopup(popup)).toBe('tx')
  })

  it('隐藏解锁页 + 可见连接页 → connect（isVisible 优先于 count，不误判 unlock）', async () => {
    const popup = makePopup({ testids: ['connect-page'], hiddenTestids: ['unlock-page'], clicks: [] })
    expect(await new MetaMaskAdapter().classifyPopup(popup)).toBe('connect')
  })

  it('无 isVisible（仅 count）：签名与交易标记同时存在 → tx 先于 sign', async () => {
    const clicks: string[] = []
    const popup = makePopupCountOnly([], ['signature-request', 'confirm-footer-button'], clicks)
    expect(await new MetaMaskAdapter().classifyPopup(popup)).toBe('tx')
  })

  it('无任何标记 → unknown', async () => {
    const popup = makePopup({ clicks: [] })
    expect(await new MetaMaskAdapter().classifyPopup(popup)).toBe('unknown')
  })
})

describe('PetraAdapter classifyPopup', () => {
  it('Sign In 文案 → sign', async () => {
    const popup = makePopup({ texts: ['Sign In'], clicks: [] })
    expect(await new PetraAdapter().classifyPopup(popup)).toBe('sign')
  })

  it('Connect 文案 → connect', async () => {
    const popup = makePopup({ texts: ['Connect'], clicks: [] })
    expect(await new PetraAdapter().classifyPopup(popup)).toBe('connect')
  })

  it('密码框可见 → unlock', async () => {
    const popup = makePopup({ password: true, clicks: [] })
    expect(await new PetraAdapter().classifyPopup(popup)).toBe('unlock')
  })

  it('隐藏 Connect 文案 + 可见 Sign In → sign（isVisible 区分隐藏，不误判 connect）', async () => {
    const popup = makePopup({ texts: ['Sign In'], hiddenTexts: ['Connect'], clicks: [] })
    expect(await new PetraAdapter().classifyPopup(popup)).toBe('sign')
  })

  it('无 isVisible（仅 count）：Sign In 与 Confirm 同时存在 → tx 先于 sign', async () => {
    const clicks: string[] = []
    const popup = makePopupCountOnly(['Sign In', 'Confirm'], [], clicks)
    expect(await new PetraAdapter().classifyPopup(popup)).toBe('tx')
  })
})

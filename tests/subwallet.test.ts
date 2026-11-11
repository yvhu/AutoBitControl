import { describe, it, expect } from 'vitest'
import { SubWalletAdapter } from '../src/automation/wallet/subwallet'
import type { PopupPage, PopupLocator } from '../src/automation/wallet/types'

/** 可变假弹窗：按可见按钮文案/标题文案/密码框响应 locator，点击后按需标记关闭 */
function makePopup(opts: {
  texts?: string[]
  titles?: string[]
  password?: boolean
  clicks: string[]
  fills?: string[]
  closeOnClick?: boolean
  dappAlert?: boolean
  url?: string
}): PopupPage {
  const texts = opts.texts ?? []
  const titles = opts.titles ?? []
  let closed = false
  let dappAlertOpen = !!opts.dappAlert
  const locator = (selector: string): PopupLocator => {
    let visible = false
    if (selector.includes('modal-id-dapp-alert-modal')) {
      visible = dappAlertOpen
    } else if (selector.includes('input[type="password"]')) {
      visible = !!opts.password
    } else {
      const button = /button:has-text\("([^"]+)"\)/.exec(selector)
      const title = /^text="(.+)"$/.exec(selector)
      if (button) visible = texts.includes(button[1])
      else if (title) visible = titles.includes(title[1])
    }
    const loc: PopupLocator = {
      click: async () => {
        opts.clicks.push(selector)
        if (selector.includes('modal-id-dapp-alert-modal')) dappAlertOpen = false
        else if (opts.closeOnClick) closed = true
      },
      fill: async (text: string) => { opts.fills?.push(text) },
      press: async () => {},
      count: async () => (visible ? 1 : 0),
      isVisible: async () => visible,
      waitFor: async () => {},
      first() { return loc },
    }
    return loc
  }
  return {
    url: () => opts.url ?? 'chrome-extension://onhogfjeacnfoofkfgppdlbmlmnplgbn/notification.html',
    getByRole: () => locator('button'),
    getByTestId: () => locator('testid'),
    locator,
    waitForEvent: async () => {},
    isClosed: () => closed,
  }
}

describe('SubWalletAdapter 元信息', () => {
  it('声明扩展 ID、provider 与弹窗 URL', () => {
    const adapter = new SubWalletAdapter()
    expect(adapter.key).toBe('subwallet')
    expect(adapter.displayName).toBe('SubWallet')
    expect(adapter.extensionId).toBe('onhogfjeacnfoofkfgppdlbmlmnplgbn')
    expect(adapter.probePath).toBe('index.html')
    expect(adapter.providerFlag).toBe('isSubWallet')
    expect(adapter.providerGlobal).toBe('SubWallet')
    expect(adapter.extensionUrlPatterns.some((p) => p.includes('notification.html'))).toBe(true)
  })
})

describe('SubWalletAdapter 分类', () => {
  const adapter = new SubWalletAdapter()

  it('密码框 → unlock', async () => {
    const popup = makePopup({ password: true, clicks: [] })
    expect(await adapter.classifyPopup(popup)).toBe('unlock')
  })

  it('签名标题 → sign（与交易共用 Approve 时靠标题区分）', async () => {
    const popup = makePopup({ titles: ['Signature request'], texts: ['Approve'], clicks: [] })
    expect(await adapter.classifyPopup(popup)).toBe('sign')
  })

  it('交易标题 → tx', async () => {
    const popup = makePopup({ titles: ['Transaction request'], texts: ['Approve'], clicks: [] })
    expect(await adapter.classifyPopup(popup)).toBe('tx')
  })

  it('Connect → connect', async () => {
    const popup = makePopup({ titles: ['Connect with SubWallet'], texts: ['Connect'], clicks: [] })
    expect(await adapter.classifyPopup(popup)).toBe('connect')
  })

  it('只有 Approve 没有标题 → 保守归为 tx', async () => {
    const popup = makePopup({ texts: ['Approve'], clicks: [] })
    expect(await adapter.classifyPopup(popup)).toBe('tx')
  })

  it('只有 Reject → unknown', async () => {
    const popup = makePopup({ texts: ['Reject'], clicks: [] })
    expect(await adapter.classifyPopup(popup)).toBe('unknown')
  })
})

describe('SubWalletAdapter 多语言', () => {
  const adapter = new SubWalletAdapter()

  it('繁体中文解锁按钮', async () => {
    const clicks: string[] = []
    const fills: string[] = []
    const popup = makePopup({ password: true, texts: ['解鎖'], clicks, fills })
    await adapter.unlock!(popup, 'pw')
    expect(fills).toEqual(['pw'])
    expect(clicks).toEqual(['button:has-text("解鎖")'])
  })

  it('日文连接按钮', async () => {
    const clicks: string[] = []
    const popup = makePopup({ texts: ['接続'], clicks, closeOnClick: true })
    expect(await adapter.classifyPopup(popup)).toBe('connect')
    await adapter.connect(popup)
    expect(clicks).toEqual(['button:has-text("接続")'])
  })

  it('俄文 Approve 作为交易确认', async () => {
    const clicks: string[] = []
    const popup = makePopup({ titles: ['Запрос на транзакцию'], texts: ['Одобрить'], clicks, closeOnClick: true })
    expect(await adapter.classifyPopup(popup)).toBe('tx')
    await adapter.confirmTx(popup)
    expect(clicks).toEqual(['button:has-text("Одобрить")'])
  })

  it('越南文签名标题 → sign', async () => {
    const popup = makePopup({ titles: ['Yêu cầu ký'], texts: ['Phê duyệt'], clicks: [] })
    expect(await adapter.classifyPopup(popup)).toBe('sign')
  })
})

describe('SubWalletAdapter 动作', () => {
  it('解锁：填密码并点 Unlock', async () => {
    const clicks: string[] = []
    const fills: string[] = []
    const popup = makePopup({ password: true, texts: ['Unlock'], clicks, fills })
    await new SubWalletAdapter().unlock!(popup, 'secret')
    expect(fills).toEqual(['secret'])
    expect(clicks).toEqual(['button:has-text("Unlock")'])
  })

  it('已解锁的签名页：unlock 直接返回', async () => {
    const popup = makePopup({ titles: ['Signature request'], texts: ['Approve'], clicks: [] })
    const started = Date.now()
    await new SubWalletAdapter().unlock!(popup, 'secret')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('签名：点 Approve 后弹窗关闭', async () => {
    const clicks: string[] = []
    const popup = makePopup({ titles: ['Signature request'], texts: ['Approve'], clicks, closeOnClick: true })
    await new SubWalletAdapter().sign(popup)
    expect(clicks).toEqual(['button:has-text("Approve")'])
  })

  it('交易：点 Approve 后弹窗关闭', async () => {
    const clicks: string[] = []
    const popup = makePopup({ titles: ['Transaction request'], texts: ['Approve'], clicks, closeOnClick: true })
    await new SubWalletAdapter().confirmTx(popup)
    expect(clicks).toEqual(['button:has-text("Approve")'])
  })

  it('dApp alert 挡住 Approve：先点右侧确认，再点 Approve', async () => {
    const clicks: string[] = []
    const popup = makePopup({
      titles: ['Signature request'],
      texts: ['Approve'],
      clicks,
      closeOnClick: true,
      dappAlert: true,
    })
    await new SubWalletAdapter().sign(popup)
    expect(clicks[0]).toContain('modal-id-dapp-alert-modal')
    expect(clicks[1]).toBe('button:has-text("Approve")')
    expect(clicks).toHaveLength(2)
  })

  it('handleLoginPopup：tx 不自动处理', async () => {
    const clicks: string[] = []
    const popup = makePopup({ titles: ['Transaction request'], texts: ['Approve'], clicks })
    expect(await new SubWalletAdapter().handleLoginPopup(popup, 'pw')).toBe(false)
    expect(clicks).toEqual([])
  })

  it('handleLoginPopup：unlock 缺密码返回 false', async () => {
    const clicks: string[] = []
    const popup = makePopup({ password: true, texts: ['Unlock'], clicks })
    expect(await new SubWalletAdapter().handleLoginPopup(popup)).toBe(false)
    expect(clicks).toEqual([])
  })

  it('isPopupReady：授权页可见即就绪', async () => {
    const popup = makePopup({ texts: ['Connect'], clicks: [] })
    expect(await new SubWalletAdapter().isPopupReady!(popup)).toBe(true)
  })
})

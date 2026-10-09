import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PopupPage, PopupLocator } from '../src/automation/wallet/types'
import { WalletRegistry } from '../src/automation/wallet/types'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { WalletActions } from '../src/automation/wallet/actions'

vi.mock('../src/automation/wallet/popup', () => ({
  waitForPopup: vi.fn(),
}))

import { waitForPopup } from '../src/automation/wallet/popup'

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

/** 有状态弹窗 mock：unlock-password 在 fill 后消失（模拟真实解锁后 UI 变化） */
function makeLockedPopup(onFill: (t: string) => void): PopupPage {
  let locked = true
  return makePopup({
    getByTestId: (id: string) => {
      if (id === 'unlock-password') {
        return makeLocator({
          count: async () => (locked ? 1 : 0),
          fill: async (t: string) => { locked = false; onFill(t) },
        })
      }
      return makeLocator()
    },
  })
}

function makeActions(walletPasswords: Record<string, string>, walletSession?: never): WalletActions {
  const reg = new WalletRegistry()
  reg.register(new MetaMaskAdapter())
  return new WalletActions({
    page: { context: () => ({}) } as never,
    walletKey: 'metamask',
    wallets: reg,
    walletPasswords,
    walletSession,
    log: {} as never,
    recover: async () => false,
  })
}

describe('WalletActions.runIntent 密码按钱包类型取用', () => {
  beforeEach(() => {
    vi.mocked(waitForPopup).mockReset()
  })

  it('metamask/petra 密码不同：解锁使用 walletKey 对应类型的密码', async () => {
    const filled: string[] = []
    const popup = makeLockedPopup((t) => { filled.push(t) })
    vi.mocked(waitForPopup).mockResolvedValue(popup as never)
    const actions = makeActions({ metamask: 'mm-pw', petra: 'pt-pw' })
    await actions.runIntent('connect')
    expect(filled).toEqual(['mm-pw'])
  })

  it('该钱包类型未配置密码且钱包锁定：抛明确错误提示配置 WALLET_PASSWORDS', async () => {
    const filled: string[] = []
    const popup = makeLockedPopup((t) => { filled.push(t) })
    vi.mocked(waitForPopup).mockResolvedValue(popup as never)
    const actions = makeActions({ petra: 'pt-pw' })
    await expect(actions.runIntent('connect')).rejects.toThrow('MetaMask 已锁定且未配置解锁密码')
    expect(filled).toEqual([])
  })

  it('钱包弹窗等待 60s 且扫描全部 context', async () => {
    vi.mocked(waitForPopup).mockResolvedValue(makeLockedPopup(() => {}) as never)
    const actions = makeActions({ metamask: 'pw' })
    await actions.runIntent('connect')
    expect(vi.mocked(waitForPopup).mock.calls[0][2]).toBe(60000)
  })
})

describe('WalletActions.ready 扩展就绪检查', () => {
  it('会话报告 missing → 抛「扩展未加载」提示重启窗口', async () => {
    const session = { ensureReady: vi.fn().mockResolvedValue('missing') }
    const actions = makeActions({}, session as never)
    await expect(actions.ready()).rejects.toThrow('钱包扩展未加载')
  })

  it('会话报告 ready → 正常通过', async () => {
    const session = { ensureReady: vi.fn().mockResolvedValue('ready') }
    const actions = makeActions({}, session as never)
    await expect(actions.ready()).resolves.toBeUndefined()
  })

  it('未注入会话（脚本/旧装配兼容）→ 跳过检查不抛错', async () => {
    const actions = makeActions({})
    await expect(actions.ready()).resolves.toBeUndefined()
  })
})

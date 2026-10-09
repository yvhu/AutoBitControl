import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalletActions, type LoginSpec, type WalletActionsDeps } from '../src/automation/wallet'
import { WalletRegistry } from '../src/automation/wallet/types'

vi.mock('../src/automation/wallet/popup', () => ({ waitForPopup: vi.fn() }))
import { waitForPopup } from '../src/automation/wallet/popup'

function adapter(over: Record<string, unknown> = {}) {
  return {
    key: 'metamask',
    extensionUrlPatterns: ['home'],
    extensionId: 'x', probePath: 'home.html', providerFlag: 'isMetaMask',
    unlock: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    sign: vi.fn(async () => {}),
    confirmTx: vi.fn(async () => {}),
    ...over,
  }
}

/** 登录态竞速：loggedInVisible 控制已登录文案是否可见 */
function deps(over: Partial<WalletActionsDeps> & { loggedInVisible?: boolean } = {}): WalletActionsDeps & { clicks: string[] } {
  const clicks: string[] = []
  let loggedIn = over.loggedInVisible ?? false
  const reg = new WalletRegistry()
  reg.register(adapter() as never)
  const base: WalletActionsDeps & { clicks: string[] } = {
    clicks,
    page: {
      context: () => ({}),
      getByText: (t: string) => {
        const visible = t === '已登录' ? loggedIn : t === 'Connect Wallet' ? !loggedIn : false
        return { first() { return this }, count: async () => (visible ? 1 : 0), isVisible: async () => visible, waitFor: async () => { if (!visible) throw new Error('未可见') } }
      },
      locator: (sel: string) => ({ first() { return this }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} }),
      waitForTimeout: async () => {},
      reload: async () => {},
      url: () => 'https://x/',
    } as never,
    walletKey: 'metamask',
    wallets: reg,
    walletPasswords: { metamask: 'pw' },
    log: { info: vi.fn(), warn: vi.fn() } as never,
    human: { click: vi.fn(async (s: string) => { clicks.push(s) }) },
    recover: vi.fn(async () => true),
    ...over,
  }
  return base
}

const SPEC: LoginSpec = { loggedIn: { text: '已登录' }, loggedOut: 'Connect Wallet', connect: 'button:has-text("Connect Wallet")', entry: { kind: 'direct' } }

describe('WalletActions.ensureLoggedIn', () => {
  beforeEach(() => vi.mocked(waitForPopup).mockReset())

  it('已登录 → 跳过，不点连接', async () => {
    const d = deps({ loggedInVisible: true })
    expect((await new WalletActions(d).ensureLoggedIn(SPEC)).skipped).toBe(true)
    expect(d.human.click).not.toHaveBeenCalled()
  })

  it('未登录 → 点连接 + 等弹窗 + 解锁 + 连接，最后 recover 等登录完成', async () => {
    vi.mocked(waitForPopup).mockResolvedValue({ url: () => 'home', waitForEvent: async () => {}, isClosed: () => false, getByTestId: () => ({ count: async () => 1, fill: async () => {}, click: async () => {}, first() { return this } }), getByRole: () => ({ first() { return this }, count: async () => 1, click: async () => {} }), locator: () => ({ first() { return this }, count: async () => 0, click: async () => {} }) } as never)
    const d = deps()
    await new WalletActions(d).ensureLoggedIn(SPEC)
    expect(d.clicks).toContain('button:has-text("Connect Wallet")')
    expect(d.recover).toHaveBeenCalled()
  })

  it('弹窗未出现 → 静默连接容忍（不抛错），仍走 recover', async () => {
    vi.mocked(waitForPopup).mockResolvedValue(null)
    const d = deps()
    await expect(new WalletActions(d).ensureLoggedIn(SPEC)).resolves.toBeDefined()
    expect(d.recover).toHaveBeenCalled()
  })
})

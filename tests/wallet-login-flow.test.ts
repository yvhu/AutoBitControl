import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalletActions, type LoginSpec, type WalletActionsDeps } from '../src/automation/wallet'
import { WalletRegistry } from '../src/automation/wallet/types'

vi.mock('../src/automation/wallet/popup', () => ({ waitForPopup: vi.fn() }))
import { waitForPopup } from '../src/automation/wallet/popup'

vi.mock('../src/automation/wallet/appkit', () => ({ openAppKitWallet: vi.fn() }))
import { openAppKitWallet } from '../src/automation/wallet/appkit'

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
      locator: (sel: string) => ({ first() { return this }, click: async () => { clicks.push(sel) }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} }),
      waitForTimeout: async () => {},
      reload: async () => {},
      url: () => 'https://x/',
    } as never,
    walletKey: 'metamask',
    wallets: reg,
    walletPasswords: { metamask: 'pw' },
    log: { info: vi.fn(), warn: vi.fn() } as never,
    recover: vi.fn(async () => true),
    ...over,
  }
  return base
}

const SPEC: LoginSpec = { loggedIn: { text: '已登录' }, loggedOut: 'Connect Wallet', connect: 'button:has-text("Connect Wallet")', entry: { kind: 'direct' } }

describe('WalletActions.ensureLoggedIn', () => {
  beforeEach(() => {
    vi.mocked(waitForPopup).mockReset()
    vi.mocked(openAppKitWallet).mockReset()
  })

  it('已登录 → 跳过，不点连接', async () => {
    const d = deps({ loggedInVisible: true })
    expect((await new WalletActions(d).ensureLoggedIn(SPEC)).skipped).toBe(true)
    expect(d.clicks).toHaveLength(0)
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
    await expect(new WalletActions(d).ensureLoggedIn({ ...SPEC, attempts: 1, reclickAfterMs: 600 })).resolves.toBeDefined()
    expect(d.recover).toHaveBeenCalled()
  })

  it('waitForPopup 超时返回 null 不当作弹窗出现 → 仍按 reclickAfterMs 补点', async () => {
    vi.mocked(waitForPopup).mockResolvedValue(null)
    const d = deps()
    const spec: LoginSpec = { ...SPEC, attempts: 1, reclickAfterMs: 600 }
    await new WalletActions(d).ensureLoggedIn(spec)
    // 初次点击 spec.connect 后弹窗未出现，应按补点选择器再点一次（bug：null 被误判为弹窗，补点被跳过只剩 1 次）
    expect(d.clicks.filter((s) => s === spec.connect)).toHaveLength(2)
  })

  it('appkit 入口 → 补点选择器用钱包入口 testid（非 spec.connect）', async () => {
    vi.mocked(waitForPopup).mockResolvedValue(null)
    const d = deps()
    const spec: LoginSpec = {
      loggedIn: { text: '已登录' },
      loggedOut: 'Connect Wallet',
      entry: { kind: 'appkit', open: 'button.open', entryTestId: 'wallet-selector-io.metamask' },
      attempts: 1,
      reclickAfterMs: 600,
    }
    await new WalletActions(d).ensureLoggedIn(spec)
    expect(openAppKitWallet).toHaveBeenCalled()
    expect(d.clicks).toContain('[data-testid="wallet-selector-io.metamask"]')
  })
})

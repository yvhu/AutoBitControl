import { describe, it, expect, vi } from 'vitest'
import { openAppKitWallet, type AppKitEntry, type WalletActionsDeps } from '../src/automation/wallet'

const ENTRY: AppKitEntry = {
  open: 'button:has-text("WALLET")',
  entryTestId: 'wallet-selector-io.metamask',
}

const MODAL_SEL = '[data-testid="w3m-modal-card"]'
const WALLET_SEL = `[data-testid="${ENTRY.entryTestId}"]`

/**
 * 假 WalletActionsDeps：可见集合控制入口/归一化按钮可见性；
 * 归一化点击在 human.click 内模拟效果（点后入口出现）；page.locator().first().waitFor 供弹窗等待
 */
function makeDeps() {
  const visibleSel = new Set<string>()
  const click = vi.fn(async (sel: string) => {
    if (sel === '[data-testid="header-back"]') visibleSel.add(WALLET_SEL)
    if (sel === '[data-testid="all-wallets"]') visibleSel.add(WALLET_SEL)
    if (sel === '[data-testid="tab-browser"]') visibleSel.add(WALLET_SEL)
  })
  const waitFor = vi.fn(async () => {})
  const makeLocator = (sel: string) => {
    const loc = {
      first: () => loc,
      waitFor,
      count: async () => (visibleSel.has(sel) ? 1 : 0),
      isVisible: async () => visibleSel.has(sel),
    }
    return loc
  }
  const deps = {
    page: { locator: (sel: string) => makeLocator(sel), waitForTimeout: vi.fn(async () => {}) },
    walletKey: 'metamask',
    human: { click },
  } as unknown as WalletActionsDeps
  return {
    deps,
    click,
    waitFor,
    setVisible: (sel: string, v: boolean) => (v ? visibleSel.add(sel) : visibleSel.delete(sel)),
  }
}

describe('openAppKitWallet 归一化', () => {
  it('先点打开按钮 + 等弹窗，入口直接可见 → 点入口', async () => {
    const { deps, click, waitFor, setVisible } = makeDeps()
    setVisible(WALLET_SEL, true)
    await openAppKitWallet(deps, ENTRY)
    expect(click).toHaveBeenCalledWith(ENTRY.open)
    expect(waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 45000 })
    expect(click).toHaveBeenCalledWith(WALLET_SEL)
  })

  it('QR 视图（header-back）→ 回退后命中入口', async () => {
    const { deps, click, setVisible } = makeDeps()
    setVisible('[data-testid="header-back"]', true)
    await openAppKitWallet(deps, ENTRY)
    expect(click).toHaveBeenCalledWith('[data-testid="header-back"]')
    expect(click).toHaveBeenCalledWith(WALLET_SEL)
  })

  it('列表收起（all-wallets）→ 展开后命中入口', async () => {
    const { deps, click, setVisible } = makeDeps()
    setVisible('[data-testid="all-wallets"]', true)
    await openAppKitWallet(deps, ENTRY)
    expect(click).toHaveBeenCalledWith('[data-testid="all-wallets"]')
    expect(click).toHaveBeenCalledWith(WALLET_SEL)
  })

  it('tab-browser 切换 → 命中入口', async () => {
    const { deps, click, setVisible } = makeDeps()
    setVisible('[data-testid="tab-browser"]', true)
    await openAppKitWallet(deps, ENTRY)
    expect(click).toHaveBeenCalledWith('[data-testid="tab-browser"]')
    expect(click).toHaveBeenCalledWith(WALLET_SEL)
  })

  it('归一化轮数耗尽仍未命中 → 抛错（含钱包 key）', async () => {
    const { deps } = makeDeps()
    await expect(openAppKitWallet(deps, ENTRY)).rejects.toThrow('AppKit 弹窗未出现 metamask 钱包入口')
  })

  it('未命中时不点入口（只点打开按钮）', async () => {
    const { deps, click } = makeDeps()
    await expect(openAppKitWallet(deps, ENTRY)).rejects.toThrow()
    expect(click).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledWith(ENTRY.open)
  })
})

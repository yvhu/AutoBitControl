import { describe, it, expect, vi } from 'vitest'
import { openAppKitWallet, type AppKitLoginOptions } from '../src/engine/appkit'

const OPTS: AppKitLoginOptions = {
  walletKey: 'metamask',
  openSelector: 'button:has-text("WALLET")',
  entryTestId: 'wallet-selector-io.metamask',
}

/** 假 ctx：visible 按可见集合判定；归一化点击记录在 human.click */
function makeCtx(over: Partial<Record<'visible', (sel: string) => boolean>> = {}) {
  const visibleSel = new Set<string>()
  const visible = over.visible ?? ((sel: string) => visibleSel.has(sel))
  const click = vi.fn(async (sel: string) => {
    // 模拟归一化点击的效果：点 header-back → 入口出现
    if (sel === '[data-testid="header-back"]') visibleSel.add(`[data-testid="${OPTS.entryTestId}"]`)
    if (sel === '[data-testid="all-wallets"]') visibleSel.add(`[data-testid="${OPTS.entryTestId}"]`)
    if (sel === '[data-testid="tab-browser"]') visibleSel.add(`[data-testid="${OPTS.entryTestId}"]`)
  })
  const ctx = {
    human: { click },
    assertVisible: vi.fn().mockResolvedValue(undefined),
    visible: vi.fn(async (sel: string) => visible(sel)),
    page: { waitForTimeout: vi.fn().mockResolvedValue(undefined) },
    loginByWallet: vi.fn().mockResolvedValue(undefined),
  }
  return { ctx: ctx as never, click, visibleSel, setVisible: (sel: string, v: boolean) => (v ? visibleSel.add(sel) : visibleSel.delete(sel)) }
}

describe('openAppKitWallet 登录封装', () => {
  it('入口直接可见 → 点击入口 + 弹窗连接，返回 false', async () => {
    const { ctx, click, setVisible } = makeCtx()
    setVisible(`[data-testid="${OPTS.entryTestId}"]`, true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
    expect(click).toHaveBeenCalledWith(OPTS.openSelector)
    expect(click).toHaveBeenCalledWith(`[data-testid="${OPTS.entryTestId}"]`)
    expect((ctx as never as { loginByWallet: ReturnType<typeof vi.fn> }).loginByWallet).toHaveBeenCalledWith({ reclick: { selector: `[data-testid="${OPTS.entryTestId}"]`, afterMs: 8000 } })
  })

  it('QR 视图（header-back）→ 回退后命中入口', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible('[data-testid="header-back"]', true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
  })

  it('列表收起（all-wallets）→ 展开后命中入口', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible('[data-testid="all-wallets"]', true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
  })

  it('tab-browser 切换 → 命中入口', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible('[data-testid="tab-browser"]', true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
  })

  it('归一化轮数耗尽仍未命中 → 抛错', async () => {
    const { ctx } = makeCtx()
    await expect(openAppKitWallet(ctx, OPTS)).rejects.toThrow('AppKit 弹窗未出现 metamask 钱包入口')
  })

  it('钱包弹窗未出现 → 返回 true（静默连接容忍）；其它错误继续抛出', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible(`[data-testid="${OPTS.entryTestId}"]`, true)
    const { loginByWallet } = ctx as never as { loginByWallet: ReturnType<typeof vi.fn> }
    loginByWallet.mockRejectedValueOnce(new Error('钱包弹窗未出现'))
    expect(await openAppKitWallet(ctx, OPTS)).toBe(true)
    loginByWallet.mockRejectedValueOnce(new Error('其它错误'))
    await expect(openAppKitWallet(ctx, OPTS)).rejects.toThrow('其它错误')
  })
})

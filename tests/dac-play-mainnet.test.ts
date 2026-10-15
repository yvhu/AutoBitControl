/**
 * DacPlayMainnetTask 单测（注入假页面，不连真浏览器）
 * 覆盖：登录编排（打开主网页 → 0x 判已登录 / Connect wallet / 无钱包列表 / 多轮重试 / 授权弹窗自动确认）
 *       领 chip（新标签页或当前页直达两种打开方式都能兜住）
 */
import { describe, it, expect, vi } from 'vitest'
import { DacPlayMainnetTask } from '../src/tasks/dac-play-mainnet'
import { TaskContext } from '../src/tasks/base'
import { WalletActions } from '../src/automation'

const URL = 'https://interstellar.dachain.io/'

/** 假页面：记录 goto 的目标；context().pages() 供 openPage(closeOtherTabs) 使用 */
function makeFakePage() {
  const gotos: string[] = []
  return {
    gotos,
    context: () => ({ pages: () => [] }),
    goto: async (u: string) => { gotos.push(u) },
    url: () => URL,
  }
}

function makeCtx(page: unknown): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new DacPlayMainnetTask(),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('DacPlayMainnetTask 登录编排', () => {
  it('meta：key/名称/分类/钱包正确', () => {
    const t = new DacPlayMainnetTask()
    expect(t.meta.key).toBe('dac-play-mainnet')
    expect(t.meta.name).toBe('DAC Play（主网）')
    expect(t.meta.category).toBe('other')
    expect(t.meta.wallet).toBe('metamask')
    expect(t.meta.enabled).toBe(false)
  })

  it('run：打开主网页并以 0x 判登录态、点 Connect wallet、无钱包列表、多轮重试', async () => {
    const page = makeFakePage()
    const ctx = makeCtx(page)
    let captured: Record<string, unknown> | undefined
    const spy = vi.spyOn(WalletActions.prototype, 'ensureConnected').mockImplementation(async (opts) => {
      captured = opts as Record<string, unknown>
      throw new Error('__connect__')
    })
    try {
      await expect(new DacPlayMainnetTask().run(ctx)).rejects.toThrow('__connect__')
    } finally {
      spy.mockRestore()
    }
    expect(page.gotos).toContain(URL)
    expect(captured?.connected).toEqual({ text: '0x' })
    expect(captured?.disconnected).toBe('Connect wallet')
    expect(captured?.connect).toBe('button:has-text("Connect wallet")')
    expect(captured?.walletOption).toBeUndefined() // 真机无站内钱包列表
    expect(captured?.attempts).toBe(3) // 登录可能需多次尝试
    expect(captured?.autoConfirmTransaction).toBe(true) // 0 撸站点：授权确认弹窗自动确认
  })
})

/**
 * 假页面（领 chip）：mode 决定 Play 的打开方式——
 * popup=开新标签页（context.pages 返回 game）；same=当前页直达（Claim 出现在 ctx.page）；none=都不出现。
 * 按选择器控制 Claim/Claimed 是否可见，并记录各自点击。
 */
function makeClaimPage(opts: { mode: 'popup' | 'same' | 'none'; claimAppears: boolean; claimedAppears: boolean }) {
  const mainClicks: string[] = []
  const gameClicks: string[] = []
  const makeLoc = (sel: string, clicks: string[], isGame: boolean) => {
    // 当前页可用 = same 模式；游戏页恒可用
    const owned = isGame || opts.mode === 'same'
    const visible = (): boolean => {
      if (sel.includes('Claimed')) return owned && opts.claimedAppears
      if (sel.includes('Claim')) return owned && opts.claimAppears
      return false
    }
    return {
      first: () => ({
        count: async () => (visible() ? 1 : 0),
        isVisible: async () => visible(),
        click: async () => { clicks.push(sel) },
        waitFor: async () => { if (!visible()) throw new Error('timeout') },
      }),
    }
  }
  const game = {
    locator: (sel: string) => makeLoc(sel, gameClicks, true),
    url: () => 'https://interstellar.dachain.io/game/',
    screenshot: async () => '/tmp/x.png',
  }
  const page = {
    context: () => ({ pages: () => (opts.mode === 'popup' ? [game] : []) }),
    locator: (sel: string) => makeLoc(sel, mainClicks, false),
    waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, ms)) },
    url: () => URL,
    screenshot: async () => '/tmp/x.png',
  }
  return { page, mainClicks, gameClicks }
}

describe('DacPlayMainnetTask 领 chip（新标签页或当前页）', () => {
  const helpers = new DacPlayMainnetTask() as unknown as { claimChip(ctx: TaskContext): Promise<void> }

  it('新标签页模式：Play 开新页 → 点 Claim → 出现 Claimed → 成功', async () => {
    const { page, gameClicks } = makeClaimPage({ mode: 'popup', claimAppears: true, claimedAppears: true })
    await expect(helpers.claimChip(makeCtx(page))).resolves.toBeUndefined()
    expect(gameClicks.some((s) => s.includes('Claim'))).toBe(true)
  })

  it('当前页直达模式：Play 当前页跳转 → 点 Claim → 出现 Claimed → 成功', async () => {
    const { page, mainClicks } = makeClaimPage({ mode: 'same', claimAppears: true, claimedAppears: true })
    await expect(helpers.claimChip(makeCtx(page))).resolves.toBeUndefined()
    expect(mainClicks.some((s) => s.includes('Claim'))).toBe(true)
  })

  it('游戏页未出现 Claim 按钮 → 抛错', async () => {
    const { page } = makeClaimPage({ mode: 'popup', claimAppears: false, claimedAppears: false })
    await expect(helpers.claimChip(makeCtx(page))).rejects.toThrow('未出现 Claim 按钮')
  })

  it('点 Claim 后未出现 Claimed 提示 → 抛错', async () => {
    const { page } = makeClaimPage({ mode: 'popup', claimAppears: true, claimedAppears: false })
    await expect(helpers.claimChip(makeCtx(page))).rejects.toThrow('未出现「Claimed')
  })

  it('既无新标签页也无当前页 Claim → 等满预算抛错', async () => {
    vi.useFakeTimers()
    try {
      const { page } = makeClaimPage({ mode: 'none', claimAppears: false, claimedAppears: false })
      const assertion = expect(helpers.claimChip(makeCtx(page))).rejects.toThrow('既未打开新标签页')
      await vi.advanceTimersByTimeAsync(31_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

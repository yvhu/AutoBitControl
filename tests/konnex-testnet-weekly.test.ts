/**
 * KonnexTestnetWeeklyTask 单测：Hub 完成态/登录分支、Quest 新标签页、双钱包流程与地址校验
 * 背景：任务跨 Hub/Quest 两个标签页，先 MetaMask 再 SubWallet，且不校验 walletAddress 具体值。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KonnexTestnetWeeklyTask } from '../src/tasks/konnex-testnet-weekly'
import { TaskContext } from '../src/tasks/base'

const mocks = vi.hoisted(() => ({
  openPage: vi.fn(),
  click: vi.fn(),
  connectWallet: vi.fn(),
  signMessage: vi.fn(),
  waitFor: vi.fn(),
  takeScreenshot: vi.fn(),
  takeElementScreenshot: vi.fn(),
  closeWalletPopups: vi.fn(),
  openTab: vi.fn(),
  waitInTab: vi.fn(),
  raceInTab: vi.fn(),
  clickInTab: vi.fn(),
  focusTab: vi.fn(),
  closeTab: vi.fn(),
}))

vi.mock('../src/api', () => ({ ...mocks }))

import { openPage, click, connectWallet, signMessage, takeScreenshot, takeElementScreenshot, closeWalletPopups, openTab, waitFor, waitInTab, closeTab } from '../src/api'

interface HubState {
  done: boolean
  link: boolean
  signIn: boolean
}

/** 假 Hub 页面：按选择器区分完成态/Testnet 入口/站内 Sign in */
function makeHubPage(state: HubState) {
  const isVisible = (selector: string): boolean => {
    if (selector.includes('Great job!')) return state.done
    if (selector.includes('/quest?walletAddress=')) return state.link
    if (selector.includes('Sign in')) return state.signIn
    return false
  }
  return {
    state,
    locator: (selector: string) => ({
      first: () => ({
        count: async () => (isVisible(selector) ? 1 : 0),
        isVisible: async () => isVisible(selector),
        click: async () => {},
      }),
    }),
    getByText: () => ({ count: async () => 0 }),
    waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    reload: vi.fn(async () => {}),
    url: () => 'https://hub.konnex.world/points',
    context: () => ({ pages: () => [] }),
    bringToFront: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
}

function makeQuestPage(url = 'https://subnets.testnet.konnex.world/quest?walletAddress=0xabc') {
  return {
    url: () => url,
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    locator: () => ({
      first: () => ({ count: async () => 1, isVisible: async () => true, click: vi.fn(async () => {}) }),
    }),
  }
}

function makeCtx(page: ReturnType<typeof makeHubPage>): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new KonnexTestnetWeeklyTask(),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: { metamask: 'pw', subwallet: 'pw' },
  })
}

describe('KonnexTestnetWeeklyTask', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.openPage.mockResolvedValue(undefined)
    mocks.click.mockResolvedValue(undefined)
    mocks.connectWallet.mockResolvedValue(undefined)
    mocks.signMessage.mockResolvedValue({ popupFailed: false })
    mocks.waitFor.mockResolvedValue(true)
    mocks.takeScreenshot.mockResolvedValue('')
    mocks.takeElementScreenshot.mockResolvedValue('')
    mocks.closeWalletPopups.mockResolvedValue(0)
    mocks.openTab.mockResolvedValue(makeQuestPage())
    mocks.waitInTab.mockResolvedValue(true)
    mocks.raceInTab.mockResolvedValue('ready')
    mocks.clickInTab.mockResolvedValue(undefined)
    mocks.focusTab.mockResolvedValue(undefined)
    mocks.closeTab.mockResolvedValue(undefined)
  })

  it('meta：key/url/钱包/开关/分组正确', () => {
    const t = new KonnexTestnetWeeklyTask()
    expect(t.meta.key).toBe('konnex-testnet-weekly')
    expect(t.meta.url).toBe('https://hub.konnex.world/points')
    expect(t.meta.wallet).toBe('metamask')
    expect(t.meta.enabled).toBe(true)
    expect(t.meta.group).toEqual({ key: 'konnex', name: 'Konnex' })
  })

  it('Hub 已是 Great job! → 直接成功，不登录、不开新标签', async () => {
    const page = makeHubPage({ done: true, link: false, signIn: false })
    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(connectWallet).not.toHaveBeenCalled()
    expect(openTab).not.toHaveBeenCalled()
    expect(takeElementScreenshot).toHaveBeenCalledWith(expect.anything(), 'konnex-testnet-weekly-success', '#loyalty-quest-root-external_rule')
  })

  it('需要登录 → 走 Konnex Hub 登录后继续 Quest 流程', async () => {
    vi.useFakeTimers()
    try {
      const state: HubState = { done: false, link: false, signIn: true }
      const page = makeHubPage(state)
      mocks.connectWallet.mockImplementation(async () => {
        state.signIn = false
        state.link = true
      })

      const done = new KonnexTestnetWeeklyTask().run(makeCtx(page))
      await vi.advanceTimersByTimeAsync(7000)
      await done

      expect(connectWallet).toHaveBeenCalledTimes(1)
      const spec = mocks.connectWallet.mock.calls[0][1]
      expect(spec.wallet).toBe('metamask')
      expect(spec.connect).toContain('Sign in')
      expect(spec.confirm).toBe('text=Connect with Ethereum')
      expect(spec.walletOption).toEqual({ text: 'MetaMask' })
      expect(openTab).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('完整流程（RPC 已就绪）→ 点 Next/Get/Submit、SubWallet 签名、回 Hub 等完成态', async () => {
    const quest = makeQuestPage()
    mocks.openTab.mockResolvedValue(quest)
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(openTab).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      urlIncludes: '/quest?walletAddress=',
      timeoutMs: 30000,
    })
    expect(connectWallet).not.toHaveBeenCalled()
    expect(mocks.clickInTab).toHaveBeenCalledTimes(4)
    expect(signMessage).toHaveBeenCalledWith(expect.anything(), {
      wallet: 'metamask',
      page: quest,
      reclick: { selector: 'button:has-text("Verify Snag account"):not([disabled]):visible', afterMs: 15000 },
    })
    expect(signMessage).toHaveBeenCalledWith(expect.anything(), {
      wallet: 'subwallet',
      page: quest,
      reclick: { selector: 'button:has-text("Submit drone request"):visible', afterMs: 15000 },
    })
    expect(closeTab).toHaveBeenCalledWith(expect.anything(), quest)
    expect(openPage).toHaveBeenCalledTimes(2)
    expect(waitFor).toHaveBeenCalled()
    expect(takeElementScreenshot).toHaveBeenCalledWith(expect.anything(), 'konnex-testnet-weekly-success', '#loyalty-quest-root-external_rule')
  })

  it('Verify Snag 签名报错但页面已推进 → 不重试，按成功继续', async () => {
    mocks.signMessage.mockRejectedValueOnce(new Error('MetaMask 连接确认未完成（弹窗未关闭）'))
    const quest = makeQuestPage()
    mocks.openTab.mockResolvedValue(quest)
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(closeWalletPopups).toHaveBeenCalledTimes(1)
    expect(mocks.clickInTab).toHaveBeenCalledTimes(4)
    expect(signMessage).toHaveBeenCalledTimes(2)
    expect(takeElementScreenshot).toHaveBeenCalledWith(expect.anything(), 'konnex-testnet-weekly-success', '#loyalty-quest-root-external_rule')
  })

  it('Verify Snag 失败且页面未推进 → 清弹窗重试 1 次后成功', async () => {
    let snagChecks = 0
    mocks.raceInTab.mockImplementation(async (_page: unknown, entries: Array<[string, unknown]>) => {
      const keys = entries.map(([k]) => k)
      if (keys.includes('knx')) {
        snagChecks++
        return snagChecks === 1 ? null : 'knx'
      }
      return 'ready'
    })
    mocks.signMessage.mockRejectedValueOnce(new Error('MetaMask 连接确认未完成（弹窗未关闭）'))
    const quest = makeQuestPage()
    mocks.openTab.mockResolvedValue(quest)
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(closeWalletPopups).toHaveBeenCalledTimes(2)
    expect(mocks.clickInTab).toHaveBeenCalledTimes(5)
    expect(signMessage).toHaveBeenCalledTimes(3)
    expect(takeElementScreenshot).toHaveBeenCalledWith(expect.anything(), 'konnex-testnet-weekly-success', '#loyalty-quest-root-external_rule')
  })

  it('Verify Snag 两次失败且页面未推进 → 抛原错误', async () => {
    mocks.raceInTab.mockImplementation(async (_page: unknown, entries: Array<[string, unknown]>) => {
      const keys = entries.map(([k]) => k)
      return keys.includes('knx') ? null : 'ready'
    })
    mocks.signMessage.mockRejectedValue(new Error('MetaMask 连接确认未完成（弹窗未关闭）'))
    const quest = makeQuestPage()
    mocks.openTab.mockResolvedValue(quest)
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await expect(new KonnexTestnetWeeklyTask().run(makeCtx(page))).rejects.toThrow('MetaMask 连接确认未完成')
    expect(closeWalletPopups).toHaveBeenCalledTimes(2)
  })

  it('Verify Snag account 不可点（已验证过）→ 跳过该步，只点 Next/Get/Submit', async () => {
    mocks.waitInTab.mockImplementation(async (_ctx: unknown, _page: unknown, matcher: unknown) => {
      return !JSON.stringify(matcher).includes('Verify Snag account')
    })
    const quest = makeQuestPage()
    mocks.openTab.mockResolvedValue(quest)
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(mocks.clickInTab).toHaveBeenCalledTimes(3)
    expect(signMessage).toHaveBeenCalledTimes(1)
    expect(signMessage).toHaveBeenCalledWith(expect.anything(), {
      wallet: 'subwallet',
      page: quest,
      reclick: { selector: 'button:has-text("Submit drone request"):visible', afterMs: 15000 },
    })
  })

  it('KNX Wallet 未连接 → 用 SubWallet 连接内容区按钮，再继续 Next', async () => {
    mocks.waitInTab.mockImplementation(async (_ctx: unknown, _page: unknown, matcher: unknown) => {
      return !JSON.stringify(matcher).includes('RPC URL')
    })
    const quest = makeQuestPage()
    mocks.openTab.mockResolvedValue(quest)
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(connectWallet).toHaveBeenCalledTimes(1)
    const spec = mocks.connectWallet.mock.calls[0][1]
    expect(spec.wallet).toBe('subwallet')
    expect(spec.page).toBe(quest)
    expect(spec.connect).toBe('section button:has-text("Connect wallet"):visible')
    expect(spec.connected).toEqual({ selector: 'div:has-text("RPC URL"):visible' })
  })

  it('Quest 页需要连接 EVM 钱包 → 用 MetaMask 在 Quest 页完成连接', async () => {
    mocks.raceInTab.mockResolvedValue('connect')
    const quest = makeQuestPage()
    mocks.openTab.mockResolvedValue(quest)
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(connectWallet).toHaveBeenCalledTimes(1)
    const spec = mocks.connectWallet.mock.calls[0][1]
    expect(spec.wallet).toBe('metamask')
    expect(spec.page).toBe(quest)
    expect(spec.connect).toBe('button:has-text("Connect EVM wallet"):visible')
    expect(spec.connected).toEqual({ selector: 'button:has-text("Reconnect EVM wallet"):visible' })
  })

  it('新标签页地址不是 Quest 页 → 抛错并截 Quest 失败图', async () => {
    mocks.openTab.mockResolvedValue(makeQuestPage('https://evil.example/quest?walletAddress=0xabc'))
    const page = makeHubPage({ done: false, link: true, signIn: false })

    await expect(new KonnexTestnetWeeklyTask().run(makeCtx(page))).rejects.toThrow('Quest 页地址不符')
    expect(takeScreenshot).toHaveBeenCalledWith(expect.anything(), 'konnex-testnet-weekly-quest-failed', expect.anything())
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('点击 Testnet 未开新标签但卡片变为完成态 → 按成功收尾', async () => {
    const state: HubState = { done: false, link: true, signIn: false }
    const page = makeHubPage(state)
    mocks.click.mockImplementation(async () => { state.done = true })
    mocks.openTab.mockImplementation(async (_ctx: unknown, trigger: () => Promise<void>) => {
      await trigger()
      throw new Error('等待新标签页超时')
    })

    await new KonnexTestnetWeeklyTask().run(makeCtx(page))

    expect(takeElementScreenshot).toHaveBeenCalledWith(expect.anything(), 'konnex-testnet-weekly-success', '#loyalty-quest-root-external_rule')
    expect(closeTab).not.toHaveBeenCalled()
  })
})

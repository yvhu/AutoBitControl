import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalletActions, type LoginFlowOptions, type WalletActionsDeps } from '../src/automation/wallet'
import { WalletRegistry } from '../src/automation/wallet/types'
import { WALLET_LIST_REVEAL_SELECTORS } from '../src/automation/wallet/heuristics'
import { waitForPopup } from '../src/automation/wallet/popup'

vi.mock('../src/automation/wallet/popup', () => ({ waitForPopup: vi.fn() }))

/** 永不落定的 waitForPopup：用于「无扩展弹窗」场景，避免与页面竞速抢先落定 */
const neverPopup = (): Promise<never> => new Promise<never>(() => {})

const CONNECT_SEL = 'button:has-text("Connect Wallet")'
const CONNECTED_TEXT = 'Connected'
const DISCONNECTED_TEXT = 'Connect Wallet'

/** 假适配器：displayName 驱动 walletOption 缺省匹配；classify/handle 可注入 */
function makeAdapter(over: Record<string, unknown> = {}) {
  return {
    key: 'metamask',
    displayName: 'MetaMask',
    extensionUrlPatterns: ['home'],
    extensionId: 'x',
    probePath: 'home.html',
    providerFlag: 'isMetaMask',
    classifyPopup: vi.fn(async () => 'connect'),
    handleLoginPopup: vi.fn(async () => true),
    unlock: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    sign: vi.fn(async () => {}),
    confirmTx: vi.fn(async () => {}),
    ...over,
  }
}

/** 假页面状态机：state[key] 控制各探针/选择器是否可见；onClick 触发状态流转 */
interface FakeState {
  [key: string]: boolean | ((sel: string) => void) | string[]
}

interface FakePage extends Record<string, unknown> {
  clicks: string[]
}

/**
 * 假 page：getByText/locator 按 key 读取可见性；waitFor 不可见时挂起至 timeout 再抛错，
 * 从而让「扩展弹窗」这类即时结果能在竞速中确定性地先落定。
 */
function makePage(state: FakeState): FakePage {
  const clicks: string[] = []
  const onClick = (typeof state.onClick === 'function' ? state.onClick : () => {}) as (sel: string) => void
  const visible = (key: string): boolean => state[key] === true
  const locatorFor = (key: string) => {
    const loc = {
      first() { return loc },
      count: async () => (visible(key) ? 1 : 0),
      isVisible: async () => visible(key),
      waitFor: async (o?: { state?: string; timeout?: number }) => {
        if (visible(key)) return
        await new Promise((r) => setTimeout(r, o?.timeout ?? 0))
        if (!visible(key)) throw new Error(`未可见: ${key}`)
      },
      click: async () => {
        clicks.push(key)
        onClick(key)
      },
    }
    return loc
  }
  return {
    clicks,
    getByText: (text: string) => locatorFor(text),
    locator: (sel: string) => locatorFor(sel),
    context: () => ({}),
    reload: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    url: () => 'https://site/',
  }
}

/** 构造注入假件依赖：page + 注册表 + 会话 + 日志 + recover */
function makeDeps(adapter: ReturnType<typeof makeAdapter>, state: FakeState, over: Partial<WalletActionsDeps> = {}) {
  const reg = new WalletRegistry()
  reg.register(adapter as never)
  const page = makePage(state)
  const deps = {
    page: page as never,
    walletKey: 'metamask',
    wallets: reg,
    walletPasswords: { metamask: 'pw' } as Record<string, string>,
    log: { info: vi.fn(), warn: vi.fn() } as never,
    recover: vi.fn(async () => state[CONNECTED_TEXT] === true),
    ...over,
  } as WalletActionsDeps
  return { deps, page }
}

describe('WalletActions.ensureConnected 自适应连接', () => {
  beforeEach(() => {
    vi.mocked(waitForPopup).mockReset()
    vi.mocked(waitForPopup).mockImplementation(neverPopup)
  })

  it('已连接 → 直接返回 skipped=true，不检查扩展就绪、不点任何按钮', async () => {
    const ensureReady = vi.fn(async () => 'ready' as const)
    const { deps, page } = makeDeps(makeAdapter(), { [CONNECTED_TEXT]: true }, { walletSession: { ensureReady } as never })
    const r = await new WalletActions(deps).ensureConnected({
      connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL,
    })
    expect(r.skipped).toBe(true)
    expect(ensureReady).not.toHaveBeenCalled()
    expect(page.clicks).toHaveLength(0)
  })

  it('站内钱包列表自动选：connect → 点默认钱包项（displayName）→ connected', async () => {
    const state: FakeState = {
      [DISCONNECTED_TEXT]: true,
      onClick: (sel: string) => {
        if (sel === CONNECT_SEL) { state[DISCONNECTED_TEXT] = false; state.MetaMask = true }
        if (sel === 'MetaMask') { state.MetaMask = false; state[CONNECTED_TEXT] = true }
      },
    }
    const { deps, page } = makeDeps(makeAdapter({ displayName: 'MetaMask' }), state)
    const spec: LoginFlowOptions = { connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL, reclickAfterMs: 30 }
    const r = await new WalletActions(deps).ensureConnected(spec)
    expect(r.skipped).toBe(false)
    expect(page.clicks).toContain(CONNECT_SEL)
    // walletOption 缺省 = 适配器 displayName
    expect(page.clicks).toContain('MetaMask')
  })

  it('站内弹窗不在列表视图：先归一化露出钱包项再点击 → connected', async () => {
    const REVEAL = '[data-testid="all-wallets"]'
    const state: FakeState = {
      [DISCONNECTED_TEXT]: true,
      [REVEAL]: true,
      onClick: (sel: string) => {
        if (sel === CONNECT_SEL) state[DISCONNECTED_TEXT] = false
        if (sel === REVEAL) { state[REVEAL] = false; state.MetaMask = true }
        if (sel === 'MetaMask') { state.MetaMask = false; state[CONNECTED_TEXT] = true }
      },
    }
    const { deps, page } = makeDeps(makeAdapter({ displayName: 'MetaMask' }), state)
    const r = await new WalletActions(deps).ensureConnected({
      connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL, reclickAfterMs: 30,
    })
    expect(r.skipped).toBe(false)
    expect(page.clicks).toContain(REVEAL)
    expect(page.clicks).toContain('MetaMask')
  })

  it('连接流程未启动（找不到连接按钮）→ 不做站内视图归一化，不误点站点返回/归一化候选', async () => {
    const REVEAL = '[data-testid="all-wallets"]'
    const state: FakeState = { [DISCONNECTED_TEXT]: true, [REVEAL]: true }
    const { deps, page } = makeDeps(makeAdapter(), state)
    // 不传 connect，且假页面找不到连接按钮 → clickConnect 返回 false，连接流程未启动
    await expect(new WalletActions(deps).ensureConnected({
      connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, attempts: 1,
    })).rejects.toThrow('登录未完成')
    expect(page.clicks).not.toContain(REVEAL)
  })

  it('归一化候选只含钱包弹窗专有选择器，不含页面级通用返回/aria 兜底', () => {
    expect(WALLET_LIST_REVEAL_SELECTORS).toContain('[data-testid="all-wallets"]')
    const broad = (s: string) => /has-text\("(返回|Back)"\)/.test(s) || /aria-label/i.test(s)
    expect(WALLET_LIST_REVEAL_SELECTORS.some(broad)).toBe(false)
  })

  it('配置缺省 walletOption 按适配器 displayName（非硬编码 MetaMask）', async () => {
    const state: FakeState = {
      [DISCONNECTED_TEXT]: true,
      onClick: (sel: string) => {
        if (sel === CONNECT_SEL) { state[DISCONNECTED_TEXT] = false; state.Phantom = true }
        if (sel === 'Phantom') { state.Phantom = false; state[CONNECTED_TEXT] = true }
      },
    }
    const { deps, page } = makeDeps(makeAdapter({ displayName: 'Phantom' }), state)
    const r = await new WalletActions(deps).ensureConnected({ connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL, reclickAfterMs: 30 })
    expect(r.skipped).toBe(false)
    expect(page.clicks).toContain('Phantom')
  })

  it('静默连接（无扩展弹窗）→ 点连接后 connected 出现即成功', async () => {
    const state: FakeState = {
      [DISCONNECTED_TEXT]: true,
      onClick: (sel: string) => {
        if (sel === CONNECT_SEL) { state[DISCONNECTED_TEXT] = false; state[CONNECTED_TEXT] = true }
      },
    }
    const { deps } = makeDeps(makeAdapter(), state)
    const r = await new WalletActions(deps).ensureConnected({ connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL, reclickAfterMs: 30 })
    expect(r.skipped).toBe(false)
    expect(vi.mocked(waitForPopup)).toHaveBeenCalled()
  })

  it('连接后自动签名：扩展弹窗分类 sign → 适配器自动处理 → connected', async () => {
    const state: FakeState = {
      [DISCONNECTED_TEXT]: true,
      onClick: (sel: string) => { if (sel === CONNECT_SEL) state[DISCONNECTED_TEXT] = false },
    }
    const popup = { url: () => 'chrome-extension://x/home.html' }
    const adapter = makeAdapter({
      classifyPopup: vi.fn(async () => 'sign'),
      handleLoginPopup: vi.fn(async () => { state[CONNECTED_TEXT] = true; return true }),
    })
    vi.mocked(waitForPopup).mockReset()
    vi.mocked(waitForPopup).mockResolvedValueOnce(popup as never).mockImplementation(neverPopup)
    const { deps } = makeDeps(adapter, state)
    const r = await new WalletActions(deps).ensureConnected({ connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL, reclickAfterMs: 30 })
    expect(r.skipped).toBe(false)
    expect(adapter.handleLoginPopup).toHaveBeenCalledWith(popup, 'pw')
    expect(adapter.sign).not.toHaveBeenCalled()
  })

  it('tx 弹窗绝不被登录流程处理：只告警、不点确认，最终超时报错', async () => {
    const state: FakeState = {
      [DISCONNECTED_TEXT]: true,
      onClick: (sel: string) => { if (sel === CONNECT_SEL) state[DISCONNECTED_TEXT] = false },
    }
    const popup = { url: () => 'chrome-extension://x/home.html' }
    const adapter = makeAdapter({ classifyPopup: vi.fn(async () => 'tx') })
    vi.mocked(waitForPopup).mockReset()
    vi.mocked(waitForPopup).mockResolvedValue(popup as never)
    const { deps } = makeDeps(adapter, state)
    await expect(new WalletActions(deps).ensureConnected({
      connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL, attempts: 1, reclickAfterMs: 30,
    })).rejects.toThrow('登录未完成')
    expect(adapter.handleLoginPopup).not.toHaveBeenCalled()
    expect(adapter.confirmTx).not.toHaveBeenCalled()
    const warn = (deps.log as unknown as { warn: ReturnType<typeof vi.fn> }).warn
    expect(warn).toHaveBeenCalled()
  })

  it('autoConfirmTransaction=true：tx 弹窗自动确认（0 撸站点无真实交易）→ connected', async () => {
    const state: FakeState = {
      [DISCONNECTED_TEXT]: true,
      onClick: (sel: string) => { if (sel === CONNECT_SEL) state[DISCONNECTED_TEXT] = false },
    }
    const popup = { url: () => 'chrome-extension://x/notification.html' }
    const adapter = makeAdapter({
      classifyPopup: vi.fn(async () => 'tx'),
      confirmTx: vi.fn(async () => { state[CONNECTED_TEXT] = true }),
    })
    vi.mocked(waitForPopup).mockReset()
    vi.mocked(waitForPopup).mockResolvedValueOnce(popup as never).mockImplementation(neverPopup)
    const { deps } = makeDeps(adapter, state)
    const r = await new WalletActions(deps).ensureConnected({
      connected: { text: CONNECTED_TEXT }, disconnected: DISCONNECTED_TEXT, connect: CONNECT_SEL,
      attempts: 1, reclickAfterMs: 30, autoConfirmTransaction: true,
    })
    expect(r.skipped).toBe(false)
    expect(adapter.confirmTx).toHaveBeenCalledWith(popup)
  })
})

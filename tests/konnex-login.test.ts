/**
 * KonnexCheckinTask 登录编排单测：登录是多段确认，不能用 Balance 判登录
 * 背景：站点流程为 站内 Sign in → Connect with Ethereum → MetaMask 连接 → SIWE 签名。
 * 钱包已连接但 session 未认证时 Balance 也会出现，旧逻辑会误判已登录并跳过后续确认，
 * 导致签到卡保持锁定（真机日志：只处理了 unlock，没有 sign，随后报「签到卡片未出现」）。
 * 现改为以签到按钮出现作为登录完成标志，先判已签到态，再决定是否登录。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KonnexCheckinTask } from '../src/tasks/konnex-checkin'
import { TaskContext } from '../src/tasks/base'

vi.mock('../src/api', () => ({
  openPage: vi.fn(async () => {}),
  connectWallet: vi.fn(async () => {}),
  race: vi.fn(async () => 'success'),
  evaluate: vi.fn(async () => ''),
  takeScreenshot: vi.fn(async () => ''),
}))

import { openPage, connectWallet, race } from '../src/api'

interface FakeState {
  button: boolean
  signIn: boolean
  done: boolean
}

/** 假页面：按选择器区分签到按钮/站内 Sign in/已签到态 */
function makePage(opts: Partial<FakeState> = {}) {
  const state: FakeState = { button: false, signIn: false, done: false, ...opts }
  const clicks: string[] = []
  const isVisible = (sel: string): boolean => {
    if (sel.includes('Great job!') || sel.includes('RESETS IN')) return state.done
    if (sel.includes('Sign in')) return state.signIn
    if (sel.includes('Check in')) return state.button
    return false
  }
  return {
    state,
    clicks,
    locator: (sel: string) => ({
      first: () => ({
        count: async () => (isVisible(sel) ? 1 : 0),
        isVisible: async () => isVisible(sel),
        click: async () => { clicks.push(sel) },
      }),
    }),
    waitForTimeout: async () => {},
    getByText: () => ({ count: async () => 0 }),
    screenshot: async () => '',
  }
}

function makeCtx(page: ReturnType<typeof makePage>): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new KonnexCheckinTask(),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

const helpers = new KonnexCheckinTask() as unknown as {
  waitCheckinState(ctx: TaskContext): Promise<'done' | 'ready' | 'needLogin'>
}

describe('KonnexCheckinTask 多段登录', () => {
  beforeEach(() => {
    vi.mocked(openPage).mockClear()
    vi.mocked(connectWallet).mockClear()
    vi.mocked(race).mockClear()
  })

  it('未登录（站内 Sign in 可见）→ 走 Sign in → Connect with Ethereum 登录，再签到', async () => {
    const page = makePage({ signIn: true })
    vi.mocked(connectWallet).mockImplementation(async () => { page.state.button = true })
    const ctx = makeCtx(page)

    await new KonnexCheckinTask().run(ctx)

    expect(connectWallet).toHaveBeenCalledTimes(1)
    const spec = vi.mocked(connectWallet).mock.calls[0][1]
    expect(spec.connect).toBe('[data-testid="connect-wallet-button"]:has-text("Sign in")')
    expect(spec.confirm).toBe('text=Connect with Ethereum')
    expect(spec.connected).toEqual({ selector: 'button:has-text("Check in")' })
    expect(JSON.stringify(spec)).not.toContain('Balance')
    expect(page.clicks).toContain('button:has-text("Check in")')
  })

  it('本周已签到 → 不登录、不点击', async () => {
    const page = makePage({ done: true })
    await new KonnexCheckinTask().run(makeCtx(page))

    expect(connectWallet).not.toHaveBeenCalled()
    expect(page.clicks).toHaveLength(0)
  })

  it('已登录待签到 → 直接签到，不登录', async () => {
    const page = makePage({ button: true })
    await new KonnexCheckinTask().run(makeCtx(page))

    expect(connectWallet).not.toHaveBeenCalled()
    expect(page.clicks).toContain('button:has-text("Check in")')
  })

  it('waitCheckinState：Sign in 可见且无按钮/已签到态 → needLogin', async () => {
    const page = makePage({ signIn: true })
    expect(await helpers.waitCheckinState(makeCtx(page))).toBe('needLogin')
  })
})

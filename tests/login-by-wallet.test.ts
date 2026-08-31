import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PopupPage, PopupLocator } from '../src/automation/wallet/types'
import { WalletRegistry } from '../src/automation/wallet/types'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { TaskContext, type SiteTask, type TaskMeta } from '../src/tasks/base'

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

class WalletTask implements SiteTask {
  meta: TaskMeta = { key: 'wallet-task', name: '钱包任务', url: '', wallet: 'metamask' }
  async run(_ctx: TaskContext) {}
}

function makeCtx(walletPasswords: Record<string, string>): TaskContext {
  const reg = new WalletRegistry()
  reg.register(new MetaMaskAdapter())
  const task = new WalletTask()
  return new TaskContext({
    page: { context: () => ({}) } as never,
    task,
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: {} as never,
    artifactsDir: '',
    walletPasswords,
    wallets: reg,
  })
}

describe('loginByWallet 密码按钱包类型取用', () => {
  beforeEach(() => {
    vi.mocked(waitForPopup).mockReset()
  })

  it('metamask/petra 密码不同：解锁使用 meta.wallet 对应类型的密码', async () => {
    const filled: string[] = []
    const popup = makePopup({
      getByTestId: (id: string) => id === 'unlock-password'
        ? makeLocator({ fill: async (t: string) => { filled.push(t) } })
        : makeLocator(),
    })
    vi.mocked(waitForPopup).mockResolvedValue(popup as never)
    const ctx = makeCtx({ metamask: 'mm-pw', petra: 'pt-pw' })
    await ctx.loginByWallet()
    expect(filled).toEqual(['mm-pw'])
  })

  it('该钱包类型未配置密码：跳过解锁直接走连接确认', async () => {
    const filled: string[] = []
    const popup = makePopup({
      getByTestId: (id: string) => id === 'unlock-password'
        ? makeLocator({ fill: async (t: string) => { filled.push(t) } })
        : makeLocator(),
    })
    vi.mocked(waitForPopup).mockResolvedValue(popup as never)
    const ctx = makeCtx({ petra: 'pt-pw' })
    await ctx.loginByWallet()
    expect(filled).toEqual([])
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface CapturedSpec {
  connected?: unknown
  disconnected?: unknown
  connect?: string
  walletOption?: unknown
  confirm?: string
  waitConnectedMs?: number
  errorTexts?: string[]
  refreshEveryMs?: number
  attempts?: number
  reclickAfterMs?: number
}

// 捕获自动化层 WalletActions 的实例与各动作调用，用于断言 api 层的映射
const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(async (_spec: CapturedSpec) => {}),
  sign: vi.fn(async () => ({ popupFailed: false })),
  confirmTx: vi.fn(async () => ({ popupFailed: false })),
  instances: [] as Array<{ deps: Record<string, unknown> }>,
}))

vi.mock('../src/automation/wallet', () => ({
  WalletActions: class {
    deps: Record<string, unknown>
    constructor(deps: Record<string, unknown>) {
      this.deps = deps
      mocks.instances.push(this)
    }
    ensureConnected = mocks.ensureConnected
    sign = mocks.sign
    confirmTx = mocks.confirmTx
  },
}))

import { connectWallet, signMessage, confirmTransaction } from '../src/api'

/** 假 ctx：wallets.get 按 key 返回带 displayName 的适配器 */
function makeCtx(taskWallet = 'metamask') {
  const wallets = {
    get: (k: string) => ({ displayName: k === 'petra' ? 'Petra' : 'MetaMask' }),
    has: () => true,
  }
  return {
    page: {},
    task: { meta: { wallet: taskWallet } },
    wallets,
    walletPasswords: { metamask: 'pw' },
    walletSession: {},
    log: { info: vi.fn(), warn: vi.fn() },
  } as never
}

describe('api/wallet connectWallet', () => {
  beforeEach(() => {
    mocks.ensureConnected.mockClear()
    mocks.instances.length = 0
  })

  it('缺省 walletOption 按适配器 displayName 组装', async () => {
    await connectWallet(makeCtx('metamask'), { wallet: 'metamask' })
    expect(mocks.ensureConnected).toHaveBeenCalledTimes(1)
    const spec = mocks.ensureConnected.mock.calls[0][0]
    expect(spec.walletOption).toEqual({ text: 'MetaMask' })
    expect(spec.connected).toBeUndefined()
    expect(spec.disconnected).toBeUndefined()
  })

  it('petra 缺省 walletOption 用 Petra 显示名', async () => {
    await connectWallet(makeCtx('petra'), { wallet: 'petra' })
    expect(mocks.ensureConnected.mock.calls[0][0].walletOption).toEqual({ text: 'Petra' })
  })

  it('显式 walletOption/connected/disconnected/connect/confirm 覆盖并透传', async () => {
    await connectWallet(makeCtx(), {
      wallet: 'metamask',
      connected: { text: 'Connected' },
      disconnected: 'Connect Wallet',
      connect: '#connect',
      walletOption: { selector: '[data-testid="rk-wallet-option-metaMask"]' },
      confirm: '#confirm',
    })
    const spec = mocks.ensureConnected.mock.calls[0][0]
    expect(spec.connected).toEqual({ text: 'Connected' })
    expect(spec.disconnected).toBe('Connect Wallet')
    expect(spec.connect).toBe('#connect')
    expect(spec.walletOption).toEqual({ selector: '[data-testid="rk-wallet-option-metaMask"]' })
    expect(spec.confirm).toBe('#confirm')
  })

  it('超时/刷新/轮次参数透传', async () => {
    await connectWallet(makeCtx(), {
      wallet: 'metamask',
      waitConnectedMs: 120000,
      errorTexts: ['Network Error'],
      refreshEveryMs: 30000,
      attempts: 3,
      reclickAfterMs: 5000,
    })
    const spec = mocks.ensureConnected.mock.calls[0][0]
    expect(spec.waitConnectedMs).toBe(120000)
    expect(spec.errorTexts).toEqual(['Network Error'])
    expect(spec.refreshEveryMs).toBe(30000)
    expect(spec.attempts).toBe(3)
    expect(spec.reclickAfterMs).toBe(5000)
  })

  it('把 ctx 的 walletKey/wallets/walletPasswords/walletSession/log 与 recover 装配进 WalletActions', async () => {
    const ctx = makeCtx() as unknown as {
      wallets: unknown
      walletPasswords: unknown
      walletSession: unknown
      log: unknown
    }
    await connectWallet(ctx as never, { wallet: 'petra' })
    const { deps } = mocks.instances[0]
    expect(deps.walletKey).toBe('petra')
    expect(deps.wallets).toBe(ctx.wallets)
    expect(deps.walletPasswords).toBe(ctx.walletPasswords)
    expect(deps.walletSession).toBe(ctx.walletSession)
    expect(deps.log).toBe(ctx.log)
    expect(typeof deps.recover).toBe('function')
  })
})

describe('api/wallet 动作函数', () => {
  beforeEach(() => {
    mocks.sign.mockClear()
    mocks.confirmTx.mockClear()
    mocks.instances.length = 0
  })

  it('signMessage：用任务钱包装配 WalletActions，以 options 调 sign 并透传 popupFailed', async () => {
    mocks.sign.mockResolvedValueOnce({ popupFailed: true })
    const res = await signMessage(makeCtx('petra'), { reclick: { selector: '#send', afterMs: 5000 } })
    expect(mocks.instances[0].deps.walletKey).toBe('petra')
    expect(mocks.sign).toHaveBeenCalledTimes(1)
    expect(mocks.sign).toHaveBeenCalledWith({ reclick: { selector: '#send', afterMs: 5000 } })
    expect(res).toEqual({ popupFailed: true })
  })

  it('signMessage：无 options 时以空对象调用', async () => {
    await signMessage(makeCtx())
    expect(mocks.sign).toHaveBeenCalledWith({})
  })

  it('confirmTransaction：以 options 调 confirmTx 并透传 popupFailed', async () => {
    mocks.confirmTx.mockResolvedValueOnce({ popupFailed: true })
    const res = await confirmTransaction(makeCtx('petra'), { reclick: { selector: '#confirm', afterMs: 3000 } })
    expect(mocks.confirmTx).toHaveBeenCalledTimes(1)
    expect(mocks.confirmTx).toHaveBeenCalledWith({ reclick: { selector: '#confirm', afterMs: 3000 } })
    expect(res).toEqual({ popupFailed: true })
  })
})

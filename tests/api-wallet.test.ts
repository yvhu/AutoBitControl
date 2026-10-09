import { describe, it, expect, vi, beforeEach } from 'vitest'

interface CapturedSpec {
  entry: Record<string, unknown>
  walletEntry?: string
  loggedIn?: unknown
  loggedOut?: unknown
}

// 捕获自动化层 WalletActions 的实例与各动作调用，用于断言 api 层的映射
const mocks = vi.hoisted(() => ({
  ensureLoggedIn: vi.fn(async (_spec: CapturedSpec) => ({ skipped: false })),
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
    ensureLoggedIn = mocks.ensureLoggedIn
    sign = mocks.sign
    confirmTx = mocks.confirmTx
  },
}))

import { loginWallet, signMessage, confirmTransaction } from '../src/api'

function makeCtx(taskWallet = 'metamask') {
  const wallets = { get: () => ({}) }
  return {
    page: {},
    task: { meta: { wallet: taskWallet } },
    wallets,
    walletPasswords: { metamask: 'pw' },
    walletSession: {},
    log: { info: vi.fn(), warn: vi.fn() },
  } as never
}

describe('api/wallet loginWallet', () => {
  beforeEach(() => {
    mocks.ensureLoggedIn.mockClear()
    mocks.instances.length = 0
  })

  it('direct：entry 为 direct，无 walletEntry；探针透传', async () => {
    await loginWallet(makeCtx(), {
      wallet: 'metamask',
      scenario: 'direct',
      loggedIn: { text: 'Connected' },
      loggedOut: { text: 'Connect Wallet' },
    })
    expect(mocks.ensureLoggedIn).toHaveBeenCalledTimes(1)
    const spec = mocks.ensureLoggedIn.mock.calls[0][0]
    expect(spec.entry).toEqual({ kind: 'direct' })
    expect(spec.walletEntry).toBeUndefined()
    expect(spec.loggedIn).toEqual({ text: 'Connected' })
    expect(spec.loggedOut).toEqual({ text: 'Connect Wallet' })
  })

  it('appkit：entry 带 open/entryTestId/modalTestId', async () => {
    await loginWallet(makeCtx(), {
      wallet: 'metamask',
      scenario: 'appkit',
      entryTestId: 'wallet-metamask',
      open: '#connect',
      modalTestId: '#modal',
      loggedIn: { text: 'Connected' },
      loggedOut: { text: 'Connect' },
    })
    const spec = mocks.ensureLoggedIn.mock.calls[0][0]
    expect(spec.entry).toEqual({
      kind: 'appkit',
      open: '#connect',
      entryTestId: 'wallet-metamask',
      modalTestId: '#modal',
    })
    expect(spec.walletEntry).toBeUndefined()
  })

  it('appkit：open 缺省用默认连接按钮', async () => {
    await loginWallet(makeCtx(), {
      wallet: 'metamask',
      scenario: 'appkit',
      entryTestId: 'wallet-x',
      loggedIn: { text: 'a' },
      loggedOut: { text: 'b' },
    })
    expect(mocks.ensureLoggedIn.mock.calls[0][0].entry.open).toBe('button:has-text("Connect Wallet")')
  })

  it('dialog：entry 带 confirm，walletEntry 透传', async () => {
    await loginWallet(makeCtx(), {
      wallet: 'petra',
      scenario: 'dialog',
      confirm: '#confirm',
      walletEntry: 'button:has-text("Petra")',
      loggedIn: { text: 'Connected' },
      loggedOut: { text: 'Connect' },
    })
    const spec = mocks.ensureLoggedIn.mock.calls[0][0]
    expect(spec.entry).toEqual({ kind: 'dialog', confirm: '#confirm' })
    expect(spec.walletEntry).toBe('button:has-text("Petra")')
  })

  it('把 ctx 的 walletKey/wallets/walletPasswords/walletSession/log 与 recover 装配进 WalletActions', async () => {
    const ctx = makeCtx() as unknown as {
      wallets: unknown
      walletPasswords: unknown
      walletSession: unknown
      log: unknown
    }
    await loginWallet(ctx as never, {
      wallet: 'petra',
      scenario: 'direct',
      loggedIn: { text: 'a' },
      loggedOut: { text: 'b' },
    })
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

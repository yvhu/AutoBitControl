import { describe, it, expect, vi } from 'vitest'
import { WalletSession } from '../src/automation/wallet/session'
import type { WalletAdapter } from '../src/automation/wallet/types'

/** 假 Page：evaluate 实现「按 flag 读取 provider 标记」；context().newCDPSession 模拟 CDP 探测 */
function makeFakePage(opts: { providerOk?: boolean; cdpOk?: boolean; evaluateDelay?: number } = {}) {
  let evaluateCalls = 0
  const page = {
    __evaluateCalls: () => evaluateCalls,
    evaluate: vi.fn(async (fn: (flag: string) => boolean, flag: string) => {
      evaluateCalls++
      const delay = opts.evaluateDelay ?? 0
      if (delay > 0) {
        // 注入慢场景：前 delay 次返回 false，之后按 providerOk
        if (evaluateCalls <= delay) return false
      }
      return opts.providerOk !== false && flag === 'isMetaMask'
    }),
    waitForTimeout: vi.fn(async () => {}),
    context: () => ({
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async (method: string) => {
          if (method === 'Target.createTarget') {
            if (opts.cdpOk === false) throw new Error('no extension')
            return { targetId: 't-1' }
          }
          return {}
        }),
        detach: vi.fn(async () => {}),
      })),
    }),
  }
  return page
}

const adapter: WalletAdapter = {
  key: 'metamask',
  extensionUrlPatterns: [],
  extensionId: 'nkbihfbeogaeaoehlefnkodbefgpgknn',
  probePath: 'home.html',
  providerFlag: 'isMetaMask',
  ensureConnected: async () => {},
}

describe('WalletSession', () => {
  it('provider 已注入（isMetaMask=true）→ ready，且 CDP 探测作预热（不改变判定）', async () => {
    const page = makeFakePage({ providerOk: true, cdpOk: false })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    expect(await s.ensureReady('metamask', adapter)).toBe('ready')
  })

  it('provider 缺失且 CDP 探测失败 → missing', async () => {
    const page = makeFakePage({ providerOk: false, cdpOk: false })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    expect(await s.ensureReady('metamask', adapter)).toBe('missing')
  })

  it('provider 缺失但 CDP 探测成功（注入慢）→ 追加轮询后 ready', async () => {
    const page = makeFakePage({ providerOk: true, cdpOk: true, evaluateDelay: 12 })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    expect(await s.ensureReady('metamask', adapter)).toBe('ready')
  })

  it('同类型第二次调用命中缓存（不再探测）', async () => {
    const page = makeFakePage({ providerOk: true })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    await s.ensureReady('metamask', adapter)
    const before = page.__evaluateCalls()
    await s.ensureReady('metamask', adapter)
    expect(page.__evaluateCalls()).toBe(before)
  })

  it('不同类型独立探测互不影响（petra 缺失不影响 metamask ready）', async () => {
    const page = makeFakePage({ providerOk: true, cdpOk: false })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    const petra = { ...adapter, key: 'petra', providerFlag: 'isPetra' }
    expect(await s.ensureReady('metamask', adapter)).toBe('ready')
    expect(await s.ensureReady('petra', petra)).toBe('missing')
  })
})

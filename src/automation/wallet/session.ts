/**
 * 钱包扩展会话检测（automation 层）：每窗口会话一个实例（window-runner 创建后注入）
 * 检测「当前浏览器实例的钱包扩展是否加载成功」——页面主世界 provider 轮询
 * （含钱包类型标识验证）＋ CDP 扩展页探测（Target.createTarget，顺带唤醒 MV3 后台）；
 * 结果按钱包类型缓存，同会话复用（扩展状态不会中途改变；新会话必须重建实例）
 * 依赖方向：仅依赖 patchright 类型与 ./types，被 engine 层依赖
 */
import type { Page } from 'patchright'
import type { WalletAdapter } from './types'

/** 扩展加载检测结果：ready 已加载可响应 / missing 未加载（窗口重启才可能恢复） */
export type WalletReadyState = 'ready' | 'missing'

/** provider 轮询预算（注入实测 0-30s 随机，10×6s 兜底） */
const PROVIDER_POLL_ROUNDS = 10
const PROVIDER_POLL_INTERVAL_MS = 6000
/** provider 缺失但 CDP 探测成功（扩展已加载、注入慢）时的追加轮询 */
const PROVIDER_EXTRA_ROUNDS = 5

/** CDP 会话最小接口：仅探测所需的 send/detach */
type CdpProbeSession = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  detach?(): Promise<void>
}

export class WalletSession {
  private states = new Map<string, WalletReadyState>()
  private readonly pollIntervalMs: number

  constructor(private page: Page, opts: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? PROVIDER_POLL_INTERVAL_MS
  }

  /** 首次调用时探测并缓存；后续同类型直接返回缓存 */
  async ensureReady(type: string, adapter: WalletAdapter): Promise<WalletReadyState> {
    const cached = this.states.get(type)
    if (cached) return cached
    const state = await this.probe(adapter)
    this.states.set(type, state)
    return state
  }

  /** provider 轮询：主世界读 window.ethereum 并验证钱包标识（4 参形式，与 TaskContext.js 一致） */
  private async providerPresent(adapter: WalletAdapter, rounds: number): Promise<boolean> {
    for (let i = 0; i < rounds; i++) {
      const ok = await this.page.evaluate((flag: string) => {
        const eth = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum
        return typeof eth !== 'undefined' && eth[flag] === true
      }, adapter.providerFlag, {}, false).catch(() => false)
      if (ok) return true
      await this.page.waitForTimeout(this.pollIntervalMs)
    }
    return false
  }

  /**
   * CDP 扩展页探测：Target.createTarget 打开扩展页（能创建即扩展已加载），
   * 打开动作同时唤醒 MV3 后台 service worker；结束后关闭目标与 CDP 会话（best-effort）
   */
  private async probeExtensionPage(adapter: WalletAdapter): Promise<boolean> {
    let session: CdpProbeSession | null = null
    try {
      session = (await this.page.context().newCDPSession(this.page)) as unknown as CdpProbeSession
      const res = await session.send('Target.createTarget', { url: `chrome-extension://${adapter.extensionId}/${adapter.probePath}` })
      const targetId = res?.targetId
      if (typeof targetId === 'string') {
        await session.send('Target.closeTarget', { targetId }).catch(() => {})
      }
      return true
    } catch {
      return false
    } finally {
      await session?.detach?.().catch(() => {})
    }
  }

  private async probe(adapter: WalletAdapter): Promise<WalletReadyState> {
    // 不注入 provider 的钱包（Petra 实测 window.petra 恒不存在）：只做 CDP 扩展页探测
    if (adapter.expectsProvider === false) {
      return (await this.probeExtensionPage(adapter)) ? 'ready' : 'missing'
    }
    if (await this.providerPresent(adapter, PROVIDER_POLL_ROUNDS)) {
      // 已注入：CDP 探测仅作预热（失败不影响判定）
      await this.probeExtensionPage(adapter)
      return 'ready'
    }
    // provider 缺失：CDP 探测区分「扩展未加载」与「注入慢」；注入慢再追加轮询
    if (!(await this.probeExtensionPage(adapter))) return 'missing'
    return (await this.providerPresent(adapter, PROVIDER_EXTRA_ROUNDS)) ? 'ready' : 'missing'
  }
}

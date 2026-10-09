/**
 * 钱包扩展会话检测（automation 层）：每窗口会话一个实例（window-runner 创建后注入）
 * 检测「当前浏览器实例的钱包扩展是否加载成功」——页面主世界 provider 轮询
 * （含钱包类型标识验证）＋ CDP 扩展页探测（Target.createTarget，顺带唤醒 MV3 后台）；
 * 结果按钱包类型缓存，同会话复用（扩展状态不会中途改变；新会话必须重建实例）
 * 依赖方向：仅依赖 patchright 类型与 ./types，被 engine 层依赖
 */
import type { Page } from 'patchright'
import type { WalletAdapter } from './types'

/**
 * 扩展加载检测结果：
 * ready 表示钱包扩展已加载、可响应交互；missing 表示未加载（本窗口会话内无法自愈，需重启浏览器窗口）。
 */
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

/**
 * 钱包扩展会话检测器：每个「浏览器窗口会话」创建一个实例（由 window-runner 装配后注入 TaskContext），
 * 用来判断本次会话里目标钱包扩展是否真的加载成功——这是后续所有钱包动作的前提。
 * 检测手段有两条：读取页面主世界的 provider 并校验钱包类型标识（如 window.ethereum.isMetaMask），
 * 以及用 CDP 打开扩展页做探测（能创建即扩展已加载，顺带唤醒 MV3 后台 service worker）。
 * 检测结果按钱包类型缓存在实例内、同会话复用（扩展状态不会中途改变；换新会话必须重建实例）。
 */
export class WalletSession {
  private states = new Map<string, WalletReadyState>()
  private readonly pollIntervalMs: number

  /**
   * @param page 本会话的页面（用于页面主世界求值与开 CDP 会话）
   * @param opts.pollIntervalMs 每次 provider 轮询之间的等待毫秒数；缺省 PROVIDER_POLL_INTERVAL_MS（6000）
   */
  constructor(private page: Page, opts: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? PROVIDER_POLL_INTERVAL_MS
  }

  /**
   * 确保某类型钱包扩展已就绪（首次调用做实际探测，之后同类型直接命中缓存）。
   * @param type 钱包类型（缓存键，通常即 adapter.key）
   * @param adapter 该类型对应的适配器（提供 providerFlag/extensionId/probePath 等探测线索）
   * @returns 'ready' 或 'missing'，语义见 WalletReadyState
   */
  async ensureReady(type: string, adapter: WalletAdapter): Promise<WalletReadyState> {
    const cached = this.states.get(type)
    if (cached) return cached
    const state = await this.probe(adapter)
    this.states.set(type, state)
    return state
  }

  /**
   * 轮询页面主世界，看钱包 provider 是否已注入且类型标识正确。
   * 执行流程：最多 rounds 轮，每轮在页面主世界读取 window.ethereum，并断言 ethereum[providerFlag] === true
   * （严格比类型，避免把别的钱包注入的 window.ethereum 误判成本钱包）；命中即返回，
   * 否则等 pollIntervalMs 再试。单轮求值异常按本轮失败计，不中断。
   * @param adapter 提供 providerFlag 的适配器
   * @param rounds 最大轮询轮数
   * @returns rounds 轮内是否检测到正确的 provider
   */
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
   * 用 CDP 探测扩展页是否存在（能创建扩展页即说明扩展已加载）。
   * 执行流程：在页面上建一个 CDP 会话，发 Target.createTarget 打开 chrome-extension://<扩展ID>/<探测路径>，
   * 拿到 targetId 后再关闭它；打开动作本身会唤醒 MV3 后台 service worker。最后无论如何都 detach 会话。
   * 全程 best-effort，任何异常都当「探测失败」返回 false，不向上抛。
   * @param adapter 提供 extensionId 与 probePath 的适配器
   * @returns 扩展页能否被创建（true=扩展已加载）
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

  /**
   * 综合探测入口，决定该适配器对应的扩展是 ready 还是 missing。
   * 流程分三种情况：① 适配器声明不注入 provider（expectsProvider=false，如 Petra），只靠 CDP 扩展页探测判定；
   * ② provider 正常轮询命中，则 CDP 探测仅作预热（失败不影响判定），判 ready；
   * ③ provider 轮询未命中，用 CDP 探测区分「扩展根本没加载」（missing）与「扩展已加载但注入慢」，
   * 后者再追加少量轮询，命中才 ready，否则 missing。
   * @param adapter 待探测的适配器
   * @returns 该钱包扩展在本会话内的就绪状态
   */
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

/**
 * 自适应连接编排（automation/wallet 层）：判初始态 → 扩展就绪 → 点连接 → 竞速「站内钱包项/扩展弹窗/connected/disconnected」自适应推进 → 等 connected
 * 真机沉淀：静默连接容忍、站内弹窗视图归一化（短竞速 + 归一化露出钱包列表）、弹窗慢补点、刷新恢复、登录阶段绝不自动确认交易。
 * 依赖方向：依赖 ./actions（类型与门面）、./heuristics、./popup、../dom（静态导入，无运行时环）。
 */
import { probeDesc, probeLocator, probeVisible, raceProbes, type Probe } from '../dom'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '../../infrastructure/constants'
import { findConnectButton, HEURISTIC_CONNECTED, HEURISTIC_DISCONNECTED, WALLET_LIST_REVEAL_SELECTORS } from './heuristics'
import type { WalletActions } from './actions'
import type { PopupPage, WalletAdapter } from './types'
import { waitForPopup } from './popup'

/** 探针简写：字符串等价于 `{ text }`（设计示例与测试用 `disconnected: 'Connect Wallet'`） */
export type LoginProbe = Probe | string

/**
 * 自适应连接规格：只描述「可见行为」，其余交给框架推断。
 * 未提供的 connected/disconnected/walletOption 由启发式判据补全（见 heuristics.ts）。
 */
export interface LoginFlowOptions {
  /** 已连接标志探针（显式）：出现即认定已登录；缺省用地址样式文本启发式 */
  connected?: LoginProbe
  /** 未连接标志探针（显式）：出现即走连接流程；缺省用通用连接按钮启发式 */
  disconnected?: LoginProbe
  /** 站点「连接钱包」按钮选择器；缺省用 findConnectButton 按候选文案自动找 */
  connect?: string
  /** 站内钱包选择项探针（如 `{ text: 'MetaMask' }`）；缺省按适配器 displayName 匹配 */
  walletOption?: LoginProbe
  /** 站点在点连接后需要额外确认的按钮（如站内对话框的「Connect with Ethereum」）；仅软点，不阻断 */
  confirm?: string
  /** 等「已连接」标志出现的最长毫秒数（缺省 90000） */
  waitConnectedMs?: number
  /** 自定义可恢复错误文案（透传 recover，出现即刷新页面） */
  errorTexts?: string[]
  /** 等待连接期间周期刷新间隔毫秒（缺省 25000） */
  refreshEveryMs?: number
  /** 整体重试轮数（缺省 2）：从第二轮起先刷新页面，覆盖网络抖动/控件晚渲染 */
  attempts?: number
  /** 每轮内竞速「什么都没命中」的等待毫秒数，超时补点一次连接按钮（缺省 8000） */
  reclickAfterMs?: number
  /**
   * 登录阶段遇到交易/授权确认弹窗（classify=tx）也自动确认。默认 false：
   * 交易一律交任务显式 confirmTransaction（安全边界）；仅「无真实链上交易的 0 撸站点」
   * 在站点把授权确认混入登录弹窗时按需开启，避免登录卡死。
   */
  autoConfirmTransaction?: boolean
}

/** 初始态竞速预算（毫秒）：判页面进来时已登录还是未登录 */
const INITIAL_RACE_MS = 20000
/** 单轮内每次短竞速的等待毫秒数：命中任一可见信号即返回，超时视为 idle 交给归一化处理 */
const SHORT_RACE_MS = 3000
/** 单轮内最多推进次数：防止「站内钱包项反复可见/扩展弹窗持续存在」等异常导致死循环 */
const MAX_STEPS = 8
/** 弹窗就绪轮询间隔（毫秒）：密码框/确认按钮渲染出来即分类，不再白等一整轮竞速 */
const POPUP_READY_POLL_MS = 100
/** 弹窗就绪最长轮询时间（毫秒）：够慢渲染的扩展弹窗完成首屏即可 */
const POPUP_READY_WAIT_MS = 1000

/** 单轮竞速结果：命中的语义键（含扩展弹窗）或 none */
type RoundResult =
  | { kind: 'connected' }
  | { kind: 'disconnected' }
  | { kind: 'walletOption' }
  | { kind: 'popup'; popup: PopupPage }
  | { kind: 'none' }

/**
 * 自适应连接编排：任务只声明可见行为，框架自动推断并推进到已连接。
 * 执行流程：
 * ① 20s 竞速判初始态（显式探针或启发式）；已连接直接返回 skipped=true；
 * ② wallet.ready()（适配器无 extensionId 时视为就绪）；
 * ③ 点连接按钮（显式 connect 或 findConnectButton）；
 * ④ 最多 attempts 轮，每轮先点连接，再在短竞速循环里推进（每次短竞速 ~3s）：
 *    站内钱包项 → 点击；扩展弹窗 → 按适配器分类自动处理（tx 默认绝不处理，告警后继续；
 *    autoConfirmTransaction=true 时自动确认，见 handlePopup）；
 *    connected → 成功；disconnected / 什么都没命中（idle）→ 归一化露出钱包列表后继续（不当作致命）；
 *    期间若始终无任何钱包交互且超过 reclickAfterMs → 补点连接按钮；
 * ⑤ 命中 connected 成功返回；否则走 recover 等「已连接」标志（错误文案/周期刷新恢复）；
 * ⑥ 全部轮次失败抛「登录未完成（等待已连接标志超时）」。
 * @param wallet WalletActions 门面（提供 deps/ready）
 * @param opts 自适应连接规格
 * @returns skipped=true 进页面即已连接；false 本次实际完成了连接
 * @throws 任务未配置钱包/注册表未注入/适配器缺 displayName；或等待已连接标志超时
 */
export async function ensureConnected(wallet: WalletActions, opts: LoginFlowOptions = {}): Promise<{ skipped: boolean }> {
  const deps = wallet.deps
  const { page } = deps
  const adapter = resolveAdapter(wallet)
  const connected = toProbe(opts.connected ?? HEURISTIC_CONNECTED)
  const disconnected = toProbe(opts.disconnected ?? HEURISTIC_DISCONNECTED)
  const walletOption = toProbe(opts.walletOption ?? { text: adapter.displayName })
  // 判据暴露：打印本轮实际使用的判据（显式/启发式）与候选，便于真机排障
  deps.log.info({
    step: 'connect',
    connected: probeDesc(connected),
    connectedSource: opts.connected ? 'explicit' : 'heuristic',
    disconnected: probeDesc(disconnected),
    disconnectedSource: opts.disconnected ? 'explicit' : 'heuristic',
    walletOption: probeDesc(walletOption),
  }, '钱包连接：判定依据')

  const initial = await raceProbes<StateKey>(page, [['connected', connected], ['disconnected', disconnected]], INITIAL_RACE_MS)
  if (initial === 'connected') return { skipped: true }

  await wallet.ready()

  const attempts = opts.attempts ?? 2
  const reclickAfterMs = opts.reclickAfterMs ?? 8000
  const waitConnectedMs = opts.waitConnectedMs ?? 90000
  const autoConfirmTransaction = opts.autoConfirmTransaction ?? false

  for (let round = 0; round < attempts; round++) {
    if (round > 0) {
      await page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(5000)
    }
    // started 标记连接流程是否真正启动（点了连接按钮或额外确认）；未启动时不做站内弹窗视图归一化
    const clicked = await clickConnect(deps, opts.connect)
    let started = clicked
    if (opts.confirm) {
      await clickSoft(deps, opts.confirm)
      started = true
    }

    const advanced = await advanceRound(deps, adapter, walletOption, connected, disconnected, opts.connect, reclickAfterMs, started, autoConfirmTransaction)
    if (advanced.connected) return { skipped: false }
    // 整轮没有任何钱包动作（站内列表/扩展弹窗均未命中）→ 补点连接按钮一次，覆盖点击落空/慢渲染
    if (!advanced.interacted) await clickConnect(deps, opts.connect)

    const ok = await deps.recover(connected, {
      budgetMs: waitConnectedMs,
      refreshEveryMs: opts.refreshEveryMs ?? 25000,
      recoverTexts: opts.errorTexts,
    })
    if (ok) return { skipped: false }
  }
  throw new Error('登录未完成（等待已连接标志超时）')
}

/** 初始态竞速键 */
type StateKey = 'connected' | 'disconnected'

/**
 * 取当前任务的适配器，并校验具备 displayName（walletOption 缺省匹配依赖它）。
 * @throws 任务未配置钱包；注册表未注入；适配器缺 displayName
 */
function resolveAdapter(wallet: WalletActions): WalletAdapter {
  const key = wallet.deps.walletKey
  if (!key) throw new Error('任务未配置钱包')
  if (!wallet.deps.wallets) throw new Error('钱包注册表未注入')
  const adapter = wallet.deps.wallets.get(key)
  if (!adapter.displayName) throw new Error(`钱包适配器 ${key} 缺少 displayName`)
  return adapter
}

/**
 * 单轮竞速：页面探针（站内钱包项/connected/disconnected）与扩展弹窗同时监视，任一先命中即返回。
 * 页面探针用 raceProbes（等待可见）；扩展弹窗用 waitForPopup（新窗口/已在窗口），二者 Promise.race。
 * @returns 命中的语义键与弹窗（弹窗时）；预算内都没命中返回 none
 */
async function raceRound(
  deps: WalletActions['deps'],
  adapter: WalletAdapter,
  walletOption: Probe,
  connected: Probe,
  disconnected: Probe,
  timeoutMs: number,
): Promise<RoundResult> {
  const pageRace = raceProbes<StateKey | 'walletOption'>(
    deps.page,
    [['walletOption', walletOption], ['connected', connected], ['disconnected', disconnected]],
    timeoutMs,
  ).then((k): RoundResult => (k ? { kind: k } : { kind: 'none' }))
  const popupRace = waitForPopup(deps.page.context(), adapter.extensionUrlPatterns, timeoutMs)
    .then((p): RoundResult => (p ? { kind: 'popup', popup: p as unknown as PopupPage } : { kind: 'none' }))
    .catch((): RoundResult => ({ kind: 'none' }))
  return Promise.race([pageRace, popupRace])
}

/**
 * 单轮推进：短竞速（~3s）循环，直到命中 connected 或推进次数耗尽。
 * 每次短竞速命中站内钱包项/扩展弹窗就处理并继续；命中 disconnected 或什么都没命中（idle）视作
 * 「站内弹窗可能不在钱包列表视图」，在连接流程已启动（allowReveal）或本轮已发生过钱包交互时
 * 调用 revealWalletList 归一化后继续（不当作致命失败）；连接流程尚未启动时不做归一化，避免误点站点按钮。
 * 期间若始终没有任何钱包交互且距上次补点超过 reclickAfterMs，补点一次连接按钮（覆盖点击落空/慢渲染）。
 * @returns connected=是否已连接；interacted=本轮是否发生过钱包交互（点钱包项/处理弹窗）
 */
async function advanceRound(
  deps: WalletActions['deps'],
  adapter: WalletAdapter,
  walletOption: Probe,
  connected: Probe,
  disconnected: Probe,
  connectSelector: string | undefined,
  reclickAfterMs: number,
  allowReveal: boolean,
  autoConfirmTransaction: boolean,
): Promise<{ connected: boolean; interacted: boolean }> {
  let interacted = false
  // 连接流程一旦启动（或本轮已交互）才允许归一化站内弹窗视图
  let revealAllowed = allowReveal
  let lastReclickAt = Date.now()
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await raceRound(deps, adapter, walletOption, connected, disconnected, SHORT_RACE_MS)
    if (res.kind === 'connected') return { connected: true, interacted }
    if (res.kind === 'walletOption') {
      await clickWalletOption(deps, walletOption)
      interacted = true
      revealAllowed = true
      lastReclickAt = Date.now()
      continue
    }
    if (res.kind === 'popup') {
      await handlePopup(deps, adapter, res.popup, autoConfirmTransaction)
      interacted = true
      revealAllowed = true
      lastReclickAt = Date.now()
      continue
    }
    // disconnected / idle：连接流程已启动才尝试把站内弹窗视图拨回钱包列表，再按需补点连接按钮
    if (revealAllowed) await revealWalletList(deps)
    if (!interacted && Date.now() - lastReclickAt >= reclickAfterMs) {
      if (await clickConnect(deps, connectSelector)) revealAllowed = true
      lastReclickAt = Date.now()
    }
  }
  return { connected: false, interacted }
}

/**
 * 处理扩展弹窗：先等 UI 就绪再分类，避免“窗口已出现但页面还没渲染”被误判成 unknown。
 * tx 弹窗默认绝不自动确认（安全边界）——告警后返回 false，由任务显式 confirmTransaction；
 * 仅当 autoConfirmTransaction=true（0 撸站点，站点把授权确认混入登录弹窗）时自动确认 tx；
 * unlock/connect/sign 交给适配器 handleLoginPopup 自动完成。
 * @returns 是否实际处理了弹窗
 */
async function handlePopup(deps: WalletActions['deps'], adapter: WalletAdapter, popup: PopupPage, autoConfirmTransaction: boolean): Promise<boolean> {
  const startedAt = Date.now()
  const ready = await waitPopupReady(adapter, popup)
  const classifyStart = Date.now()
  const kind = await adapter.classifyPopup(popup).catch(() => 'unknown' as const)
  const classifyMs = Date.now() - classifyStart
  const logTiming = (handled: boolean): void => {
    deps.log.info({
      step: 'wallet',
      wallet: adapter.key,
      kind,
      ready,
      classifyMs,
      handleMs: Date.now() - classifyStart - classifyMs,
      handled,
    }, '钱包弹窗处理耗时')
  }
  if (kind === 'tx') {
    if (!autoConfirmTransaction) {
      deps.log.warn({ step: 'connect', kind, wallet: adapter.key, url: popup.url?.() }, '检测到交易确认弹窗，登录流程不自动处理（交由任务显式确认）')
      logTiming(false)
      return false
    }
    deps.log.info({ step: 'connect', kind, wallet: adapter.key, url: popup.url?.() }, '检测到交易/授权确认弹窗，已按任务配置自动确认（autoConfirmTransaction）')
    await adapter.confirmTx(popup).catch(() => {})
    logTiming(true)
    return true
  }
  const handled = await adapter.handleLoginPopup(popup, deps.walletPasswords?.[adapter.key]).catch(() => false)
  if (!handled) deps.log.warn({ step: 'connect', kind, wallet: adapter.key }, '钱包弹窗未识别（unknown/缺密码），继续等待连接标志')
  logTiming(handled)
  return handled
}

/**
 * 等弹窗 UI 就绪：适配器未实现 isPopupReady 时视为就绪；
 * 否则 100ms 轮询，最多 1 秒——密码框/确认按钮一出现立刻返回，避免分类空转。
 */
async function waitPopupReady(adapter: WalletAdapter, popup: PopupPage): Promise<boolean> {
  if (!adapter.isPopupReady) return true
  const deadline = Date.now() + POPUP_READY_WAIT_MS
  while (Date.now() < deadline) {
    if (popup.isClosed?.()) return true
    if (await adapter.isPopupReady(popup).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, POPUP_READY_POLL_MS))
  }
  return adapter.isPopupReady(popup).catch(() => false)
}

/**
 * 点击站内钱包选择项：能走到这里说明短竞速已确认其可见，直接点（点击落空由下一轮竞速/补点兜底）。
 */
async function clickWalletOption(deps: WalletActions['deps'], probe: Probe): Promise<void> {
  await probeLocator(deps.page, probe).first().click({ timeout: 5000 }).catch(() => {})
}

/**
 * 归一化站内钱包弹窗视图：弹窗可能停在 QR 详情页/收起态而非钱包列表，逐一探测库无关候选
 * （返回/全部钱包/浏览器标签 + 通用文案/aria 兜底），点首个可见者把视图拨回列表；一个都没命中则静默返回。
 * @returns 是否实际点击了归一化候选
 */
async function revealWalletList(deps: WalletActions['deps']): Promise<boolean> {
  for (const selector of WALLET_LIST_REVEAL_SELECTORS) {
    if (await probeVisible(deps.page, { selector })) {
      await clickSoft(deps, selector)
      return true
    }
  }
  return false
}

/**
 * 点连接按钮：显式 connect 优先，否则按候选文案自动找；找不到只记日志（部分站点进页自动弹窗）。
 * @returns 是否实际点击了连接按钮（false=未找到，供调用方判断连接流程是否已启动）
 */
async function clickConnect(deps: WalletActions['deps'], explicit?: string): Promise<boolean> {
  const selector = explicit ?? (await findConnectButton(deps.page))
  if (!selector) {
    deps.log.info({ step: 'connect' }, '未找到连接按钮（可能进页自动弹窗或已连接）')
    return false
  }
  await clickSoft(deps, selector)
  return true
}

/** 软点：控件慢渲染/点击落空都不抛错，交给后续竞速与补点兜底 */
async function clickSoft(deps: WalletActions['deps'], selector: string): Promise<void> {
  await deps.page.locator(selector).first().click({ timeout: 5000 }).catch(() => {})
}

/** 把探针简写归一为完整探针：字符串按文案匹配，已结构化对象原样返回 */
function toProbe(p: LoginProbe): Probe {
  return typeof p === 'string' ? { text: p } : p
}

/**
 * 自适应连接编排（automation/wallet 层）：判初始态 → 扩展就绪 → 点连接 → 竞速「站内钱包项/扩展弹窗/connected/disconnected」自适应推进 → 等 connected
 * 真机沉淀：静默连接容忍、站内弹窗视图归一化（短竞速 + 归一化露出钱包列表）、弹窗慢补点、刷新恢复、登录阶段绝不自动确认交易。
 * 依赖方向：依赖 ./actions（类型与门面）、./heuristics、./popup、../dom（静态导入，无运行时环）。
 */
import { firstTextPresent, probeDesc, probeLocator, probePresent, probeVisible, raceProbes, type Probe } from '../dom'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '../../infrastructure/constants'
import { findConnectButton, HEURISTIC_CONNECTED, HEURISTIC_DISCONNECTED, WALLET_LIST_REVEAL_SELECTORS } from './heuristics'
import type { WalletActions } from './actions'
import type { PopupPage, WalletAdapter } from './types'
import { findOpenPopup, waitForPopup } from './popup'
import { sleep } from './popup-wait'

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
   * 点连接后至少观察钱包弹窗的毫秒数（缺省 15000）：
   * 站点未连接按钮一直可见时，旧逻辑会瞬间跑完 8 轮推进而错过稍后弹出的钱包弹窗；
   * 这里给一个最短观察窗口，期间持续监听扩展弹窗。
   */
  observeMs?: number
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
const MAX_STEPS = 100
/** 点连接后至少观察钱包弹窗的时长（毫秒）：未连接按钮常显时避免瞬间跑完推进轮次、错过稍后弹出的弹窗 */
const DEFAULT_OBSERVE_MS = 15000
/** 观察钱包弹窗期间的 idle 轮询间隔（毫秒）：disconnected 常显时避免热循环，同时保持弹窗监听 */
const OBSERVE_IDLE_MS = 500
/** 钱包交互完成后主动刷新的沉降时间（毫秒） */
const POST_INTERACTION_SETTLE_MS = 3000
/** recover 期间单次竞速预算（毫秒）：同时监听页面信号与扩展弹窗 */
const RECOVER_RACE_MS = 1000
/** recover 空闲轮询间隔（毫秒）：避免 disconnected 常显时热循环 */
const RECOVER_IDLE_MS = 300
/** 最后一轮始终没有钱包交互时，额外给的短 recover 预算（毫秒） */
const NO_INTERACTION_RECOVER_MS = 30000
/** 弹窗内状态轮询间隔（毫秒）：密码框/确认按钮渲染出来即分类，不再白等一整轮竞速 */
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
    window: deps.profileName,
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
  // 观察窗口不超过整体等待预算：任务调小 waitConnectedMs（真机/单测）时不要反而多等
  const observeMs = Math.min(opts.observeMs ?? DEFAULT_OBSERVE_MS, waitConnectedMs)
  const autoConfirmTransaction = opts.autoConfirmTransaction ?? false
  const refreshEveryMs = opts.refreshEveryMs ?? 25000

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

    // 点连接后至少观察 observeMs：未连接按钮常显时不再瞬间跑完推进轮次
    const advanced = await advanceRound(deps, adapter, walletOption, connected, disconnected, opts.connect, reclickAfterMs, started, autoConfirmTransaction, observeMs)
    if (advanced.connected) return { skipped: false }

    if (advanced.interacted) {
      // 钱包已交互：先主动刷新一次（站点通常要重载后才渲染地址），再进入带弹窗监听的 recover
      deps.log.info({ step: 'recover', window: deps.profileName, url: page.url() }, '钱包交互完成，刷新页面确认登录态')
      await page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(POST_INTERACTION_SETTLE_MS)
      if (await probePresent(page, connected)) return { skipped: false }
      const recovered = await recoverWithPopups(deps, adapter, walletOption, connected, disconnected, {
        budgetMs: waitConnectedMs,
        refreshEveryMs,
        recoverTexts: opts.errorTexts,
        autoConfirmTransaction,
      })
      if (recovered.connected) return { skipped: false }
      continue
    }

    // 整轮没有任何钱包交互：补点一次连接按钮；非最后一轮直接 reload 重试，不再空等 90 秒
    await clickConnect(deps, opts.connect)
    if (round < attempts - 1) continue
    // 最后一轮仍无交互：给一次带弹窗监听的短 recover（覆盖扩展冷启动/弹窗迟到）
    const recovered = await recoverWithPopups(deps, adapter, walletOption, connected, disconnected, {
      budgetMs: Math.min(waitConnectedMs, NO_INTERACTION_RECOVER_MS),
      refreshEveryMs,
      recoverTexts: opts.errorTexts,
      autoConfirmTransaction,
    })
    if (recovered.connected) return { skipped: false }
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
  // 优先处理“已经开着”的弹窗：否则页面上的未连接按钮可能每轮都抢先命中，弹窗永远排不上
  const openPopup = findOpenPopup(deps.page.context(), adapter.extensionUrlPatterns)
  if (openPopup) return { kind: 'popup', popup: openPopup as unknown as PopupPage }
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
 * 单轮推进：在 observeMs 观察窗口内循环竞速（每次 ~3s），命中 connected 即返回。
 * 每次短竞速命中站内钱包项/扩展弹窗就处理并继续；命中 disconnected 或什么都没命中（idle）视作
 * 「站内弹窗可能不在钱包列表视图」，在连接流程已启动（allowReveal）或本轮已发生过钱包交互时
 * 调用 revealWalletList 归一化后继续（不当作致命失败）；连接流程尚未启动时不做归一化，避免误点站点按钮。
 * 期间若始终没有任何钱包交互且距上次补点超过 reclickAfterMs，补点一次连接按钮（覆盖点击落空/慢渲染）。
 * 注意：观察窗口是“至少”，disconnected 常显时每次都会很快返回，必须靠 sleep 撑满窗口，否则会在
 * 钱包弹窗尚未打开时就结束推进（真机 2026-10-21：弹窗出现但流程已进入 recover，白等 90s）。
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
  observeMs: number,
): Promise<{ connected: boolean; interacted: boolean }> {
  let interacted = false
  // 连接流程一旦启动（或本轮已交互）才允许归一化站内弹窗视图
  let revealAllowed = allowReveal
  let lastReclickAt = Date.now()
  const observeDeadline = Date.now() + observeMs
  let step = 0
  while (step < MAX_STEPS && Date.now() < observeDeadline) {
    step++
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
      // 同一弹窗可能还在关闭动画中，稍作停顿避免热循环重复处理
      await sleep(200)
      continue
    }
    // disconnected / idle：连接流程已启动才尝试把站内弹窗视图拨回钱包列表，再按需补点连接按钮
    if (revealAllowed) await revealWalletList(deps)
    if (!interacted && Date.now() - lastReclickAt >= reclickAfterMs) {
      if (await clickConnect(deps, connectSelector)) revealAllowed = true
      lastReclickAt = Date.now()
    }
    // 观察窗口内保持监听：disconnected 常显时 raceRound 会立刻返回，这里稍作停顿避免热循环
    if (Date.now() < observeDeadline) await sleep(OBSERVE_IDLE_MS)
  }
  if (await probePresent(deps.page, connected)) return { connected: true, interacted }
  return { connected: false, interacted }
}

/**
 * 带钱包弹窗监听的 recover：等待“已连接”标志期间继续处理迟到的扩展弹窗。
 * 旧实现只轮询页面文案，弹窗在 advanceRound 结束后才出现时会一直挂着，直到超时或下一轮重试；
 * 这里每次 1s 竞速同时看页面信号和扩展弹窗，命中弹窗立即处理，命中钱包项立即点击。
 */
async function recoverWithPopups(
  deps: WalletActions['deps'],
  adapter: WalletAdapter,
  walletOption: Probe,
  connected: Probe,
  disconnected: Probe,
  opts: { budgetMs: number; refreshEveryMs: number; recoverTexts?: string[]; autoConfirmTransaction: boolean },
): Promise<{ connected: boolean; interacted: boolean }> {
  const end = Date.now() + opts.budgetMs
  let lastRefresh = Date.now()
  let lastBeat = Date.now()
  let interacted = false
  while (Date.now() < end) {
    const res = await raceRound(deps, adapter, walletOption, connected, disconnected, RECOVER_RACE_MS)
    if (res.kind === 'connected') return { connected: true, interacted }
    if (res.kind === 'popup') {
      await handlePopup(deps, adapter, res.popup, opts.autoConfirmTransaction)
      interacted = true
      // 钱包刚有动作：站点通常要刷新后才渲染地址，把下次刷新提前到 5 秒后（同时给后续弹窗留出时间）
      if (opts.refreshEveryMs > 0) lastRefresh = Math.min(lastRefresh, Date.now() - opts.refreshEveryMs + 5000)
      continue
    }
    if (res.kind === 'walletOption') {
      await clickWalletOption(deps, walletOption)
      interacted = true
      continue
    }
    const errText = await firstTextPresent(deps.page, opts.recoverTexts ?? [])
    const stale = opts.refreshEveryMs > 0 && Date.now() - lastRefresh >= opts.refreshEveryMs
    if (errText !== '' || stale) {
      deps.log.info({ step: 'recover', window: deps.profileName, errText, url: deps.page.url() }, '刷新页面恢复（错误提示或周期刷新）')
      await deps.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      await deps.page.waitForTimeout(5000)
      lastRefresh = Date.now()
      lastBeat = lastRefresh
      continue
    }
    if (Date.now() - lastBeat >= 15000) {
      lastBeat = Date.now()
      deps.log.info({
        step: 'wait',
        window: deps.profileName,
        probe: probeDesc(connected),
        waitedMs: opts.budgetMs - (end - Date.now()),
        url: deps.page.url(),
      }, '仍在等待登录完成（已连接标志）')
    }
    await sleep(RECOVER_IDLE_MS)
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
      window: deps.profileName,
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
      deps.log.warn({ step: 'connect', window: deps.profileName, kind, wallet: adapter.key, url: popup.url?.() }, '检测到交易确认弹窗，登录流程不自动处理（交由任务显式确认）')
      logTiming(false)
      return false
    }
    deps.log.info({ step: 'connect', window: deps.profileName, kind, wallet: adapter.key, url: popup.url?.() }, '检测到交易/授权确认弹窗，已按任务配置自动确认（autoConfirmTransaction）')
    await adapter.confirmTx(popup).catch(() => {})
    logTiming(true)
    return true
  }
  const handled = await adapter.handleLoginPopup(popup, deps.walletPasswords?.[adapter.key]).catch(() => false)
  if (!handled) deps.log.warn({ step: 'connect', window: deps.profileName, kind, wallet: adapter.key }, '钱包弹窗未识别（unknown/缺密码），继续等待连接标志')
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
    deps.log.info({ step: 'connect', window: deps.profileName }, '未找到连接按钮（可能进页自动弹窗或已连接）')
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

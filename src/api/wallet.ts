/**
 * 钱包函数（api 层）：连接（connectWallet）与单次动作（signMessage/confirmTransaction）
 * 依赖方向：engine 的 TaskContext 类型、automation barrel（WalletActions 与连接相关类型）
 * 设计思路：把「wallet + 可见行为声明」映射为 automation 的自适应连接规格（LoginFlowOptions），
 * 复用 automation/wallet 的 ensureConnected 编排；连接之外的签名/交易确认动作，
 * 缺省从任务配置的钱包（ctx.task.meta.wallet）装配 WalletActions 后转发 sign/confirmTx；
 * 多标签页/双钱包场景可用 opts.wallet 与 opts.page 覆盖本次动作的钱包与操作页面。
 */
import type { Page } from 'patchright'
import type { TaskContext } from '../engine/task-context'
import { matchesWalletUrl, WalletActions } from '../automation'
import { waitFor, type Matcher } from './wait'

/** 内置钱包类型（与 automation/wallet 注册表 key 一致）；仅作已知值提示，ConnectOptions.wallet 接受任意注册表 key */
export type WalletType = 'metamask' | 'petra' | 'subwallet'

/**
 * 自适应连接规格：任务只描述站点「可见行为」，其余交给框架推断。
 * 未提供的 connected/disconnected/connect/walletOption 由自动化层启发式补全。
 */
export interface ConnectOptions {
  /** 钱包类型，作为 WalletActions 的 walletKey；接受任意已注册适配器 key（配置驱动新钱包无需改此类型） */
  wallet: string
  /** 已连接标志匹配器（显式）：出现即认定已连接；缺省用地址样式文本启发式 */
  connected?: Matcher
  /** 未连接标志匹配器（显式）：出现即走连接流程；缺省用通用连接按钮启发式 */
  disconnected?: Matcher
  /** 站点「连接钱包」按钮选择器；缺省按候选文案（Connect Wallet/连接钱包/Connect）自动找 */
  connect?: string
  /** 站内钱包选择项匹配器（如 `{ text: 'MetaMask' }`）；缺省按适配器 displayName 匹配 */
  walletOption?: Matcher
  /** 站点在点连接后需要额外确认的按钮（如站内对话框的「Connect with Ethereum」）；仅软点 */
  confirm?: string
  /** 等「已连接」标志出现的最长毫秒数（缺省 90000） */
  waitConnectedMs?: number
  /** 自定义可恢复错误文案（透传 recover，出现即刷新页面） */
  errorTexts?: string[]
  /** 等待连接期间周期刷新间隔毫秒（缺省 25000） */
  refreshEveryMs?: number
  /** 整体重试轮数（缺省 2） */
  attempts?: number
  /** 每轮内无动作时补点连接按钮前的等待毫秒数（缺省 8000） */
  reclickAfterMs?: number
  /** 点连接后至少观察钱包弹窗的毫秒数（缺省 15000）：避免未连接按钮常显时瞬间跑完推进轮次、错过稍后弹出的弹窗 */
  observeMs?: number
  /** 操作页面（缺省 ctx.page）；多标签页场景指定新标签页 */
  page?: Page
  /**
   * 登录阶段遇到交易/授权确认弹窗（classify=tx）也自动确认。默认 true：
   * 登录期的签名/授权弹窗自动点掉；登录阶段会弹真实链上交易（要花 gas）的
   * 特殊站点显式传 false，交易仍交由任务自身 confirmTransaction 显式确认。
   */
  autoConfirmTransaction?: boolean
}

/**
 * 自适应钱包连接：把 api 的可见行为声明映射为 automation 连接规格，并装配 WalletActions 执行。
 * @param ctx 任务上下文（提供 page/wallets/walletPasswords/walletSession/log 与 recover）
 * @param opts 自适应连接规格
 * @throws 连接未完成（所有轮次等待已连接标志超时）
 */
export async function connectWallet(ctx: TaskContext, opts: ConnectOptions): Promise<void> {
  const actions = buildWalletActions(ctx, opts.wallet, opts.page)
  await actions.ensureConnected({
    connected: opts.connected,
    disconnected: opts.disconnected,
    connect: opts.connect,
    walletOption: opts.walletOption ?? defaultWalletOption(ctx, opts.wallet),
    confirm: opts.confirm,
    waitConnectedMs: opts.waitConnectedMs,
    errorTexts: opts.errorTexts,
    refreshEveryMs: opts.refreshEveryMs,
    attempts: opts.attempts,
    reclickAfterMs: opts.reclickAfterMs,
    observeMs: opts.observeMs,
    autoConfirmTransaction: opts.autoConfirmTransaction,
  })
}

/**
 * 缺省钱包选项：按适配器 displayName 匹配站内钱包列表项（如 { text: 'MetaMask' }）。
 * 未注入注册表时返回 undefined，交由 automation 层再用 displayName 兜底/抛错。
 */
function defaultWalletOption(ctx: TaskContext, wallet: string): Matcher | undefined {
  if (!ctx.wallets) return undefined
  return { text: ctx.wallets.get(wallet).displayName }
}

/** @deprecated 用 connectWallet；保留别名过渡 */
export const loginWallet = connectWallet

/** 单次钱包动作的可选参数 */
export interface WalletActionOptions {
  /** 钱包适配器 key（缺省用任务配置的 meta.wallet）；同一任务需要第二个钱包时显式指定 */
  wallet?: string
  /** 操作页面（缺省 ctx.page）；多标签页/二次确认场景可指定其它标签页 */
  page?: Page
  /** 补点配置：等 afterMs 毫秒弹窗仍未出现，就点一下 selector 重新触发（应对慢渲染/点击落空） */
  reclick?: { selector: string; afterMs: number }
}

/**
 * 从 ctx 装配 WalletActions（connectWallet 用 opts.wallet；单次动作用任务配置的钱包或显式覆盖）。
 * walletKey 决定取哪个适配器与密码；page 决定弹窗上下文与补点所在的页面。
 */
function buildWalletActions(ctx: TaskContext, walletKey?: string, page?: Page): WalletActions {
  return new WalletActions({
    page: page ?? ctx.page,
    profileName: ctx.profile?.name,
    walletKey,
    wallets: ctx.wallets,
    walletPasswords: ctx.walletPasswords,
    walletSession: ctx.walletSession,
    log: ctx.log,
    recover: (matcher, recoverOpts) => waitFor(ctx, matcher, { ...recoverOpts }),
  })
}

/**
 * 等一次钱包弹窗并完成消息签名。
 * @param ctx 任务上下文（提供 page/wallets/walletPasswords/walletSession/log 与 recover）
 * @param opts 补点参数（弹窗慢渲染/点击落空时重新触发）
 * @returns popupFailed：弹窗未出现时为 true，调用方按业务态判定
 */
export async function signMessage(ctx: TaskContext, opts: WalletActionOptions = {}): Promise<{ popupFailed: boolean }> {
  const { wallet, page, ...action } = opts
  return buildWalletActions(ctx, wallet ?? ctx.task.meta.wallet, page).sign(action)
}

/**
 * 等一次钱包弹窗并确认交易。
 * @param ctx 任务上下文（提供 page/wallets/walletPasswords/walletSession/log 与 recover）
 * @param opts 补点参数（弹窗慢渲染/点击落空时重新触发）
 * @returns popupFailed：弹窗未出现时为 true，调用方按业务态判定
 */
export async function confirmTransaction(ctx: TaskContext, opts: WalletActionOptions = {}): Promise<{ popupFailed: boolean }> {
  const { wallet, page, ...action } = opts
  return buildWalletActions(ctx, wallet ?? ctx.task.meta.wallet, page).confirmTx(action)
}

/** 清理钱包弹窗的可选参数 */
export interface CloseWalletPopupsOptions {
  /** 钱包适配器 key（缺省用任务配置的 meta.wallet） */
  wallet?: string
  /** 起始页面（缺省 ctx.page）；会扫描其所属浏览器的全部 context */
  page?: Page
}

/**
 * 关闭当前浏览器里该钱包遗留的扩展弹窗（连接/解锁/签名页）。
 * 用途：进入下一段钱包动作前清理上一阶段残留弹窗，避免 waitForPopup 先命中旧弹窗、
 * 新弹窗一直没人处理。调用方应在「确定上一段已结束、准备发起新动作」时使用。
 * @param ctx 任务上下文（提供页面、钱包注册表）
 * @param opts 钱包与起始页面
 * @returns 实际关闭的弹窗数量
 */
export async function closeWalletPopups(ctx: TaskContext, opts: CloseWalletPopupsOptions = {}): Promise<number> {
  const key = opts.wallet ?? ctx.task.meta.wallet
  if (!key || !ctx.wallets) return 0
  const adapter = ctx.wallets.get(key)
  const start = opts.page ?? ctx.page
  const browser = typeof start.context().browser === 'function' ? start.context().browser() : undefined
  const contexts = browser ? browser.contexts() : [start.context()]
  let closed = 0
  for (const c of contexts) {
    for (const p of c.pages()) {
      if (!matchesWalletUrl(p.url(), adapter.extensionUrlPatterns)) continue
      const done = await p.close().then(() => true).catch(() => false)
      if (done) closed++
    }
  }
  if (closed > 0) ctx.log.info({ step: 'wallet', wallet: key, closed }, '已清理残留钱包弹窗')
  return closed
}

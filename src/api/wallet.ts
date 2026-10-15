/**
 * 钱包函数（api 层）：连接（connectWallet）与单次动作（signMessage/confirmTransaction）
 * 依赖方向：engine 的 TaskContext 类型、automation barrel（WalletActions 与连接相关类型）
 * 设计思路：把「wallet + 可见行为声明」映射为 automation 的自适应连接规格（LoginFlowOptions），
 * 复用 automation/wallet 的 ensureConnected 编排；连接之外的签名/交易确认动作，
 * 直接从任务配置的钱包（ctx.task.meta.wallet）装配 WalletActions 后转发 sign/confirmTx。
 */
import type { TaskContext } from '../engine/task-context'
import { WalletActions } from '../automation'
import { waitFor, type Matcher } from './wait'

/** 内置钱包类型（与 automation/wallet 注册表 key 一致）；仅作已知值提示，ConnectOptions.wallet 接受任意注册表 key */
export type WalletType = 'metamask' | 'petra'

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
  /**
   * 登录阶段遇到交易/授权确认弹窗（classify=tx）也自动确认。默认 false：
   * 交易一律交任务显式 confirmTransaction（安全边界）；仅「无真实链上交易的 0 撸站点」
   * 在站点把授权确认混入登录弹窗时按需开启。
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
  const actions = buildWalletActions(ctx, opts.wallet)
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
  /** 补点配置：等 afterMs 毫秒弹窗仍未出现，就点一下 selector 重新触发（应对慢渲染/点击落空） */
  reclick?: { selector: string; afterMs: number }
}

/**
 * 从 ctx 装配 WalletActions（connectWallet 用 opts.wallet；单次动作用任务配置的钱包）。
 * walletKey 决定取哪个适配器与密码。
 */
function buildWalletActions(ctx: TaskContext, walletKey?: string): WalletActions {
  return new WalletActions({
    page: ctx.page,
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
  return buildWalletActions(ctx, ctx.task.meta.wallet).sign(opts)
}

/**
 * 等一次钱包弹窗并确认交易。
 * @param ctx 任务上下文（提供 page/wallets/walletPasswords/walletSession/log 与 recover）
 * @param opts 补点参数（弹窗慢渲染/点击落空时重新触发）
 * @returns popupFailed：弹窗未出现时为 true，调用方按业务态判定
 */
export async function confirmTransaction(ctx: TaskContext, opts: WalletActionOptions = {}): Promise<{ popupFailed: boolean }> {
  return buildWalletActions(ctx, ctx.task.meta.wallet).confirmTx(opts)
}

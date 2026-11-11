/**
 * Konnex Hub 共享逻辑：Hub 地址、站内登录链路常量与登录编排
 * 依赖方向：依赖 ./base（任务基类与类型）与 ../api（能力函数）
 * 设计思路：konnex 的多个任务（签到、Testnet 周任务）共用同一段 Hub 登录流程，
 *   抽到此处避免各任务重复维护 Sign in → Connect with Ethereum → MetaMask 的文案与选择器
 */
import { connectWallet, type Matcher } from '../api'
import type { TaskContext } from './base'

/** Konnex Hub 任务页（各 konnex 任务的统一入口） */
export const KONNEX_HUB_URL = 'https://hub.konnex.world/points'

/** 站内登录入口（钱包已连但 session 未认证时出现） */
export const KONNEX_SIGN_IN_BTN = '[data-testid="connect-wallet-button"]:has-text("Sign in")'

/** 登录弹窗内的入口文案 */
export const KONNEX_ETHEREUM_ENTRY_TEXT = 'Connect with Ethereum'

/** 钱包选择项文案 */
export const KONNEX_METAMASK_ENTRY_TEXT = 'MetaMask'

/** Hub 登录规格：调用方按自己的「真正登录完成」标志声明 connected */
export interface KonnexHubLoginOptions {
  /** 已登录标志：登录完成后才存在的业务元素（签到按钮/任务入口/已完成态等） */
  connected: Matcher
}

/**
 * 走 Konnex Hub 的完整站内登录：Sign in → Connect with Ethereum → MetaMask → SIWE 签名。
 * SIWE 签名由 connectWallet 的 autoConfirmTransaction 默认自动确认；
 * connected 必须是「只有认证后才存在」的元素，不能用 Balance/地址这类钱包已连就会出现的标志。
 * @param ctx 任务上下文
 * @param opts 登录规格（调用方提供已登录标志）
 */
export async function ensureKonnexHubLogin(ctx: TaskContext, opts: KonnexHubLoginOptions): Promise<void> {
  await connectWallet(ctx, {
    wallet: 'metamask',
    connected: opts.connected,
    disconnected: { selector: KONNEX_SIGN_IN_BTN },
    connect: KONNEX_SIGN_IN_BTN,
    confirm: `text=${KONNEX_ETHEREUM_ENTRY_TEXT}`,
    walletOption: { text: KONNEX_METAMASK_ENTRY_TEXT },
  })
}

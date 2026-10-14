/**
 * 钱包连接启发式判据（automation/wallet 层）：当任务未显式提供 connected/disconnected 时，
 * 用一组通用、库无关的判据推断站点登录态与连接入口，供自适应 ensureConnected 复用。
 * 依赖方向：仅依赖 ../dom 的探针原语与 patchright 类型，被 login-flow 依赖。
 * 设计思路：去库名（不认 appkit/rainbowkit/w3m），只描述「页面可见行为」——
 * 已连接 = 页面出现地址样式文本；未连接 = 出现通用连接按钮；连接入口 = 按候选文案找首个可见按钮。
 */
import type { Page } from 'patchright'
import { probeVisible, type Probe } from '../dom'

/** 通用「连接钱包」按钮候选文案（按优先级：英文全称 → 中文 → 英文简写） */
export const CONNECT_BUTTON_TEXTS = ['Connect Wallet', '连接钱包', 'Connect']

/** 通用连接按钮选择器：由候选文案按优先级拼成，供 findConnectButton 与未连接探针共用，避免两处漂移 */
const connectButtonSelector = (): string =>
  CONNECT_BUTTON_TEXTS.map((t) => `button:has-text("${t}")`).join(', ')

/** 启发式已连接判据：页面出现地址样式文本（0x + 至少 6 位十六进制）即视为已连接 */
export const HEURISTIC_CONNECTED: Probe = { selector: 'text=/0x[a-fA-F0-9]{6,}/' }

/** 启发式未连接判据：任一通用连接按钮可见即视为未连接（候选与 findConnectButton 同源） */
export const HEURISTIC_DISCONNECTED: Probe = {
  selector: connectButtonSelector(),
}

/**
 * 站内钱包弹窗「不在列表视图」时的归一化候选（库无关，按优先级排列）：
 * 只保留钱包弹窗专有的结构 testid（返回 / 全部钱包 / 浏览器标签）与「全部钱包」文案，
 * 不再使用页面级通用「返回/Back」文案或 aria-label 兜底——避免误点站点自身的返回按钮。
 */
export const WALLET_LIST_REVEAL_SELECTORS = [
  '[data-testid="header-back"]',
  '[data-testid="all-wallets"]',
  '[data-testid="tab-browser"]',
  'button:has-text("全部钱包")',
  'button:has-text("All wallets")',
]

/**
 * 在页面里按候选文案找首个可见的「连接钱包」按钮，返回其选择器。
 * 逐个候选构造 `button:has-text("...")` 并用探针判可见，命中第一个即返回，
 * 顺序保证「Connect Wallet」优先于「Connect」，避免误选中子串按钮。
 * @param page 目标页面
 * @returns 首个可见连接按钮的选择器；都没找到返回 undefined
 */
export async function findConnectButton(page: Page): Promise<string | undefined> {
  for (const text of CONNECT_BUTTON_TEXTS) {
    const selector = `button:has-text("${text}")`
    if (await probeVisible(page, { selector })) return selector
  }
  return undefined
}

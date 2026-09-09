/**
 * Arc 领水任务（faucet-arc）：Circle 测试网水龙头 https://faucet.circle.com/ 领取 20 testnet USDC
 * 页面核实（2026-09-09 SSR 抓取，选择器已提取；交互细节真机验证后回填）：
 *   表单：input[name="address"]（placeholder Wallet address）+ form button[type="submit"]（文案 Send 20 USDC，地址校验前 disabled）
 *   Network 下拉：button[name="network"]（.field-display-value 显示当前值，默认 Arc Testnet）；
 *     选项 [role="listbox"] [role="option"] 共 38 项（downshift 生成的 item id 带随机数字后缀，按文本匹配）
 *   币种：三张 radio 卡片（USDC/EURC/CIRBTC），input[name="currency"][value="USDC"] 默认 checked；
 *     卡片 [data-testid="select-card-USDC"]（三卡片 id 重复非法，禁用 id 选择器）
 *   验证码：reCAPTCHA v3 无形（页面常驻 api.js，浏览器自行生成 token，不主动打码）
 *     + v2 回退挑战（提交被拒后动态注入 iframe，站点文案 "Please verify that you are not a bot and submit again."）
 *   成功：headline "Tokens sent" + "20 testnet USDC is on its way to your wallet and should appear shortly."
 *   限频：每资产×网络 1-2 小时限领一次（不做判定：用户隔天执行一次，撞限频按失败处理）
 * 流程：开页 → 填 metamask 地址（数据源列，不连钱包）→ 校验网络/币种默认值 → 点 Send → 竞速成功文案/v2 提示
 *   → v2 出现才 yescaptcha 打码（避免误打常驻 v3 白花点数）→ 再点 Send → 成功截图
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// —— 站点元素与文案（2026-09-09 SSR 核实）——
/** 地址输入框 */
export const ADDRESS_SELECTOR = 'input[name="address"]'
/** Network 下拉触发按钮 */
export const NETWORK_BUTTON_SELECTOR = 'button[name="network"]'
/** Network 下拉当前显示值容器 */
export const NETWORK_DISPLAY_SELECTOR = 'button[name="network"] .field-display-value'
/** Network 目标网络名 */
export const TARGET_NETWORK = 'Arc Testnet'
/** Network 下拉目标选项（按文本匹配；downshift 选项 id 带随机后缀不可硬编码） */
export const NETWORK_OPTION_SELECTOR = '[role="listbox"] [role="option"]:has-text("Arc Testnet")'
/** USDC 币种 radio */
export const CURRENCY_RADIO_SELECTOR = 'input[name="currency"][value="USDC"]'
/** USDC 币种卡片（未选中时点击选中） */
export const CURRENCY_CARD_SELECTOR = '[data-testid="select-card-USDC"]'
/** 提交按钮 */
export const SUBMIT_SELECTOR = 'form button[type="submit"]'
/** 领取成功文案（任务单判定文案） */
export const SUCCESS_TEXT = 'is on its way to your wallet and should appear shortly'
/** v2 挑战提示文案（提交被拒后出现；出现才触发打码） */
export const CAPTCHA_V2_TEXT = 'verify that you are not a bot'
/** 提交按钮 enabled 轮询上限（毫秒） */
export const SUBMIT_ENABLED_TIMEOUT_MS = 15000
/** 单次提交后的竞速等待（毫秒） */
export const SUBMIT_RACE_MS = 30000

/** 读取 Network 下拉当前显示值（元素缺失/读取失败返回空串） */
export async function currentNetwork(ctx: TaskContext): Promise<string> {
  const loc = ctx.page.locator(NETWORK_DISPLAY_SELECTOR).first()
  if ((await loc.count()) === 0) return ''
  return ((await loc.textContent().catch(() => '')) ?? '').trim()
}

/** USDC radio 是否已选中（元素缺失/读取失败按未选中处理） */
export async function isUsdcChecked(ctx: TaskContext): Promise<boolean> {
  const loc = ctx.page.locator(CURRENCY_RADIO_SELECTOR).first()
  if ((await loc.count()) === 0) return false
  return (await loc.isChecked().catch(() => false)) === true
}

/** 确保 Network = Arc Testnet：已是则不动；否则打开下拉点选目标选项并二次校验 */
export async function ensureNetwork(ctx: TaskContext): Promise<void> {
  if ((await currentNetwork(ctx)) === TARGET_NETWORK) return
  await ctx.human.click(NETWORK_BUTTON_SELECTOR)
  const opt = ctx.page.locator(NETWORK_OPTION_SELECTOR).first()
  if ((await opt.count()) === 0) throw new Error(`Network 下拉未找到选项: ${TARGET_NETWORK}`)
  await ctx.human.click(NETWORK_OPTION_SELECTOR)
  const now = await currentNetwork(ctx)
  if (now !== TARGET_NETWORK) throw new Error(`Network 选择失败: 当前显示 ${now || '(空)'}，期望 ${TARGET_NETWORK}`)
}

/** 确保币种 = USDC：已选中则不动；否则点卡片并二次校验 */
export async function ensureUsdc(ctx: TaskContext): Promise<void> {
  if (await isUsdcChecked(ctx)) return
  await ctx.human.click(CURRENCY_CARD_SELECTOR)
  if (!(await isUsdcChecked(ctx))) throw new Error('USDC 币种选择失败: radio 仍未选中')
}

/** 等提交按钮变为可用（地址校验通过后解除 disabled）；超时抛错 */
export async function ensureSubmitEnabled(ctx: TaskContext, timeoutMs = SUBMIT_ENABLED_TIMEOUT_MS): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const btn = ctx.page.locator(SUBMIT_SELECTOR).first()
    if ((await btn.count()) > 0 && (await btn.isEnabled().catch(() => false))) return
    await ctx.page.waitForTimeout(500)
  }
  throw new Error(`提交按钮 ${timeoutMs}ms 内未变为可用（地址校验未通过？）`)
}

/**
 * Arc 领水任务（faucet-arc）：Circle 测试网水龙头 https://faucet.circle.com/ 领取 20 testnet USDC
 * 页面核实（2026-09-09 SSR 抓取，选择器已提取；交互细节真机验证后回填）：
 *   表单：input[name="address"]（placeholder Wallet address）+ form button[type="submit"]（文案 Send 20 USDC，地址校验前 disabled）
 *   Network 下拉：button[name="network"]（.field-display-value 显示当前值，默认 Arc Testnet）；
 *     选项 [role="listbox"] [role="option"] 共 38 项（downshift 生成的 item id 带随机数字后缀，按文本匹配）
 *   币种：三张 radio 卡片（USDC/EURC/CIRBTC），input[name="currency"][value="USDC"] 默认 checked；
 *     卡片 [data-testid="select-card-USDC"]（三卡片 id 重复非法，禁用 id 选择器）
 *   验证码：reCAPTCHA v3 无形（页面常驻 api.js，浏览器自行生成 token，不主动打码）
 *   成功：headline "Tokens sent" + "20 testnet USDC is on its way to your wallet and should appear shortly."
 *   限频：每资产×网络 1-2 小时限领一次（不做判定：用户隔天执行一次，撞限频按失败处理）
 * 流程：开页 → 填 metamask 地址（数据源列，不连钱包）→ 校验网络/币种默认值 → 点 Send → 等成功文案
 *   → 成功截图（人机验证处理待定：yescaptcha 已移除）
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
/** 提交按钮 enabled 轮询上限（毫秒） */
export const SUBMIT_ENABLED_TIMEOUT_MS = 15000
/** 单次提交后的成功文案等待（毫秒） */
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

/**
 * 等提交按钮变为可用（地址校验通过后解除 disabled）
 * @param onPoll 每次轮询的回调（用于 hydration 清空自愈：发现地址框被清空立即重填）
 * @throws 超时抛错
 */
export async function ensureSubmitEnabled(ctx: TaskContext, timeoutMs = SUBMIT_ENABLED_TIMEOUT_MS, onPoll?: () => Promise<void>): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const btn = ctx.page.locator(SUBMIT_SELECTOR).first()
    if ((await btn.count()) > 0 && (await btn.isEnabled().catch(() => false))) return
    if (onPoll) await onPoll().catch(() => {})
    await ctx.page.waitForTimeout(500)
  }
  throw new Error(`提交按钮 ${timeoutMs}ms 内未变为可用（地址校验未通过？）`)
}

/**
 * 等成功文案出现（单次提交后的唯一判定）；轮询 1s 间隔
 * @returns 预算内文案出现 true / 超时 false
 */
export async function waitForOutcome(ctx: TaskContext, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await ctx.textPresent(SUCCESS_TEXT)) return true
    await ctx.page.waitForTimeout(1000)
  }
  return false
}

/** 点提交并等成功文案；超时抛错（提交后 30000ms 内未出现成功文案） */
async function submitAndWait(ctx: TaskContext): Promise<void> {
  await ctx.human.click(SUBMIT_SELECTOR)
  if (!(await waitForOutcome(ctx, SUBMIT_RACE_MS))) {
    throw new Error(`提交后 ${SUBMIT_RACE_MS}ms 内未出现成功文案`)
  }
}

/** Arc 领水主流程（模块级函数：任务类委托它，集成测试经任务类覆盖）*/
async function runArcFaucet(ctx: TaskContext): Promise<void> {
  // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
  await ctx.closeOtherTabs()
  await ctx.goto()
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  // 钱包地址按窗口从数据源读取（严格模式：缺行/缺列/空值即任务失败——数据没备齐不该硬跑）
  const address = await ctx.account('metamask钱包地址')
  const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
  await addressInput.fill(address)
  await ensureNetwork(ctx)
  await ensureUsdc(ctx)
  // 提交按钮等待 + hydration 清空自愈合并（真机 2026-09-10 批量：React hydration 可晚于 6s 清空地址框，
  // 12+/90 窗口首发失败；每 500ms 轮询发现空框即重填，直到按钮可用或超时）
  await ensureSubmitEnabled(ctx, SUBMIT_ENABLED_TIMEOUT_MS, async () => {
    if (((await addressInput.inputValue().catch(() => '')) ?? '') === '') {
      await addressInput.fill(address)
    }
  })
  // 提交：v3 常驻不打码（浏览器自行生成 token）；只等成功文案，超时抛错交重试
  await submitAndWait(ctx)
  // 成功截图留档；截图失败只告警，不判任务失败（真机偶发等字体加载超时）
  try {
    await ctx.screenshot('arc-faucet-success')
  } catch (e) {
    ctx.log.warn({ step: 'faucet', window: ctx.profile.name, err: (e as Error).message }, '成功截图失败（不影响任务结果）')
  }
}

/** Arc 领水任务（Circle 测试网水龙头：Arc Testnet 领取 20 testnet USDC）*/
export class ArcFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-arc',
    name: 'Arc 领水',
    group: { key: 'arc', name: 'Arc' },
    url: 'https://faucet.circle.com/',
    sourceUrl: 'https://faucet.circle.com/',
    note: '真机核实（2026-09-09）：站点为 reCAPTCHA Enterprise（页面常驻 v3 sitekey 6LcNs_0p，浏览器自行生成 token）；不连钱包，地址取自数据源「metamask钱包地址」列；限频每资产×网络 1-2 小时（不做判定）；人机验证处理待定（yescaptcha 已移除）',
    category: 'faucet',
    lastUpdated: '2026-09-09',
    enabled: true,
    // 页面流程耗时；不连钱包：只填地址，不配置 wallet
    timeoutSec: 420,
    // 短退避：领水任务重试成本低，撞限频/网络抖动重试两次收敛
    retry: { max: 2, backoffSec: 120 },
    // 公共水龙头保守并发：多窗口各自 IP，3 路并行避免触发平台风控
    concurrency: 3,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runArcFaucet(ctx)
  }
}

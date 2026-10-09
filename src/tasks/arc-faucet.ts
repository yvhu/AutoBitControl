/**
 * Arc 领水任务（faucet-arc）：Circle 测试网水龙头 https://faucet.circle.com/ 领取 20 testnet USDC
 * 流程（真机核实）：填地址 → 校验网络/币种 → 点 Send → 竞速成功文案/v2 挑战
 *   → v2 走浏览器插件自动解题（ctx.captcha.waitPlugin）→ 再点 Send → 成功截图
 * 依赖方向：仅依赖 ./base（经 ctx 用能力），不再直接 import automation
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'

// —— 站点元素与文案（2026-09-09 SSR 核实）——
export const ADDRESS_SELECTOR = 'input[name="address"]'
export const NETWORK_BUTTON_SELECTOR = 'button[name="network"]'
export const NETWORK_DISPLAY_SELECTOR = 'button[name="network"] .field-display-value'
export const TARGET_NETWORK = 'Arc Testnet'
export const NETWORK_OPTION_SELECTOR = '[role="listbox"] [role="option"]:has-text("Arc Testnet")'
export const CURRENCY_RADIO_SELECTOR = 'input[name="currency"][value="USDC"]'
export const CURRENCY_CARD_SELECTOR = '[data-testid="select-card-USDC"]'
export const SUBMIT_SELECTOR = 'form button[type="submit"]'
export const SUCCESS_TEXT = 'is on its way to your wallet and should appear shortly'
export const CAPTCHA_V2_TEXT = 'verify that you are not a bot'
export const SUBMIT_ENABLED_TIMEOUT_MS = 15000
export const SUBMIT_RACE_MS = 30000
export const V3_SITEKEY = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'

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
  await ctx.page.locator(NETWORK_BUTTON_SELECTOR).first().click()
  const opt = ctx.page.locator(NETWORK_OPTION_SELECTOR).first()
  if ((await opt.count()) === 0) throw new Error(`Network 下拉未找到选项: ${TARGET_NETWORK}`)
  await ctx.page.locator(NETWORK_OPTION_SELECTOR).first().click()
  const now = await currentNetwork(ctx)
  if (now !== TARGET_NETWORK) throw new Error(`Network 选择失败: 当前显示 ${now || '(空)'}，期望 ${TARGET_NETWORK}`)
}

/** 确保币种 = USDC：已选中则不动；否则点卡片并二次校验 */
export async function ensureUsdc(ctx: TaskContext): Promise<void> {
  if (await isUsdcChecked(ctx)) return
  await ctx.page.locator(CURRENCY_CARD_SELECTOR).first().click()
  if (!(await isUsdcChecked(ctx))) throw new Error('USDC 币种选择失败: radio 仍未选中')
}

/** 等提交按钮变为可用（地址校验通过后解除 disabled）；onPoll 用于 hydration 清空自愈 */
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

/** 竞速等待：成功文案 / v2 挑战文案谁先出现；每 2s 补一次 DOM 挑战检测 */
export async function waitForOutcome(ctx: TaskContext, timeoutMs: number, allowChallenge = true): Promise<'success' | 'captcha' | null> {
  const end = Date.now() + timeoutMs
  let lastCheck = 0
  while (Date.now() < end) {
    if (await ctx.page.getByText(SUCCESS_TEXT, { exact: false }).count() > 0) return 'success'
    if (allowChallenge) {
      if (await ctx.page.getByText(CAPTCHA_V2_TEXT, { exact: false }).count() > 0) return 'captcha'
      if (Date.now() - lastCheck >= 2000 && (await ctx.captcha.hasChallenge(V3_SITEKEY))) return 'captcha'
      lastCheck = Date.now()
    }
    await ctx.page.waitForTimeout(1000)
  }
  return null
}

/** 点提交并竞速等待结果 */
async function submitAndWait(ctx: TaskContext, allowChallenge = true): Promise<'success' | 'captcha' | null> {
  await ctx.page.locator(SUBMIT_SELECTOR).first().click()
  return waitForOutcome(ctx, SUBMIT_RACE_MS, allowChallenge)
}

/** Arc 领水任务（Circle 测试网水龙头：Arc Testnet 领取 20 testnet USDC） */
export class ArcFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-arc',
    name: 'Arc 领水',
    group: { key: 'arc', name: 'Arc' },
    url: 'https://faucet.circle.com/',
    sourceUrl: 'https://faucet.circle.com/',
    note: '真机核实（2026-09-09）：站点为 reCAPTCHA Enterprise（页面常驻 v3 sitekey 6LcNs_0p，浏览器自行生成 token）；提交被拒后动态注入 v2 挑战——人机验证走浏览器插件自动解题（ctx.captcha.waitPlugin，插件=yescaptcha 人机助手；任务侧只等 aria-checked 变绿）；不连钱包，地址取自数据源「metamask钱包地址」列；限频每资产×网络 1-2 小时（不做判定）',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: true,
    timeoutSec: 420,
    retry: { max: 2, backoffSec: 120 },
    concurrency: 3,
  }

  async action(ctx: TaskContext): Promise<void> {
    await ctx.page.locator(ADDRESS_SELECTOR).first().waitFor({ state: 'visible', timeout: 20000 })
    const address = await ctx.account('metamask钱包地址')
    const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
    await addressInput.fill(address)
    await ensureNetwork(ctx)
    await ensureUsdc(ctx)
    // 提交按钮等待 + hydration 清空自愈合并（React hydration 可晚于 6s 清空地址框）
    await ensureSubmitEnabled(ctx, SUBMIT_ENABLED_TIMEOUT_MS, async () => {
      if (((await addressInput.inputValue().catch(() => '')) ?? '') === '') {
        await addressInput.fill(address)
      }
    })
    let outcome = await submitAndWait(ctx)
    if (outcome === 'captcha') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '检测到 v2 挑战，等待浏览器插件自动解题')
      const solved = await ctx.captcha.waitPlugin({ siteKeyExclude: V3_SITEKEY })
      if (solved === 'none') throw new Error('未检测到验证码锚点 frame')
      if (solved === 'timeout') throw new Error('等待验证码插件解题超时（检查插件 ClientKey/余额）')
      await ensureSubmitEnabled(ctx)
      outcome = await submitAndWait(ctx, false)
    }
    if (outcome !== 'success') throw new Error(`提交后 ${SUBMIT_RACE_MS}ms 内未出现成功文案（v2 挑战也未出现）`)
    await ctx.safeScreenshot('arc-faucet-success')
  }
}

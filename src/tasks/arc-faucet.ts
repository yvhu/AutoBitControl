/**
 * Arc 领水任务（faucet-arc）：Circle 测试网水龙头 https://faucet.circle.com/ 领取 20 testnet USDC
 * 流程（真机核实）：填地址 → 校验网络/币种 → 点 Send → 等待成功文案 → 成功截图
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数），不再直接 import automation
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, click, fill, getAccount, waitFor, takeScreenshot } from '../api'

// —— 站点元素与文案（2026-09-09 SSR 核实）——
export const ADDRESS_SELECTOR = 'input[name="address"]' // 收款地址输入框
export const NETWORK_BUTTON_SELECTOR = 'button[name="network"]' // Network 下拉触发按钮
export const NETWORK_DISPLAY_SELECTOR = 'button[name="network"] .field-display-value' // 下拉当前显示值
export const TARGET_NETWORK = 'Arc Testnet' // 目标网络名（必须精确匹配显示文本）
export const NETWORK_OPTION_SELECTOR = '[role="listbox"] [role="option"]:has-text("Arc Testnet")' // 下拉里的目标选项
export const CURRENCY_RADIO_SELECTOR = 'input[name="currency"][value="USDC"]' // USDC 隐藏 radio（读选中态）
export const CURRENCY_CARD_SELECTOR = '[data-testid="select-card-USDC"]' // USDC 可见卡片（点击选中）
export const SUBMIT_SELECTOR = 'form button[type="submit"]' // 表单提交按钮（地址校验通过才启用）
export const SUCCESS_TEXT = 'is on its way to your wallet and should appear shortly' // 提交成功文案
export const SUBMIT_ENABLED_TIMEOUT_MS = 15000 // 等提交按钮启用的预算（地址校验完成）
export const SUBMIT_RACE_MS = 30000 // 提交后等成功文案的预算

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
  await click(ctx, NETWORK_BUTTON_SELECTOR)
  const opt = ctx.page.locator(NETWORK_OPTION_SELECTOR).first()
  if ((await opt.count()) === 0) throw new Error(`Network 下拉未找到选项: ${TARGET_NETWORK}`)
  await click(ctx, NETWORK_OPTION_SELECTOR)
  const now = await currentNetwork(ctx)
  if (now !== TARGET_NETWORK) throw new Error(`Network 选择失败: 当前显示 ${now || '(空)'}，期望 ${TARGET_NETWORK}`)
}

/** 确保币种 = USDC：已选中则不动；否则点卡片并二次校验 */
export async function ensureUsdc(ctx: TaskContext): Promise<void> {
  if (await isUsdcChecked(ctx)) return
  await click(ctx, CURRENCY_CARD_SELECTOR)
  if (!(await isUsdcChecked(ctx))) throw new Error('USDC 币种选择失败: radio 仍未选中')
}

/**
 * 等提交按钮变为可用（地址校验通过后解除 disabled），轮询 500ms。
 * @param ctx 任务上下文
 * @param timeoutMs 等待预算，默认 SUBMIT_ENABLED_TIMEOUT_MS（15s）
 * @param onPoll 每轮轮询后的回调，用于 hydration 清空自愈（重填被清空的地址）
 * @throws 超时仍不可用时抛出
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
 * 点提交并等待成功文案出现（超时返回 false）。
 * 用 api 的 waitFor 文案探针轮询（recoverTexts 置空 = 纯轮询，避免误触发刷新），与旧 getByText 即时判定等价。
 */
async function submitAndWait(ctx: TaskContext): Promise<boolean> {
  await click(ctx, SUBMIT_SELECTOR)
  return waitFor(ctx, { text: SUCCESS_TEXT }, { budgetMs: SUBMIT_RACE_MS, recoverTexts: [] })
}

/** Arc 领水任务（Circle 测试网水龙头：Arc Testnet 领取 20 testnet USDC） */
export class ArcFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-arc',
    name: 'Arc 领水',
    group: { key: 'arc', name: 'Arc' },
    url: 'https://faucet.circle.com/',
    sourceUrl: 'https://faucet.circle.com/',
    note: '真机核实（2026-09-09）：站点为 reCAPTCHA Enterprise（页面常驻 v3 sitekey，浏览器自行生成 token，无交互）；不连钱包，地址取自数据源「metamask钱包地址」列；提交后只等成功文案（人机验证收口为仅 Turnstile 方框点击）；限频每资产×网络 1-2 小时（不做判定）',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: true,
    timeoutSec: 420,
    retry: { max: 2, backoffSec: 120 },
    concurrency: 3,
  }

  /**
   * 站点动作：填地址 → 校正网络/币种 → 提交 → 等成功文案。
   * 站点不连钱包，地址取自数据源「metamask钱包地址」列。
   * @param ctx 任务上下文（page/log/accountRow 等运行时数据）
   */
  async run(ctx: TaskContext): Promise<void> {
    // 0) 打开落地页并清掉残留标签页
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    // 1) 等地址输入框渲染（落地页为 SSR + hydration，可能较慢）
    await waitFor(ctx, { selector: ADDRESS_SELECTOR }, { assert: true, budgetMs: 20000 })
    const address = await getAccount(ctx, 'metamask钱包地址')
    const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
    await fill(ctx, ADDRESS_SELECTOR, address)
    // 2) 校正网络（Arc Testnet）与币种（USDC），已正确则不动
    await ensureNetwork(ctx)
    await ensureUsdc(ctx)
    // 3) 等提交按钮启用；期间做 hydration 清空自愈（React hydration 可晚于 6s 清空地址框）
    await ensureSubmitEnabled(ctx, SUBMIT_ENABLED_TIMEOUT_MS, async () => {
      if (((await addressInput.inputValue().catch(() => '')) ?? '') === '') {
        await addressInput.fill(address)
      }
    })
    // 4) 提交并等成功文案；超时抛错走失败流程（把成功判定提到 action 内，断言明确）
    const ok = await submitAndWait(ctx)
    if (!ok) throw new Error(`提交后 ${SUBMIT_RACE_MS}ms 内未出现成功文案`)
    await takeScreenshot(ctx, 'arc-faucet-success')
  }
}

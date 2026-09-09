/**
 * Arc 领水任务（faucet-arc）：Circle 测试网水龙头 https://faucet.circle.com/ 领取 20 testnet USDC
 * 页面核实（2026-09-09 SSR 抓取，选择器已提取；交互细节真机验证后回填）：
 *   表单：input[name="address"]（placeholder Wallet address）+ form button[type="submit"]（文案 Send 20 USDC，地址校验前 disabled）
 *   Network 下拉：button[name="network"]（.field-display-value 显示当前值，默认 Arc Testnet）；
 *     选项 [role="listbox"] [role="option"] 共 38 项（downshift 生成的 item id 带随机数字后缀，按文本匹配）
 *   币种：三张 radio 卡片（USDC/EURC/CIRBTC），input[name="currency"][value="USDC"] 默认 checked；
 *     卡片 [data-testid="select-card-USDC"]（三卡片 id 重复非法，禁用 id 选择器）
 *   验证码：reCAPTCHA v3 无形（页面常驻 api.js，浏览器自行生成 token，不主动打码）
 *     + v2 回退挑战（提交被拒后动态注入 anchor/bframe iframe，站点文案 "Please verify that you are not a bot and submit again."）
 *   成功：headline "Tokens sent" + "20 testnet USDC is on its way to your wallet and should appear shortly."
 *   限频：每资产×网络 1-2 小时限领一次（不做判定：用户隔天执行一次，撞限频按失败处理）
 * 流程：开页 → 填 metamask 地址（数据源列，不连钱包）→ 校验网络/币种默认值 → 点 Send → 竞速成功文案/v2 提示
 *   → v2 出现走九宫格模拟点击（点复选框 → 截图网格 → yescaptcha 分类 → 点选 → 验证 → aria-checked 循环；
 *     常驻 v3 不打码，避免白花点数）→ 再点 Send → 成功截图
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
/** 常驻 v3 sitekey（页面加载即有，挑战检测时排除） */
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

/**
 * 检测 v2 挑战是否已渲染：主文档存在 anchor iframe 且 sitekey ≠ 常驻 v3，或已出现网格 bframe
 * 注意：ctx.js 会把函数序列化到页面主世界执行，闭包捕获不到模块变量，v3 sitekey 必须在函数体内联
 */
export async function detectV2Challenge(ctx: TaskContext): Promise<boolean> {
  return ctx.js(() => {
    const v3Sitekey = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'
    const anchors = Array.from(document.querySelectorAll('iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="recaptcha/api2/anchor"]'))
    for (const el of anchors) {
      const m = (el.getAttribute('src') ?? '').match(/[?&]k=([^&]+)/)
      if (m && m[1] !== v3Sitekey) return true
    }
    return document.querySelector('iframe[src*="recaptcha/enterprise/bframe"], iframe[src*="recaptcha/api2/bframe"]') !== null
  })
}

/** 竞速等待：成功文案 / v2 挑战文案谁先出现；每 2s 补一次 DOM 挑战检测（v2 文案未渲染但 iframe 已注入时兜底）*/
export async function waitForOutcome(ctx: TaskContext, timeoutMs: number): Promise<'success' | 'captcha' | null> {
  const end = Date.now() + timeoutMs
  let lastCheck = 0
  while (Date.now() < end) {
    if (await ctx.textPresent(SUCCESS_TEXT)) return 'success'
    if (await ctx.textPresent(CAPTCHA_V2_TEXT)) return 'captcha'
    if (Date.now() - lastCheck >= 2000 && (await detectV2Challenge(ctx))) return 'captcha'
    lastCheck = Date.now()
    await ctx.page.waitForTimeout(1000)
  }
  return null
}

/** 点提交并竞速等待结果 */
async function submitAndWait(ctx: TaskContext): Promise<'success' | 'captcha' | null> {
  await ctx.human.click(SUBMIT_SELECTOR)
  return waitForOutcome(ctx, SUBMIT_RACE_MS)
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
  // React hydration 后重渲染会清掉程序化填充（真机首跑必现）——2s 快速检测重填，最多 3 次
  for (let attempt = 0; attempt < 3; attempt++) {
    await ctx.page.waitForTimeout(2000)
    if (((await addressInput.inputValue().catch(() => '')) ?? '') === '') {
      await addressInput.fill(address)
      continue
    }
    break
  }
  await ensureSubmitEnabled(ctx)
  // 提交：v3 常驻不打码（浏览器自行生成 token）；被拒后站点动态注入 v2 挑战（anchor + 九宫格 bframe）
  let outcome = await submitAndWait(ctx)
  if (outcome === 'captcha') {
    ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '检测到 v2 挑战，走九宫格模拟点击')
    const grid = await ctx.solveRecaptchaGrid({ siteKeyExclude: V3_SITEKEY })
    if (grid === 'failed') throw new Error('九宫格模拟点击失败（多轮未通过）')
    // widget 完成后站点恢复提交按钮；再提交一次
    await ensureSubmitEnabled(ctx)
    outcome = await submitAndWait(ctx)
  }
  if (outcome !== 'success') throw new Error(`提交后 ${SUBMIT_RACE_MS}ms 内未出现成功文案（v2 挑战也未出现）`)
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
    note: '真机核实（2026-09-09 rev2）：挑战为 reCAPTCHA Enterprise v2 复选框（sitekey 6LcCqC8s，页面另常驻 v3 6LcNs_0p）；挑战出现后提交按钮禁用直到 widget 完成——token 注入路线不可行（yescaptcha 官方：协议接口非 100% 通过），改走 ReCaptchaV2Classification 九宫格模拟点击（点复选框 → 截图网格 → 分类坐标 → 点选 → 验证 → aria-checked 循环，图片点完 100% 通过）；提示语映射覆盖常见 16+ 类（中英），未覆盖提示语任务失败；限频每资产×网络 1-2 小时一次且失败请求也计数（不做判定，用户隔天执行）；不连钱包，地址取自数据源「metamask钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-09',
    enabled: true,
    // 网格多轮解题 + 页面流程耗时；不连钱包：只填地址，不配置 wallet
    timeoutSec: 420,
    // 短退避：领水任务重试成本低，撞限频/网络抖动重试两次收敛
    retry: { max: 2, backoffSec: 120 },
    captcha: { auto: true },
    // 公共水龙头保守并发：多窗口各自 IP，3 路并行避免触发平台风控
    concurrency: 3,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runArcFaucet(ctx)
  }
}

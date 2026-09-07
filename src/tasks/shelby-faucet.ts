/**
 * Shelby 文档站领水任务（APT 与 ShelbyUSD，两个任务类共用一个领取循环）
 * 真机核实（2026-09-07，窗口 1/3）：
 *   文档页表单：input[name="address"]（placeholder Address）+ Fund 按钮；网络选择器默认 Shelbynet（不动）
 *   领水接口：POST https://faucet.shelbynet.shelby.xyz/fund（ShelbyUSD 带 ?asset=shelbyusd，由页面自身调用）
 *   成功：HTTP 200 txn_hashes 非空，页面出现 "Funding successful! View in explorer"
 *   达上限：HTTP 429 error_code=Rejected + rejection_reasons 含 UsageLimitExhausted
 *   （每币种 5 次/每窗口 IP 合计 10 次/天）
 *   全程无验证码；成功判定走接口响应（页面成功 toast 会累积，无法区分新旧）
 * 流程：打开页面 → 等表单就绪 → 数据源取「petra钱包地址」→ 清空并拟人键入
 *   → 循环最多 MAX_CLAIMS_PER_RUN 次「点 Fund → 等 /fund POST 响应 → 判定」，
 *   达上限提前退出视为成功（服务端计数天然幂等，重跑补领至上限即收敛）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// —— 站点元素（真机核实）——
/** 地址输入框（两个页面一致） */
const ADDRESS_SELECTOR = 'input[name="address"]'
/** 领取按钮（两个页面一致） */
const FUND_BUTTON_SELECTOR = 'button:has-text("Fund")'
/** 领水接口 URL 片段（限定 host：防御网络选择器残留 Local 的异常） */
const FUND_URL_PART = 'faucet.shelbynet.shelby.xyz/fund'
/** 每币种每日最多领取次数（与服务端限额约定一致：合计 10 次/天由两个任务各 5 次用满） */
const MAX_CLAIMS_PER_RUN = 5
/** 单次领取等待接口响应超时（毫秒） */
const FUND_WAIT_MS = 30000
/** 两次领取之间的拟人停顿（毫秒区间） */
const CLAIM_GAP_MIN_MS = 3000
const CLAIM_GAP_MAX_MS = 8000

/** /fund 响应体（成功与拒绝两种形态，真机核实） */
export interface FundResponse {
  txn_hashes?: string[]
  message?: string
  error_code?: string
  rejection_reasons?: Array<{ reason?: string; code?: string }>
}

/** 领取结果判定：success 成功 / limit 达当日上限 / rejected 其它拒绝 */
export type FundVerdict = 'success' | 'limit' | 'rejected'

/** 判定 /fund 响应体：txn_hashes 非空即成功；含 UsageLimitExhausted 即达上限；其余一律拒绝 */
export function judgeFundResponse(body: FundResponse | null): FundVerdict {
  if (body && Array.isArray(body.txn_hashes) && body.txn_hashes.length > 0) return 'success'
  const reasons = body?.rejection_reasons ?? []
  if (reasons.some((r) => r.code === 'UsageLimitExhausted')) return 'limit'
  return 'rejected'
}

/**
 * 领取循环：最多 maxClaims 次「点 Fund → 等 /fund POST 响应 → 判定」
 * - 成功计数并拟人停顿后继续；达上限提前退出（视为成功，重跑幂等）；其它拒绝抛错进失败重试
 * - 每轮点击前防御性校验输入框仍含地址（成功领取后页面可能清空表单），为空则回填
 * - 先注册 waitForResponse 再点击，避免响应早于等待注册；谓词限定 POST 方法与接口 host
 * @returns 实际成功领取次数（达上限提前退出时小于 maxClaims）
 */
export async function runClaimLoop(ctx: TaskContext, address: string, maxClaims: number): Promise<{ claimed: number }> {
  let claimed = 0
  for (let i = 0; i < maxClaims; i++) {
    const input = ctx.page.locator(ADDRESS_SELECTOR).first()
    const current = await input.inputValue().catch(() => '')
    if (current === '') await input.fill(address)
    const respPromise = ctx.page.waitForResponse((r) => r.url().includes(FUND_URL_PART) && r.request().method() === 'POST', {
      timeout: FUND_WAIT_MS,
    })
    await ctx.human.click(FUND_BUTTON_SELECTOR)
    let body: FundResponse | null = null
    try {
      const res = await respPromise
      body = (await res.json().catch(() => null)) as FundResponse | null
    } catch (e) {
      throw new Error(`第 ${i + 1} 次领取失败（等待 /fund 响应超时）: ${(e as Error).message}`)
    }
    const verdict = judgeFundResponse(body)
    if (verdict === 'success') {
      claimed++
      ctx.log.info({ step: 'fund', window: ctx.profile.name, claim: i + 1 }, '领取成功')
      await ctx.page.waitForTimeout(CLAIM_GAP_MIN_MS + Math.floor(Math.random() * (CLAIM_GAP_MAX_MS - CLAIM_GAP_MIN_MS)))
      continue
    }
    if (verdict === 'limit') {
      ctx.log.info({ step: 'fund', window: ctx.profile.name, claim: i + 1 }, '已达当日领取上限，提前结束（视为成功）')
      break
    }
    throw new Error(`第 ${i + 1} 次领取被拒绝: ${JSON.stringify(body ?? {})}`.slice(0, 500))
  }
  return { claimed }
}

/** 领水任务公共流程（两个任务类共用）：不连钱包，地址取自数据源「petra钱包地址」列 */
async function runShelbyFaucet(ctx: TaskContext): Promise<void> {
  // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
  await ctx.closeOtherTabs()
  await ctx.goto()
  // 等表单就绪（输入框可见）
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  // 钱包地址按窗口从数据源读取（严格模式：缺行/缺列/空值即任务失败——数据没备齐不该硬跑）
  const address = await ctx.account('petra钱包地址')
  // 先清空防重试会话残留，再拟人逐键输入
  await ctx.page.locator(ADDRESS_SELECTOR).first().fill('')
  await ctx.typeInto(ADDRESS_SELECTOR, address)
  // 循环领取：最多 MAX_CLAIMS_PER_RUN 次，达上限提前退出（视为成功）
  const { claimed } = await runClaimLoop(ctx, address, MAX_CLAIMS_PER_RUN)
  ctx.log.info({ step: 'fund', window: ctx.profile.name, claimed }, '领水完成')
  // 成功截图留档（自动存档到 data/screenshots/<日期>/<窗口>/<任务>/）
  await ctx.screenshot('shelby-faucet-success')
}

/** APT 领水任务 */
export class ShelbyAptFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'shelby-apt-faucet',
    name: 'Shelby APT 领水',
    url: 'https://docs.shelby.xyz/apis/faucet/aptos',
    sourceUrl: 'https://docs.shelby.xyz/apis/faucet/aptos',
    note: '真机核实（2026-09-07）：文档页表单 input[name="address"] + Fund 按钮；接口 POST faucet.shelbynet.shelby.xyz/fund；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 error_code=Rejected + UsageLimitExhausted 即达上限，视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空（页面显示 Funding successful!，toast 累积不做判定）；网络选择器保持默认 Shelbynet（等待接口限定 host 兜底防御残留 Local）；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-07',
    enabled: true,
    // 不连钱包：只填地址，不配置 wallet
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 600 },
    captcha: { auto: true },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runShelbyFaucet(ctx)
  }
}

/** ShelbyUSD 领水任务 */
export class ShelbyUsdFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'shelby-usd-faucet',
    name: 'Shelby ShelbyUSD 领水',
    url: 'https://docs.shelby.xyz/apis/faucet/shelbyusd',
    sourceUrl: 'https://docs.shelby.xyz/apis/faucet/shelbyusd',
    note: '真机核实（2026-09-07）：与 APT 领水同表单结构；接口 POST faucet.shelbynet.shelby.xyz/fund?asset=shelbyusd；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 UsageLimitExhausted 视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空；网络选择器保持默认 Shelbynet；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-07',
    enabled: true,
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 600 },
    captcha: { auto: true },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runShelbyFaucet(ctx)
  }
}

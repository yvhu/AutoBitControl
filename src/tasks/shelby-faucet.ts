/**
 * Shelby 文档站领水任务（合并版）：一次开窗领取 APT 与 ShelbyUSD 各最多 5 次
 * 真机核实（2026-09-07，窗口 1/3/4 与批量批次）：
 *   文档页表单：input[name="address"]（placeholder Address）+ Fund 按钮；网络选择器默认 Shelbynet（不动）
 *   领水接口：POST https://faucet.shelbynet.shelby.xyz/fund（ShelbyUSD 带 ?asset=shelbyusd，由页面自身调用）
 *   成功：HTTP 200 txn_hashes 非空，页面出现 "Funding successful! View in explorer"
 *   达上限：HTTP 429 error_code=Rejected + rejection_reasons 含 UsageLimitExhausted
 *   （每币种 5 次/每窗口 IP 合计 10 次/天）
 *   全程无验证码；成功判定走接口响应（页面成功 toast 会累积，无法区分新旧）
 * 实测坑（批量批次）：成功 toast 插入后布局位移，下一轮点击可能落空（请求未发出）——
 *   等响应超时后拟人补点一次自我纠正（残余风险：极慢响应下补点会多领一次，
 *   但达上限提前退出使任务自校正，最多造成两币种额度微偏）；任务自身截图
 *   偶发等字体加载超时，截图失败只告警不判任务失败
 * 流程：打开 APT 页 → 填地址 → 领 5 次 → 打开 USD 页 → 填地址 → 领 5 次，
 *   达上限提前退出视为成功（服务端计数天然幂等，重跑补领至上限即收敛）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'
import type { Response } from 'patchright'

// —— 站点元素与接口（真机核实）——
/** 地址输入框（两个页面一致） */
const ADDRESS_SELECTOR = 'input[name="address"]'
/** 领取按钮（两个页面一致） */
const FUND_BUTTON_SELECTOR = 'button:has-text("Fund")'
/** 领水接口 URL 片段（限定 host：防御网络选择器残留 Local 的异常） */
const FUND_URL_PART = 'faucet.shelbynet.shelby.xyz/fund'
/** 每币种每日最多领取次数（与服务端限额约定一致：合计 10 次/天由两页各 5 次用满） */
const MAX_CLAIMS_PER_RUN = 5
/** 单次领取等待接口响应超时（毫秒，真机响应 1-3s；超时触发补点） */
const FUND_WAIT_MS = 10000
/** 响应超时后的补点次数上限（点击落空自我纠正，批量实测校准） */
const RECLICK_MAX = 1
/** 两次领取之间的拟人停顿（毫秒区间） */
const CLAIM_GAP_MIN_MS = 1000
const CLAIM_GAP_MAX_MS = 2000

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
 * 注册并等待一次 /fund POST 响应：注册即吞错（防孤儿 promise 触发进程级 unhandledRejection），
 * 超时返回 null；谓词限定 POST 方法与接口 host
 */
function waitFundResponse(ctx: TaskContext): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.url().includes(FUND_URL_PART) && r.request().method() === 'POST', { timeout: FUND_WAIT_MS })
    .catch(() => null)
}

/**
 * 领取循环：最多 maxClaims 次「点 Fund → 等 /fund POST 响应 → 判定」
 * - 成功计数并拟人停顿后继续；达上限提前退出（视为成功，重跑幂等）；其它拒绝抛错进失败重试
 * - 响应超时（点击落空——成功 toast 插入后布局位移，真机实测）：拟人补点最多 RECLICK_MAX 次
 * - 每轮点击前防御性校验输入框仍含地址（页面可能清空表单），为空则回填
 * - 先注册 waitForResponse 再点击，避免响应早于等待注册
 * @returns 实际成功领取次数（达上限提前退出时小于 maxClaims）
 */
export async function runClaimLoop(ctx: TaskContext, address: string, maxClaims: number): Promise<{ claimed: number }> {
  let claimed = 0
  for (let i = 0; i < maxClaims; i++) {
    const input = ctx.page.locator(ADDRESS_SELECTOR).first()
    const current = await input.inputValue().catch(() => '')
    if (current === '') await input.fill(address)
    let res: Response | null = null
    for (let attempt = 0; attempt <= RECLICK_MAX; attempt++) {
      const respPromise = waitFundResponse(ctx)
      await ctx.human.click(FUND_BUTTON_SELECTOR)
      res = await respPromise
      if (res) break
      ctx.log.warn({ step: 'fund', window: ctx.profile.name, claim: i + 1, attempt: attempt + 1 }, '等待 /fund 响应超时，拟人补点重试')
    }
    if (!res) throw new Error(`第 ${i + 1} 次领取失败（等待 /fund 响应超时）`)
    const body = (await res.json().catch(() => null)) as FundResponse | null
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

/** 领水任务公共流程：每页填地址 + 循环领取；不连钱包，地址取自数据源「petra钱包地址」列 */
async function runShelbyFaucet(ctx: TaskContext, usdUrl: string): Promise<void> {
  // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
  await ctx.closeOtherTabs()
  await ctx.goto()
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  // 钱包地址按窗口从数据源读取（严格模式：缺行/缺列/空值即任务失败——数据没备齐不该硬跑）
  const address = await ctx.account('petra钱包地址')
  // APT 页：fill 直填（等价粘贴，免逐键打字）
  await ctx.page.locator(ADDRESS_SELECTOR).first().fill(address)
  const apt = await runClaimLoop(ctx, address, MAX_CLAIMS_PER_RUN)
  ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'apt', claimed: apt.claimed }, 'APT 领水完成')
  // ShelbyUSD 页
  await ctx.goto(usdUrl)
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  await ctx.page.locator(ADDRESS_SELECTOR).first().fill(address)
  const usd = await runClaimLoop(ctx, address, MAX_CLAIMS_PER_RUN)
  ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'shelbyusd', claimed: usd.claimed }, 'ShelbyUSD 领水完成')
  // 成功截图留档；截图偶发等字体加载超时（真机实测）——失败只告警，不判任务失败
  try {
    await ctx.screenshot('shelby-faucet-success')
  } catch (e) {
    ctx.log.warn({ step: 'fund', window: ctx.profile.name, err: (e as Error).message }, '成功截图失败（不影响任务结果）')
  }
}

/** Shelby 领水任务（合并版：APT + ShelbyUSD 各最多 5 次，一次开窗） */
export class ShelbyFaucetTask extends SiteTask {
  /** ShelbyUSD 文档页地址（独立于 meta.url，供集成测试覆盖为本地 fixture） */
  usdUrl = 'https://docs.shelby.xyz/apis/faucet/shelbyusd'

  meta: TaskMeta = {
    key: 'shelby-faucet',
    name: 'Shelby 领水',
    url: 'https://docs.shelby.xyz/apis/faucet/aptos',
    sourceUrl: ['https://docs.shelby.xyz/apis/faucet/aptos', 'https://docs.shelby.xyz/apis/faucet/shelbyusd'],
    note: '真机核实（2026-09-07）：两文档页表单一致（input[name="address"] + Fund 按钮）；接口 POST faucet.shelbynet.shelby.xyz/fund（USD 带 ?asset=shelbyusd）；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 UsageLimitExhausted 视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空；成功 toast 插入会致下一轮点击偶发落空——响应超时自动补点一次；任务截图偶发等字体超时已非致命化；地址 fill 直填（等价粘贴）；网络选择器保持默认 Shelbynet；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-07',
    enabled: true,
    // 不连钱包：只填地址，不配置 wallet
    timeoutSec: 300,
    // 短退避：服务端计数幂等，重跑补领至上限即收敛
    retry: { max: 2, backoffSec: 120 },
    captcha: { auto: true },
    concurrency: 6,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runShelbyFaucet(ctx, this.usdUrl)
  }
}

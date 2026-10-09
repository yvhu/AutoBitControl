/**
 * Shelby 文档站领水任务（合并版）：一次开窗领取 APT 与 ShelbyUSD 各最多 5 次
 * 两页流程：APT 页 → 填地址 → 循环领取 → USD 页 → 填地址 → 循环领取
 * 成功判定走 /fund 接口响应；达上限（UsageLimitExhausted）视为成功幂等收敛
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）；不连钱包
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, click, fill, getAccount, waitFor, takeScreenshot } from '../api'
import type { Response } from 'patchright'

const ADDRESS_SELECTOR = 'input[name="address"]' // 收款地址输入框（APT 页与 USD 页一致）
const FUND_BUTTON_SELECTOR = 'button:has-text("Fund")' // 领取按钮
const FUND_URL_PART = 'faucet.shelbynet.shelby.xyz/fund' // /fund 接口 URL 片段（判断响应归属）
const MAX_CLAIMS_PER_RUN = 5 // 每币种每次运行最多领取次数（站点限额）
const FUND_WAIT_MS = 10000 // 单次等 /fund 响应的预算
const RECLICK_MAX = 1 // 等待响应超时后补点 Fund 的最大次数
const CLAIM_GAP_MIN_MS = 1000 // 两次成功领取之间的最小间隔（拟人化）
const CLAIM_GAP_MAX_MS = 2000 // 两次成功领取之间的最大间隔

/** /fund 接口响应体（字段均可选：成功带 txn_hashes，限额带 rejection_reasons.code=UsageLimitExhausted） */
export interface FundResponse {
  txn_hashes?: string[] // 成功时返回的交易哈希列表（非空即成功）
  message?: string // 服务端提示文案
  error_code?: string // 错误码
  rejection_reasons?: Array<{ reason?: string; code?: string }> // 拒绝原因列表（限额判定看 code）
}

/** 领取判定结果：success=成功、limit=已达上限（按成功幂等处理）、rejected=被拒 */
export type FundVerdict = 'success' | 'limit' | 'rejected'

/** 判定 /fund 响应体：txn_hashes 非空即成功；含 UsageLimitExhausted 即达上限；其余一律拒绝 */
export function judgeFundResponse(body: FundResponse | null): FundVerdict {
  if (body && Array.isArray(body.txn_hashes) && body.txn_hashes.length > 0) return 'success'
  const reasons = body?.rejection_reasons ?? []
  if (reasons.some((r) => r.code === 'UsageLimitExhausted')) return 'limit'
  return 'rejected'
}

/** 注册并等待一次 /fund POST 响应（注册即吞错；超时返回 null） */
function waitFundResponse(ctx: TaskContext): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.url().includes(FUND_URL_PART) && r.request().method() === 'POST', { timeout: FUND_WAIT_MS })
    .catch(() => null)
}

/**
 * 领取循环：最多 maxClaims 次「点 Fund → 等 /fund POST 响应 → 判定」。
 * 每轮先确保地址框有值；等响应超时则拟人补点一次；success 计数并随机间隔后续领，
 * limit 提前结束（视为成功幂等），rejected 直接抛错。
 * @param ctx 任务上下文
 * @param address 收款地址（数据源 petra 钱包地址）
 * @param maxClaims 本页最多尝试领取次数
 * @returns claimed=实际成功领取次数（达上限提前退出时可能小于 maxClaims）
 */
export async function runClaimLoop(ctx: TaskContext, address: string, maxClaims: number): Promise<{ claimed: number }> {
  let claimed = 0
  for (let i = 0; i < maxClaims; i++) {
    const input = ctx.page.locator(ADDRESS_SELECTOR).first()
    const current = await input.inputValue().catch(() => '')
    if (current === '') await fill(ctx, ADDRESS_SELECTOR, address)
    let res: Response | null = null
    for (let attempt = 0; attempt <= RECLICK_MAX; attempt++) {
      const respPromise = waitFundResponse(ctx)
      await click(ctx, FUND_BUTTON_SELECTOR)
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

/** Shelby 领水任务（合并版：APT + ShelbyUSD 各最多 5 次，一次开窗） */
export class ShelbyFaucetTask extends SiteTask {
  usdUrl = 'https://docs.shelby.xyz/apis/faucet/shelbyusd'

  meta: TaskMeta = {
    key: 'shelby-faucet',
    name: 'Shelby 领水',
    group: { key: 'shelby', name: 'Shelby' },
    url: 'https://docs.shelby.xyz/apis/faucet/aptos',
    sourceUrl: ['https://docs.shelby.xyz/apis/faucet/aptos', 'https://docs.shelby.xyz/apis/faucet/shelbyusd'],
    note: '真机核实（2026-09-07）：两文档页表单一致（input[name="address"] + Fund 按钮）；接口 POST faucet.shelbynet.shelby.xyz/fund（USD 带 ?asset=shelbyusd）；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 UsageLimitExhausted 视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空；成功 toast 插入会致下一轮点击偶发落空——响应超时自动补点一次；截图偶发等字体超时已非致命化；地址 fill 直填；网络选择器保持默认 Shelbynet；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: true,
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 120 },
    concurrency: 6,
  }

  /**
   * 两页流程，覆盖默认 run：一次开窗连续领 APT 与 ShelbyUSD。
   * 先清理残留标签页，再先后对两页执行领取，最后统一截图。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    // APT 页首次领取：开页并清残留标签页；地址在此读取（第二页复用）
    const address = await this.claimOnPage(ctx, this.meta.url, undefined, true)
    ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'apt', claimed: address.claimed }, 'APT 领水完成')
    // USD 页复用 APT 页读到的同一地址，避免重复读数据源
    const usd = await this.claimOnPage(ctx, this.usdUrl, address.addr)
    ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'shelbyusd', claimed: usd.claimed }, 'ShelbyUSD 领水完成')
    await takeScreenshot(ctx, 'shelby-faucet-success')
  }

  /**
   * 打开一页 → 等地址框 → 取/用地址 → 填地址 → 循环领取。
   * @param ctx 任务上下文
   * @param url 该币种文档页地址
   * @param knownAddress 已读到的地址（第二页复用传入）；省略时从数据源「petra钱包地址」读取
   * @param closeOtherTabs 是否在开页时清掉残留标签页（仅首个页面置 true）
   * @returns addr=使用的地址、claimed=本页成功领取次数
   */
  private async claimOnPage(ctx: TaskContext, url: string, knownAddress?: string, closeOtherTabs = false): Promise<{ addr: string; claimed: number }> {
    await openPage(ctx, url, { closeOtherTabs })
    await waitFor(ctx, { selector: ADDRESS_SELECTOR }, { assert: true, budgetMs: 20000 })
    const addr = knownAddress ?? (await getAccount(ctx, 'petra钱包地址'))
    await fill(ctx, ADDRESS_SELECTOR, addr)
    const { claimed } = await runClaimLoop(ctx, addr, MAX_CLAIMS_PER_RUN)
    return { addr, claimed }
  }
}

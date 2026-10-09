/**
 * AuraLaunch 领水任务（auralaunch-faucet）：Caldera LiteForge 测试网水龙头
 * 地址取自数据源「metamask钱包地址」直填（不连钱包）；领取走 tRPC，限频=已领取=成功幂等
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import type { Response } from 'patchright'

export const ADDRESS_SELECTOR = 'input[placeholder="Recipient\'s Wallet Address"]' // 收款地址输入框
export const REQUEST_BTN_SELECTOR = '.flex.justify-center.items-center.gap-2:has-text("Request")' // Request 领取按钮
export const LIMIT_KEYWORDS = ['sorry, something went wrong', 'try again later', 'already claimed', 'rate limit', 'cooldown', '24 hours'] // 限频/已领取文案（命中即按成功幂等）
export const SUCCESS_TEXT = 'Successfully requested funds to your wallet' // 页面成功文案
export const FAUCET_RESPONSE_WAIT_MS = 15000 // 单次等领水请求的预算
export const UI_OUTCOME_WAIT_MS = 30000 // 无请求时等页面成功/限频文案的预算
export const INPUT_READY_WAIT_MS = 45000 // 首屏等地址框可用的预算
export const INPUT_READY_RELOAD_WAIT_MS = 30000 // 刷新后等地址框可用的预算
export const RECLICK_MAX = 1 // 未捕获请求时补点 Request 的最大次数（Turnstile token 未就绪自愈）
export const RECLICK_WAIT_MS = 5000 // 补点前等待时间

/**
 * 解包 tRPC 批量信封（真机 2026-10-08 核实）：
 *   成功/失败：200 + [{result:{data:{json:{success:boolean,message:string}}}}]
 *   限频：429 + [{error:{json:{message,code,data:{code:"TOO_MANY_REQUESTS"}}}}]
 * 返回 success 布尔与 message；无该信封返回 null
 */
export function unwrapTrpcEnvelope(body: unknown): { success?: boolean; message?: string } | null {
  const items = Array.isArray(body) ? body : [body]
  for (const item of items) {
    const it = item as { result?: { data?: unknown }; error?: { json?: unknown } } | null
    if (!it) continue
    const resultData = it.result?.data as { json?: unknown } | null
    const json = resultData?.json ?? null
    if (json && typeof json === 'object' && typeof (json as { success?: unknown }).success === 'boolean') {
      const c = json as { success: boolean; message?: unknown }
      return { success: c.success, message: typeof c.message === 'string' ? c.message : '' }
    }
  }
  return null
}

/**
 * 领水响应判定（真机 2026-10-08 核实：成功/失败都返回 200 + success 布尔，不能只看状态码）：
 * 429 + TOO_MANY_REQUESTS = limit；信封 success:true = success；success:false = rejected；无信封按状态码兜底
 */
export async function judgeFaucetResponse(res: Response): Promise<'success' | 'limit' | 'rejected'> {
  const body = await res.json().catch(() => null)
  const raw = JSON.stringify(body ?? {})
  const envelope = unwrapTrpcEnvelope(body)
  if (envelope && typeof envelope.success === 'boolean') return envelope.success ? 'success' : 'rejected'
  if (res.status() === 429) return 'limit'
  if (/TOO_MANY_REQUESTS|24 hours|rate limit|cooldown/i.test(raw)) return 'limit'
  if (res.status() >= 200 && res.status() < 300) return 'success'
  return 'rejected'
}

/**
 * 注册并等待一次领水 POST 响应（请求体含目标地址以区分本窗口请求；注册即吞错，超时返回 null）。
 * @param ctx 任务上下文
 * @param address 目标地址（用于匹配请求体）
 */
export function waitFaucetResponse(ctx: TaskContext, address: string): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.request().method() === 'POST' && (r.request().postData() ?? '').includes(address), { timeout: FAUCET_RESPONSE_WAIT_MS })
    .catch(() => null)
}

/**
 * 轮询页面文案判结果（无请求可捕获时的兜底）：成功文案=success、命中任限频词=limit、超时=none。
 * @param ctx 任务上下文
 * @param timeoutMs 轮询预算，默认 UI_OUTCOME_WAIT_MS
 */
export async function waitUiOutcome(ctx: TaskContext, timeoutMs = UI_OUTCOME_WAIT_MS): Promise<'success' | 'limit' | 'none'> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await ctx.page.getByText(SUCCESS_TEXT, { exact: false }).count() > 0) return 'success'
    for (const kw of LIMIT_KEYWORDS) {
      if (await ctx.page.getByText(kw, { exact: false }).count() > 0) return 'limit'
    }
    await ctx.page.waitForTimeout(1000)
  }
  return 'none'
}

/**
 * 等地址框就绪：先按 timeoutMs 轮询；若始终不存在则刷新一次再按刷新预算轮询。
 * 地址框存在但持续禁用是站点已领取的表现（由调用方结合限频文案判定）。
 * @param ctx 任务上下文
 * @param timeoutMs 首轮等待预算，默认 INPUT_READY_WAIT_MS
 * @returns ready=出现且可用、disabled=出现但禁用、missing=两轮都不存在
 */
export async function waitInputReady(ctx: TaskContext, timeoutMs = INPUT_READY_WAIT_MS): Promise<'ready' | 'disabled' | 'missing'> {
  const poll = async (ms: number): Promise<'ready' | 'disabled' | null> => {
    const end = Date.now() + ms
    let existed = false
    while (Date.now() < end) {
      const loc = ctx.page.locator(ADDRESS_SELECTOR).first()
      if ((await loc.count()) > 0) {
        existed = true
        if (await loc.isEnabled().catch(() => false)) return 'ready'
      }
      await ctx.page.waitForTimeout(1000)
    }
    return existed ? 'disabled' : null
  }
  const first = await poll(timeoutMs)
  if (first) return first
  await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  return (await poll(INPUT_READY_RELOAD_WAIT_MS)) ?? 'missing'
}

/** AuraLaunch 领水任务（Caldera LiteForge 测试网水龙头） */
export class AuralaunchFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'auralaunch-faucet',
    name: 'AuraLaunch 领水',
    group: { key: 'auralaunch', name: 'AuraLaunch' },
    url: 'https://liteforge.hub.caldera.xyz/',
    sourceUrl: 'https://liteforge.hub.caldera.xyz/',
    note: '真机核实（2026-10-08）：Caldera LiteForge 水龙头（Bridge/Faucet 同页 SPA）；地址框 input[placeholder="Recipient\'s Wallet Address"]；不连钱包，地址取自数据源「metamask钱包地址」列；领水走 tRPC faucet.requestFaucetFunds——成功 200+success:true、失败 200+success:false（不能只看状态码）、限频 429+TOO_MANY_REQUESTS（24h 一次，视为已领取=成功幂等）；站点有 Turnstile（实测无需人工点击），token 未就绪时点击无请求——补点一次自愈；落地页渲染可超 20s、已领后地址框可能短暂禁用——等就绪+刷新兜底',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: true,
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 120 },
    concurrency: 3,
  }

  /**
   * 站点动作：等地址框就绪 → 读地址填入 → 点 Request 并捕获 tRPC 响应 → 判定成功/限频/拒绝。
   * 不连钱包；限频（24h 一次）视为已领取=成功幂等。
   * @param ctx 任务上下文，提供 page、account（取数据源列）、log、safeScreenshot
   */
  async action(ctx: TaskContext): Promise<void> {
    // 1) 等地址框就绪；missing=站点未渲染/改版，直接失败
    const ready = await waitInputReady(ctx)
    if (ready === 'missing') throw new Error('地址输入框未出现（页面未渲染或站点改版）')
    // 2) 地址框存在但禁用：多为已领取（结合限频文案确认为成功幂等），否则失败并附页面文本
    if (ready === 'disabled') {
      // 逐一匹配全部限频关键词（与旧 recoverErrorText(LIMIT_KEYWORDS) 等价）
      let limitText = ''
      for (const kw of LIMIT_KEYWORDS) {
        if (await ctx.page.getByText(kw, { exact: false }).count() > 0) { limitText = kw; break }
      }
      if (limitText !== '') {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name, limitText }, '地址框禁用且出现限频提示，视为已领取 = 成功（重跑幂等）')
        await ctx.safeScreenshot('auralaunch-faucet-limit')
        return
      }
      const bodyText = await ctx.page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '')
      throw new Error(`地址输入框持续禁用且无限频提示（页面文本: ${bodyText.slice(0, 300)}）`)
    }
    // 3) 读地址并填入；填后被框架清空则再填一次
    const address = await ctx.account('metamask钱包地址')
    const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
    await addressInput.fill(address)
    if (((await addressInput.inputValue().catch(() => '')) ?? '') !== address) {
      await addressInput.fill(address)
    }
    // 4) 点 Request 并捕获请求；未捕获（Turnstile token 未就绪）则等待后补点
    let resp: Response | null = null
    for (let attempt = 0; attempt <= RECLICK_MAX && !resp; attempt++) {
      const respPromise = waitFaucetResponse(ctx, address)
      await ctx.page.locator(REQUEST_BTN_SELECTOR).first().click()
      resp = await respPromise
      if (!resp && attempt < RECLICK_MAX) {
        ctx.log.warn({ step: 'faucet', window: ctx.profile.name, attempt: attempt + 1 }, '点击 Request 后未捕获领水请求（Turnstile 未就绪？），等待后补点')
        await ctx.page.waitForTimeout(RECLICK_WAIT_MS)
      }
    }
    if (resp) {
      const verdict = await judgeFaucetResponse(resp)
      if (verdict === 'success') {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '领水成功（tRPC success:true）')
        await ctx.safeScreenshot('auralaunch-faucet-success')
        return
      }
      if (verdict === 'limit') {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '已达当日领取上限（24h 限频），视为已领取 = 成功（重跑幂等）')
        await ctx.safeScreenshot('auralaunch-faucet-limit')
        return
      }
      const envelope = unwrapTrpcEnvelope(await resp.json().catch(() => null))
      throw new Error(`领水请求被拒绝: ${envelope?.message ?? '未知原因（无信封）'}`.slice(0, 400))
    }
    const outcome = await waitUiOutcome(ctx)
    if (outcome === 'success') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '领水成功（页面成功文案）')
      await ctx.safeScreenshot('auralaunch-faucet-success')
      return
    }
    if (outcome === 'limit') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '页面出现限频提示，视为已领取 = 成功（重跑幂等）')
      await ctx.safeScreenshot('auralaunch-faucet-limit')
      return
    }
    const bodyText = await ctx.page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '')
    throw new Error(`点击 Request 后未出现成功/限频信号（页面文本: ${bodyText.slice(0, 300)}）`)
  }
}

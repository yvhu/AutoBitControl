/**
 * AuraLaunch 领水任务（auralaunch-faucet）：Caldera LiteForge 测试网水龙头
 * 地址取自数据源「metamask钱包地址」直填（不连钱包）；领取走 tRPC，限频=已领取=成功幂等
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import type { Response } from 'patchright'

export const ADDRESS_SELECTOR = 'input[placeholder="Recipient\'s Wallet Address"]'
export const REQUEST_BTN_SELECTOR = '.flex.justify-center.items-center.gap-2:has-text("Request")'
export const LIMIT_KEYWORDS = ['sorry, something went wrong', 'try again later', 'already claimed', 'rate limit', 'cooldown', '24 hours']
export const SUCCESS_TEXT = 'Successfully requested funds to your wallet'
export const FAUCET_RESPONSE_WAIT_MS = 15000
export const UI_OUTCOME_WAIT_MS = 30000
export const INPUT_READY_WAIT_MS = 45000
export const INPUT_READY_RELOAD_WAIT_MS = 30000
export const RECLICK_MAX = 1
export const RECLICK_WAIT_MS = 5000

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

export function waitFaucetResponse(ctx: TaskContext, address: string): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.request().method() === 'POST' && (r.request().postData() ?? '').includes(address), { timeout: FAUCET_RESPONSE_WAIT_MS })
    .catch(() => null)
}

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

  async action(ctx: TaskContext): Promise<void> {
    const ready = await waitInputReady(ctx)
    if (ready === 'missing') throw new Error('地址输入框未出现（页面未渲染或站点改版）')
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
    const address = await ctx.account('metamask钱包地址')
    const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
    await addressInput.fill(address)
    if (((await addressInput.inputValue().catch(() => '')) ?? '') !== address) {
      await addressInput.fill(address)
    }
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

/**
 * AuraLaunch 领水任务（auralaunch-faucet）：Caldera LiteForge 测试网水龙头 https://liteforge.hub.caldera.xyz/
 * 真机核实（2026-10-08，窗口 04/05/76/92/100 探针与批量批次）：
 *   页面为 SPA：Bridge 与 Faucet 卡片同页，faucet 卡片含 input[placeholder="Recipient's Wallet Address"] + Request 按钮
 *   不连钱包：地址按窗口从数据源「metamask钱包地址」列读取直填
 *   领水接口：POST https://liteforge.hub.caldera.xyz/api/trpc/faucet.requestFaucetFunds（tRPC 批量信封）
 *     请求体 {"0":{"json":{"rollupSubdomain":"liteforge","recipientAddress":"<地址>","turnstileToken":"..."}}}
 *     成功：200 + [{result:{data:{json:{success:true}}}}]
 *     失败：200 + [{result:{data:{json:{success:false,"message":"Failed to send transaction"}}}}]（不能只看状态码！）
 *     限频：429 + [{error:{json:{message:"You can only request funds once every 24 hours...",code:-32029,data:{code:"TOO_MANY_REQUESTS"}}}}]
 *   站点有 Cloudflare Turnstile（sitekey 0x4AAAAAAASRorjU_k9HAdVc，render=explicit）：
 *     实测无需人工点击（token 自动生成，challenge-platform 流量为自动模式）；
 *     但 token 未生成时点 Request 无请求发出（窗口76）——响应超时补点一次自愈
 *   坑：落地页渲染可超 20s（窗口84）；当日已领取后地址框可能短暂 disabled（窗口99）——等就绪 + 刷新兜底
 *   限频视为已领取 = 成功（重跑幂等，窗口100/92 实测 429 收敛）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'
import type { Response } from 'patchright'

// —— 站点元素与文案（素材核实；真机复核后再收紧）——
/** 收款地址输入框 */
export const ADDRESS_SELECTOR = 'input[placeholder="Recipient\'s Wallet Address"]'
/** 领取按钮（素材为 div 文案 Request；类名取稳定片段，不限定标签） */
export const REQUEST_BTN_SELECTOR = '.flex.justify-center.items-center.gap-2:has-text("Request")'
/** 限频兜底关键词（英文通用；成功/限频原文真机核实后替换为精确文案） */
export const LIMIT_KEYWORDS = ['sorry, something went wrong', 'try again later', 'already claimed', 'rate limit', 'cooldown', '24 hours']
/** 领水成功文案（用户确认：Successfully requested funds to your wallet!） */
export const SUCCESS_TEXT = 'Successfully requested funds to your wallet'
/** 等领水响应超时（毫秒；响应未捕获走 UI 兜底） */
export const FAUCET_RESPONSE_WAIT_MS = 15000
/** UI 兜底竞速预算（毫秒） */
export const UI_OUTCOME_WAIT_MS = 30000
/** 等地址框就绪预算（毫秒；真机 2026-10-08：窗口84 落地页 20s 未渲染出输入框，99 已领取后输入框持续 disabled） */
export const INPUT_READY_WAIT_MS = 45000
/** 就绪判定后的刷新重试预算（毫秒） */
export const INPUT_READY_RELOAD_WAIT_MS = 30000
/** 点击后未捕获领水请求的补点次数（真机 2026-10-08：窗口76 点击后无任何请求，疑似 Turnstile token 未生成） */
export const RECLICK_MAX = 1
/** 补点前的等待（毫秒；给 Turnstile token 生成留时间） */
export const RECLICK_WAIT_MS = 5000

/**
 * 解包 tRPC 批量信封（真机 2026-10-08 核实）：
 *   成功/失败：[{result:{data:{json:{success:boolean,message:string}}}}]
 *   限频：[{error:{json:{message,code,data:{code:"TOO_MANY_REQUESTS",...}}}}]
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
 * 领水响应判定（真机 2026-10-08 核实：失败同样返回 200 + success:false，不能只看状态码）：
 * 限频关键词/429 → limit；tRPC 信封 success:true → success；success:false → rejected；无信封按状态码兜底
 */
export async function judgeFaucetResponse(res: Response): Promise<'success' | 'limit' | 'rejected'> {
  const body = await res.json().catch(() => null)
  const raw = JSON.stringify(body ?? {})
  const envelope = unwrapTrpcEnvelope(body)
  // 1) tRPC 信封 success 布尔优先（真机核实：成功/失败都以 200 + success 返回，不能只看状态码）
  if (envelope && typeof envelope.success === 'boolean') {
    return envelope.success ? 'success' : 'rejected'
  }
  // 2) 限频：HTTP 429 或响应体含限频/24h/TOO_MANY_REQUESTS 标识
  if (res.status() === 429) return 'limit'
  if (/TOO_MANY_REQUESTS|24 hours|rate limit|cooldown/i.test(raw)) return 'limit'
  // 3) 无信封兜底：2xx 按成功，其余拒绝
  if (res.status() >= 200 && res.status() < 300) return 'success'
  return 'rejected'
}

/**
 * 注册并等待领水 POST 响应（谓词：请求体含所填钱包地址）；
 * 注册即吞错（防孤儿 promise 触发进程级 unhandledRejection），超时返回 null
 */
export function waitFaucetResponse(ctx: TaskContext, address: string): Promise<Response | null> {
  return ctx.page
    .waitForResponse(
      (r) => r.request().method() === 'POST' && (r.request().postData() ?? '').includes(address),
      { timeout: FAUCET_RESPONSE_WAIT_MS },
    )
    .catch(() => null)
}

/** UI 兜底竞速：成功文案 → success；限频文案 → limit；超时 none（Request 按钮是否消失不可靠，不作为成功信号） */
export async function waitUiOutcome(ctx: TaskContext, timeoutMs = UI_OUTCOME_WAIT_MS): Promise<'success' | 'limit' | 'none'> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await ctx.textPresent(SUCCESS_TEXT)) return 'success'
    for (const kw of LIMIT_KEYWORDS) {
      if (await ctx.textPresent(kw)) return 'limit'
    }
    await ctx.page.waitForTimeout(1000)
  }
  return 'none'
}

/**
 * 等地址框就绪：'ready' 可编辑；'disabled' 预算内存在但始终禁用（已领取限频状态/加载竞态）；
 * 'missing' 刷新兜底后仍未出现（页面未渲染或站点改版）
 * 真机 2026-10-08：落地页渲染可超 20s（窗口84 断言超时）；当日已领取后输入框 disabled（窗口99 fill 超时）
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
  // 刷新兜底一次（输入框未出现/持续禁用可能是加载竞态），之后按最终状态返回
  await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  return (await poll(INPUT_READY_RELOAD_WAIT_MS)) ?? 'missing'
}

/** 成功截图（容错）：截图失败只告警不判任务失败 */
async function screenshotSafe(ctx: TaskContext, name: string): Promise<void> {
  try {
    await ctx.screenshot(name)
  } catch (e) {
    ctx.log.warn({ step: 'faucet', window: ctx.profile.name, err: (e as Error).message }, '成功截图失败（不影响任务结果）')
  }
}

/** AuraLaunch 领水主流程（模块级函数：任务类委托它，测试经任务类覆盖） */
async function runAuralaunchFaucet(ctx: TaskContext): Promise<void> {
  // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
  await ctx.closeOtherTabs()
  await ctx.goto()
  // 等地址框就绪（真机：落地页渲染可超 20s；已领取后输入框持续 disabled）
  const ready = await waitInputReady(ctx)
  if (ready === 'missing') throw new Error('地址输入框未出现（页面未渲染或站点改版）')
  if (ready === 'disabled') {
    // 输入框禁用且页面出现限频提示 → 当天已领取 = 成功（幂等）；否则抛错带页面文本排障
    const limitText = await ctx.recoverErrorText(LIMIT_KEYWORDS)
    if (limitText !== '') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name, limitText }, '地址框禁用且出现限频提示，视为已领取 = 成功（重跑幂等）')
      await screenshotSafe(ctx, 'auralaunch-faucet-limit')
      return
    }
    const bodyText = await ctx
      .js<string>(() => document.body.innerText.slice(0, 500))
      .catch(() => '')
    throw new Error(`地址输入框持续禁用且无限频提示（页面文本: ${bodyText.slice(0, 300)}）`)
  }
  // 钱包地址按窗口从数据源读取（严格模式：缺行/缺列/空值即任务失败——数据没备齐不该硬跑）
  const address = await ctx.account('metamask钱包地址')
  const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
  await addressInput.fill(address)
  // 防御性校验：站点可能按已连钱包自动填地址，确认覆盖成功再点（不一致重填一次）
  if (((await addressInput.inputValue().catch(() => '')) ?? '') !== address) {
    await addressInput.fill(address)
  }
  // 先注册响应等待再点击，避免响应早于等待注册；Turnstile token 未生成时点击可能无请求发出——
  // 响应超时后补点一次（真机 2026-10-08：窗口76 点击后无任何请求）
  let resp: Response | null = null
  for (let attempt = 0; attempt <= RECLICK_MAX && !resp; attempt++) {
    const respPromise = waitFaucetResponse(ctx, address)
    await ctx.human.click(REQUEST_BTN_SELECTOR)
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
      await screenshotSafe(ctx, 'auralaunch-faucet-success')
      return
    }
    if (verdict === 'limit') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '已达当日领取上限（24h 限频），视为已领取 = 成功（重跑幂等）')
      await screenshotSafe(ctx, 'auralaunch-faucet-limit')
      return
    }
    const envelope = unwrapTrpcEnvelope(await resp.json().catch(() => null))
    throw new Error(`领水请求被拒绝: ${envelope?.message ?? '未知原因（无信封）'}`.slice(0, 400))
  }
  // 未捕获到领水响应（接口形态与预期不符）：UI 兜底竞速（成功/限频文案）
  const outcome = await waitUiOutcome(ctx)
  if (outcome === 'success') {
    ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '领水成功（页面成功文案）')
    await screenshotSafe(ctx, 'auralaunch-faucet-success')
    return
  }
  if (outcome === 'limit') {
    ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '页面出现限频提示，视为已领取 = 成功（重跑幂等）')
    await screenshotSafe(ctx, 'auralaunch-faucet-limit')
    return
  }
  const bodyText = await ctx
    .js<string>(() => document.body.innerText.slice(0, 500))
    .catch(() => '')
  throw new Error(`点击 Request 后未出现成功/限频信号（页面文本: ${bodyText.slice(0, 300)}）`)
}

/** AuraLaunch 领水任务（Caldera LiteForge 测试网水龙头） */
export class AuralaunchFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'auralaunch-faucet',
    name: 'AuraLaunch 领水',
    group: { key: 'auralaunch', name: 'AuraLaunch' },
    url: 'https://liteforge.hub.caldera.xyz/',
    sourceUrl: 'https://liteforge.hub.caldera.xyz/',
    note: '真机核实（2026-10-08）：Caldera LiteForge 水龙头（Bridge/Faucet 同页 SPA）；地址框 input[placeholder="Recipient\'s Wallet Address"]；不连钱包，地址取自数据源「metamask钱包地址」列；领水走 tRPC faucet.requestFaucetFunds——成功 200+success:true、失败 200+success:false（不能只看状态码）、限频 429+TOO_MANY_REQUESTS（24h 一次，视为已领取=成功幂等）；站点有 Turnstile（实测无需人工点击，token 自动生成），token 未就绪时点击无请求——补点一次自愈；落地页渲染可超 20s、已领后地址框可能短暂禁用——等就绪+刷新兜底',
    category: 'faucet',
    lastUpdated: '2026-10-08',
    enabled: true,
    // 不连钱包：只填地址，不配置 wallet
    timeoutSec: 300,
    // 短退避：领水任务重试成本低，撞限频/网络抖动重试两次收敛
    retry: { max: 2, backoffSec: 120 },
    // 公共水龙头保守并发（参照 arc）
    concurrency: 3,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runAuralaunchFaucet(ctx)
  }
}

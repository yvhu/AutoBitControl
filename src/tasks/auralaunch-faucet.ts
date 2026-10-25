/**
 * AuraLaunch 领水任务（auralaunch-faucet）：Caldera LiteForge 测试网水龙头
 * 站点：https://liteforge.hub.caldera.xyz/
 * 设计：地址取自数据源「metamask钱包地址」直填（不连钱包）；领取走 tRPC faucet.requestFaucetFunds
 * 时间预算：timeoutSec 300s、retry.max 2 次 / 退避 120s
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, fill, click, waitFor, race, clickTurnstile, getAccountValue, takeScreenshot, evaluate } from '../api'
import type { Response } from 'patchright'

const ADDRESS_SELECTOR = 'input[placeholder="Recipient\'s Wallet Address"]' // 收款地址输入框
const REQUEST_BTN_SELECTOR = 'button:has-text("Request")' // Request 领取按钮
const SUCCESS_TEXT = 'Successfully requested funds to your wallet' // 成功弹窗文案
const ERROR_TEXT = 'something went wrong' // 报错弹窗文案（出现则刷新重走）
const FAUCET_API_PART = 'faucet.requestFaucetFunds' // 领水 tRPC 接口 URL 片段
const ALREADY_CLAIMED_RE = /TOO_MANY_REQUESTS|once every 24 hours/i // 接口返回中的「当天已领取」标志（限频）
const FAUCET_RESPONSE_WAIT_MS = 15000 // 等待领水接口响应的预算
const BUTTON_ENABLE_WAIT_MS = 20000 // 填地址后等按钮可点的预算
const ADDRESS_UNLOCK_WAIT_MS = 45000 // 地址框禁用时等人机验证通过（地址框解锁）的预算
const AUTO_PASS_GRACE_MS = 10000 // 先等验证自动通过的宽限期，过了仍禁用才兜底点击方框
const TURNSTILE_CLICK_INTERVAL_MS = 3000 // 兜底点击方框的重试间隔
const MAX_RELOAD_ATTEMPTS = 3 // 报错弹窗刷新重走的最大次数，超过直接失败

/** 轮询等按钮从 disabled 变为可点（超时抛错） */
async function waitButtonEnabled(ctx: TaskContext, selector: string, budgetMs = BUTTON_ENABLE_WAIT_MS): Promise<void> {
  const loc = ctx.page.locator(selector).first()
  const end = Date.now() + budgetMs
  while (Date.now() < end) {
    if (await loc.isEnabled().catch(() => false)) return
    await ctx.page.waitForTimeout(500)
  }
  throw new Error(`领取按钮持续禁用: ${selector}`)
}

/**
 * 地址框禁用时轮询等其变为可编辑（=人机验证已通过）：先给自动通过留宽限期，宽限期内不点击；
 * 过了宽限期仍禁用，说明未自动通过，则兜底点击人机验证方框（clickTurnstile 取盒已限时，不会阻塞预算）。
 * 点完继续轮询等解锁。超时抛错。
 */
async function waitAddressEditable(ctx: TaskContext, budgetMs = ADDRESS_UNLOCK_WAIT_MS): Promise<void> {
  const loc = ctx.page.locator(ADDRESS_SELECTOR).first()
  const end = Date.now() + budgetMs
  let nextClickAt = Date.now() + AUTO_PASS_GRACE_MS
  while (Date.now() < end) {
    if (await loc.isEnabled().catch(() => false)) return
    if (Date.now() >= nextClickAt) {
      const clicked = await clickTurnstile(ctx)
      if (clicked) ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '地址框仍禁用，检测到人机验证方框并点击（自动通过未生效的兜底）')
      nextClickAt = Date.now() + TURNSTILE_CLICK_INTERVAL_MS
    }
    await ctx.page.waitForTimeout(500)
  }
  throw new Error('地址框持续禁用（人机验证未通过）')
}

/** 注册并等待一次领水 tRPC 响应（POST，匹配接口 URL 片段；吞错，超时返回 null） */
function waitFaucetResponse(ctx: TaskContext): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(FAUCET_API_PART), { timeout: FAUCET_RESPONSE_WAIT_MS })
    .catch(() => null)
}

/**
 * 领水接口返回值是否表示「当天已领取」：
 * 命中 TOO_MANY_REQUESTS / "once every 24 hours"（24h 限频）即为当天已领取 —— 幂等成功，不再刷新重试。
 * 真机样例：200/429 都可能，错误信封 { error: { json: { message: 'You can only request funds once every 24 hours...', data: { code: 'TOO_MANY_REQUESTS' } } } }。
 */
function isAlreadyClaimedBody(body: unknown): boolean {
  return ALREADY_CLAIMED_RE.test(JSON.stringify(body ?? {}))
}

export class AuralaunchFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'auralaunch-faucet', // 全局唯一任务键（面板/API/数据库均以此索引）
    name: 'AuraLaunch 领水',
    group: { key: 'auralaunch', name: 'AuraLaunch' }, // 任务分组（面板按组展示）
    url: 'https://liteforge.hub.caldera.xyz/', // 落地页
    sourceUrl: 'https://liteforge.hub.caldera.xyz/', // 任务来源说明链接（面板展示用）
    note: '真机核实（2026-10-08）：Caldera LiteForge 水龙头（Bridge/Faucet 同页 SPA）；地址框 input[placeholder="Recipient\'s Wallet Address"]；不连钱包，地址取自数据源「metamask钱包地址」列；地址框初始禁用，站点 Turnstile 人机验证多数自动通过（通过后地址框自行解锁，此时无需点击）；未自动通过时才兜底点击验证方框（先留 10s 宽限期再点）；点击 Request 后成功弹窗=成功、报错弹窗时查领水接口（faucet.requestFaucetFunds）返回值——命中 TOO_MANY_REQUESTS/once every 24 hours = 当天已领取，视为成功幂等不刷新，其他错误才刷新重走（最多 3 次，超过失败）',
    category: 'faucet', // 任务类别：领水
    lastUpdated: '2026-10-15',
    enabled: true, // 参与定时/批量触发
    timeoutSec: 300, // 单任务整体超时秒数
    retry: { max: 2, backoffSec: 120 }, // 失败最多再试 2 次，每次退避 120s（不占窗）
  }

  /**
   * 执行流程：打开落地页 → 等地址框出现 → 判断是否禁用（禁用则轮询等人机验证解锁：先等自动通过，
   *          过了宽限期未通过再兜底点击验证方框）
   *          → 可输入则填地址 → 等 Request 按钮可点 → 点击并监听领水接口 →
   *          成功弹窗=成功；报错弹窗=查接口返回值（当天已领取 24h 限频=成功幂等；其他错误=刷新重走，最多 3 次）。
   * @param ctx 任务上下文（page/log/accountRow 等运行时数据）
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    const address = await getAccountValue(ctx, 'metamask钱包地址')
    let reloadCount = 0 // 已刷新重走次数
    while (true) {
      await waitFor(ctx, { selector: ADDRESS_SELECTOR }, { assert: true, budgetMs: 45000 })
      // 地址框禁用：轮询等其解锁（站点人机验证会自动通过，无需点击方框）
      if (!(await ctx.page.locator(ADDRESS_SELECTOR).first().isEnabled().catch(() => false))) {
        await waitAddressEditable(ctx)
      }
      // 可输入：填地址 → 等按钮可点 → 点 Request
      await fill(ctx, ADDRESS_SELECTOR, address)
      await waitButtonEnabled(ctx, REQUEST_BTN_SELECTOR)
      // 点 Request 前注册接口监听：报错时用于区分「当天已领取」与其他错误
      const respPromise = waitFaucetResponse(ctx)
      await click(ctx, REQUEST_BTN_SELECTOR)
      // 弹窗判定：成功弹窗=成功；报错弹窗=再查接口返回值
      const outcome = await race(ctx, [['success', { text: SUCCESS_TEXT }], ['error', { text: ERROR_TEXT }]], 30000)
      if (outcome === 'success') {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '领水成功')
        await takeScreenshot(ctx, 'auralaunch-faucet-success')
        return
      }
      // 查接口返回值：当天已领取（24h 限频）= 成功幂等，不再刷新重试
      const resp = await respPromise
      if (resp && isAlreadyClaimedBody(await resp.json().catch(() => null))) {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '接口返回当天已领取（24h 限频），视为成功（不刷新重试）')
        await takeScreenshot(ctx, 'auralaunch-faucet-already-claimed')
        return
      }
      if (outcome === 'error') {
        if (reloadCount >= MAX_RELOAD_ATTEMPTS) {
          throw new Error(`点击 Request 报错后已刷新 ${MAX_RELOAD_ATTEMPTS} 次仍未成功`)
        }
        reloadCount += 1
        ctx.log.warn({ step: 'faucet', window: ctx.profile.name, reloadCount }, '弹窗报错（something went wrong），刷新页面重走流程')
        await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        continue
      }
      const bodyText = await evaluate(ctx, () => document.body.innerText.slice(0, 500)).catch(() => '')
      throw new Error(`点击 Request 后未出现成功/报错弹窗（页面文本: ${bodyText.slice(0, 300)}）`)
    }
  }
}

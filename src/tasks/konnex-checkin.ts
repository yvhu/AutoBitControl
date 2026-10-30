/**
 * Konnex 签到任务：Check In (Weekly) 每周签到（+10 KP，每周一次）
 * 登录：Connect Wallet → 弹窗「Connect with Ethereum」→ 选 MetaMask → 钱包弹窗确认
 * 已签到两种卡片状态（Great job! 横幅 / RESETS IN 倒计时）都算成功
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, connectWallet, race, evaluate, takeScreenshot } from '../api'

const SIGN_IN_BTN = '[data-testid="connect-wallet-button"]:has-text("Sign in")' // 站内登录入口（钱包已连但 session 未认证时出现）
const ETHEREUM_ENTRY_TEXT = 'Connect with Ethereum' // 登录弹窗内的入口文案
const METAMASK_ENTRY_TEXT = 'MetaMask' // 钱包选择项文案
const CHECKIN_BTN = 'button:has-text("Check in")' // 签到按钮（页面唯一；也是真正登录完成的标志）
const CHECKIN_CARD = '#loyalty-quest-root-check_in' // 签到卡片根节点（含按钮/已签到态）
const SUCCESS_TEXT = 'Check-In Succeeded!' // 签到成功弹窗标题
const DONE_TEXT = 'Great job!' // 本周已签到的横幅文案
const RESET_TEXT = 'RESETS IN' // 本周已签到的倒计时文案

const CHECKIN_CARD_WAIT_MS = 45000 // 等签到卡片渲染的预算（卡片渲染有延迟）
const CHECKIN_SUCCESS_WAIT_MS = 30000 // 点签到后等成功弹窗/已签到态的预算

export class KonnexCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'konnex-checkin',
    name: 'Konnex 签到',
    group: { key: 'konnex', name: 'Konnex' },
    url: 'https://hub.konnex.world/points',
    sourceUrl: ['https://cryptorank.io/zh/drophunting/konnex-activity1071', 'https://airdrops.io/konnex/'],
    note: '每周签到（+10 KP）；登录是多段确认：站内 Sign in → Connect with Ethereum → MetaMask 连接 → SIWE 签名（autoConfirmTransaction 自动确认）→ 站点 session 认证。不能用 Balance 判登录（钱包已连但未签名时也会出现）；以签到按钮出现作为真正登录完成的标志。成功判定弹窗 h1（Check-In Succeeded!）；当周已签到显示 Great job! 横幅或暗态 RESETS IN，两种都算成功',
    category: 'checkin',
    lastUpdated: '2026-10-30',
    enabled: true,
    wallet: 'metamask',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
  }

  /**
   * 执行流程：打开任务页 → 先判已签到/已登录 → 需要时走站内登录（Sign in → Connect with Ethereum → MetaMask → SIWE 签名）→ 签到。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    const state = await this.waitCheckinState(ctx)
    if (state === 'done') {
      ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '本周已签到（卡片为已签到状态）')
      await takeScreenshot(ctx, 'konnex-success')
      return
    }
    if (state === 'needLogin') {
      await connectWallet(ctx, {
        wallet: 'metamask',
        // 签到按钮出现 = 站点 session 已认证（Balance 在钱包已连但未签名时也会出现，不能当登录态）
        connected: { selector: CHECKIN_BTN },
        disconnected: { selector: SIGN_IN_BTN },
        connect: SIGN_IN_BTN,
        confirm: `text=${ETHEREUM_ENTRY_TEXT}`,
        walletOption: { text: METAMASK_ENTRY_TEXT },
      })
    }
    await this.checkin(ctx)
  }

  /**
   * 等页面进入可操作状态：已签到 / 已登录待签到 / 需要登录（站内 Sign in 可见）。
   * @returns done=本周已签到；ready=已登录可签到；needLogin=需要走登录流程
   */
  private async waitCheckinState(ctx: TaskContext): Promise<'done' | 'ready' | 'needLogin'> {
    const deadline = Date.now() + CHECKIN_CARD_WAIT_MS
    while (Date.now() < deadline) {
      if (await this.checkinDone(ctx)) return 'done'
      if (await this.isVisible(ctx, CHECKIN_BTN)) return 'ready'
      if (await this.isVisible(ctx, SIGN_IN_BTN)) return 'needLogin'
      await ctx.page.waitForTimeout(2000)
    }
    // 预算内既没签到按钮也没站内登录入口：交给 checkin 报卡片异常，便于排障
    return 'ready'
  }

  /**
   * 判断某选择器的首个匹配元素当前是否可见（元素不存在或查询异常一律按不可见处理）。
   * @param ctx 任务上下文
   * @param selector CSS 选择器
   * @returns 可见返回 true，否则 false
   */
  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    try {
      const loc = ctx.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }

  /**
   * 签到：轮询等卡片渲染（按钮出现，或已是本周已签到态）→ 点 Check in
   * → 竞速成功弹窗/已签到横幅 → 断言成功并截图，否则抛错。
   * @param ctx 任务上下文
   */
  private async checkin(ctx: TaskContext): Promise<void> {
    const deadline = Date.now() + CHECKIN_CARD_WAIT_MS
    let hasBtn = false
    while (Date.now() < deadline) {
      hasBtn = await this.isVisible(ctx, CHECKIN_BTN)
      if (hasBtn) break
      // 按钮未出现前先判是否已签到（本周已签到则卡片无按钮，直接成功）
      if (await this.checkinDone(ctx)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '本周已签到（卡片为已签到状态）')
        await takeScreenshot(ctx, 'konnex-success')
        return
      }
      await ctx.page.waitForTimeout(2000)
    }
    // 等满预算既无按钮也非已签到态：站点异常或改版
    if (!hasBtn) throw new Error('签到卡片未出现（Check in 按钮与已签到状态均无；页面异常或站点改版）')
    await ctx.page.locator(CHECKIN_BTN).first().click()
    // 竞速：成功弹窗标题 或 已签到横幅，任一即视为成功
    const outcome = await race(ctx, [['success', { text: SUCCESS_TEXT }], ['done', { text: DONE_TEXT }]], CHECKIN_SUCCESS_WAIT_MS)
    if (outcome === 'success' || outcome === 'done' || (await this.checkinDone(ctx))) {
      ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '签到成功（Check-In Succeeded!）')
      await takeScreenshot(ctx, 'konnex-success')
      return
    }
    // 兜底排错信息：把卡片文本与页面 h1 一并抛出，便于定位站点改版
    const card = await evaluate(ctx, () => (document.querySelector('#loyalty-quest-root-check_in')?.textContent ?? '').trim().slice(0, 300)).catch(() => '')
    const headings = await evaluate(ctx, () => [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim()).filter(Boolean).join(' | ')).catch(() => '')
    throw new Error(`点击 Check in 后未出现成功弹窗（卡片: ${card || '无'}；h1: ${headings || '无'}；可能已签到/站点改版）`)
  }

  /**
   * 卡片是否处于已签到状态：横幅 Great job! 或暗态 RESETS IN（任一即已签到）。
   * @param ctx 任务上下文
   */
  private async checkinDone(ctx: TaskContext): Promise<boolean> {
    if (await this.isVisible(ctx, `${CHECKIN_CARD}:has-text("${DONE_TEXT}")`)) return true
    return this.isVisible(ctx, `${CHECKIN_CARD}:has-text("${RESET_TEXT}")`)
  }
}

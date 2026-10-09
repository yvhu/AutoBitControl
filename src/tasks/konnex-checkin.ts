/**
 * Konnex 签到任务：Check In (Weekly) 每周签到（+10 KP，每周一次）
 * 登录：Connect Wallet → 弹窗「Connect with Ethereum」→ 选 MetaMask → 钱包弹窗确认
 * 已签到两种卡片状态（Great job! 横幅 / RESETS IN 倒计时）都算成功
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

const BALANCE_TEXT = 'Balance'
const CONNECT_WALLET_BTN = '[data-testid="connect-wallet-button"]'
const ETHEREUM_ENTRY_TEXT = 'Connect with Ethereum'
const METAMASK_ENTRY_TEXT = 'MetaMask'
const CHECKIN_BTN = 'button:has-text("Check in")'
const CHECKIN_CARD = '#loyalty-quest-root-check_in'
const SUCCESS_TEXT = 'Check-In Succeeded!'
const DONE_TEXT = 'Great job!'
const RESET_TEXT = 'RESETS IN'

const CHECKIN_CARD_WAIT_MS = 45000
const CHECKIN_SUCCESS_WAIT_MS = 30000

export class KonnexCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'konnex-checkin',
    name: 'Konnex 签到',
    group: { key: 'konnex', name: 'Konnex' },
    url: 'https://hub.konnex.world/points',
    sourceUrl: ['https://cryptorank.io/zh/drophunting/konnex-activity1071', 'https://airdrops.io/konnex/'],
    note: '每周签到（+10 KP）；真机核实：登录后余额小部件 Balance 作登录态标记；签到按钮为唯一 button:has-text("Check in")；成功判定弹窗 h1（Check-In Succeeded!）；当周已签到显示 Great job! 横幅或暗态 RESETS IN，两种都算成功；卡片渲染有延迟；MetaMask 弹窗「连接/确认」由适配器自动处理',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'metamask',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  login: LoginSpec = {
    loggedIn: { text: BALANCE_TEXT },
    loggedOut: 'Connect Wallet',
    connect: CONNECT_WALLET_BTN,
    entry: { kind: 'dialog', confirm: `text=${ETHEREUM_ENTRY_TEXT}` },
    walletEntry: `text=${METAMASK_ENTRY_TEXT}`,
    intents: ['connect'],
  }

  async action(ctx: TaskContext): Promise<void> {
    await this.checkin(ctx)
  }

  /** 卡片当前是否可见 */
  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    try {
      const loc = ctx.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }

  /** 签到：等卡片渲染 → （已签到则成功）点 Check in → 竞速成功弹窗/已签到状态 */
  private async checkin(ctx: TaskContext): Promise<void> {
    const deadline = Date.now() + CHECKIN_CARD_WAIT_MS
    let hasBtn = false
    while (Date.now() < deadline) {
      hasBtn = await this.isVisible(ctx, CHECKIN_BTN)
      if (hasBtn) break
      if (await this.checkinDone(ctx)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '本周已签到（卡片为已签到状态）')
        await ctx.safeScreenshot('konnex-success')
        return
      }
      await ctx.page.waitForTimeout(2000)
    }
    if (!hasBtn) throw new Error('签到卡片未出现（Check in 按钮与已签到状态均无；页面异常或站点改版）')
    await ctx.page.locator(CHECKIN_BTN).first().click()
    const outcome = await ctx.race([['success', { text: SUCCESS_TEXT }], ['done', { text: DONE_TEXT }]], CHECKIN_SUCCESS_WAIT_MS)
    if (outcome === 'success' || outcome === 'done' || (await this.checkinDone(ctx))) {
      ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '签到成功（Check-In Succeeded!）')
      await ctx.safeScreenshot('konnex-success')
      return
    }
    const card = await ctx.js<string>(() => (document.querySelector('#loyalty-quest-root-check_in')?.textContent ?? '').trim().slice(0, 300)).catch(() => '')
    const headings = await ctx.js<string>(() => [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim()).filter(Boolean).join(' | ')).catch(() => '')
    throw new Error(`点击 Check in 后未出现成功弹窗（卡片: ${card || '无'}；h1: ${headings || '无'}；可能已签到/站点改版）`)
  }

  /** 卡片是否处于已签到状态：横幅 Great job! 或暗态 RESETS IN（任一即已签到） */
  private async checkinDone(ctx: TaskContext): Promise<boolean> {
    if (await this.isVisible(ctx, `${CHECKIN_CARD}:has-text("${DONE_TEXT}")`)) return true
    return this.isVisible(ctx, `${CHECKIN_CARD}:has-text("${RESET_TEXT}")`)
  }
}

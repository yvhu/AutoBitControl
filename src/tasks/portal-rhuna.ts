/**
 * Rhuna 签到任务：Daily Check-in（+20 pts）
 * 登录：Petra（点 Connect Wallet 直接唤起 prompt.html，Sign In 签名）
 * 站点 token 存 localStorage，全程刷新恢复导向
 * 依赖方向：仅依赖 ./base（常量 RECOVER_TEXTS 经 base 取）
 */
import { SiteTask, RECOVER_TEXTS, gotoWithRetry, type LoginSpec, type TaskContext, type TaskMeta } from './base'

const HELLO_TEXT = 'Hello,' // 登录态标记（页头问候语出现即已登录）
const CONNECT_TEXT = 'Connect Wallet' // 未登录时的连接按钮文案
const START_QUESTS_TEXT = 'Start Quests' // 落地页进入任务页的按钮
const CHECKIN_TEXT = 'Daily Check-in' // 每日签到卡片文案
const SUCCESS_TEXT = 'Quest completed successfully!' // 领取成功文案
const PROCESSING_TEXT = 'Processing your quest...' // 领取处理中提示

const CHECKIN_ROUNDS = 6 // 签到弹窗最大重试轮数（每轮刷新恢复）
const CLAIM_RACE_MS = 15000 // 弹窗内竞速「完成/Claim」出现的时间
const CLAIM_RECHECK_MS = 10000 // 点 Claim 后竞速「处理中/成功」的时间
const SUCCESS_WAIT_MS = 60000 // Claim 后等待最终成功的总预算
const DIALOG_SELECTOR = '[role="dialog"]' // 弹窗根节点（领取弹窗/Turnstile 容器）

export class PortalRhunaTask extends SiteTask {
  meta: TaskMeta = {
    key: 'portal-rhuna',
    name: 'Rhuna 签到',
    group: { key: 'portal', name: 'Portal' },
    url: 'https://portal.rhuna.io/',
    sourceUrl: ['https://cryptorank.io/zh/drophunting/rhuna-activity958'],
    note: '真机核实：登录用 Petra（点 Connect Wallet 直接唤起扩展弹窗 prompt.html，无站内钱包选择）；弹窗流程为输密码+Unlock → Sign In 签名；Petra 不注入页面 provider，就绪判定靠 CDP；站点间歇性报 Network Error，token 存 localStorage，刷新即恢复；领取时弹出 Turnstile 方框，点方框即完成（ISP IP 一点即过）',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'petra',
    timeoutSec: 1200,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 2,
  }

  login: LoginSpec = {
    loggedIn: { text: HELLO_TEXT },
    loggedOut: CONNECT_TEXT,
    connect: 'button:has-text("Connect Wallet"):visible',
    entry: { kind: 'direct' },
    intents: ['sign'],
  }

  /**
   * 站点动作：进入 Quests 页并领取每日签到（登录已由默认 run 完成）。
   * @param ctx 任务上下文
   */
  async action(ctx: TaskContext): Promise<void> {
    await this.enterQuests(ctx)
    await this.checkin(ctx)
  }

  /**
   * 判断某选择器的首个匹配元素当前是否可见（元素不存在或查询异常一律按不可见处理）。
   * @param ctx 任务上下文
   * @param selector CSS 选择器
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
   * 返回首个出现在页面上的文案（命中即返回，全不命中返回空串），用于识别可恢复错误。
   * @param ctx 任务上下文
   * @param texts 待检测文案列表（按优先级）
   */
  private async firstTextPresent(ctx: TaskContext, texts: string[]): Promise<string> {
    for (const t of texts) {
      if ((await ctx.page.getByText(t, { exact: false }).count()) > 0) return t
    }
    return ''
  }

  /** 进 Quests 页：Start Quests 优先（含刷新恢复），兜底直达 /quests */
  private async enterQuests(ctx: TaskContext): Promise<void> {
    const startBtn = `button:has-text("${START_QUESTS_TEXT}")`
    if (await this.isVisible(ctx, startBtn)) {
      await ctx.page.locator(startBtn).first().click()
      if (await ctx.recover({ text: CHECKIN_TEXT }, { budgetMs: 60000, refreshEveryMs: 25000, recoverTexts: RECOVER_TEXTS })) return
    }
    await gotoWithRetry(ctx.page, 'https://portal.rhuna.io/quests', ctx.log)
    if (await ctx.recover({ text: CHECKIN_TEXT }, { budgetMs: 60000, refreshEveryMs: 25000, recoverTexts: RECOVER_TEXTS })) return
    throw new Error('Quests 页未出现 Daily Check-in（页面或网络异常）')
  }

  /** 点 Daily Check-in 卡片 → 弹窗竞速 → 领取/已领收尾（最多 CHECKIN_ROUNDS 轮） */
  private async checkin(ctx: TaskContext): Promise<void> {
    for (let round = 0; round < CHECKIN_ROUNDS; round++) {
      try {
        await ctx.page.locator(`div.cursor-pointer:has-text("${CHECKIN_TEXT}")`).first().click()
        await ctx.page.locator(DIALOG_SELECTOR).first().waitFor({ state: 'visible', timeout: 15000 })
      } catch {
        ctx.log.info({ step: 'recover', window: ctx.profile.name }, '领取弹窗打开失败，刷新恢复')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      const outcome = await ctx.race([['success', { text: SUCCESS_TEXT }], ['claim', { text: 'Claim' }]], CLAIM_RACE_MS)
      if (outcome === 'success') {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '今日已领取（弹窗直接显示完成）')
        await ctx.safeScreenshot('rhuna-success')
        return
      }
      if (outcome !== 'claim') {
        const modalText = await ctx.js<string>(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 300)).catch(() => '')
        ctx.log.warn({ step: 'checkin', window: ctx.profile.name, modalText }, '弹窗内未出现 Claim/完成提示，下一轮重开')
        continue
      }
      const claimBtn = '[role="dialog"] button:has-text("Claim")'
      await ctx.page.locator(claimBtn).first().click()
      await ctx.captcha.autoClick()
      const processing = await ctx.race([['processing', { text: PROCESSING_TEXT }], ['success', { text: SUCCESS_TEXT }]], CLAIM_RECHECK_MS)
      if (processing === null) {
        await ctx.page.locator(claimBtn).first().click().catch(() => {})
      }
      if (await this.claimLoop(ctx, claimBtn)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '签到成功（Quest completed successfully!）')
        await ctx.safeScreenshot('rhuna-success')
        return
      }
      const modalText = await ctx.js<string>(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 300)).catch(() => '')
      ctx.log.warn({ step: 'checkin', window: ctx.profile.name, modalText }, '点 Claim 后等待完成提示超时，下一轮重开')
    }
    throw new Error('Daily Check-in 领取未完成（弹窗内未出现完成提示）')
  }

  /** 方框点击容错：瞬时 CDP 拒绝不打断领取 */
  private async tryClickTurnstile(ctx: TaskContext): Promise<'clicked' | 'absent' | 'rejected'> {
    try {
      return (await ctx.captcha.turnstile()) ? 'clicked' : 'absent'
    } catch (e) {
      const msg = (e as Error).message
      if (!/Protocol error|session closed|Target page|target crashed|Navigation failed|Execution context was destroyed|browser has been closed/i.test(msg)) throw e
      ctx.log.warn({ step: 'turnstile', window: ctx.profile.name, err: msg }, '验证方框点击持续被浏览器拒绝（iframe 重渲染），进入冷却期后重试')
      return 'rejected'
    }
  }

  /** Claim 后等待完成循环（单轮内）：成功=true；处理中耐心等；Claim 重现补点；错误/停滞后刷新 */
  private async claimLoop(ctx: TaskContext, claimBtn: string): Promise<boolean> {
    const end = Date.now() + SUCCESS_WAIT_MS
    let clicks = 0
    let lastRefresh = Date.now()
    let lastCheckClick = 0
    let lastCheckLog = 0
    while (Date.now() < end) {
      if (await ctx.page.getByText(SUCCESS_TEXT, { exact: false }).count() > 0) return true
      if (Date.now() - lastCheckClick > 15000) {
        const result = await this.tryClickTurnstile(ctx)
        if (result === 'clicked' || result === 'rejected') lastCheckClick = Date.now()
        if (result === 'clicked') continue
      }
      if (lastCheckClick > 0 && Date.now() - lastCheckClick < 15000 && Date.now() - lastCheckLog > 30000 && (await ctx.captcha.visible())) {
        lastCheckLog = Date.now()
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '验证方框已点击但仍存在（验证未通过），冷却期满后重点')
      }
      const errText = await this.firstTextPresent(ctx, RECOVER_TEXTS)
      if (errText !== '') {
        ctx.log.info({ step: 'recover', window: ctx.profile.name, errText }, '领取等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      if ((await ctx.page.getByText(PROCESSING_TEXT, { exact: false }).count()) > 0) {
        await ctx.page.waitForTimeout(3000)
        continue
      }
      if (clicks < 3 && await this.isVisible(ctx, claimBtn)) {
        await ctx.page.locator(claimBtn).first().click().catch(() => {})
        clicks++
        ctx.log.info({ step: 'checkin', window: ctx.profile.name, clicks }, 'Claim 按钮重新出现，补点')
        continue
      }
      if (Date.now() - lastRefresh >= 30000) {
        ctx.log.info({ step: 'recover', window: ctx.profile.name }, '刷新页面恢复（错误提示或周期刷新）')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    return false
  }
}

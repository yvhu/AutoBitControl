/**
 * DAC Inception 任务：量子箱开箱（每日 5 箱）
 * 登录：Enter Inception → Get Started 弹窗点 WALLET → AppKit 归一化 → MetaMask
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

const LIMIT_TEXT = 'Daily limit reached'
const MODAL_TITLE = 'What is inside?'
const REVEAL_TEXTS = ['You Won', 'Better luck next time']
const INSUFFICIENT_TEXT = 'Insufficient QE'
const SIDEBAR_TEXT = 'Quantum Crate'
const ENTER_TEXT = 'Enter Inception'
const METAMASK_ENTRY = 'wallet-selector-io.metamask'

const GET_STARTED_WAIT_MS = 45000
const CRATE_PAGE_WAIT_MS = 20000
const CRATE_PAGE_ATTEMPTS = 2
const CRATE_LOOP_MAX = 8
const OPEN_FREE_RACE_MS = 6000
const OPEN_FREE_ATTEMPTS = 3
const REVEAL_TOTAL_MS = 120000
const REVEAL_RECLICK_AT_MS = 45000
const MODAL_GONE_MS = 10000

type RaceKey = 'loggedIn' | 'landing' | 'limit' | 'modal' | 'revealed' | 'insufficient'

export class InceptionDachainTask extends SiteTask {
  meta: TaskMeta = {
    key: 'inception-dachain',
    name: 'DAC 签到',
    group: { key: 'inception', name: 'Inception' },
    url: 'https://inception.dachain.io/',
    sourceUrl: ['https://airdrops.io/dac/', 'https://cryptorank.io/zh/drophunting/arc-chain-activity911'],
    note: '真机核实：免费箱按钮实为 OPEN FOR 150 QE（余额 ≥150 QE 才可点）；弹窗 Close 常驻，开箱结果需等 You Won / Better luck next time；每日 5 箱上限；登录：Enter Inception → Get Started 点 WALLET → AppKit 归一化点 MetaMask；MetaMask 中文界面（适配器按 testid）',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'metamask',
    timeoutSec: 900,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  login: LoginSpec = {
    loggedIn: { text: SIDEBAR_TEXT },
    loggedOut: ENTER_TEXT,
    connect: `button:has-text("${ENTER_TEXT}")`,
    entry: { kind: 'appkit', open: 'button:has-text("WALLET")', entryTestId: METAMASK_ENTRY },
    intents: ['connect'],
  }

  async action(ctx: TaskContext): Promise<void> {
    await this.enterCratePage(ctx)
    await this.openCrates(ctx)
  }

  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    try {
      const loc = ctx.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }

  /** 点 Open Free 后竞速：上限提示 / 开箱弹窗 / 余额不足 */
  private raceAfterOpenFree(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    return ctx.race([['limit', { text: LIMIT_TEXT }], ['modal', { text: MODAL_TITLE }], ['insufficient', { text: INSUFFICIENT_TEXT }]], timeoutMs)
  }

  /** 开箱结果竞速：结果文案任一 / 余额不足 / 弹窗内上限提示 */
  private raceReveal(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    const entries: Array<[RaceKey, { text: string }]> = [
      ...REVEAL_TEXTS.map((t) => ['revealed', { text: t }] as [RaceKey, { text: string }]),
      ['insufficient', { text: INSUFFICIENT_TEXT }],
      ['limit', { text: LIMIT_TEXT }],
    ]
    return ctx.race(entries, timeoutMs)
  }

  /** 读页面每日开箱计数器（DAILY OPENS x/y）；解析失败返回 null */
  private async dailyOpens(ctx: TaskContext): Promise<{ opened: number; total: number } | null> {
    return ctx.js<{ opened: number; total: number } | null>(() => {
      const text = (document as unknown as { body?: { innerText?: string } }).body?.innerText ?? ''
      const m = text.match(/DAILY[\s|]*OPENS[\s|]*(\d+)\s*\/\s*(\d+)/)
      return m ? { opened: Number(m[1]), total: Number(m[2]) } : null
    }).catch(() => null)
  }

  private async finishAtLimit(ctx: TaskContext, signal: string): Promise<void> {
    ctx.log.info({ step: 'crates', window: ctx.profile.name, signal }, '每日上限已达成')
    await ctx.safeScreenshot('dac-success')
  }

  /** 点左侧目录栏 Quantum Crate → 等 Open Free；点击可能未生效则补点 */
  private async enterCratePage(ctx: TaskContext): Promise<void> {
    for (let attempt = 0; attempt < CRATE_PAGE_ATTEMPTS; attempt++) {
      await ctx.page.locator(`button:has-text("${SIDEBAR_TEXT}")`).first().click()
      try {
        await ctx.page.getByText('Open Free', { exact: false }).first().waitFor({ state: 'visible', timeout: CRATE_PAGE_WAIT_MS })
        ctx.log.info({ step: 'crates', window: ctx.profile.name }, '进入开箱页面')
        return
      } catch {
        // SPA 路由未生效，补点
      }
    }
    throw new Error('点击 Quantum Crate 后未出现开箱页面（等待 Open Free 超时）')
  }

  /** 反复开箱，直到出现每日上限（toast / 页面计数器 / 弹窗内提示） */
  private async openCrates(ctx: TaskContext): Promise<void> {
    for (let i = 0; i < CRATE_LOOP_MAX; i++) {
      const info = await this.dailyOpens(ctx)
      if (info && info.opened >= info.total) {
        await this.finishAtLimit(ctx, `counter ${info.opened}/${info.total}`)
        return
      }
      let outcome: RaceKey | null = null
      for (let attempt = 0; attempt < OPEN_FREE_ATTEMPTS && !outcome; attempt++) {
        await ctx.page.locator('button:has-text("Open Free")').first().click()
        outcome = await this.raceAfterOpenFree(ctx, OPEN_FREE_RACE_MS)
      }
      if (outcome === 'limit') {
        await this.finishAtLimit(ctx, 'toast')
        return
      }
      if (outcome === 'insufficient') throw new Error('QE 余额不足（Insufficient QE），无法继续开箱')
      if (outcome !== 'modal') throw new Error('点击 Open Free 后既无开箱弹窗也无每日上限提示（页面或网络异常）')

      const revealed = await this.revealInModal(ctx)
      if (revealed === 'limit') {
        await this.finishAtLimit(ctx, 'modal')
        return
      }
      if (revealed === 'insufficient') throw new Error('QE 余额不足（Insufficient QE），无法继续开箱')
      if (revealed !== 'revealed') throw new Error('等待开箱结果超时（视频/接口过慢）')
      await ctx.page.locator('button:has-text("Close")').first().click()
      await this.waitGoneOrHidden(ctx, `text=${MODAL_TITLE}`, MODAL_GONE_MS)
      ctx.log.info({ step: 'crates', window: ctx.profile.name, opened: i + 1 }, '开箱完成')
    }
    throw new Error('开箱次数超过预期仍未出现每日上限提示')
  }

  /** 弹窗内开箱并等结果（结果 / 余额不足 / 弹窗内上限提示 / 超时 null） */
  private async revealInModal(ctx: TaskContext): Promise<RaceKey | null> {
    const deadline = Date.now() + REVEAL_TOTAL_MS
    await ctx.page.locator('button:has-text("Open for")').first().click()
    let revealed = await this.raceReveal(ctx, REVEAL_RECLICK_AT_MS)
    if (!revealed && (await this.isVisible(ctx, 'button:has-text("Open for")'))) {
      await ctx.page.locator('button:has-text("Open for")').first().click()
    }
    if (!revealed) revealed = await this.raceReveal(ctx, Math.max(0, deadline - Date.now()))
    return revealed
  }

  /** 等元素消失或隐藏（最多 timeoutMs） */
  private async waitGoneOrHidden(ctx: TaskContext, selector: string, timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (!(await this.isVisible(ctx, selector))) return
      await ctx.page.waitForTimeout(500)
    }
  }
}

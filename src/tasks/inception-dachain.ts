/**
 * DAC Inception 任务：量子箱开箱（每日 5 箱）
 * 登录：Enter Inception → Get Started 弹窗点 WALLET → AppKit 归一化 → MetaMask
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, loginWallet, click, waitFor, race, runJs, elementState, takeScreenshot } from '../api'

const LIMIT_TEXT = 'Daily limit reached' // 每日开箱上限提示
const MODAL_TITLE = 'What is inside?' // 开箱弹窗标题
const REVEAL_TEXTS = ['You Won', 'Better luck next time'] // 开箱结果文案（中奖/未中奖均算开箱完成）
const INSUFFICIENT_TEXT = 'Insufficient QE' // 余额不足提示（无法继续开箱）
const SIDEBAR_TEXT = 'Quantum Crate' // 左侧目录栏开箱入口（也作登录态标记）
const ENTER_TEXT = 'Enter Inception' // 落地页进入按钮（未登录时可见）
const METAMASK_ENTRY = 'wallet-selector-io.metamask' // AppKit 钱包选择项的 testid

const CRATE_PAGE_WAIT_MS = 20000 // 点目录栏后等开箱页元素（Open Free）出现的预算
const CRATE_PAGE_ATTEMPTS = 2 // 进入开箱页的补点次数（SPA 路由可能未生效）
const CRATE_LOOP_MAX = 8 // 开箱循环上限（每日 5 箱，留冗余）
const OPEN_FREE_RACE_MS = 6000 // 点 Open 后竞速「上限/弹窗/余额不足」的单次时间
const OPEN_FREE_ATTEMPTS = 3 // 点 Open 的补点次数（点击可能未生效）
const REVEAL_TOTAL_MS = 120000 // 弹窗内等开箱结果的总预算（含视频/接口）
const REVEAL_RECLICK_AT_MS = 45000 // 到点仍未出结果则补点 Open for 的时间
const MODAL_GONE_MS = 10000 // 点 Close 后等弹窗消失的预算

/** 竞速键：登录态/落地页/上限/开箱弹窗/已开箱结果/余额不足 */
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

  /**
   * 执行流程：打开任务页 → 声明式钱包登录（AppKit 归一化 MetaMask）→ 进入开箱页反复开箱。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    await loginWallet(ctx, {
      wallet: 'metamask',
      scenario: 'appkit',
      loggedIn: { text: SIDEBAR_TEXT },
      loggedOut: ENTER_TEXT,
      connect: `button:has-text("${ENTER_TEXT}")`,
      open: 'button:has-text("WALLET")',
      entryTestId: METAMASK_ENTRY,
      intents: ['connect'],
    })
    await this.action(ctx)
  }

  /**
   * 站点动作：进入开箱页 → 反复开箱直到每日上限。
   * @param ctx 任务上下文
   */
  async action(ctx: TaskContext): Promise<void> {
    await this.enterCratePage(ctx)
    await this.openCrates(ctx)
  }

  /** 判断某选择器的首个匹配元素当前是否可见 */
  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    return (await elementState(ctx, selector)) === 'visible'
  }

  /** 点 Open Free 后竞速：上限提示 / 开箱弹窗 / 余额不足 */
  private raceAfterOpenFree(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    return race(ctx, [['limit', { text: LIMIT_TEXT }], ['modal', { text: MODAL_TITLE }], ['insufficient', { text: INSUFFICIENT_TEXT }]], timeoutMs)
  }

  /** 开箱结果竞速：结果文案任一 / 余额不足 / 弹窗内上限提示 */
  private raceReveal(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    const entries: Array<[RaceKey, { text: string }]> = [
      ...REVEAL_TEXTS.map((t) => ['revealed', { text: t }] as [RaceKey, { text: string }]),
      ['insufficient', { text: INSUFFICIENT_TEXT }],
      ['limit', { text: LIMIT_TEXT }],
    ]
    return race(ctx, entries, timeoutMs)
  }

  /** 读页面每日开箱计数器（DAILY OPENS x/y）；解析失败返回 null */
  private async dailyOpens(ctx: TaskContext): Promise<{ opened: number; total: number } | null> {
    return runJs<{ opened: number; total: number } | null>(ctx, () => {
      const text = (document as unknown as { body?: { innerText?: string } }).body?.innerText ?? ''
      const m = text.match(/DAILY[\s|]*OPENS[\s|]*(\d+)\s*\/\s*(\d+)/)
      return m ? { opened: Number(m[1]), total: Number(m[2]) } : null
    }).catch(() => null)
  }

  /**
   * 到达每日上限的统一收尾：记日志并截图（视为成功）。
   * @param ctx 任务上下文
   * @param signal 触发上限的信号来源（counter/toast/modal），仅用于日志
   */
  private async finishAtLimit(ctx: TaskContext, signal: string): Promise<void> {
    ctx.log.info({ step: 'crates', window: ctx.profile.name, signal }, '每日上限已达成')
    await takeScreenshot(ctx, 'dac-success')
  }

  /** 点左侧目录栏 Quantum Crate → 等 Open Free；点击可能未生效则补点 */
  private async enterCratePage(ctx: TaskContext): Promise<void> {
    for (let attempt = 0; attempt < CRATE_PAGE_ATTEMPTS; attempt++) {
      await click(ctx, `button:has-text("${SIDEBAR_TEXT}")`)
      if (await waitFor(ctx, { text: 'Open Free' }, { budgetMs: CRATE_PAGE_WAIT_MS })) {
        ctx.log.info({ step: 'crates', window: ctx.profile.name }, '进入开箱页面')
        return
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
        await click(ctx, 'button:has-text("Open Free")')
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
      await click(ctx, 'button:has-text("Close")')
      await waitFor(ctx, { gone: `text=${MODAL_TITLE}` }, { budgetMs: MODAL_GONE_MS })
      ctx.log.info({ step: 'crates', window: ctx.profile.name, opened: i + 1 }, '开箱完成')
    }
    throw new Error('开箱次数超过预期仍未出现每日上限提示')
  }

  /** 弹窗内开箱并等结果（结果 / 余额不足 / 弹窗内上限提示 / 超时 null） */
  private async revealInModal(ctx: TaskContext): Promise<RaceKey | null> {
    const deadline = Date.now() + REVEAL_TOTAL_MS
    await click(ctx, 'button:has-text("Open for")')
    let revealed = await this.raceReveal(ctx, REVEAL_RECLICK_AT_MS)
    if (!revealed && (await this.isVisible(ctx, 'button:has-text("Open for")'))) {
      await click(ctx, 'button:has-text("Open for")')
    }
    if (!revealed) revealed = await this.raceReveal(ctx, Math.max(0, deadline - Date.now()))
    return revealed
  }
}

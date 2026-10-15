/**
 * DAC Play 领 chip 任务（dac-play-mainnet）：主网点 Play 领取 chip 奖励
 * 站点：https://interstellar.dachain.io/（主网）
 * 与 dac-checkin-mainnet（签到）独立：本任务只做「登录 → Play → Claim 领取」，可单独触发/重跑
 * 登录：点「Connect wallet」直开 MetaMask 扩展弹窗（无站内钱包列表）；已登录判据=页面出现 0x 地址；登录可能需多次尝试
 * 领取：点「Play」（新标签页或当前页打开，两种都要兜住）→「Reading your chip…」自动跳转 → 出现 Claim 按钮点它 → 出现「Claimed … QE.」即成功
 * 执行流程：打开任务页 → 自适应钱包登录 → 领 chip
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, connectWallet, click, getElementState, takeScreenshot } from '../api'

/** 站点入口（主网） */
const SITE_URL = 'https://interstellar.dachain.io/'

/** 站内连接按钮文案（真机核实：纯按钮，无钱包选择列表，点击直开 MetaMask 扩展弹窗） */
const CONNECT_TEXT = 'Connect wallet'

/** 已登录判据：页面出现 0x 地址样式文本（同其它任务） */
const ADDRESS_TEXT = '0x'

/** 领 chip 入口链接（真机核实：打开方式不稳定，可能新标签页也可能当前页直达） */
const PLAY_LINK = 'a[aria-label="Play Chip Entropico"]'
/** 领取按钮（精确文案，避免与 Claimed 子串互撞） */
const CLAIM_BTN = 'button:text-is("Claim")'
/** 领取成功提示（Claimed <数量> QE.，数量不固定） */
const CLAIMED_MSG = 'p.message:has-text("Claimed")'

const GAME_PAGE_WAIT_MS = 30000 // 点 Play 后等游戏页（新标签页或当前页出现 Claim）的预算
const CLAIM_WAIT_MS = 60000 // 游戏页「Reading your chip…」自动跳转后等 Claim 按钮的预算
const CLAIMED_WAIT_MS = 60000 // 点 Claim 后等「Claimed … QE.」出现的预算

export class DacPlayMainnetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'dac-play-mainnet', // 全局唯一任务键（面板/API/数据库均以此索引）
    name: 'DAC Play（主网）', // 与 dac-checkin-mainnet（签到）区分
    group: { key: 'dac-mainnet', name: 'DAC 主网' },
    url: SITE_URL,
    sourceUrl: '', // TODO: 填入来源说明链接
    note: '主网 Play 领 chip：点「Connect wallet」直开 MetaMask 扩展弹窗（无站内钱包列表）；已登录判据=页面出现 0x 地址；点「Play」（新标签页或当前页皆可）→ Claim →「Claimed … QE.」成功',
    category: 'other',
    lastUpdated: '2026-10-15',
    enabled: false, // 待真机验证后再开启
    wallet: 'metamask',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  /**
   * 执行流程：打开任务页 → 自适应钱包登录（0x 判已登录；点 Connect wallet 直开钱包弹窗；多轮重试）→ 领 chip。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })

    // 自适应钱包登录：已登录（出现 0x 地址）直接跳过；否则点 Connect wallet → MetaMask 扩展弹窗自动确认。
    // 无站内钱包选择列表，故不传 walletOption；登录可能需多次尝试，提高整体重试轮数。
    await connectWallet(ctx, {
      wallet: 'metamask',
      connected: { text: ADDRESS_TEXT },
      disconnected: CONNECT_TEXT,
      connect: `button:has-text("${CONNECT_TEXT}")`,
      attempts: 3,
      // 0 撸项目无真实链上交易：站点把授权/确认混入登录弹窗（被判为 tx），直接自动确认，避免登录卡死
      autoConfirmTransaction: true,
    })

    await this.claimChip(ctx)
  }

  /** 判断某选择器的首个匹配元素当前是否可见 */
  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    return (await getElementState(ctx, selector)) === 'visible'
  }

  /**
   * 领 chip：点「Play」→ 定位游戏页（新标签页或当前页直达）→ 等 Claim 按钮（先经「Reading your chip…」自动跳转）
   * → 点 Claim → 等「Claimed … QE.」出现作成功断言。
   * 游戏页可能是新标签页也可能是当前页，故统一用其原生 page 操作。
   * @param ctx 任务上下文
   */
  private async claimChip(ctx: TaskContext): Promise<void> {
    await click(ctx, PLAY_LINK)
    const gamePage = await this.resolveGamePage(ctx)
    if (!gamePage) throw new Error('点击 Play 后既未打开新标签页，当前页也未出现 Claim 按钮（跳转失败或站点改版）')
    const claim = gamePage.locator(CLAIM_BTN).first()
    try {
      await claim.waitFor({ state: 'visible', timeout: CLAIM_WAIT_MS })
    } catch {
      throw new Error('未出现 Claim 按钮（「Reading your chip…」跳转失败或站点改版）')
    }
    await claim.click()
    try {
      await gamePage.locator(CLAIMED_MSG).first().waitFor({ state: 'visible', timeout: CLAIMED_WAIT_MS })
    } catch {
      throw new Error('点击 Claim 后未出现「Claimed … QE.」提示（可能已领取/站点改版）')
    }
    ctx.log.info({ step: 'claim', window: ctx.profile.name }, '领取成功（Claimed … QE.）')
    await takeScreenshot(ctx, 'dac-play-success', gamePage)
  }

  /**
   * 定位 Play 后的游戏页：优先新标签页（context 出现非扩展新页），否则当前页直达（当前页出现 Claim 按钮）。
   * Play 的打开方式不稳定（新 tab / 当前 tab 二选一），故两条都轮询；预算内都没有返回 null。
   */
  private async resolveGamePage(ctx: TaskContext): Promise<TaskContext['page'] | null> {
    const context = ctx.page.context()
    const deadline = Date.now() + GAME_PAGE_WAIT_MS
    while (Date.now() < deadline) {
      const tab = context.pages().find((p) => p !== ctx.page && !p.url().startsWith('chrome-extension://'))
      if (tab) return tab
      if (await this.isVisible(ctx, CLAIM_BTN)) return ctx.page
      await ctx.page.waitForTimeout(1000)
    }
    return null
  }
}

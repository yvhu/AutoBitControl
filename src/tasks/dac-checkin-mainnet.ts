/**
 * DAC 主网签到任务（dac-checkin-mainnet）：正式环境（主网）签到
 * 站点：https://interstellar.dachain.io/（主网）
 * 与 inception-dachain（原测试网量子箱开箱）区分：本任务为正式环境签到流程
 * 登录：点「Connect wallet」直开 MetaMask 扩展弹窗（无站内钱包列表）；已登录判据=页面出现 0x 地址；登录可能需多次尝试
 * 签到：点「Check in · +10 QE」→ 出现「Checked in today」（disabled）即成功；页面只剩「Checked in today」即今日已签到（幂等）
 * 执行流程：打开任务页 → 自适应钱包登录 → 签到（含已签到幂等）
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, connectWallet, click, waitFor, getElementState, takeScreenshot } from '../api'

/** 站点入口（主网） */
const SITE_URL = 'https://interstellar.dachain.io/'

/** 站内连接按钮文案（真机核实：纯按钮，无钱包选择列表，点击直开 MetaMask 扩展弹窗） */
const CONNECT_TEXT = 'Connect wallet'

/** 已登录判据：页面出现 0x 地址样式文本（同其它任务） */
const ADDRESS_TEXT = '0x'

/** 签到按钮文案（Check in · +10 QE；与已签到态 Checked in today 不互为子串） */
const CHECKIN_TEXT = 'Check in'
/** 已签到/成功态按钮文案（按钮 disabled） */
const CHECKED_TEXT = 'Checked in today'

const CHECKIN_BTN = `button:has-text("${CHECKIN_TEXT}")`
const CHECKED_BTN = `button:has-text("${CHECKED_TEXT}")`

const CHECKIN_RENDER_WAIT_MS = 30000 // 等签到按钮/已签到态渲染的预算（SPA 数据异步加载）
const CHECKIN_SUCCESS_WAIT_MS = 30000 // 点签到后等「Checked in today」出现的预算

export class DacCheckinMainnetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'dac-checkin-mainnet', // 全局唯一任务键（面板/API/数据库均以此索引）
    name: 'DAC 签到（主网）', // 与测试网任务 inception-dachain 区分
    group: { key: 'dac-mainnet', name: 'DAC 主网' },
    url: SITE_URL,
    sourceUrl: '', // TODO: 填入来源说明链接
    note: '主网签到：点「Connect wallet」直开 MetaMask 扩展弹窗（无站内钱包列表）；已登录判据=页面出现 0x 地址；登录可能需多次尝试；点「Check in」后出现 disabled 的「Checked in today」即成功，页面只剩后者即今日已签到',
    category: 'checkin',
    lastUpdated: '2026-10-15',
    enabled: false, // 待真机验证后再开启
    wallet: 'metamask',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  /**
   * 执行流程：打开任务页 → 自适应钱包登录（0x 判已登录；点 Connect wallet 直开钱包弹窗；多轮重试）→ 签到。
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

    await this.checkin(ctx)
  }

  /** 判断某选择器的首个匹配元素当前是否可见 */
  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    return (await getElementState(ctx, selector)) === 'visible'
  }

  /**
   * 签到：轮询等签到按钮或已签到态渲染。
   * 已是「Checked in today」（当日已签到）直接成功返回；否则点「Check in」，等出现 disabled 的「Checked in today」作成功断言。
   * @param ctx 任务上下文
   */
  private async checkin(ctx: TaskContext): Promise<void> {
    const deadline = Date.now() + CHECKIN_RENDER_WAIT_MS
    let hasBtn = false
    while (Date.now() < deadline) {
      hasBtn = await this.isVisible(ctx, CHECKIN_BTN)
      if (hasBtn) break
      // 签到按钮未出现前先判是否今日已签到（此时只剩 Checked in today），是则幂等成功
      if (await this.isVisible(ctx, CHECKED_BTN)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name, state: 'already' }, '今日已签到（Checked in today）')
        await takeScreenshot(ctx, 'dac-mainnet-success')
        return
      }
      await ctx.page.waitForTimeout(2000)
    }
    // 等满预算既无签到按钮也非已签到态：站点异常或改版
    if (!hasBtn) throw new Error('未出现签到按钮，也非「Checked in today」已签到态（页面异常或站点改版）')
    await click(ctx, CHECKIN_BTN)
    if (!(await waitFor(ctx, { selector: CHECKED_BTN }, { budgetMs: CHECKIN_SUCCESS_WAIT_MS }))) {
      throw new Error('点击签到后未出现「Checked in today」（可能已签到/站点改版）')
    }
    ctx.log.info({ step: 'checkin', window: ctx.profile.name, state: 'checked' }, '签到成功（Checked in today）')
    await takeScreenshot(ctx, 'dac-mainnet-success')
  }
}

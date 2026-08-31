/**
 * DAC Inception 任务：量子箱开箱（每日 5 箱）
 * 流程（按站点实际页面核实）：
 *   打开落地页 → 等 Enter Inception（网络差刷新重试）→ 登录方式选择弹窗点 WALLET
 *   → 钱包列表点 MetaMask（AppKit data-testid）→ 钱包弹窗解锁 + 连接
 *   → 等左侧目录栏出现（登录成功）→ 点 Quantum Crate → 点 Open Free
 *   → 弹窗点 Open for → 等开箱视频/结果出现 Close → 点 Close
 *   → 重复开箱直到出现 Daily limit reached 提示（成功判定与已领取判定同一文案）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// 每日上限提示文案（站点 toast 原文，数字随配置变化故只匹配前缀）
const LIMIT_TEXT = 'Daily limit reached'
// 开箱弹窗标题（点击 Open Free 后出现，与上限提示互斥）
const MODAL_TITLE = 'What is inside?'
// 开箱结果文案（弹窗 Close 按钮常驻，等结果必须等这两句之一出现）
const REVEAL_TEXTS = ['You Won', 'Better luck next time']

export class InceptionDachainTask extends SiteTask {
  meta: TaskMeta = {
    key: 'inception-dachain',
    name: 'DAC 签到',
    url: 'https://inception.dachain.io/',
    sourceUrl: ['https://airdrops.io/dac/', 'https://cryptorank.io/zh/drophunting/arc-chain-activity911'],
    note: '真机核实：免费箱按钮实为 OPEN FOR 150 QE（余额 ≥150 QE 才可点，不足报 Insufficient QE）；弹窗 Close 按钮常驻（开箱结果需等 You Won / Better luck next time 出现）；开箱视频很卡放宽等待；每日 5 箱上限，达到后点 Open Free 弹 Daily limit reached 提示即成功（已领取同判定）；落地页网络差时常渲染失败需刷新重试；MetaMask 为中文界面（适配器按 testid 定位）',
    category: 'faucet',
    lastUpdated: '2026-08-31',
    enabled: true,
    // 无 schedule：仅手动触发/窗口立即跑（按模板默认）
    wallet: 'metamask',
    // 开箱视频慢 + 最多 5 箱，放宽单次超时
    timeoutSec: 900,
    retry: { max: 2, backoffSec: 600 },
    captcha: { auto: true, maxCost: 1500 },
  }

  /** 竞速等待：上限提示 或 开箱弹窗出现（都等不到返回 null） */
  private async raceLimitOrModal(ctx: TaskContext, timeoutMs: number): Promise<'limit' | 'modal' | null> {
    const r = await Promise.race([
      ctx.waitForText(LIMIT_TEXT, timeoutMs).then(() => 'limit' as const).catch(() => null),
      ctx.waitForText(MODAL_TITLE, timeoutMs).then(() => 'modal' as const).catch(() => null),
    ])
    return r ?? null
  }

  /** 等待多个文案任一出现（返回命中文案，超时返回 null） */
  private async waitAnyText(ctx: TaskContext, texts: string[], timeoutMs: number): Promise<string | null> {
    const r = await Promise.race(texts.map((t) => ctx.waitForText(t, timeoutMs).then(() => t).catch(() => null)))
    return r ?? null
  }

  async run(ctx: TaskContext): Promise<void> {
    // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
    await ctx.closeOtherTabs()
    await ctx.goto()

    // 已登录（cookie 还在）：左侧目录栏直接可见，跳过登录步骤
    let popupFailed = false
    if (!(await ctx.textPresent('Quantum Crate'))) {
      // 第 1 步：等 Enter Inception 出现，网络差刷不出来就反复刷新
      for (let i = 0; i < 10; i++) {
        if (await ctx.textPresent('Enter Inception')) break
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(10000)
        if (i === 9) throw new Error('多次刷新后仍未出现 Enter Inception（网络异常）')
      }

      // MetaMask 扩展未注入快速失败（真机实测部分窗口无 window.ethereum：点钱包项只会出二维码、永远等不到弹窗）
      const hasMetaMask = await ctx.js<boolean>(() => typeof (window as unknown as { ethereum?: unknown }).ethereum !== 'undefined')
      if (!hasMetaMask) throw new Error('未检测到 MetaMask 扩展（window.ethereum 缺失），请检查该窗口的扩展配置')

      // 第 2 步：Enter Inception → 登录方式选择弹窗（Get Started）→ 点 WALLET（钱包登录）
      await ctx.clickCheckin('button:has-text("Enter Inception")', { assert: 'text=Get Started', assertTimeoutMs: 30000 })
      await ctx.human.click('button:has-text("WALLET")')
      // 钱包列表出现后点 MetaMask（AppKit 钱包项 data-testid，真机核实）
      const walletEntry = '[data-testid="wallet-selector-io.metamask"]'
      await ctx.assertVisible(walletEntry, 30000)
      await ctx.human.click(walletEntry)
      // 钱包弹窗 → 解锁 → 确认连接；已授权过站点的窗口可能不再弹弹窗（静默连接），
      // 弹窗未出现不立即判失败，交给后面的左侧目录判定
      try {
        await ctx.loginByWallet()
      } catch (e) {
        if ((e as Error).message.includes('钱包弹窗未出现')) popupFailed = true
        else throw e
      }
    }

    // 第 3 步：等登录完成（左侧目录栏出现）——连接成功后站点偶发不自动跳转（真机实测），
    // 10s 未见目录则刷新页面重试（最多 6 轮，覆盖慢跳转与网络抖动）
    let loggedIn = false
    for (let i = 0; i < 6 && !loggedIn; i++) {
      loggedIn = await ctx.textPresent('Quantum Crate')
      if (loggedIn) break
      if (i === 1) await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
      await ctx.page.waitForTimeout(10000)
    }
    if (!loggedIn) {
      throw new Error(
        popupFailed
          ? '钱包弹窗未出现且页面未登录：该窗口 MetaMask 可能未安装/未启用（window.ethereum 缺失）'
          : '等待文案超时: Quantum Crate',
      )
    }
    // 点左侧目录栏 Quantum Crate → 页面出现 Open Free 表示打开成功
    await ctx.human.click('button:has-text("Quantum Crate")')
    await ctx.waitForText('Open Free', 20000)

    // 第 4 步：反复开箱，直到出现每日上限提示
    for (let i = 0; i < 8; i++) {
      // 上限提示 toast 出现时间短（约 4s），点完 Open Free 后竞速检测，漏掉就重点一次
      let outcome: 'limit' | 'modal' | null = null
      for (let attempt = 0; attempt < 3 && !outcome; attempt++) {
        await ctx.human.click('button:has-text("Open Free")')
        outcome = await this.raceLimitOrModal(ctx, 6000)
      }
      if (outcome === 'limit') {
        await ctx.screenshot('dac-success')
        return
      }
      if (outcome !== 'modal') throw new Error('点击 Open Free 后既无开箱弹窗也无每日上限提示（页面或网络异常）')
      // 弹窗内点 Open for（开箱），等视频/接口完成出现开箱结果（You Won / Better luck next time）
      // 注意：弹窗 Close 按钮常驻，不能等它；开箱视频/接口很卡，放宽到 90s
      await ctx.human.click('button:has-text("Open for")')
      const revealed = await this.waitAnyText(ctx, REVEAL_TEXTS, 90000)
      if (!revealed) throw new Error('等待开箱结果超时（视频/接口过慢）')
      await ctx.human.click('button:has-text("Close")')
      await ctx.page.waitForTimeout(2000)
    }
    throw new Error('开箱次数超过预期仍未出现每日上限提示')
  }
}

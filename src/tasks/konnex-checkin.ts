/**
 * Konnex 签到任务：Check In (Weekly) 每周签到（+10 KP，每周一次，每周重置）
 * 流程（真机核实 2026-10-07，窗口2；登录分支按用户录屏式素材编写，待新窗口真机验证）：
 *   打开 /points 落地页 → 竞速判定登录状态（Balance 余额小部件已登录 / Connect Wallet 未登录）
 *   → 未登录：点 Connect Wallet（data-testid=connect-wallet-button）
 *     → 弹窗点 "Connect with Ethereum" → 选 MetaMask
 *     → MetaMask 弹窗解锁 + 连接（适配器按 testid 自动处理「连接/确认」按钮）
 *   → 等 Balance 出现（登录完成）→ 点 Check in 按钮（#loyalty-quest-root-check_in 卡片内）
 *   → 成功弹窗 #check-in-modal__success__heading "Check-In Succeeded!" 即成功
 * 已签到当周（真机核实三种卡片状态）：
 *   a. 刚完成：卡片内显示 "Great job! 10 added to your balance." 横幅（刷新后仍显示，直到点横幅 Close）
 *   b. 横幅被关闭后：卡片变暗（opacity-50）显示 "RESETS IN <倒计时>"，无按钮，刷新后仍持久
 *   两种状态都算成功
 * 坑：站点页面持续动画（倒计时/动态榜），成功截图 CDP 偶发 30s 超时挂起——截图已容错不阻断任务
 *   （真机实测窗口89 因此误报 retry_wait，重试走已签到路径成功）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '../infrastructure/constants'

// —— 站点文案/选择器（真机核实）——
// 登录成功标志（余额小部件标签；未登录落地页不渲染 Balance）
const BALANCE_TEXT = 'Balance'
// 未登录落地页按钮（真机录屏素材：data-testid 稳定）
const CONNECT_WALLET_BTN = '[data-testid="connect-wallet-button"]'
// 连接弹窗内的以太坊入口文案
const ETHEREUM_ENTRY_TEXT = 'Connect with Ethereum'
// 钱包选择列表里的 MetaMask 入口
const METAMASK_ENTRY_TEXT = 'MetaMask'
// 签到按钮（页面唯一 Check in 按钮；卡片容器 id=loyalty-quest-root-check_in 可作兜底定位）
const CHECKIN_BTN = 'button:has-text("Check in")'
// 签到卡片容器（已签到横幅的定位范围）
const CHECKIN_CARD = '#loyalty-quest-root-check_in'
// 成功文案（弹窗 h1#check-in-modal__success__heading 的文本断言）
const SUCCESS_TEXT = 'Check-In Succeeded!'
// 已签到横幅文案（刚完成时显示；点横幅 Close 后消失）
const DONE_TEXT = 'Great job!'
// 已签到暗态倒计时文案（横幅被关闭后的持久状态，真机核实：RESETS IN <倒计时>）
const RESET_TEXT = 'RESETS IN'

// —— 时间配置（参照既有任务真机校准）——
const CHECKIN_CARD_WAIT_MS = 45000 // 等签到卡片渲染出状态（SPA 数据加载慢，真机实测 goto 后约 1s 卡片尚未出现）
const CHECKIN_SUCCESS_WAIT_MS = 30000 // 点 Check in 后等成功弹窗/已签到横幅（弹窗可能有过渡动画）

export class KonnexCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'konnex-checkin',
    name: 'Konnex 签到',
    group: { key: 'konnex', name: 'Konnex' },
    url: 'https://hub.konnex.world/points',
    sourceUrl: ['https://cryptorank.io/zh/drophunting/konnex-activity1071', 'https://airdrops.io/konnex/'],
    note: '每周签到（Check In Weekly，+10 KP，每周一次、每周重置）；真机核实：登录后余额小部件标签 Balance 可作登录态标记（未登录落地页是 Connect Wallet 按钮）；签到按钮为页面唯一 button:has-text("Check in")；成功判定为弹窗 h1#check-in-modal__success__heading（Check-In Succeeded!）；当周已签到时按钮消失，卡片显示 Great job! 横幅（点 Close 后变为暗态 RESETS IN 倒计时，刷新后均持久），两种状态都算成功；卡片渲染有延迟（goto 后约 1s），判定前须等待；MetaMask 弹窗「连接/确认」两步由适配器自动处理；登录分支按录屏素材编写，新窗口真机验证后复核',
    category: 'checkin',
    lastUpdated: '2026-10-07',
    enabled: true,
    wallet: 'metamask',
    // 登录弹窗 + 钱包解锁 + 等待兜底，放宽单次超时
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
    await ctx.closeOtherTabs()
    await ctx.goto()

    // 登录状态竞速判定：SPA 渲染有延迟，已登录窗口误入登录分支会假报失败；
    // 状态不明时反复刷新（每轮两种状态都认，已登录窗口刷新后直接走已登录分支）
    const state = await ctx.detectPageState({
      loggedInText: BALANCE_TEXT,
      landingText: 'Connect Wallet',
      waitMs: 20000,
      rounds: 10,
      roundWaitMs: 15000,
      reloadTimeoutMs: DEFAULT_RELOAD_TIMEOUT_MS,
    })
    if (state === 'landing') {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '未登录，进入 MetaMask 登录流程')
      await this.loginByMetaMask(ctx)
      // 等登录完成（Balance 余额小部件出现）——先被动等，再刷新 2 轮兜底
      if (!(await ctx.waitForTextWithReloads(BALANCE_TEXT, { passiveMs: 45000, rounds: 2, roundWaitMs: 30000, reloadTimeoutMs: DEFAULT_RELOAD_TIMEOUT_MS }))) {
        throw new Error('钱包连接后登录未完成（等待 Balance 超时，站点登录接口慢或该窗口账号异常）')
      }
    } else {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '已登录（cookie 有效），跳过登录')
    }

    await this.checkin(ctx)
  }

  /**
   * 钱包登录（未登录分支）：Connect Wallet → "Connect with Ethereum" → MetaMask → 钱包弹窗连接
   */
  private async loginByMetaMask(ctx: TaskContext): Promise<void> {
    // 会话级钱包扩展就绪检查：扩展未加载时快速失败（重试将重启浏览器窗口）
    await ctx.ensureWalletReady()

    // 点 Connect Wallet → 等连接弹窗出现
    await ctx.human.click(CONNECT_WALLET_BTN)
    await ctx.assertVisible(`text=${ETHEREUM_ENTRY_TEXT}`, 45000)
    await ctx.human.click(`text=${ETHEREUM_ENTRY_TEXT}`)

    // 弹窗内选 MetaMask → 唤起钱包弹窗解锁 + 连接（适配器按 testid 自动点「连接/确认」；
    // 已授权过站点的窗口可能静默连接不弹窗——loginByWallet 抛「钱包弹窗未出现」不立即判失败，
    // 登录结果以页面 Balance 出现为准）
    const entry = `text=${METAMASK_ENTRY_TEXT}`
    await ctx.assertVisible(entry, 15000)
    try {
      await ctx.loginByWallet({ reclick: { selector: entry, afterMs: 8000 } })
    } catch (e) {
      if (!(e as Error).message.includes('钱包弹窗未出现')) throw e
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '钱包弹窗未出现（可能静默连接），以页面登录态判定')
    }
  }

  /**
   * 签到：等卡片渲染 → 点 Check in → 等成功弹窗/已签到状态出现
   * 已签到当周三种卡片状态（真机核实）：横幅 Great job! / 暗态 RESETS IN 倒计时——都算成功
   * 两者均未出现：dump 卡片与 h1 内容辅助排障
   * 成功截图失败不阻断任务（真机实测：该站页面持续动画，CDP 截图偶发 30s 超时挂起）
   */
  private async checkin(ctx: TaskContext): Promise<void> {
    // SPA 渲染 + 任务数据加载有延迟（真机实测：goto 后约 1s 卡片尚未渲染，直接判定会假报异常）：
    // 先等卡片状态出现——Check in 按钮（可签到）或已签到状态（横幅/倒计时）
    const deadline = Date.now() + CHECKIN_CARD_WAIT_MS
    let hasBtn = false
    while (Date.now() < deadline) {
      hasBtn = await ctx.visible(CHECKIN_BTN)
      if (hasBtn) break
      if (await this.checkinDone(ctx)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '本周已签到（卡片为已签到状态）')
        await this.screenshotSafe(ctx, 'konnex-success')
        return
      }
      await ctx.page.waitForTimeout(2000)
    }
    if (!hasBtn) throw new Error('签到卡片未出现（Check in 按钮与已签到状态均无；页面异常或站点改版）')
    await ctx.human.click(CHECKIN_BTN)
    // 成功弹窗与已签到状态竞速（横幅/倒计时在卡片状态更新后立即出现）
    const outcome = await ctx.raceTexts([['success', SUCCESS_TEXT], ['done', DONE_TEXT]], CHECKIN_SUCCESS_WAIT_MS)
    if (outcome === 'success' || outcome === 'done' || (await this.checkinDone(ctx))) {
      ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '签到成功（Check-In Succeeded!）')
      await this.screenshotSafe(ctx, 'konnex-success')
      return
    }
    const card = await ctx
      .js<string>(() => (document.querySelector('#loyalty-quest-root-check_in')?.textContent ?? '').trim().slice(0, 300))
      .catch(() => '')
    const headings = await ctx
      .js<string>(() => [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim()).filter(Boolean).join(' | '))
      .catch(() => '')
    throw new Error(`点击 Check in 后未出现成功弹窗（卡片: ${card || '无'}；h1: ${headings || '无'}；可能已签到/站点改版）`)
  }

  /** 卡片是否处于已签到状态：横幅 Great job! 或暗态 RESETS IN 倒计时（任一即已签到） */
  private async checkinDone(ctx: TaskContext): Promise<boolean> {
    if (await ctx.visible(`${CHECKIN_CARD}:has-text("${DONE_TEXT}")`)) return true
    return ctx.visible(`${CHECKIN_CARD}:has-text("${RESET_TEXT}")`)
  }

  /** 成功截图（容错）：截图失败只告警不失败任务——该站页面持续动画，CDP 截图偶发 30s 超时 */
  private async screenshotSafe(ctx: TaskContext, name: string): Promise<void> {
    try {
      await ctx.screenshot(name)
    } catch (e) {
      ctx.log.warn({ step: 'checkin', window: ctx.profile.name, err: (e as Error).message }, '成功截图失败（不影响任务结果）')
    }
  }
}

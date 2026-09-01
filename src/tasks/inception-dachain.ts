/**
 * DAC Inception 任务：量子箱开箱（每日 5 箱）
 * 流程（按站点实际页面核实 + 多窗口并行实测修正）：
 *   打开落地页 → 竞速判定登录状态（Quantum Crate 已登录 / Enter Inception 未登录，
 *   两者都可能在 SPA 渲染 0-3s 后才出现——过早判定会把已登录窗口误入登录分支，
 *   而已登录仪表盘永远不出现 Enter Inception，导致假报"网络异常"）
 *   → 未登录：点 Enter Inception → 登录方式选择弹窗点 WALLET
 *   → AppKit 弹窗视图归一化（初始视图不固定：钱包列表 / 上次钱包 QR 页 / 列表收起，
 *   分别用直接命中 / header-back 回退 / all-wallets 展开 / tab-browser 切换）→ 点 MetaMask
 *   → 钱包弹窗解锁 + 连接（静默连接不判失败）
 *   → 等左侧目录栏出现（登录成功）→ 点 Quantum Crate → 点 Open Free
 *   → 弹窗点 Open for → 等开箱结果出现 Close → 点 Close → 等弹窗真正消失再开下一箱
 *   → 重复直到每日上限（toast / 页面计数器 / 弹窗内提示，任一命中即成功）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// —— 站点文案（真机核实，与 UI 语言无关的部分用 testid）——
// 每日上限提示文案（站点 toast 原文，数字随配置变化故只匹配前缀）
const LIMIT_TEXT = 'Daily limit reached'
// 开箱弹窗标题（点击 Open Free 后出现，与上限提示互斥）
const MODAL_TITLE = 'What is inside?'
// 开箱结果文案（弹窗 Close 按钮常驻，等结果必须等这两句之一出现）
const REVEAL_TEXTS = ['You Won', 'Better luck next time']
// 余额不足文案（QE 不足 150 时站点提示；快速失败避免空耗 90s 开箱等待）
const INSUFFICIENT_TEXT = 'Insufficient QE'
// 登录成功标志（左侧目录栏）
const SIDEBAR_TEXT = 'Quantum Crate'
// 未登录落地页按钮
const ENTER_TEXT = 'Enter Inception'
// AppKit 钱包列表里的 MetaMask 入口（data-testid，与 UI 语言无关）
const METAMASK_ENTRY = '[data-testid="wallet-selector-io.metamask"]'

// —— 时间/次数配置（全部经真机实测校准；改动前重新真机验证）——
const STATE_WAIT_MS = 20000 // 初始登录状态竞速（SPA 渲染延迟容忍）
const STATE_RELOAD_ROUNDS = 10 // 状态不明时刷新轮数
const STATE_RELOAD_WAIT_MS = 15000 // 每轮刷新后竞速
const RELOAD_TIMEOUT_MS = 45000 // page.reload 超时
const ETH_POLL_ROUNDS = 10 // window.ethereum 注入轮询次数（并发实测 0-30s 随机）
const ETH_POLL_INTERVAL_MS = 6000 // 轮询间隔（总预算 60s）
const GET_STARTED_WAIT_MS = 45000 // Enter Inception → Get Started 断言（高负载下弹窗渲染慢）
const APP_KIT_MODAL_WAIT_MS = 45000 // AppKit 弹窗出现等待（高负载下渲染慢）
const APP_KIT_NORMALIZE_ROUNDS = 5 // 弹窗视图归一化轮数
const APP_KIT_ROUND_SLEEP_MS = 3000 // 每轮归一化后停顿
const SIDEBAR_PASSIVE_MS = 45000 // 钱包连接后被动等目录（登录 API 慢，实测可 >60s）
const SIDEBAR_RELOAD_ROUNDS = 2 // 目录不出现时刷新轮数
const SIDEBAR_RELOAD_WAIT_MS = 30000 // 每轮等目录
const CRATE_PAGE_WAIT_MS = 20000 // 目录点击后等 Open Free
const CRATE_PAGE_ATTEMPTS = 2 // 目录点击补点次数（SPA 路由未生效场景）
const CRATE_LOOP_MAX = 8 // 开箱循环上限（5 箱 + 上限提示判定余量）
const OPEN_FREE_RACE_MS = 6000 // 点 Open Free 后竞速（上限 toast 约 4s）
const OPEN_FREE_ATTEMPTS = 3 // 竞速漏检重点次数
const REVEAL_TOTAL_MS = 90000 // 开箱结果总预算（视频很卡）
const REVEAL_RECLICK_AT_MS = 45000 // 无结果且按钮仍在时补点（预算不缩短）
const MODAL_GONE_MS = 10000 // Close 后等弹窗消失（未关则遮挡下一轮点击）

/** 竞速结果标识（各竞速点的键值合集） */
type RaceKey = 'loggedIn' | 'landing' | 'limit' | 'modal' | 'revealed' | 'insufficient'

export class InceptionDachainTask extends SiteTask {
  meta: TaskMeta = {
    key: 'inception-dachain',
    name: 'DAC 签到',
    url: 'https://inception.dachain.io/',
    sourceUrl: ['https://airdrops.io/dac/', 'https://cryptorank.io/zh/drophunting/arc-chain-activity911'],
    note: '真机核实：免费箱按钮实为 OPEN FOR 150 QE（余额 ≥150 QE 才可点，不足报 Insufficient QE）；弹窗 Close 按钮常驻（开箱结果需等 You Won / Better luck next time 出现）；开箱视频很卡放宽等待；每日 5 箱上限，达到后成功判定有 3 个信号（toast / 页面 DAILY OPENS 计数器 / 弹窗内提示）；落地页网络差时常渲染失败需刷新重试；MetaMask 为中文界面（适配器按 testid 定位）；并行实测补充：已登录窗口仪表盘不出现 Enter Inception，必须竞速判定登录状态；AppKit 弹窗初始视图不固定（钱包列表/SafePal QR 页），需归一化后找 MetaMask',
    category: 'faucet',
    lastUpdated: '2026-09-01',
    enabled: true,
    // 无 schedule：仅手动触发/窗口立即跑（按模板默认）
    wallet: 'metamask',
    // 开箱视频慢 + 最多 5 箱，放宽单次超时
    timeoutSec: 900,
    retry: { max: 2, backoffSec: 600 },
    captcha: { auto: true, maxCost: 1500 },
  }

  // —— 通用竞速等待 ——

  /** 多文案竞速：任一出现返回其键，都等不到返回 null（Promise.race 统一实现） */
  private async raceTexts(ctx: TaskContext, entries: Array<[RaceKey, string]>, timeoutMs: number): Promise<RaceKey | null> {
    const r = await Promise.race(entries.map(([k, text]) => ctx.waitForText(text, timeoutMs).then(() => k).catch(() => null)))
    return r ?? null
  }

  /** 登录状态竞速：已登录（目录栏）/ 未登录（Enter Inception） */
  private raceLoginState(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    return this.raceTexts(ctx, [['loggedIn', SIDEBAR_TEXT], ['landing', ENTER_TEXT]], timeoutMs)
  }

  /** 点 Open Free 后竞速：上限提示 / 开箱弹窗 / 余额不足 */
  private raceAfterOpenFree(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    return this.raceTexts(ctx, [['limit', LIMIT_TEXT], ['modal', MODAL_TITLE], ['insufficient', INSUFFICIENT_TEXT]], timeoutMs)
  }

  /** 开箱结果竞速：结果文案任一 / 余额不足 / 弹窗内上限提示（达上限时弹窗无结果） */
  private raceReveal(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    const entries: Array<[RaceKey, string]> = [
      ...REVEAL_TEXTS.map((t) => ['revealed', t] as [RaceKey, string]),
      ['insufficient', INSUFFICIENT_TEXT],
      ['limit', LIMIT_TEXT],
    ]
    return this.raceTexts(ctx, entries, timeoutMs)
  }

  // —— 页面状态工具 ——

  /**
   * 读页面每日开箱计数器（DAILY OPENS x/y）：
   * 真机实测达上限后点 Open Free 可能弹出无结果弹窗，点 Open for 既不报错也不出现
   * 开箱结果，空耗 90s——用页面计数器做确定性判定
   * @returns 解析失败（站点改版/未渲染）返回 null，走文案竞速兜底
   */
  private async dailyOpens(ctx: TaskContext): Promise<{ opened: number; total: number } | null> {
    return ctx.js<{ opened: number; total: number } | null>(() => {
      const text = document.body?.innerText ?? ''
      const m = text.match(/DAILY[\s|]*OPENS[\s|]*(\d+)\s*\/\s*(\d+)/)
      return m ? { opened: Number(m[1]), total: Number(m[2]) } : null
    }).catch(() => null)
  }

  /** 元素是否可见（任何异常按不可见处理） */
  private async visible(ctx: TaskContext, selector: string): Promise<boolean> {
    try {
      const loc = ctx.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }

  /** 等元素消失或隐藏（元素从未出现视为已消失；最多 timeoutMs） */
  private async waitGoneOrHidden(ctx: TaskContext, selector: string, timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try {
        const loc = ctx.page.locator(selector).first()
        if ((await loc.count()) === 0) return
        if (!(await loc.isVisible().catch(() => false))) return
      } catch {
        return
      }
      await ctx.page.waitForTimeout(500)
    }
  }

  /** 达上限成功：截图 + 日志（三个信号的统一收尾） */
  private async finishAtLimit(ctx: TaskContext, signal: string): Promise<void> {
    ctx.log.info({ step: 'crates', window: ctx.profile.name, signal }, '每日上限已达成')
    await ctx.screenshot('dac-success')
  }

  // —— 主流程 ——

  async run(ctx: TaskContext): Promise<void> {
    // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
    await ctx.closeOtherTabs()
    await ctx.goto()

    const state = await this.detectState(ctx)
    let popupFailed = false
    if (state === 'landing') {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '未登录，进入钱包登录流程')
      try {
        popupFailed = await this.loginByMetaMask(ctx)
      } catch (e) {
        // 落地页闪烁修正：站点可能先闪现落地页（竞速抓到 Enter Inception）再完成
        // 登录跳转（按钮消失致点击失败）——重查状态，目录栏已出现则按已登录继续
        if (await ctx.textPresent(SIDEBAR_TEXT).catch(() => false)) {
          ctx.log.info({ step: 'login', window: ctx.profile.name }, '登录态已修正：页面已完成登录，跳过登录流程')
        } else {
          throw e
        }
      }
    } else {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '已登录（cookie 有效），跳过登录')
    }

    if (!(await this.waitForSidebar(ctx))) {
      throw new Error(
        popupFailed
          ? '钱包弹窗未出现且登录未完成：该窗口 MetaMask 可能未启用，或站点静默连接失败（重试将重启浏览器窗口）'
          : '钱包连接后登录未完成（等待 Quantum Crate 目录超时，站点登录接口慢或该窗口账号异常）',
      )
    }

    await this.enterCratePage(ctx)
    await this.openCrates(ctx)
  }

  /**
   * 登录状态竞速判定：goto 后 SPA 渲染有延迟（真机实测 0-3s 判定会误判），
   * 已登录窗口若误入登录分支，仪表盘永远不出现 Enter Inception（假报网络异常）；
   * 状态不明时反复刷新（每轮两种状态都认，已登录窗口刷新后直接走已登录分支）
   */
  private async detectState(ctx: TaskContext): Promise<'loggedIn' | 'landing'> {
    let state = await this.raceLoginState(ctx, STATE_WAIT_MS)
    for (let i = 0; i < STATE_RELOAD_ROUNDS && !state; i++) {
      await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      state = await this.raceLoginState(ctx, STATE_RELOAD_WAIT_MS)
    }
    if (!state) throw new Error('多次刷新后仍未出现 Enter Inception 或 Quantum Crate（网络异常）')
    return state as 'loggedIn' | 'landing'
  }

  /**
   * 钱包登录（未登录分支）：Enter Inception → WALLET → AppKit 归一化 → MetaMask → 钱包弹窗
   * @returns 钱包弹窗是否未出现（静默连接容忍：由调用方结合目录栏判定）
   */
  private async loginByMetaMask(ctx: TaskContext): Promise<boolean> {
    // 并行：MetaMask 扩展注入轮询（与后续 UI 流程重叠，缺失窗口提前失败且错误准确）
    const ethReady = (async (): Promise<boolean> => {
      for (let i = 0; i < ETH_POLL_ROUNDS; i++) {
        const ok = await ctx.js<boolean>(() => typeof (window as unknown as { ethereum?: unknown }).ethereum !== 'undefined').catch(() => false)
        if (ok) return true
        await ctx.page.waitForTimeout(ETH_POLL_INTERVAL_MS)
      }
      return false
    })()

    // Enter Inception → 登录方式选择弹窗（Get Started）→ 点 WALLET
    await ctx.clickCheckin('button:has-text("Enter Inception")', { assert: 'text=Get Started', assertTimeoutMs: GET_STARTED_WAIT_MS })
    await ctx.human.click('button:has-text("WALLET")')

    // AppKit 弹窗视图归一化：初始视图不固定（钱包列表 / 上次钱包 QR 页 / 列表收起），
    // 依次尝试 直接命中 → header-back 回退 → all-wallets 展开 → tab-browser 切换
    await ctx.assertVisible('[data-testid="w3m-modal-card"]', APP_KIT_MODAL_WAIT_MS)
    const entryFound = await this.normalizeAppKit(ctx)
    if (!entryFound) throw new Error('AppKit 弹窗未出现 MetaMask 入口（弹窗视图异常，归一化未命中）')

    // 扩展注入判定：弹窗归一化耗时已并行覆盖大部分轮询窗口，此处缺失即为真缺失
    if (!(await ethReady)) {
      throw new Error('窗口 MetaMask 扩展未加载（window.ethereum 缺失，60s 轮询未等到），重试将重启浏览器窗口')
    }
    await ctx.human.click(METAMASK_ENTRY)

    // 钱包弹窗 → 解锁 → 确认连接；已授权过站点的窗口可能不再弹弹窗（静默连接），
    // 弹窗未出现不立即判失败，交给后面的左侧目录判定；
    // 8s 内未出现则补点一次入口（AppKit 动画未稳定时首次点击可能不注册）
    try {
      await ctx.loginByWallet({ reclick: { selector: METAMASK_ENTRY, afterMs: 8000 } })
      return false
    } catch (e) {
      if ((e as Error).message.includes('钱包弹窗未出现')) return true
      throw e
    }
  }

  /** AppKit 弹窗内找 MetaMask 入口（找不到时按视图状态归一化后重试） */
  private async normalizeAppKit(ctx: TaskContext): Promise<boolean> {
    for (let i = 0; i < APP_KIT_NORMALIZE_ROUNDS; i++) {
      if (await this.visible(ctx, METAMASK_ENTRY)) return true
      if (await this.visible(ctx, '[data-testid="header-back"]')) {
        await ctx.human.click('[data-testid="header-back"]')
      } else if (await this.visible(ctx, '[data-testid="all-wallets"]')) {
        await ctx.human.click('[data-testid="all-wallets"]')
      } else if (await this.visible(ctx, '[data-testid="tab-browser"]')) {
        await ctx.human.click('[data-testid="tab-browser"]')
      }
      await ctx.page.waitForTimeout(APP_KIT_ROUND_SLEEP_MS)
    }
    return false
  }

  /**
   * 等登录完成（左侧目录栏出现）——真机实测：钱包连接成功后站点侧登录 API
   * 在网络差时很慢（可能 >60s）或需要刷新后才呈现：先被动等，再刷新 2 轮
   */
  private async waitForSidebar(ctx: TaskContext): Promise<boolean> {
    const waitFor = async (ms: number): Promise<boolean> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await ctx.textPresent(SIDEBAR_TEXT)) return true
        await ctx.page.waitForTimeout(5000)
      }
      return false
    }
    if (await waitFor(SIDEBAR_PASSIVE_MS)) return true
    for (let round = 0; round < SIDEBAR_RELOAD_ROUNDS; round++) {
      await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      if (await waitFor(SIDEBAR_RELOAD_WAIT_MS)) return true
    }
    return false
  }

  /** 点左侧目录栏 Quantum Crate → 等 Open Free；点击可能未生效（SPA 路由慢）则补点 */
  private async enterCratePage(ctx: TaskContext): Promise<void> {
    for (let attempt = 0; attempt < CRATE_PAGE_ATTEMPTS; attempt++) {
      await ctx.human.click(`button:has-text("${SIDEBAR_TEXT}")`)
      if (await ctx.waitForText('Open Free', CRATE_PAGE_WAIT_MS).then(() => true).catch(() => false)) {
        ctx.log.info({ step: 'crates', window: ctx.profile.name }, '进入开箱页面')
        return
      }
    }
    throw new Error('点击 Quantum Crate 后未出现开箱页面（等待 Open Free 超时）')
  }

  /** 反复开箱，直到出现每日上限（toast / 页面计数器 / 弹窗内提示） */
  private async openCrates(ctx: TaskContext): Promise<void> {
    for (let i = 0; i < CRATE_LOOP_MAX; i++) {
      // 页面每日额度计数器快速判定：已满直接成功（比点按钮等 toast 更确定性）
      const info = await this.dailyOpens(ctx)
      if (info && info.opened >= info.total) {
        await this.finishAtLimit(ctx, `counter ${info.opened}/${info.total}`)
        return
      }
      // 上限 toast 出现时间短（约 4s），点完 Open Free 后竞速检测，漏掉就重点一次
      let outcome: RaceKey | null = null
      for (let attempt = 0; attempt < OPEN_FREE_ATTEMPTS && !outcome; attempt++) {
        await ctx.human.click('button:has-text("Open Free")')
        outcome = await this.raceAfterOpenFree(ctx, OPEN_FREE_RACE_MS)
      }
      if (outcome === 'limit') {
        await this.finishAtLimit(ctx, 'toast')
        return
      }
      if (outcome === 'insufficient') throw new Error('QE 余额不足（Insufficient QE），无法继续开箱')
      if (outcome !== 'modal') throw new Error('点击 Open Free 后既无开箱弹窗也无每日上限提示（页面或网络异常）')

      // 弹窗内点 Open for（开箱），等视频/接口完成出现开箱结果；
      // 总预算 90s，45s 无结果且按钮仍在 → 补点一次（首次点击未注册场景），预算不缩短
      const revealed = await this.revealInModal(ctx)
      if (revealed === 'limit') {
        await this.finishAtLimit(ctx, 'modal')
        return
      }
      if (revealed === 'insufficient') throw new Error('QE 余额不足（Insufficient QE），无法继续开箱')
      if (revealed !== 'revealed') throw new Error('等待开箱结果超时（视频/接口过慢）')
      await ctx.human.click('button:has-text("Close")')
      // 等弹窗真正消失再开下一箱（固定 sleep 在弹窗未关时会导致下一轮 Open Free 点击被遮挡）
      await this.waitGoneOrHidden(ctx, `text=${MODAL_TITLE}`, MODAL_GONE_MS)
      ctx.log.info({ step: 'crates', window: ctx.profile.name, opened: i + 1 }, '开箱完成')
    }
    throw new Error('开箱次数超过预期仍未出现每日上限提示')
  }

  /** 弹窗内开箱并等结果（结果 / 余额不足 / 弹窗内上限提示 / 超时 null） */
  private async revealInModal(ctx: TaskContext): Promise<RaceKey | null> {
    const deadline = Date.now() + REVEAL_TOTAL_MS
    await ctx.human.click('button:has-text("Open for")')
    let revealed = await this.raceReveal(ctx, REVEAL_RECLICK_AT_MS)
    if (!revealed && (await this.visible(ctx, 'button:has-text("Open for")'))) {
      await ctx.human.click('button:has-text("Open for")')
    }
    if (!revealed) revealed = await this.raceReveal(ctx, Math.max(0, deadline - Date.now()))
    return revealed
  }
}

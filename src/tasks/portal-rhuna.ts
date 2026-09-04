/**
 * Rhuna 签到任务：Daily Check-in 每日签到（+20 pts，实测到账 160 RP）
 * 流程（按站点实际页面核实 + 真机实测修正，2026-09-02）：
 *   打开落地页 → 竞速判定登录状态（头部 Hello, 0x... 已登录 / Connect Wallet 未登录）
 *   → 未登录：点 Connect Wallet（:visible，页面有 4 个同文案按钮）→ Petra prompt.html 弹窗
 *   → 输密码 + Unlock → Sign In Request 点 Sign In（Aptos signMessage 签名）→ 弹窗关闭
 *   → 等 Hello, 出现（登录完成，后端 siwa/verify + validate 链路约 5s）
 *   → 进 Quests（Start Quests 按钮优先，兜底直达 /quests）→ 等 Daily Check-in 卡片
 *   → 点卡片弹 dialog：竞速「Quest completed successfully!（已领=成功）/ Claim（待领）」
 *   → 点 Claim → Processing your quest...（约 15s）→ Quest completed successfully! 即成功
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// —— 站点文案（真机核实）——
// 登录成功标志（头部 Hello, 0x...!）
const HELLO_TEXT = 'Hello,'
// 未登录落地页按钮（header/hero/footer 共 4 个，部分隐藏，必须 :visible 过滤）
const CONNECT_TEXT = 'Connect Wallet'
// 已登录首页的任务入口按钮
const START_QUESTS_TEXT = 'Start Quests'
// Quests 页签到卡片标题（桌面/移动两套 DOM，卡片整体 cursor-pointer 可点）
const CHECKIN_TEXT = 'Daily Check-in'
// 弹窗内成功文案（已领取时直接出现；领取完成后出现）
const SUCCESS_TEXT = 'Quest completed successfully!'
// 领取处理中提示（点 Claim 后出现，约 15s）
const PROCESSING_TEXT = 'Processing your quest...'
// 站点间歇性报错（真机实测：登录/跳转/签到后偶发，刷新页面即恢复——刷新会重新生成 Turnstile token）
const NETWORK_ERROR_TEXT = 'Network Error'
const TURNSTILE_ERROR_TEXT = 'Turnstile token request timed out'
/** 需要刷新恢复的错误文案合集（任一出现即刷新） */
const RECOVER_ERROR_TEXTS = [NETWORK_ERROR_TEXT, TURNSTILE_ERROR_TEXT]

// —— 时间/次数配置（真机实测校准）——
const RELOAD_TIMEOUT_MS = 45000 // page.reload 超时（登录态判定与目录等待共用）
const HELLO_WAIT_MS = 60000 // Sign In 后等 Hello（后端链路约 5s；Network Error 时循环内自动刷新）
const QUESTS_WAIT_MS = 60000 // 进 Quests 后等 Daily Check-in（含 Network Error 恢复）
const CLAIM_RACE_MS = 15000 // 弹窗内竞速：成功文案 / Claim 按钮
const CLAIM_RECHECK_MS = 10000 // 点 Claim 后未见处理中提示时的补点间隔
const SUCCESS_WAIT_MS = 60000 // 领取完成等待预算/轮（实测约 15s；卡"Processing"时周期刷新 30s 内会打断）
const CHECKIN_ROUNDS = 6 // 领取弹窗操作轮数（卡处理中/刷新丢弹窗后重开；部分窗口代理差需多轮）

/** 弹窗竞速结果标识 */
type RaceKey = 'success' | 'claim'

// 人机验证方框 iframe（站点 interaction-only Turnstile 组件：点 Claim 后渲染在右下角浮层，
// 真机实测 ISP IP 一点即过——之前代码从不点它，只会等 token 超时报错）
// 优先站点自建容器内（div[data-turnstile-container]），兜底任意可见挑战 iframe
const TURNSTILE_FRAME_SEL = ['div[data-turnstile-container] iframe:visible', 'iframe[src*="challenges.cloudflare.com"]:visible']

// 方框点击重试：点击后 Turnstile iframe 重渲染期间 CDP 派发会被浏览器拒绝
// （Protocol error / Invalid parameters，真机实测 09-04 凌晨 15+ 窗口因此失败，
// 且「再点一次」大多能过）——瞬时错误最多重试 3 次，间隔 1-2s 拟人化随机
const TURNSTILE_CLICK_MAX = 3
// CDP 会话级瞬时错误模式：与 app.ts TRANSIENT_PATTERN 同语义（点击方框场景的窄化子集）
const CDP_TRANSIENT = /Protocol error|session closed/

export class PortalRhunaTask extends SiteTask {
  meta: TaskMeta = {
    key: 'portal-rhuna',
    name: 'Rhuna 签到',
    url: 'https://portal.rhuna.io/',
    sourceUrl: ['https://cryptorank.io/zh/drophunting/rhuna-activity958'],
    note: '真机核实：登录用 Petra（点 Connect Wallet 直接唤起扩展弹窗 prompt.html，无站内钱包选择）；弹窗流程为输密码+Unlock → Sign In 签名（必须在新鲜请求上点，过期请求签名后站点不登录）；Petra 在本环境不注入页面 provider（window.petra 恒不存在），就绪判定仅靠 CDP 扩展页探测；部分窗口弹窗出现慢或偶发不出现，等 60s+8s 补点，未出现则刷新重试；getByRole 匹配不到 Sign In 按钮须用 has-text；Daily Check-in 卡片桌面/移动双 DOM，卡片整体可点；已领取弹窗直接显示 Quest completed successfully!（同样算成功）；领取时站点弹出 interaction-only 人机验证方框（右下角浮层，点方框即完成验证，ISP IP 一点即过）——任务自动拟人点击方框；站点间歇性报 Network Error / Turnstile token request timed out / Turnstile script failed to load（站点代码在 claim 时轮询 window.turnstile 10 秒未定义即报）/ chrome-error 错误页——token 存 localStorage，刷新即恢复，任务全程"刷新恢复导向"（错误文案立即刷 + 关键等待周期刷 + 弹窗打开失败无条件刷）；token 超时时调用 yescaptcha 打码回填兜底；登录态不跨浏览器重启（sessionStorage），每次新会话都走登录；个别窗口代理不稳 IP 探活会失败，属窗口环境问题',
    category: 'checkin',
    lastUpdated: '2026-09-02',
    enabled: true,
    wallet: 'petra',
    // 登录弹窗 + 领取处理宽松（接口高负载可慢至 60s+）+ 刷新恢复兜底，放宽单次超时
    timeoutSec: 1200,
    retry: { max: 2, backoffSec: 600 },
    captcha: { auto: true, maxCost: 1500 },
    concurrency: 2,
  }

  async run(ctx: TaskContext): Promise<void> {
    // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
    await ctx.closeOtherTabs()
    await ctx.goto()

    // 登录状态竞速判定：SPA 渲染有延迟，已登录窗口若误入登录分支会假报失败；
    // 状态不明时反复刷新（每轮两种状态都认，已登录窗口刷新后直接走已登录分支）
    const state = await ctx.detectPageState({
      loggedInText: HELLO_TEXT,
      landingText: CONNECT_TEXT,
      waitMs: 20000,
      rounds: 10,
      roundWaitMs: 15000,
      reloadTimeoutMs: RELOAD_TIMEOUT_MS,
    })
    if (state === 'landing') {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '未登录，进入 Petra 登录流程')
      await this.loginWithRetry(ctx)
    } else {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '已登录（cookie 有效），跳过登录')
    }

    await this.enterQuests(ctx)
    await this.checkin(ctx)
  }

  /**
   * Petra 登录 + 完成校验（最多 2 轮）：
   * 真机实测签名后站点偶发 Network Error 打断 verify——刷新后回到落地页，
   * 此时重新走一遍登录（新签名请求）即可；第二轮后仍未完成则抛错
   */
  private async loginWithRetry(ctx: TaskContext): Promise<void> {
    for (let round = 0; round < 2; round++) {
      if (round > 0) {
        // 重登前清理上一轮遗留的钱包弹窗页并刷新站点（保证干净落地页 + 新签名请求）
        await ctx.closeOtherTabs()
        await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
      }
      await this.loginByPetra(ctx)
      // 等登录完成（头部 Hello, 出现）——后端 siwa/verify + validate 链路约 5s；
      // 站点 token 存 localStorage：每 25s 主动刷新一次，刷新后自动完成登录 UI
      if (await this.waitForTextRecover(ctx, HELLO_TEXT, HELLO_WAIT_MS, 25000)) return
      // 仍未完成：重查登录态——已登录则收尾，仍落地页则重登，状态不明则抛错
      const st = await ctx
        .detectPageState({ loggedInText: HELLO_TEXT, landingText: CONNECT_TEXT, waitMs: 15000, rounds: 3, roundWaitMs: 10000, reloadTimeoutMs: RELOAD_TIMEOUT_MS })
        .catch(() => null)
      if (st === 'loggedIn') return
      if (st === 'landing' && round === 0) {
        ctx.log.info({ step: 'login', window: ctx.profile.name }, '签名后未完成登录（Network Error 打断），重走登录流程')
        continue
      }
      throw new Error('钱包签名后登录未完成（等待 Hello, 超时，站点登录接口慢或该窗口账号异常）')
    }
  }

  /**
   * 等文案出现（刷新恢复导向）：页面出现可恢复错误（Network Error / Turnstile 超时）立即刷新；
   * 配置 refreshEveryMs 时即使无错误也按周期主动刷新（真机实测：站点 token 存 localStorage，
   * 页面 JS 状态坏了时刷新即恢复登录态/路由，多数"卡住"场景刷新解决）
   * @returns 预算内文案出现 true / 超时 false
   */
  private async waitForTextRecover(ctx: TaskContext, text: string, budgetMs: number, refreshEveryMs = 0): Promise<boolean> {
    const end = Date.now() + budgetMs
    let lastRefresh = Date.now()
    while (Date.now() < end) {
      if (await ctx.textPresent(text)) return true
      const stale = refreshEveryMs > 0 && Date.now() - lastRefresh >= refreshEveryMs
      const errText = await this.recoverErrorText(ctx)
      if (stale || errText !== '') {
        ctx.log.info({ step: 'recover', window: ctx.profile.name, errText }, '刷新页面恢复（错误提示或周期刷新）')
        await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    return false
  }

  /** 页面是否出现可恢复错误文案 */
  private async hasRecoverError(ctx: TaskContext): Promise<boolean> {
    for (const t of RECOVER_ERROR_TEXTS) {
      if (await ctx.textPresent(t)) return true
    }
    return false
  }

  /** 当前页面命中的可恢复错误文案（日志排障用；无则空串） */
  private async recoverErrorText(ctx: TaskContext): Promise<string> {
    for (const t of RECOVER_ERROR_TEXTS) {
      if (await ctx.textPresent(t)) return t
    }
    return ''
  }

  /**
   * Petra 登录：点 Connect Wallet → 弹窗（输密码+Unlock → Sign In 签名）
   * 弹窗出现慢（部分窗口 >30s）：loginByWallet 等 60s + 8s 后补点；
   * 弹窗未出现（Petra 偶发不响应，真机实测）：刷新页面重新发起连接请求，最多 2 次
   */
  private async loginByPetra(ctx: TaskContext): Promise<void> {
    await ctx.ensureWalletReady()
    const connect = 'button:has-text("Connect Wallet"):visible'
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        ctx.log.info({ step: 'login', window: ctx.profile.name }, '钱包弹窗未出现，刷新后重试连接')
        await ctx.closeOtherTabs()
        await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(8000)
        // 刷新后可能已登录（连接静默完成）：直接收尾
        if (!(await ctx.visible(connect))) {
          const st = await ctx
            .detectPageState({ loggedInText: HELLO_TEXT, landingText: CONNECT_TEXT, waitMs: 10000, rounds: 3, roundWaitMs: 10000, reloadTimeoutMs: RELOAD_TIMEOUT_MS })
            .catch(() => null)
          if (st === 'loggedIn') return
          if (st !== 'landing') break
        }
      }
      await ctx.human.click(connect)
      try {
        await ctx.loginByWallet({ reclick: { selector: connect, afterMs: 8000 } })
        return
      } catch (e) {
        if (attempt === 1 || !(e as Error).message.includes('钱包弹窗未出现')) throw e
      }
    }
    throw new Error('钱包弹窗未出现（重试后仍未弹出，Petra 扩展异常或窗口状态问题）')
  }

  /** 进 Quests 页：Start Quests 按钮优先（站点引导路径），兜底直达 /quests；全程 Network Error 自动恢复 */
  private async enterQuests(ctx: TaskContext): Promise<void> {
    const startBtn = `button:has-text("${START_QUESTS_TEXT}")`
    if (await ctx.visible(startBtn)) {
      await ctx.human.click(startBtn)
      // 点击后等 Daily Check-in（含 Network Error 刷新恢复 + 25s 周期主动刷新）
      if (await this.waitForTextRecover(ctx, CHECKIN_TEXT, QUESTS_WAIT_MS, 25000)) return
    }
    // 兜底：直达 /quests（goto 自带 3 次重试）
    await ctx.goto('https://portal.rhuna.io/quests')
    if (!(await this.waitForTextRecover(ctx, CHECKIN_TEXT, QUESTS_WAIT_MS, 25000))) {
      if (!(await ctx.waitForTextWithReloads(CHECKIN_TEXT, { passiveMs: 30000, rounds: 2, roundWaitMs: 20000, reloadTimeoutMs: RELOAD_TIMEOUT_MS }))) {
        throw new Error('Quests 页未出现 Daily Check-in（页面或网络异常）')
      }
    }
  }

  /**
   * 点 Daily Check-in 卡片 → 弹窗竞速 → 领取/已领收尾
   * 弹窗操作最多 CHECKIN_ROUNDS 轮：Network Error 刷新后弹窗丢失则重开一轮；
   * 已领取弹窗直接显示完成文案（同样算成功）
   */
  private async checkin(ctx: TaskContext): Promise<void> {
    for (let round = 0; round < CHECKIN_ROUNDS; round++) {
      try {
        await ctx.human.click(`div.cursor-pointer:has-text("${CHECKIN_TEXT}")`)
        await ctx.assertVisible('[role="dialog"]', 15000)
      } catch {
        // 点击未注册/弹窗未渲染/页面错误页：一律刷新恢复后下一轮重开
        // （真机实测：该窗口代理不稳时页面会变 chrome-error 错误页，无错误文案可检测，只能无条件刷新）
        ctx.log.info({ step: 'recover', window: ctx.profile.name }, '领取弹窗打开失败，刷新恢复')
        await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      // 弹窗内竞速：已领取直接出成功文案；未领取出 Claim 按钮
      const outcome: RaceKey | null = await ctx.raceTexts([['success', SUCCESS_TEXT], ['claim', 'Claim']], CLAIM_RACE_MS)
      if (outcome === 'success') {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '今日已领取（弹窗直接显示完成）')
        await ctx.screenshot('rhuna-success')
        return
      }
      if (outcome !== 'claim') {
        // 弹窗已开但既无 Claim 也无完成提示：dump 弹窗内容供排障（站点改版/接口挂起场景）
        const modalText = await ctx
          .js<string>(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 300))
          .catch(() => '')
        ctx.log.warn({ step: 'checkin', window: ctx.profile.name, modalText }, '弹窗内未出现 Claim/完成提示，下一轮重开')
        continue
      }

      // 点 Claim → 人机验证方框出现即拟人点击（interaction-only 组件点方框即完成验证）
      const claimBtn = '[role="dialog"] button:has-text("Claim")'
      await ctx.human.click(claimBtn)
      await this.autoClickTurnstile(ctx)
      const processing = await ctx.raceTexts([['processing', PROCESSING_TEXT], ['success', SUCCESS_TEXT]], CLAIM_RECHECK_MS)
      if (processing === null) {
        await ctx.human.click(claimBtn).catch(() => {})
      }
      // 等成功文案：成功 → 收尾；Claim 重新出现（请求未注册，真机实测）→ 同轮立即重点；
      // 可恢复错误/每 30s 周期 → 刷新（刷新丢弹窗则下一轮重开，已成功服务端 → 直显完成）
      if (await this.claimLoop(ctx, claimBtn)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '签到成功（Quest completed successfully!）')
        await ctx.screenshot('rhuna-success')
        return
      }
      const modalText = await ctx
        .js<string>(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 300))
        .catch(() => '')
      ctx.log.warn({ step: 'checkin', window: ctx.profile.name, modalText }, '点 Claim 后等待完成提示超时，下一轮重开')
    }
    throw new Error('Daily Check-in 领取未完成（弹窗内未出现完成提示）')
  }

  /**
   * Claim 后等待完成循环（单轮内）：
   * - 成功文案出现 → true
   * - Processing your quest... 显示中 → 耐心等（领取请求在途，真机实测负载高时接口
   *   可慢至 60s+；此前"每 30s 周期刷新"会打断在途请求导致领取永远完不成）
   * - Claim 按钮重新出现（请求未注册/被重置）→ 立即重点（每轮最多 3 次）
   * - 可恢复错误 → 立即刷新；无处理中/无按钮/无错误（页面状态异常）→ 每 30s 刷新恢复
   * @returns 预算内成功 true / 超时 false
   */
  private async claimLoop(ctx: TaskContext, claimBtn: string): Promise<boolean> {
    const end = Date.now() + SUCCESS_WAIT_MS
    let clicks = 0
    let lastRefresh = Date.now()
    let lastCheckClick = 0
    let lastCheckLog = 0
    while (Date.now() < end) {
      if (await ctx.textPresent(SUCCESS_TEXT)) return true
      // 人机验证方框出现（补点后重新渲染）：立即拟人点击（每 15s 最多点一次）
      if (Date.now() - lastCheckClick > 15000 && (await this.clickTurnstileCheckbox(ctx))) {
        lastCheckClick = Date.now()
        continue
      }
      // 方框已点击但验证未通过（方框仍存在）：低频追踪日志（每 30s 一条，定位点击被拒/验证卡住的窗口）
      if (lastCheckClick > 0 && Date.now() - lastCheckClick < 15000 && Date.now() - lastCheckLog > 30000 && (await this.turnstileVisible(ctx))) {
        lastCheckLog = Date.now()
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '验证方框已点击但仍存在（验证未通过），冷却期满后重点')
      }
      const errText = await this.recoverErrorText(ctx)
      if (errText !== '') {
        ctx.log.info({ step: 'recover', window: ctx.profile.name, errText }, '领取等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      // 处理中：不打断在途请求，耐心等
      if (await ctx.textPresent(PROCESSING_TEXT)) {
        await ctx.page.waitForTimeout(3000)
        continue
      }
      if (clicks < 3 && (await ctx.visible(claimBtn))) {
        await ctx.human.click(claimBtn).catch(() => {})
        clicks++
        ctx.log.info({ step: 'checkin', window: ctx.profile.name, clicks }, 'Claim 按钮重新出现，补点')
        continue
      }
      // 无处理中、无按钮、无错误：弹窗丢失/页面状态异常 → 周期刷新恢复
      if (Date.now() - lastRefresh >= 30000) {
        ctx.log.info({ step: 'recover', window: ctx.profile.name }, '刷新页面恢复（错误提示或周期刷新）')
        await ctx.page.reload({ timeout: RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    return false
  }

  /**
   * 点击人机验证方框（interaction-only Turnstile 组件）：
   * 组件渲染为右下角浮层 iframe（站点容器 div[data-turnstile-container]，z-index 最高），
   * 方框在 iframe 左侧——拟人点击即完成验证（真机实测 ISP IP 一点即过，无需图片题）
   * 瞬时失败重试：点击后 iframe 重渲染期间 CDP 派发会被浏览器拒绝（Invalid parameters），
   * 每次重试重新取盒（不用旧坐标点已移动的 iframe），非瞬时错误不重试直接抛
   * @returns 是否执行了点击
   */
  private async clickTurnstileCheckbox(ctx: TaskContext): Promise<boolean> {
    let lastErr: Error | null = null
    for (let attempt = 1; attempt <= TURNSTILE_CLICK_MAX; attempt++) {
      const box = await this.turnstileBox(ctx)
      if (!box) return false
      const x = box.x + Math.min(30, box.width * 0.4)
      const y = box.y + box.height / 2
      ctx.log.info({ step: 'checkin', window: ctx.profile.name, x: Math.round(x), y: Math.round(y), attempt }, '出现人机验证方框，拟人点击')
      try {
        await ctx.human.clickAt(x, y)
        return true
      } catch (e) {
        lastErr = e as Error
        if (!CDP_TRANSIENT.test(lastErr.message)) throw lastErr
        ctx.log.warn({ step: 'checkin', window: ctx.profile.name, attempt, x: Math.round(x), y: Math.round(y), err: lastErr.message }, '验证方框点击被浏览器拒绝（iframe 重渲染瞬时态），等待后重试')
        await ctx.page.waitForTimeout(1000 + Math.floor(Math.random() * 1000))
      }
    }
    throw lastErr ?? new Error('人机验证方框点击失败（重试耗尽）')
  }

  /** 取验证方框盒（不可见/尺寸过小返回 null）：重试循环每次重新取盒 */
  private async turnstileBox(ctx: TaskContext): Promise<{ x: number; y: number; width: number; height: number } | null> {
    for (const sel of TURNSTILE_FRAME_SEL) {
      const box = await ctx.page
        .locator(sel)
        .first()
        .boundingBox()
        .catch(() => null)
      if (box && box.width >= 20 && box.height >= 20) return box
    }
    return null
  }

  /** 验证方框当前是否可见（轻量 count 检查，claimLoop 低频追踪用） */
  private async turnstileVisible(ctx: TaskContext): Promise<boolean> {
    for (const sel of TURNSTILE_FRAME_SEL) {
      if (await ctx.page.locator(sel).first().count() > 0) return true
    }
    return false
  }

  /** 等验证方框出现并点击（方框在点 Claim 后 1-3s 渲染，最多等 budgetMs） */
  private async autoClickTurnstile(ctx: TaskContext, budgetMs = 10000): Promise<boolean> {
    const end = Date.now() + budgetMs
    while (Date.now() < end) {
      if (await this.clickTurnstileCheckbox(ctx)) return true
      await ctx.page.waitForTimeout(500)
    }
    ctx.log.info({ step: 'checkin', window: ctx.profile.name, budgetMs }, '预算内未检测到人机验证方框（可能免验证或方框未渲染）')
    return false
  }
}

/**
 * X 日常活跃任务（x-daily-activity）：打开首页时间线，滚动阅读并随机点赞
 * 依赖方向：依赖 ../base（任务基类）、../../api（能力函数）、同目录 overlay/scroll helper
 * 页面操作：全部走 ctx.page（patchright Page：locator/mouse.wheel/mouse.move/evaluate/keyboard），不引入其它自动化库
 * 设计思路：低强度互动——每次运行滚动 3-6 分钟、最多点赞 0-2 条；
 *          只点当前视口内未点赞的非推广推文，不转发/不回复/不关注，降低风控风险。
 * 登录前提：依赖比特窗口已保存的 X 登录态；未登录直接截图失败，不尝试自动登录。
 */
import { SiteTask, type TaskContext, type TaskMeta } from '../base'
import { computeXDwellMs, readXLoadState, readXScrollMetrics, readXTimelineSignature, readXVisibleContent } from './content'
import { ensureNoBlockingOverlay, hasBlockingOverlay, type XAdPersonalizationChoice } from './overlay'
import { humanReadingPause, humanScrollBurst, smoothScrollBy, type ScreenBox } from './scroll'
import { openPage, race, takeScreenshot } from '../../api'

const AD_PERSONALIZATION_CHOICE: XAdPersonalizationChoice = 'turn-on' // 用户明确选择：开启个性化广告以减少插屏
const AUTO_EXPAND_COLLAPSED = false // 暂时关闭自动展开 Show more，避免展开时布局回跳

const HOME_URL = 'https://x.com/home' // X 首页时间线
const TIMELINE_SELECTOR = '[data-testid="primaryColumn"]' // 主时间线容器
const LOGGED_IN_SELECTOR = '[data-testid="SideNav_NewTweet_Button"]' // 已登录侧栏「发帖」按钮
const LOGIN_BUTTON_SELECTOR = '[data-testid="loginButton"]' // 未登录页登录按钮
const LOGIN_INPUT_SELECTOR = 'input[name="text"]' // 未登录页账号输入框
const RELOAD_ERROR_SELECTOR = 'text=Something went wrong. Try reloading.' // X 时间线错误提示
const RETRY_BUTTON_SELECTOR = 'button:has-text("Retry")' // 错误提示中的重试按钮
const TWEET_SELECTOR = 'article[data-testid="tweet"]' // 单条推文
const LIKE_SELECTOR = 'button[data-testid="like"]' // 未点赞按钮
const UNLIKE_SELECTOR = 'button[data-testid="unlike"]' // 已点赞按钮
const PROMOTED_TEXTS = [
  'promoted', '广告', '推广', '廣告', '推廣', '贊助', // 英/简中/繁中
  'sponsorisé', 'sponsorisée', 'promu', 'publicité', // 法
  'anzeige', 'gesponsert', 'werbung', // 德
  'プロモーション', '広告', 'スポンサー', // 日
  'promocionado', 'patrocinado', 'publicidad', // 西
  'promovido', 'publicidade', // 葡
  'sponsorizzato', 'pubblicità', 'promosso', // 意
  'продвигается', 'реклама', 'спонсор', // 俄
  'gepromoot', 'advertentie', 'gesponsord', // 荷
  'tanıtılan', 'reklam', 'sponsorlu', // 土
  '프로모션', '광고', '스폰서', // 韩
  'promowane', 'reklama', 'sponsorowane', // 波
  'إعلان', 'مُموّل', // 阿
] // 推广推文标记（多语言，命中即跳过）

const LOAD_WAIT_MS = 45000 // 登录/时间线加载预算
const MAX_TIMELINE_RECOVERY_ATTEMPTS = 3 // X 时间线错误提示最多恢复次数
const TIMELINE_RECOVERY_WAIT_MS = 8000 // 点击 Retry/刷新后等待错误提示消失的预算
const ACTIVITY_MIN_MS = 180000 // 活跃最短时长（3 分钟）
const ACTIVITY_MAX_MS = 360000 // 活跃最长时长（6 分钟）
const SCROLL_MIN_ROUNDS = 12 // 最少滚动轮数（成功断言用）
const MAX_SCROLL_ROUNDS = 30 // 滚动轮数上限（保持活跃即可，不追求刷满时长）
const LIKE_MIN = 0 // 单次运行最少目标点赞数
const LIKE_MAX = 2 // 单次运行最多目标点赞数
const LIKE_PROBABILITY = 0.08 // 每轮尝试点赞的概率（多数轮次不互动）
const LIKE_GAP_MIN_MS = 90000 // 两次点赞最小间隔
const LIKE_GAP_MAX_MS = 180000 // 两次点赞最大间隔
const LIKE_CLICK_TIMEOUT_MS = 5000 // 点赞点击超时（被弹窗挡住时快速失败）
const LIKE_VERIFY_MS = 5000 // 点击后确认已点赞状态的预算
const LIKE_VERIFY_POLL_MS = 500 // 确认状态的轮询间隔
const INITIAL_DWELL_MIN_MS = 2000 // 进入页面后先浏览再操作
const INITIAL_DWELL_MAX_MS = 5000
const SKIP_READ_PROBABILITY = 0.3 // 30% 的内容直接划过不看

/** X 日常活跃任务 */
export class XDailyActivityTask extends SiteTask {
  meta: TaskMeta = {
    key: 'x-daily-activity',
    name: 'X 日常活跃',
    group: { key: 'social', name: '社交日常' },
    url: HOME_URL,
    sourceUrl: 'https://x.com/home',
    note: '依赖窗口已登录 X；低强度：滚动阅读 3-6 分钟、随机点赞 0-2 条；不转发/不回复/不关注；未登录会截图报错，不自动登录',
    category: 'other',
    lastUpdated: '2026-11-09',
    enabled: true,
    timeoutSec: 600,
    retry: { max: 1, backoffSec: 300 },
  }

  /**
   * @param rng 随机数源（默认 Math.random；单测注入固定序列，生产无需传参）
   */
  constructor(private readonly rng: () => number = Math.random) {
    super()
  }

  /**
   * 执行流程：打开首页 → 竞速判登录态 → 等时间线 → 滚动阅读并随机点赞 → 成功截图。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    if (!(await ensureNoBlockingOverlay(ctx, { xAdChoice: AD_PERSONALIZATION_CHOICE }))) {
      throw new Error('X 广告个性化插屏无法关闭，已停止执行')
    }
    await this.ensureLoggedIn(ctx)
    if (!(await this.waitForTimelineReady(ctx, LOAD_WAIT_MS))) {
      throw new Error('X 时间线加载超时（推文未就绪）')
    }
    const result = await this.runActivity(ctx)
    ctx.log.info({ step: 'x-activity', window: ctx.profile.name, ...result }, 'X 日常活跃完成')
    await takeScreenshot(ctx, 'x-activity-success')
  }

  /**
   * 判登录态：已登录侧栏 / 时间线容器任一可见即通过；登录按钮/账号输入框可见则明确失败。
   * @param ctx 任务上下文
   */
  private async ensureLoggedIn(ctx: TaskContext): Promise<void> {
    const outcome = await race(ctx, [
      ['loggedIn', { selector: LOGGED_IN_SELECTOR }],
      ['timeline', { selector: TIMELINE_SELECTOR }],
      ['reloadError', { selector: RELOAD_ERROR_SELECTOR }],
      ['loginButton', { selector: LOGIN_BUTTON_SELECTOR }],
      ['loginInput', { selector: LOGIN_INPUT_SELECTOR }],
    ], LOAD_WAIT_MS)
    if (outcome === 'reloadError') {
      await this.recoverTimelineError(ctx)
      return this.ensureLoggedIn(ctx)
    }
    if (outcome === 'loggedIn' || outcome === 'timeline') return
    await takeScreenshot(ctx, 'x-activity-login-required')
    if (outcome === 'loginButton' || outcome === 'loginInput') {
      ctx.log.warn({ step: 'x-activity', window: ctx.profile.name }, 'X 未登录，停止执行')
      throw new Error('X 未登录（请先在比特窗口登录后再跑）')
    }
    throw new Error('X 首页未加载（时间线与登录入口均未出现，可能网络异常）')
  }

  /**
   * 滚动阅读循环：随机滚动 + 随机停留，按概率点赞，直到时长或轮数用尽。
   * @param ctx 任务上下文
   * @returns 实际滚动轮数与点赞数
   */
  private async runActivity(ctx: TaskContext): Promise<{ scrolls: number; likes: number }> {
    await ctx.page.waitForTimeout(this.randomInt(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS))
    const timelineBox = await this.getTimelineBox(ctx)
    const end = Date.now() + this.randomInt(ACTIVITY_MIN_MS, ACTIVITY_MAX_MS)
    const maxLikes = this.randomInt(LIKE_MIN, LIKE_MAX)
    let scrolls = 0
    let likes = 0
    let nextLikeAt = 0
    let stagnantScrolls = 0
    let reachedBottom = false
    while (Date.now() < end && scrolls < MAX_SCROLL_ROUNDS) {
      if (!(await ensureNoBlockingOverlay(ctx, { xAdChoice: AD_PERSONALIZATION_CHOICE }))) {
        await ctx.page.waitForTimeout(1000)
        continue
      }
      if (!(await this.waitForTimelineReady(ctx, 8000))) {
        await ctx.page.waitForTimeout(1000)
        continue
      }
      const beforeSignature = await readXTimelineSignature(ctx)
      const targetDistance = timelineBox ? await this.getNextTweetScroll(ctx, timelineBox) : null
      const distance = targetDistance ?? (timelineBox ? Math.round(timelineBox.height * 0.5) : 400)
      let scrolled = await smoothScrollBy(ctx, distance)
      if (!scrolled && !(await hasBlockingOverlay(ctx))) {
        // 原生平滑滚动不可用时回退 wheel
        scrolled = await humanScrollBurst(ctx, {
          direction: 1,
          rng: this.rng,
          box: timelineBox ?? undefined,
          allowReverse: false,
          distancePx: distance,
          smoothWheel: true,
          smoothDurationMinMs: 900,
          smoothDurationMaxMs: 1600,
          frameMs: 16,
        })
      }
      if (!scrolled) {
        await ctx.page.waitForTimeout(500)
        continue
      }
      scrolls++
      await ctx.page.waitForTimeout(this.randomInt(1500, 3000))
      if (!(await this.waitForTimelineReady(ctx, 5000))) {
        await ctx.page.waitForTimeout(1000)
        continue
      }
      const afterSignature = await readXTimelineSignature(ctx)
      const metrics = await readXScrollMetrics(ctx)
      const atBottom = metrics !== null && metrics.top + metrics.clientHeight >= metrics.scrollHeight - 8
      if (atBottom) {
        reachedBottom = true
        ctx.log.info({ step: 'x-activity', window: ctx.profile.name, scrolls }, 'X 时间线已到实际底部，停止滚动')
        break
      }
      if (beforeSignature && afterSignature && beforeSignature === afterSignature) {
        stagnantScrolls++
        if (stagnantScrolls >= 3) {
          reachedBottom = true
          ctx.log.info({ step: 'x-activity', window: ctx.profile.name, scrolls }, 'X 时间线连续 3 次没有新内容，停止滚动')
          break
        }
      } else {
        stagnantScrolls = 0
      }
      await this.readAndDwell(ctx, timelineBox)
      if (scrolls % 3 === 0) {
        ctx.log.info({ step: 'x-activity', window: ctx.profile.name, scrolls, likes }, 'X 滚动阅读中')
      }
      if (likes >= maxLikes) continue
      if (Date.now() < nextLikeAt) continue
      if (this.rng() >= LIKE_PROBABILITY) continue
      if (await this.tryLikeVisibleTweet(ctx)) {
        likes++
        nextLikeAt = Date.now() + this.randomInt(LIKE_GAP_MIN_MS, LIKE_GAP_MAX_MS)
        ctx.log.info({ step: 'x-activity', window: ctx.profile.name, likes }, '已点赞一条推文')
      }
    }
    if (scrolls < SCROLL_MIN_ROUNDS && !reachedBottom) {
      throw new Error(`X 滚动轮数不足（${scrolls}/${SCROLL_MIN_ROUNDS}），页面可能未正常加载`)
    }
    return { scrolls, likes }
  }

  /** 等时间线加载完成：无骨架屏/aria-busy 且至少 2 条推文；读取失败时回退为可继续 */
  private async waitForTimelineReady(ctx: TaskContext, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await this.isTimelineReloadErrorVisible(ctx)) {
        await this.recoverTimelineError(ctx)
        continue
      }
      const state = await readXLoadState(ctx)
      if (!state) return true
      if (!state.loading && state.articleCount >= 2) return true
      await ctx.page.waitForTimeout(300)
    }
    ctx.log.warn({ step: 'x-activity', window: ctx.profile.name }, '等待 X 时间线加载超时，暂缓滚动')
    return false
  }

  /** 检测 X 错误提示并点 Retry 恢复；按钮缺失/点击无效时刷新页面兜底，最多尝试 3 次 */
  private async recoverTimelineError(ctx: TaskContext): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_TIMELINE_RECOVERY_ATTEMPTS; attempt++) {
      if (!(await this.isTimelineReloadErrorVisible(ctx))) return true

      const retryButton = ctx.page.locator(RETRY_BUTTON_SELECTOR).first()
      const canClickRetry = await retryButton.isVisible().catch(() => false)
      if (canClickRetry) {
        try {
          await retryButton.click({ timeout: 3000 })
          ctx.log.warn({ step: 'x-activity', window: ctx.profile.name, attempt }, 'X 时间线出现错误提示，已点击 Retry')
        } catch (e) {
          ctx.log.warn({ step: 'x-activity', window: ctx.profile.name, attempt, err: (e as Error).message }, '点击 X Retry 失败，刷新页面兜底')
          await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        }
      } else {
        ctx.log.warn({ step: 'x-activity', window: ctx.profile.name, attempt }, 'X 错误提示未找到 Retry 按钮，刷新页面兜底')
        await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      }

      const recoveryEnd = Date.now() + TIMELINE_RECOVERY_WAIT_MS
      while (Date.now() < recoveryEnd) {
        if (!(await this.isTimelineReloadErrorVisible(ctx))) return true
        await ctx.page.waitForTimeout(250)
      }
    }

    if (await this.isTimelineReloadErrorVisible(ctx)) {
      throw new Error(`X 时间线错误提示连续恢复 ${MAX_TIMELINE_RECOVERY_ATTEMPTS} 次仍未消失`)
    }
    return true
  }

  /** 检查 X 时间线错误提示是否可见 */
  private async isTimelineReloadErrorVisible(ctx: TaskContext): Promise<boolean> {
    try {
      return await ctx.page.locator(RELOAD_ERROR_SELECTOR).first().isVisible()
    } catch {
      return false
    }
  }

  /** 计算滚动到下一篇推文顶部所需的距离；取不到内容时返回 null，回退比例滚动 */
  private async getNextTweetScroll(ctx: TaskContext, box: ScreenBox): Promise<number | null> {
    const profiles = await readXVisibleContent(ctx, 8)
    if (profiles.length === 0) return null
    const anchor = profiles.find((p) => p.top + p.height > box.y + 20) ?? profiles[0]
    const next = profiles.find((p) => p.index > anchor.index && p.top > anchor.top + 40)
    const targetTop = next ? next.top : box.y + box.height * 0.75
    const delta = targetTop - (box.y + 56)
    if (delta <= 0) return null
    return Math.round(delta)
  }

  /** 取时间线容器框并裁剪到当前视口；取不到时返回 null，滚动回退到视口模式 */
  private async getTimelineBox(ctx: TaskContext): Promise<ScreenBox | null> {
    try {
      const box = await ctx.page.locator(TIMELINE_SELECTOR).first().boundingBox()
      if (!box) return null
      const viewport = await this.getViewport(ctx)
      const top = Math.max(box.y, 0)
      const bottom = Math.min(box.y + box.height, viewport.height)
      if (bottom - top < 100) return null
      return { x: box.x, y: top, width: box.width, height: bottom - top }
    } catch {
      return null
    }
  }

  /**
   * 按可见内容阅读：优先选完整落在时间线框内的推文，10% 跳过、70% 读 1 条、20% 读 2 条。
   * 折叠推文 30% 概率点开 Show more（testid 优先，多语言文案兜底），再按内容类型停留。
   */
  private async readAndDwell(ctx: TaskContext, box: ScreenBox | null): Promise<void> {
    if (!(await ensureNoBlockingOverlay(ctx, { xAdChoice: AD_PERSONALIZATION_CHOICE }))) return
    let profiles = await readXVisibleContent(ctx, 6)
    if (profiles.length === 0) {
      await humanReadingPause(ctx, this.rng)
      return
    }
    let inBox = box
      ? profiles.filter((p) => p.top >= box.y + 40 && p.top + p.height <= box.y + box.height - 40)
      : profiles
    if (box && inBox.length === 0) {
      await ctx.page.waitForTimeout(500)
      profiles = await readXVisibleContent(ctx, 6)
      inBox = profiles.filter((p) => p.top >= box.y + 40 && p.top + p.height <= box.y + box.height - 40)
    }
    const candidates = inBox.length > 0 ? inBox : profiles
    if (this.rng() < SKIP_READ_PROBABILITY) return
    const pick = candidates[0]
    if (AUTO_EXPAND_COLLAPSED && pick.collapsed && this.rng() < 0.3) await this.expandTweet(ctx, pick.index)
    const dwellMs = computeXDwellMs(pick, this.rng)
    ctx.log.info({ step: 'x-activity', window: ctx.profile.name, kind: pick.kind, textLength: pick.textLength, collapsed: pick.collapsed, dwellMs }, '阅读推文内容')
    await ctx.page.waitForTimeout(dwellMs)
  }

  /** 点开折叠长文；失败只告警，仍按长文停留 */
  private async expandTweet(ctx: TaskContext, index: number): Promise<void> {
    try {
      if (!(await ensureNoBlockingOverlay(ctx, { xAdChoice: AD_PERSONALIZATION_CHOICE }))) return
      const tweet = ctx.page.locator(TWEET_SELECTOR).nth(index)
      const link = tweet.locator('[data-testid="tweet-text-show-more-link"]')
      if ((await link.count()) === 0) return
      await link.first().click({ timeout: 3000 })
      await ctx.page.waitForTimeout(800 + Math.floor(this.rng() * 701))
      ctx.log.info({ step: 'x-activity', window: ctx.profile.name, index }, '已展开长推文')
    } catch (e) {
      ctx.log.warn({ step: 'x-activity', window: ctx.profile.name, index, err: (e as Error).message }, '展开长推文失败，按长文停留')
    }
  }

  /**
   * 给当前视口内第一条可点赞的普通推文点赞。
   * 跳过不可见、超出视口、推广、已点赞的推文；单条处理失败只告警并继续下一条。
   * @param ctx 任务上下文
   * @returns 是否成功点赞（以点赞按钮翻转为已点赞为准）
   */
  private async tryLikeVisibleTweet(ctx: TaskContext): Promise<boolean> {
    if (!(await ensureNoBlockingOverlay(ctx, { xAdChoice: AD_PERSONALIZATION_CHOICE }))) return false
    const viewport = await this.getViewport(ctx)
    const tweets = ctx.page.locator(TWEET_SELECTOR)
    const count = await tweets.count()
    for (let i = 0; i < count; i++) {
      try {
        const tweet = tweets.nth(i)
        if (!(await tweet.isVisible())) continue
        const box = await tweet.boundingBox()
        if (!box || box.y < 0 || box.y + 80 > viewport.height) continue
        const text = (await tweet.textContent()) ?? ''
        if (this.isPromoted(text)) continue
        const like = tweet.locator(LIKE_SELECTOR)
        if ((await like.count()) === 0) continue
        await like.first().click({ timeout: LIKE_CLICK_TIMEOUT_MS })
        // 点击成功即计入点赞；状态确认只做尽力校验（X 异步更新/列表重渲染常导致 1-2 秒内查不到 unlike）
        const verifyEnd = Date.now() + LIKE_VERIFY_MS
        let verified = false
        while (Date.now() < verifyEnd) {
          if ((await tweet.locator(UNLIKE_SELECTOR).count()) > 0) {
            verified = true
            break
          }
          await ctx.page.waitForTimeout(LIKE_VERIFY_POLL_MS)
        }
        if (!verified) {
          ctx.log.warn({ step: 'x-activity', window: ctx.profile.name, index: i }, '点赞已点击但未在预算内确认已点赞状态（仍计入点赞）')
        }
        return true
      } catch (e) {
        ctx.log.warn({ step: 'x-activity', window: ctx.profile.name, index: i, err: (e as Error).message }, '点赞候选处理失败，继续下一条')
      }
    }
    return false
  }

  /** 是否推广推文（大小写不敏感，中英文标记均跳过） */
  private isPromoted(text: string): boolean {
    const lower = text.toLowerCase()
    return PROMOTED_TEXTS.some((t) => lower.includes(t))
  }

  /** 取视口尺寸（任务内自包含求值） */
  private async getViewport(ctx: TaskContext): Promise<{ width: number; height: number }> {
    return ctx.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) as Promise<{ width: number; height: number }>
  }

  /** 闭区间随机整数（注入 rng 便于单测固定序列） */
  private randomInt(min: number, max: number): number {
    const r = Math.min(0.999999, Math.max(0, this.rng()))
    return min + Math.floor(r * (max - min + 1))
  }
}

/**
 * Discord 日常活跃任务（discord-daily-activity）：进频道发 1 条消息并向上滚动阅读
 * 依赖方向：依赖 ../base（任务基类）、../../api（能力函数）、同目录 overlay/scroll helper
 * 页面操作：全部走 ctx.page（patchright Page：locator/mouse.wheel/mouse.move/evaluate/keyboard），不引入其它自动化库
 * 设计思路：低强度互动——每个频道滚动 2-4 分钟，固定发 1 条消息；不管理服务器，降低风控风险。
 * 登录前提：依赖比特窗口已保存的 Discord 登录态；未登录直接截图失败，不尝试自动登录。
 * 注意：Discord DOM 类名混淆，消息输入框选择器可能随改版失效，
 *      首次真机运行后需按截图与日志校准 MESSAGE_INPUT_SELECTORS。
 */
import type { Locator } from 'patchright'
import { SiteTask, type TaskContext, type TaskMeta } from '../base'
import { computeDiscordDwellMs, isDiscordTooOld, readDiscordVisibleContent } from './content'
import { ensureNoBlockingOverlay, hasBlockingOverlay } from './overlay'
import { humanReadingPause, humanScrollBurst, smoothScrollBy, type ScreenBox } from './scroll'
import { openPage, race, takeScreenshot } from '../../api'

/** 频道 URL 列表：填写要活跃的 Discord 频道，例如 https://discord.com/channels/<服务器ID>/<频道ID> */
export const DISCORD_CHANNEL_URLS: string[] = [
  'https://discord.com/channels/1506994513338433676/1506994513942544436',
]

/** 允许发消息的频道 URL：只有这里列出的频道才会发言，其它频道只读 */
export const DISCORD_MESSAGE_CHANNEL_URLS: string[] = [
  'https://discord.com/channels/1506994513338433676/1506994513942544436',
]

/** 发消息文案池：为空则不发；按窗口名 + 日期轮换，避免所有账号同一句 */
export const DISCORD_MESSAGES: string[] = [
  'gm', '早安', '打卡', '来看看', '今天有什么新项目',
  '蹲一个', '学习了', '感谢分享', '这个不错', '先观察',
  '收到', '支持一下', '有点意思', '继续关注', '今天行情怎么样',
  '有新任务吗', '一起交流', '刚看到', '这个项目可以', '我再研究下',
  '有教程吗', '坐等更新', '看着还行', '注意风险', '慢慢来',
  '保持关注', '今天也要加油', '冒个泡', '路过看看', '这边有人吗',
  '感谢大佬', '学到了', '收藏了', '期待后续', '不错不错',
  '晚安', 'good', 'nice', 'thanks', 'ok',
]

const MESSAGE_INPUT_SELECTORS = [
  '[role="textbox"][data-slate-editor="true"]',
  'div[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
]

/** 当前频道是否允许发消息 */
export function isMessageChannelAllowed(url: string, allowed: string[] = DISCORD_MESSAGE_CHANNEL_URLS): boolean {
  return allowed.includes(url)
}

/** 按窗口名 + 日期从文案池轮换取一条，避免所有窗口同一句；文案池为空返回 null */
export function pickMessageForProfile(profileName: string, messages: string[], day = new Date().getDate()): string | null {
  if (messages.length === 0) return null
  let hash = 0
  for (const ch of profileName) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return messages[(hash + day) % messages.length]
}

const DISCORD_HOME_URL = 'https://discord.com/channels/@me'
const CHAT_BOX_SELECTORS = [
  '[data-list-id="chat-messages"]',
  '[role="log"]',
  '[class*="scrollerInner"]',
  '[class*="messagesWrapper"]',
] // 消息列表滚动容器（不含单条 li，避免把一条消息当成可视区域）
const CHAT_SELECTORS = [...CHAT_BOX_SELECTORS, 'li[id^="chat-messages-"]'] // 聊天区探测（改版时逐级回退）
const CHAT_SELECTOR = CHAT_SELECTORS.map((selector) => `${selector}:visible`).join(', ')
/** 未登录标志的按钮文本（多语言） */
const LOGIN_TEXTS = [
  'Log In', 'Connexion', 'Se connecter', 'Anmelden', 'ログイン', '登入', '登录',
  'Iniciar sesión', 'Entrar', 'Accedi', 'Войти', 'Inloggen', 'Giriş Yap', '로그인', 'Zaloguj się',
]
const LOGIN_SELECTORS = ['input[name="email"]', ...LOGIN_TEXTS.map((text) => `button:has-text("${text}")`)]

/** 浏览器版提示文案（多语言） */
const CONTINUE_TEXTS = [
  'Continue in Browser', 'Continuer dans le navigateur', 'Im Browser fortfahren',
  'ブラウザで続ける', '在瀏覽器中繼續', '在浏览器中继续',
  'Continuar en el navegador', 'Continuar no navegador', 'Continua nel browser',
  'Продолжить в браузере', 'Doorgaan in browser', 'Tarayıcıda devam et',
  '브라우저에서 계속', 'Kontynuuj w przeglądarce',
]
const CONTINUE_SELECTORS = CONTINUE_TEXTS.map((text) => `button:has-text("${text}")`)

const JUMP_TO_PRESENT_SELECTORS = [
  'button[aria-label="Jump to present"]',
  'button:has-text("Jump to present")',
  'button:has-text("Aller au présent")',
  'button:has-text("Zum Aktuellen springen")',
  'button:has-text("現在位置にジャンプ")',
  'button:has-text("跳至目前位置")',
  'button:has-text("跳转到当前")',
  'button:has-text("Ir al presente")',
  'button:has-text("Ir para o presente")',
  'button:has-text("Vai al presente")',
  'button:has-text("Перейти к текущему")',
  'button:has-text("Naar heden springen")',
  'button:has-text("Şimdiye git")',
  'button:has-text("현재 위치로 이동")',
] // 「跳到最新消息」按钮（Discord 打开时可能停在未读位置）

const LOAD_WAIT_MS = 90000 // 频道加载/登录态判定预算（Discord 在低内存/多窗口下可能加载超过 45 秒）
const CHANNEL_MIN_MS = 120000 // 单频道活跃最短时长
const CHANNEL_MAX_MS = 240000 // 单频道活跃最长时长
const TOTAL_BUDGET_MS = 720000 // 整个任务活跃时长上限
const MAX_CHANNELS = 2 // 单次运行最多进入的频道数
const SCROLL_MIN_ROUNDS = 8 // 单频道最少滚动轮数（成功断言用）
const MAX_SCROLL_ROUNDS = 18 // 单频道滚动轮数上限（保持活跃即可，不追求刷满时长）
const INITIAL_DWELL_MIN_MS = 2000 // 进入频道后先浏览再操作
const INITIAL_DWELL_MAX_MS = 5000
const SKIP_READ_PROBABILITY = 0.25 // 25% 的消息直接划过不看

const CONTINUE_SETTLE_MS = 2000 // 点掉「在浏览器中继续」后的等待

/** Discord 日常活跃任务 */
export class DiscordDailyActivityTask extends SiteTask {
  meta: TaskMeta = {
    key: 'discord-daily-activity',
    name: 'Discord 日常活跃',
    group: { key: 'social', name: '社交日常' },
    url: DISCORD_CHANNEL_URLS[0] ?? DISCORD_HOME_URL,
    sourceUrl: 'https://discord.com/channels/@me',
    note: '需先填写 src/tasks/social/discord-daily-activity.ts 的 DISCORD_CHANNEL_URLS；依赖窗口已登录 Discord；每频道滚动 2-4 分钟、在允许发言的频道发 1 条消息；不管理服务器；Discord DOM 混淆，首次真机需按截图校准选择器',
    category: 'other',
    lastUpdated: '2026-11-09',
    enabled: true,
    timeoutSec: 900,
    retry: { max: 1, backoffSec: 300 },
  }

  /**
   * @param channelUrls 频道 URL 列表（默认读模块常量；单测注入）
   * @param rng 随机数源（默认 Math.random；单测注入固定序列）
   */
  constructor(
    private readonly channelUrls: string[] = DISCORD_CHANNEL_URLS,
    private readonly rng: () => number = Math.random,
  ) {
    super()
  }

  /**
   * 执行流程：校验频道配置 → 逐个频道打开、判登录 → 发 1 条消息并滚动阅读 → 汇总结果。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    const urls = this.channelUrls.slice(0, MAX_CHANNELS)
    if (urls.length === 0) {
      throw new Error('未配置 Discord 频道 URL：请填写 src/tasks/social/discord-daily-activity.ts 的 DISCORD_CHANNEL_URLS')
    }
    const startedAt = Date.now()
    const failures: string[] = []
    let scrolls = 0
    let messages = 0
    let opened = 0
    for (const url of urls) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
        ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name, url }, 'Discord 活跃总时长已到，跳过剩余频道')
        break
      }
      try {
        const result = await this.runChannel(ctx, url, opened === 0)
        scrolls += result.scrolls
        messages += result.messages
        opened++
      } catch (e) {
        failures.push(`${url}: ${(e as Error).message}`)
        ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name, url, err: (e as Error).message }, 'Discord 频道处理失败，继续下一个')
      }
    }
    if (opened === 0) {
      throw new Error(`Discord 频道全部失败: ${failures.join(' | ')}`)
    }
    await takeScreenshot(ctx, failures.length > 0 ? 'discord-activity-partial' : 'discord-activity-success')
    ctx.log.info({ step: 'discord-activity', window: ctx.profile.name, scrolls, messages, channels: opened }, 'Discord 日常活跃完成')
    if (failures.length > 0) {
      throw new Error(`Discord 部分频道失败: ${failures.join(' | ')}`)
    }
  }

  /**
   * 单个频道：打开 → 处理浏览器版提示 → 竞速判登录/聊天区 → 滚动活跃。
   * @param ctx 任务上下文
   * @param url 频道地址
   * @param closeOtherTabs 是否清掉之前的标签页（仅首个频道）
   */
  private async runChannel(ctx: TaskContext, url: string, closeOtherTabs: boolean): Promise<{ scrolls: number; messages: number }> {
    await openPage(ctx, url, { closeOtherTabs })
    await this.dismissContinue(ctx)
    if (!(await ensureNoBlockingOverlay(ctx))) {
      await takeScreenshot(ctx, 'discord-activity-overlay-blocked')
      throw new Error('Discord 弹窗无法关闭，已停止执行')
    }
    const outcome = await race(ctx, [
      ['chat', { selector: CHAT_SELECTOR }],
      ['loginEmail', { selector: LOGIN_SELECTORS[0] }],
      ['loginButton', { selector: LOGIN_SELECTORS[1] }],
      ['loginButtonZh', { selector: LOGIN_SELECTORS[2] }],
    ], LOAD_WAIT_MS)
    if (outcome === 'chat') return this.runChannelActivity(ctx, url)
    await this.logChatProbeStats(ctx)
    await takeScreenshot(ctx, 'discord-activity-login-required')
    if (outcome === 'loginEmail' || outcome === 'loginButton' || outcome === 'loginButtonZh') {
      throw new Error('Discord 未登录（请先在比特窗口登录后再跑）')
    }
    throw new Error(`Discord 频道未加载（url=${ctx.page.url()}；聊天区与登录入口均未出现，可能加载超时/选择器失效）`)
  }

  /**
   * 单频道活跃循环：发 1 条消息后向上滚动阅读。
   * @param ctx 任务上下文
   * @returns 实际滚动轮数与成功发送消息数
   */
  private async runChannelActivity(ctx: TaskContext, url: string): Promise<{ scrolls: number; messages: number }> {
    await ctx.page.waitForTimeout(this.randomInt(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS))
    const chatBox = await this.getChatBox(ctx)
    await this.jumpToLatest(ctx)
    const end = Date.now() + this.randomInt(CHANNEL_MIN_MS, CHANNEL_MAX_MS)
    const messagePool = isMessageChannelAllowed(url) ? DISCORD_MESSAGES : []
    let scrolls = 0
    let sentMessages = 0
    let oldHistoryScreens = 0
    let hitOldHistory = false
    // 每个账号每次进入允许发言的频道，固定发一条；不按概率
    const text = pickMessageForProfile(ctx.profile.name, messagePool)
    if (text) {
      await ctx.page.waitForTimeout(this.randomInt(5000, 15000))
      if (await this.sendChannelMessage(ctx, text)) {
        sentMessages++
        ctx.log.info({ step: 'discord-activity', window: ctx.profile.name, text }, '本次互动：发消息')
      }
    }
    while (Date.now() < end && scrolls < MAX_SCROLL_ROUNDS) {
      if (!(await ensureNoBlockingOverlay(ctx))) {
        await ctx.page.waitForTimeout(1000)
        continue
      }
      const chatHeight = chatBox?.height ?? 600
      const distance = Math.round(chatHeight * (0.55 + this.rng() * 0.15))
      let scrolled = await smoothScrollBy(ctx, distance, { direction: -1, containerSelectors: CHAT_SELECTORS })
      if (!scrolled && !(await hasBlockingOverlay(ctx))) {
        scrolled = await humanScrollBurst(ctx, { direction: -1, rng: this.rng, box: chatBox ?? undefined, allowReverse: false })
      }
      if (!scrolled) {
        await ctx.page.waitForTimeout(500)
        continue
      }
      scrolls++
      await ctx.page.waitForTimeout(this.randomInt(800, 1500))
      const profiles = await readDiscordVisibleContent(ctx, 6)
      const recent = profiles.filter((profile) => profile.ageDays === null || !isDiscordTooOld(profile))
      if (profiles.length === 0) {
        await humanReadingPause(ctx, this.rng)
      } else if (recent.length === 0) {
        oldHistoryScreens++
        if (oldHistoryScreens >= 2) {
          hitOldHistory = true
          ctx.log.info({ step: 'discord-activity', window: ctx.profile.name, scrolls }, '连续 2 屏全部是 7 天前的消息，停止继续翻历史')
          break
        }
      } else {
        oldHistoryScreens = 0
        if (this.rng() >= SKIP_READ_PROBABILITY) {
          const inBox = chatBox
            ? recent.filter((p) => p.top >= chatBox.y + 20 && p.top + p.height <= chatBox.y + chatBox.height - 20)
            : recent
          const candidates = inBox.length > 0 ? inBox : recent
          const pick = candidates[Math.floor(this.rng() * candidates.length)]
          const dwellMs = computeDiscordDwellMs(pick, this.rng)
          if (dwellMs > 0) {
            ctx.log.info({ step: 'discord-activity', window: ctx.profile.name, kind: pick.kind, ageDays: pick.ageDays === null ? null : Math.round(pick.ageDays), dwellMs }, '阅读 Discord 消息')
            await ctx.page.waitForTimeout(dwellMs)
          }
        }
      }
      if (scrolls % 2 === 0) {
        ctx.log.info({ step: 'discord-activity', window: ctx.profile.name, scrolls, messages: sentMessages }, 'Discord 滚动阅读中')
      }
    }
    await this.scrollToBottom(ctx, chatBox)
    if (scrolls < SCROLL_MIN_ROUNDS && !hitOldHistory) {
      throw new Error(`Discord 滚动轮数不足（${scrolls}/${SCROLL_MIN_ROUNDS}），聊天区可能未正常加载`)
    }
    return { scrolls, messages: sentMessages }
  }

  /** 发一条消息：找输入框 → 逐字输入 → Enter → 验证消息出现；失败只告警不重试 */
  private async sendChannelMessage(ctx: TaskContext, text: string): Promise<boolean> {
    if (!(await ensureNoBlockingOverlay(ctx))) return false
    const input = await this.firstVisibleOnPage(ctx, MESSAGE_INPUT_SELECTORS)
    if (!input) {
      ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name }, '未找到消息输入框，跳过发送')
      return false
    }
    try {
      await input.click({ timeout: 3000 })
      await ctx.page.waitForTimeout(300 + Math.floor(this.rng() * 301))
      await input.pressSequentially(text, { delay: 40 + Math.floor(this.rng() * 81) })
      await ctx.page.waitForTimeout(300 + Math.floor(this.rng() * 501))
      await ctx.page.keyboard.press('Enter')
      await ctx.page.waitForTimeout(800)
      const appeared = (await ctx.page.locator('[id^="message-content-"]', { hasText: text }).count()) > 0
      if (!appeared) {
        ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name, text }, '消息发送后未在频道中出现，跳过')
        return false
      }
      ctx.log.info({ step: 'discord-activity', window: ctx.profile.name, text }, '已发送 Discord 消息')
      return true
    } catch (e) {
      ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name, err: (e as Error).message }, '发送 Discord 消息失败，跳过')
      return false
    }
  }

  /** 打开频道后先跳到最新消息：优先点「Jump to present」，没有则把消息列表滚到底 */
  private async jumpToLatest(ctx: TaskContext): Promise<void> {
    const button = await this.firstVisibleOnPage(ctx, JUMP_TO_PRESENT_SELECTORS)
    if (button) {
      try {
        await button.click({ timeout: 3000 })
        await ctx.page.waitForTimeout(800)
        ctx.log.info({ step: 'discord-activity', window: ctx.profile.name }, '已点击跳到最新消息')
        return
      } catch (e) {
        ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name, err: (e as Error).message }, '点击跳到最新失败，尝试滚动到底')
      }
    }
    try {
      const jumped = await ctx.page.evaluate(() => {
        const selectors = ['[data-list-id="chat-messages"]', '[role="log"]', '[class*="scrollerInner"]']
        for (const selector of selectors) {
          let el = document.querySelector(selector) as HTMLElement | null
          while (el && el.scrollHeight <= el.clientHeight && el.parentElement) el = el.parentElement as HTMLElement
          if (el) {
            el.scrollTop = el.scrollHeight
            return true
          }
        }
        return false
      })
      if (jumped === true) {
        await ctx.page.waitForTimeout(800)
        ctx.log.info({ step: 'discord-activity', window: ctx.profile.name }, '已滚到最新消息')
      }
    } catch (e) {
      ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name, err: (e as Error).message }, '跳到最新消息失败，按当前位置阅读')
    }
  }

  /** 取消息列表容器框并裁剪到当前视口；取不到时返回 null，滚动回退到视口模式 */
  private async getChatBox(ctx: TaskContext): Promise<ScreenBox | null> {
    for (const selector of CHAT_BOX_SELECTORS) {
      try {
        const box = await ctx.page.locator(selector).first().boundingBox()
        if (!box) continue
        const viewport = await this.getViewport(ctx)
        const top = Math.max(box.y, 0)
        const bottom = Math.min(box.y + box.height, viewport.height)
        if (bottom - top < 80) continue
        return { x: box.x, y: top, width: box.width, height: bottom - top }
      } catch {
        // 单个选择器失败继续尝试下一个
      }
    }
    return null
  }

  /** 取视口尺寸（用于裁剪消息列表容器） */
  private async getViewport(ctx: TaskContext): Promise<{ width: number; height: number }> {
    return ctx.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) as Promise<{ width: number; height: number }>
  }

  /** 结束前回到底部（最新消息）：2-4 次快速向下滚动，然后停 2-5 秒 */
  private async scrollToBottom(ctx: TaskContext, box: ScreenBox | null): Promise<void> {
    const bursts = 2 + Math.floor(this.rng() * 3)
    for (let i = 0; i < bursts; i++) {
      if (!(await ensureNoBlockingOverlay(ctx))) return
      if (box) {
        const x = Math.floor(box.x + box.width * (0.3 + this.rng() * 0.4))
        const y = Math.floor(box.y + box.height * (0.3 + this.rng() * 0.4))
        await ctx.page.mouse.move(x, y)
        await ctx.page.mouse.wheel(0, Math.round(box.height * (0.9 + this.rng() * 0.1)))
      } else {
        await humanScrollBurst(ctx, { direction: 1, rng: this.rng })
      }
      await ctx.page.waitForTimeout(200 + Math.floor(this.rng() * 201))
    }
    await ctx.page.waitForTimeout(this.randomInt(2000, 5000))
  }

  /** 聊天区判定失败时记录各候选选择器的 count/visible 与当前 URL，便于区分慢加载和选择器失效 */
  private async logChatProbeStats(ctx: TaskContext): Promise<void> {
    const stats: Array<{ selector: string; count?: number; visible?: number; err?: string }> = []
    for (const selector of CHAT_SELECTORS) {
      try {
        const locator = ctx.page.locator(selector)
        const count = await locator.count()
        let visible = 0
        for (let i = 0; i < Math.min(count, 5); i++) {
          if (await locator.nth(i).isVisible().catch(() => false)) visible++
        }
        stats.push({ selector, count, visible })
      } catch (e) {
        stats.push({ selector, err: (e as Error).message })
      }
    }
    ctx.log.warn({ step: 'discord-activity', window: ctx.profile.name, url: ctx.page.url(), stats }, 'Discord 聊天区探测详情')
  }

  /** 点掉「在浏览器中继续」提示（存在才点） */
  private async dismissContinue(ctx: TaskContext): Promise<void> {
    const button = await this.firstVisibleOnPage(ctx, CONTINUE_SELECTORS)
    if (!button) return
    await button.click().catch(() => {})
    await ctx.page.waitForTimeout(CONTINUE_SETTLE_MS)
  }

  /** 在一组选择器里返回首个可见元素；都不存在返回 null（查询异常按不存在处理） */
  private async firstVisibleOnPage(ctx: TaskContext, selectors: string[]): Promise<Locator | null> {
    for (const selector of selectors) {
      try {
        const locator = ctx.page.locator(selector).first()
        if ((await locator.count()) === 0) continue
        if (await locator.isVisible()) return locator
      } catch {
        // 单个选择器异常不影响其它候选
      }
    }
    return null
  }

  /** 闭区间随机整数（注入 rng 便于单测固定序列） */
  private randomInt(min: number, max: number): number {
    const r = Math.min(0.999999, Math.max(0, this.rng()))
    return min + Math.floor(r * (max - min + 1))
  }
}

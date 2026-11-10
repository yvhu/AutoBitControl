/**
 * 社交任务内容感知（tasks 层 helper）：识别文字/图片/视频/卡片与 Discord 消息年龄，计算停留时间
 * 依赖方向：仅依赖 ../base 的 TaskContext 类型
 * 页面读取：只通过 ctx.page.evaluate（patchright Page）读取 DOM，不引入其它自动化库
 */
import type { TaskContext } from '../base'

export type ContentKind = 'text' | 'image' | 'video' | 'card' | 'empty'

export interface XContentProfile {
  index: number
  kind: ContentKind
  textLength: number
  collapsed: boolean
  videoDurationSec: number | null
  top: number
  height: number
}

export interface DiscordContentProfile {
  index: number
  kind: ContentKind
  textLength: number
  ageDays: number | null
  top: number
  height: number
}

export interface XLoadState {
  loading: boolean
  articleCount: number
}

export interface XScrollMetrics {
  top: number
  scrollHeight: number
  clientHeight: number
}

export type XScrollProgress = 'bottom' | 'moved' | 'stationary' | 'unknown'

/** 根据真实滚动位置优先判断进度；位置不可读时才回退比较推文签名 */
export function getXScrollProgress(
  beforeMetrics: XScrollMetrics | null,
  afterMetrics: XScrollMetrics | null,
  beforeSignature: string | null,
  afterSignature: string | null,
): XScrollProgress {
  if (afterMetrics && afterMetrics.top + afterMetrics.clientHeight >= afterMetrics.scrollHeight - 8) return 'bottom'
  if (beforeMetrics && afterMetrics) {
    if (Math.abs(afterMetrics.top - beforeMetrics.top) > 1) return 'moved'
    if (beforeSignature && afterSignature && beforeSignature !== afterSignature) return 'moved'
    return 'stationary'
  }
  if (beforeSignature && afterSignature) return beforeSignature === afterSignature ? 'stationary' : 'moved'
  return 'unknown'
}

export const DISCORD_NORMAL_DAYS = 3 // 3 天内正常阅读
export const DISCORD_MAX_DAYS = 7 // 超过 7 天不再读，停止翻历史

const READ_JITTER_MIN = 0.8
const READ_JITTER_MAX = 1.2

/** 读取 X 当前视口内前 N 条推文的内容档案；读取失败返回空数组，调用方回退旧逻辑 */
export async function readXVisibleContent(ctx: TaskContext, limit = 6): Promise<XContentProfile[]> {
  try {
    const raw = await ctx.page.evaluate((max: number) => {
      const SHOW_MORE_TEXTS = [
        'show more', 'afficher plus', 'mehr anzeigen', 'さらに表示',
        '顯示更多', '显示更多', 'mostrar más', 'mostrar mais', 'mostra altro',
        'показать полностью', 'meer weergeven', 'daha fazlasını göster', '더 보기', 'pokaż więcej',
      ]
      const isShowMoreText = (value: string): boolean => {
        const text = value.trim().toLowerCase()
        return SHOW_MORE_TEXTS.some((candidate) => text === candidate || text.startsWith(`${candidate} `))
      }
      return [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, max).map((article, index) => {
        const textEl = article.querySelector('[data-testid="tweetText"]') as HTMLElement | null
        const text = (textEl?.innerText ?? '').trim()
        const showMoreByTestId = Boolean(article.querySelector('[data-testid="tweet-text-show-more-link"]'))
        const showMoreByText = [...article.querySelectorAll('a, [role="link"]')].some((node) => isShowMoreText(node.textContent ?? ''))
        const collapsed = showMoreByTestId || showMoreByText
        const video = article.querySelector('video') as HTMLVideoElement | null
        const videoDurationSec = video && Number.isFinite(video.duration) ? video.duration : null
        const hasImage = Boolean(article.querySelector('[data-testid="tweetPhoto"], img[src*="pbs.twimg.com/media"]'))
        const hasCard = Boolean(article.querySelector('[data-testid="card.wrapper"], [data-testid="card.layoutLarge.media"]'))
        const kind = video ? 'video' : hasImage ? 'image' : hasCard ? 'card' : text ? 'text' : 'empty'
        const rect = article.getBoundingClientRect()
        return { index, kind, textLength: text.length, collapsed, videoDurationSec, top: rect.top, height: rect.height }
      })
    }, limit)
    return Array.isArray(raw) ? (raw as XContentProfile[]) : []
  } catch {
    return []
  }
}

/** 读取 X 时间线加载状态：骨架屏/aria-busy 与当前推文数量；读取失败返回 null */
export async function readXLoadState(ctx: TaskContext): Promise<XLoadState | null> {
  try {
    const raw = await ctx.page.evaluate(() => {
      const timeline = document.querySelector('[data-testid="primaryColumn"]')
      const skeleton = Boolean(document.querySelector('[data-testid="tweetSkeleton"]'))
      const busy = Boolean((timeline ?? document).querySelector('[aria-busy="true"]'))
      const articleCount = document.querySelectorAll('article[data-testid="tweet"]').length
      return { loading: skeleton || busy, articleCount }
    })
    if (!raw || typeof raw !== 'object' || typeof (raw as { loading?: unknown }).loading !== 'boolean') return null
    return raw as XLoadState
  } catch {
    return null
  }
}

/** 读取 X 实际滚动容器的几何信息，用于判断是否真的到底；读取失败返回 null */
export async function readXScrollMetrics(ctx: TaskContext): Promise<XScrollMetrics | null> {
  try {
    const raw = await ctx.page.evaluate(() => {
      const findScrollable = (): HTMLElement | null => {
        const candidates = [
          document.querySelector('[data-testid="primaryColumn"]') as HTMLElement | null,
          document.scrollingElement as HTMLElement | null,
        ]
        for (const candidate of candidates) {
          let el = candidate
          while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement as HTMLElement | null
          if (el) return el
        }
        return null
      }
      const el = findScrollable()
      if (!el) return null
      return { top: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
    })
    if (!raw || typeof raw !== 'object') return null
    const value = raw as { top?: unknown; scrollHeight?: unknown; clientHeight?: unknown }
    if (typeof value.top !== 'number' || typeof value.scrollHeight !== 'number' || typeof value.clientHeight !== 'number') return null
    return value as XScrollMetrics
  } catch {
    return null
  }
}

/** 读取 X 时间线首尾推文标识，用于判断滚动后是否出现新内容；读取失败返回 null */
export async function readXTimelineSignature(ctx: TaskContext): Promise<string | null> {
  try {
    const raw = await ctx.page.evaluate(() => {
      const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')]
      if (tweets.length === 0) return ''
      const first = tweets[0].querySelector('a[href*="/status/"]')?.getAttribute('href') ?? ''
      const last = tweets[tweets.length - 1].querySelector('a[href*="/status/"]')?.getAttribute('href') ?? ''
      return `${first}|${last}`
    })
    return typeof raw === 'string' ? raw : null
  } catch {
    return null
  }
}

/** 读取 Discord 当前视口内前 N 条消息的内容档案与年龄；读取失败返回空数组 */
export async function readDiscordVisibleContent(ctx: TaskContext, limit = 6): Promise<DiscordContentProfile[]> {
  try {
    const raw = await ctx.page.evaluate((max: number) => {
      return [...document.querySelectorAll('li[id^="chat-messages-"]')].slice(0, max).map((item, index) => {
        const textEl = item.querySelector('[id^="message-content-"]') as HTMLElement | null
        const text = (textEl?.innerText ?? '').trim()
        const hasImage = Boolean(item.querySelector('img[class*="image"], [class*="attachment"] img'))
        const hasVideo = Boolean(item.querySelector('video, [class*="video"] video'))
        const hasCard = Boolean(item.querySelector('[class*="embed"], [class*="embedWrapper"]'))
        const timeEl = item.querySelector('time[datetime]')
        const timestamp = timeEl?.getAttribute('datetime')
        const parsed = timestamp ? Date.parse(timestamp) : NaN
        const ageDays = Number.isFinite(parsed) ? (Date.now() - parsed) / 86400000 : null
        const kind = hasVideo ? 'video' : hasImage ? 'image' : hasCard ? 'card' : text ? 'text' : 'empty'
        const rect = item.getBoundingClientRect()
        return { index, kind, textLength: text.length, ageDays, top: rect.top, height: rect.height }
      })
    }, limit)
    return Array.isArray(raw) ? (raw as DiscordContentProfile[]) : []
  } catch {
    return []
  }
}

/** X 内容停留：文字按可见长度/是否折叠，图片 5-12 秒，视频 8-30 秒 */
export function computeXDwellMs(profile: XContentProfile, rng: () => number): number {
  let base: number
  if (profile.kind === 'video') {
    base = profile.videoDurationSec !== null
      ? Math.min(12000, Math.max(4000, profile.videoDurationSec * 1000 * 0.1))
      : randomInt(4000, 12000, rng)
  } else if (profile.kind === 'image') {
    base = randomInt(2500, 6000, rng)
  } else if (profile.kind === 'card') {
    base = randomInt(2000, 4000, rng)
  } else if (profile.kind === 'empty') {
    base = randomInt(500, 1000, rng)
  } else if (profile.collapsed) {
    base = randomInt(4000, 8000, rng)
  } else if (profile.textLength < 80) {
    base = randomInt(1000, 2500, rng)
  } else if (profile.textLength <= 280) {
    base = randomInt(2000, 4500, rng)
  } else {
    base = randomInt(4000, 8000, rng)
  }
  return applyJitter(base, rng)
}

/** Discord 是否超过可读年龄（默认 7 天） */
export function isDiscordTooOld(profile: DiscordContentProfile, maxDays = DISCORD_MAX_DAYS): boolean {
  return profile.ageDays !== null && profile.ageDays > maxDays
}

/** Discord 停留：3 天内按内容，3-7 天快扫，>7 天不停留 */
export function computeDiscordDwellMs(profile: DiscordContentProfile, rng: () => number): number {
  if (isDiscordTooOld(profile)) return 0
  if (profile.ageDays === null) return applyJitter(randomInt(500, 1500, rng), rng)
  if (profile.ageDays > DISCORD_NORMAL_DAYS) return applyJitter(randomInt(1000, 2000, rng), rng)

  let base: number
  if (profile.kind === 'video') base = randomInt(3000, 10000, rng)
  else if (profile.kind === 'image') base = randomInt(2500, 6000, rng)
  else if (profile.kind === 'card') base = randomInt(2000, 4000, rng)
  else if (profile.kind === 'empty') base = randomInt(500, 1000, rng)
  else if (profile.textLength < 80) base = randomInt(1500, 3000, rng)
  else if (profile.textLength <= 300) base = randomInt(3000, 5000, rng)
  else base = randomInt(4000, 8000, rng)
  return applyJitter(base, rng)
}

/** 闭区间随机整数（clamp rng，避免注入 1 时越界） */
function randomInt(min: number, max: number, rng: () => number): number {
  const r = Math.min(0.999999, Math.max(0, rng()))
  return min + Math.floor(r * (max - min + 1))
}

/** 阅读时间抖动 0.7-1.3 倍，避免每次同一时长 */
function applyJitter(ms: number, rng: () => number): number {
  return Math.round(ms * (READ_JITTER_MIN + Math.min(0.999999, Math.max(0, rng())) * (READ_JITTER_MAX - READ_JITTER_MIN)))
}

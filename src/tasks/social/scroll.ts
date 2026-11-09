/**
 * 社交任务自然滚动（tasks 层内部 helper）：模拟阅读节奏的滚动与停顿
 * 依赖方向：仅依赖 ../base 的 TaskContext 类型
 * 页面操作：全部走 ctx.page（patchright Page：mouse.move/mouse.wheel/evaluate），不引入其它自动化库
 * 设计思路：滚动次数少、停留久——60% 只滚 1 次、30% 滚 2 次、10% 滚 3 次；
 *          8% 概率回滚一小段；阅读停顿分短/正常/长三档，避免机械匀速。
 */
import type { TaskContext } from '../base'
import { hasBlockingOverlay } from './overlay'

/** 屏幕坐标框（时间线/消息列表容器） */
export interface ScreenBox {
  x: number
  y: number
  width: number
  height: number
}

/** 滚动参数：direction=1 向下、-1 向上；rng 供单测注入固定序列；box 存在时在容器内滚动 */
export interface ScrollBurstOptions {
  direction: 1 | -1
  rng: () => number
  box?: ScreenBox
  /** 是否允许随机反向回滚（X 关闭，避免来回上下） */
  allowReverse?: boolean
  stepsMin?: number
  stepsMax?: number
  stepGapMinMs?: number
  stepGapMaxMs?: number
  distanceMinRatio?: number
  distanceMaxRatio?: number
  /** 指定本次滚动总距离（优先于比例计算） */
  distancePx?: number
  /** 单段滚轮像素范围：设置后按总距离自动拆成多段小滚轮（不缓动） */
  notchMinPx?: number
  notchMaxPx?: number
  /** 帧级平滑滚轮：每 frameMs 发一次小 wheel，按缓入缓出滚完总距离 */
  smoothWheel?: boolean
  smoothDurationMinMs?: number
  smoothDurationMaxMs?: number
  frameMs?: number
}

const SHORT_PAUSE_MIN_MS = 3000
const SHORT_PAUSE_MAX_MS = 7000
const NORMAL_PAUSE_MIN_MS = 8000
const NORMAL_PAUSE_MAX_MS = 15000
const LONG_PAUSE_MIN_MS = 20000
const LONG_PAUSE_MAX_MS = 40000
const SHORT_PAUSE_PROBABILITY = 0.6 // 60% 快速扫过
const LONG_PAUSE_PROBABILITY = 0.1 // 10% 长文/视频/走神，其余 30% 正常阅读

/**
 * 执行一次自然滚动：随机移动鼠标 → 20% 概率停顿 → 6-12 段小滚轮（缓入缓出）→ 8% 概率反向回滚。
 * 弹窗可见时直接返回 false，绝不滚到底层页面。
 * @param ctx 任务上下文
 * @param opts 方向与随机源
 * @returns 是否完成滚动（有弹窗/被中断返回 false）
 */
export async function humanScrollBurst(ctx: TaskContext, opts: ScrollBurstOptions): Promise<boolean> {
  if (await hasBlockingOverlay(ctx)) return false
  const viewport = await getViewport(ctx)
  const target = opts.box ?? { x: 0, y: 0, width: viewport.width, height: viewport.height }
  // 鼠标落在目标容器内部的随机位置，避免滚到时间线/消息列表外面
  const x = Math.floor(target.x + target.width * (0.3 + opts.rng() * 0.4))
  const y = Math.floor(target.y + target.height * (0.25 + opts.rng() * 0.5))
  await ctx.page.mouse.move(x, y)

  // 20% 概率在当前位置停留 1-2 秒，模拟 hover 看内容
  if (opts.rng() < 0.2) await ctx.page.waitForTimeout(1000 + Math.floor(opts.rng() * 1001))
  if (await hasBlockingOverlay(ctx)) return false

  const ratioMin = opts.distanceMinRatio ?? 0.55
  const ratioMax = opts.distanceMaxRatio ?? 0.85
  const total = opts.distancePx !== undefined
    ? Math.max(120, Math.round(opts.distancePx))
    : opts.box
      ? Math.max(200, Math.round(target.height * (ratioMin + opts.rng() * (ratioMax - ratioMin))))
      : 300 + Math.floor(opts.rng() * 501) // 无容器时 300-800px
  if (opts.smoothWheel) {
    const duration = randomInt(opts.smoothDurationMinMs ?? 900, opts.smoothDurationMaxMs ?? 1600, opts.rng)
    const frameMs = opts.frameMs ?? 16
    const frames = Math.max(1, Math.round(duration / frameMs))
    let sent = 0
    for (let i = 1; i <= frames; i++) {
      if (await hasBlockingOverlay(ctx)) return false
      const progress = i / frames
      const eased = progress * progress * (3 - 2 * progress) // smoothstep 缓入缓出
      const targetCum = Math.round(total * eased)
      const delta = targetCum - sent
      if (delta > 0) {
        await ctx.page.mouse.wheel(0, opts.direction * delta)
        sent = targetCum
      }
      await ctx.page.waitForTimeout(frameMs)
    }
    if (sent < total) await ctx.page.mouse.wheel(0, opts.direction * (total - sent))
    return true
  }

  const notchMode = opts.notchMinPx !== undefined && opts.notchMaxPx !== undefined
  const stepsMin = opts.stepsMin ?? 6
  const stepsMax = opts.stepsMax ?? 12
  const steps = notchMode
    ? Math.max(1, Math.ceil(total / Math.max(opts.notchMinPx as number, opts.notchMaxPx as number)))
    : stepsMin + Math.floor(opts.rng() * (stepsMax - stepsMin + 1))
  if (!(await wheelSeries(ctx, opts.direction, total, steps, opts.rng, opts.stepGapMinMs ?? 20, opts.stepGapMaxMs ?? 50, notchMode))) {
    return false
  }

  // 偶尔回看一点，模拟「没看清/看漏了」；X 关闭此项避免来回上下
  if ((opts.allowReverse ?? true) && opts.rng() < 0.08) {
    await ctx.page.waitForTimeout(400 + Math.floor(opts.rng() * 501))
    const reverseTotal = opts.box
      ? Math.max(100, Math.round(target.height * (0.15 + opts.rng() * 0.15)))
      : 200 + Math.floor(opts.rng() * 201)
    if (!(await wheelSeries(ctx, -opts.direction as 1 | -1, reverseTotal, 3 + Math.floor(opts.rng() * 3), opts.rng, 20, 50, false))) {
      return false
    }
  }
  return true
}

/** 把总距离拆成多段小 wheel 事件；缓入缓出，接近真实滚轮/触控板 */
async function wheelSeries(
  ctx: TaskContext,
  direction: 1 | -1,
  total: number,
  steps: number,
  rng: () => number,
  gapMinMs: number,
  gapMaxMs: number,
  uniform = false,
): Promise<boolean> {
  const base = total / steps
  for (let i = 0; i < steps; i++) {
    if (await hasBlockingOverlay(ctx)) return false
    const progress = (i + 0.5) / steps
    const factor = uniform || steps === 1 ? 1 : 0.7 + 0.6 * Math.sin(Math.PI * progress)
    const delta = Math.max(20, Math.round(base * factor))
    await ctx.page.mouse.wheel(0, direction * delta)
    if (i < steps - 1) await ctx.page.waitForTimeout(gapMinMs + Math.floor(rng() * (gapMaxMs - gapMinMs + 1)))
  }
  return true
}

/** 原生平滑滚动参数 */
export interface SmoothScrollOptions {
  /** 1 向下，-1 向上 */
  direction?: 1 | -1
  /** 优先在这些元素里找可滚动容器；默认 primaryColumn */
  containerSelectors?: string[]
  /** 等待滚动停止的最长时间 */
  maxWaitMs?: number
}

/**
 * 原生平滑滚动：找到实际可滚动容器，scrollTo({ behavior: 'smooth' }) 滚指定距离，并等待滚动停止。
 * 弹窗可见时直接返回 false；找不到容器/执行失败也返回 false，由调用方决定是否回退 wheel。
 * @param ctx 任务上下文
 * @param delta 滚动距离（像素，方向由 opts.direction 决定）
 * @param opts 方向与容器选择器
 * @returns 是否成功发起并完成滚动
 */
export async function smoothScrollBy(ctx: TaskContext, delta: number, opts: SmoothScrollOptions = {}): Promise<boolean> {
  if (await hasBlockingOverlay(ctx)) return false
  const direction = opts.direction ?? 1
  const selectors = opts.containerSelectors?.length ? opts.containerSelectors : ['[data-testid="primaryColumn"]']
  try {
    const started = await ctx.page.evaluate(({ distance, direction, selectors }) => {
      const findScrollable = (): HTMLElement | null => {
        for (const selector of selectors) {
          let el = document.querySelector(selector) as HTMLElement | null
          while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement as HTMLElement | null
          if (el) return el
        }
        const fallback = document.scrollingElement as HTMLElement | null
        return fallback && fallback.scrollHeight > fallback.clientHeight + 10 ? fallback : null
      }
      const el = findScrollable()
      if (!el) return false
      el.scrollTo({ top: el.scrollTop + direction * distance, behavior: 'smooth' })
      return true
    }, { distance: delta, direction, selectors })
    if (started !== true) return false

    const end = Date.now() + (opts.maxWaitMs ?? 2500)
    let lastTop: number | null = null
    while (Date.now() < end) {
      await ctx.page.waitForTimeout(80)
      const top = await readScrollTop(ctx, selectors)
      if (top === null) return true
      if (lastTop !== null && Math.abs(top - lastTop) < 1) return true
      lastTop = top
    }
    return true
  } catch {
    return false
  }
}

/** 读取指定滚动容器的 scrollTop（读不到返回 null） */
async function readScrollTop(ctx: TaskContext, selectors: string[]): Promise<number | null> {
  try {
    const raw = await ctx.page.evaluate((selectors) => {
      for (const selector of selectors) {
        let el = document.querySelector(selector) as HTMLElement | null
        while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement as HTMLElement | null
        if (el) return el.scrollTop
      }
      return document.scrollingElement ? document.scrollingElement.scrollTop : window.scrollY
    }, selectors)
    return typeof raw === 'number' ? raw : null
  } catch {
    return null
  }
}

/**
 * 一次阅读停顿：60% 短停 3-7 秒、10% 长停 20-40 秒、30% 正常停 8-15 秒。
 * @param ctx 任务上下文
 * @param rng 随机源
 */
export async function humanReadingPause(ctx: TaskContext, rng: () => number): Promise<void> {
  const roll = rng()
  if (roll < SHORT_PAUSE_PROBABILITY) {
    await ctx.page.waitForTimeout(randomInt(SHORT_PAUSE_MIN_MS, SHORT_PAUSE_MAX_MS, rng))
    return
  }
  if (roll < SHORT_PAUSE_PROBABILITY + LONG_PAUSE_PROBABILITY) {
    await ctx.page.waitForTimeout(randomInt(LONG_PAUSE_MIN_MS, LONG_PAUSE_MAX_MS, rng))
    return
  }
  await ctx.page.waitForTimeout(randomInt(NORMAL_PAUSE_MIN_MS, NORMAL_PAUSE_MAX_MS, rng))
}

/** 闭区间随机整数（clamp rng，避免测试注入 1 时越界） */
function randomInt(min: number, max: number, rng: () => number): number {
  const r = Math.min(0.999999, Math.max(0, rng()))
  return min + Math.floor(r * (max - min + 1))
}

/** 取视口尺寸（任务内自包含求值） */
async function getViewport(ctx: TaskContext): Promise<{ width: number; height: number }> {
  return ctx.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) as Promise<{ width: number; height: number }>
}

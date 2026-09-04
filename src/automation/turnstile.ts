/**
 * Turnstile 交互式人机验证方框（automation 层）：检测方框 iframe 并拟人点击
 * 依赖方向：依赖 infrastructure 常量与 humanize 类型，被 engine/task-context 委托
 * 设计思路：interaction-only Turnstile（真机实测 ISP IP 一点即过）点方框即完成验证——
 *   点击后 iframe 重渲染期间 CDP 派发会被浏览器拒绝（Invalid parameters），
 *   瞬时错误最多重试 TURNSTILE_CLICK_MAX 次、每次重新取盒（不用旧坐标点已移动的 iframe）
 */
import type { Page } from 'patchright'
import type { Logger } from '../infrastructure/logger'
import { CDP_TRANSIENT_PATTERN } from '../infrastructure/constants'
import type { Humanizer } from './humanize'

/** 默认方框 iframe 选择器：站点容器优先，兜底任意可见挑战 iframe */
export const TURNSTILE_FRAME_SEL = ['div[data-turnstile-container] iframe:visible', 'iframe[src*="challenges.cloudflare.com"]:visible']

/** 点击重试上限（真机实测 09-04 凌晨批量失败后校准：再点一次大多能过） */
export const TURNSTILE_CLICK_MAX = 3

export interface TurnstileBox {
  x: number
  y: number
  width: number
  height: number
}

export interface TurnstileDeps {
  page: Page
  human: Humanizer
  /** 日志器：模块内消息为通用措辞，窗口名等上下文由调用方包装注入 */
  logger: Pick<Logger, 'info' | 'warn'>
}

/** 取方框盒（不可见/尺寸过小返回 null）：重试循环每次重新取盒 */
export async function turnstileBox(page: Page, selectors: string[] = TURNSTILE_FRAME_SEL): Promise<TurnstileBox | null> {
  for (const sel of selectors) {
    const box = await page
      .locator(sel)
      .first()
      .boundingBox()
      .catch(() => null)
    if (box && box.width >= 20 && box.height >= 20) return box
  }
  return null
}

/** 方框当前是否可见（轻量 count 检查，低频追踪用） */
export async function turnstileVisible(page: Page, selectors: string[] = TURNSTILE_FRAME_SEL): Promise<boolean> {
  for (const sel of selectors) {
    if (await page.locator(sel).first().count() > 0) return true
  }
  return false
}

/**
 * 检测到方框即拟人点击（方框在 iframe 左侧中部）：
 * 瞬时失败（CDP 协议错误）重试；非瞬时错误（找不到元素等）不重试直接抛
 * @returns 执行了点击 true / 方框未出现 false
 */
export async function clickTurnstileBox(deps: TurnstileDeps, opts: { selectors?: string[]; maxAttempts?: number } = {}): Promise<boolean> {
  const selectors = opts.selectors ?? TURNSTILE_FRAME_SEL
  const maxAttempts = opts.maxAttempts ?? TURNSTILE_CLICK_MAX
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const box = await turnstileBox(deps.page, selectors)
    if (!box) return false
    const x = box.x + Math.min(30, box.width * 0.4)
    const y = box.y + box.height / 2
    deps.logger.info({ step: 'turnstile', x: Math.round(x), y: Math.round(y), attempt }, '检测到人机验证方框，拟人点击')
    try {
      await deps.human.clickAt(x, y)
      return true
    } catch (e) {
      lastErr = e as Error
      if (!CDP_TRANSIENT_PATTERN.test(lastErr.message)) throw lastErr
      deps.logger.warn({ step: 'turnstile', attempt, x: Math.round(x), y: Math.round(y), err: lastErr.message }, '验证方框点击被浏览器拒绝（iframe 重渲染瞬时态），等待后重试')
      await deps.page.waitForTimeout(1000 + Math.floor(Math.random() * 1000))
    }
  }
  throw lastErr ?? new Error('人机验证方框点击失败（重试耗尽）')
}

/** 等验证方框出现并点击（方框在触发动作后 1-3s 渲染，最多等 budgetMs） */
export async function autoClickTurnstile(deps: TurnstileDeps, budgetMs = 10000): Promise<boolean> {
  const end = Date.now() + budgetMs
  while (Date.now() < end) {
    if (await clickTurnstileBox(deps)) return true
    await deps.page.waitForTimeout(500)
  }
  deps.logger.info({ step: 'turnstile', budgetMs }, '预算内未检测到人机验证方框（可能免验证或方框未渲染）')
  return false
}

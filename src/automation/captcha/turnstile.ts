/**
 * Turnstile 交互式人机验证方框（automation 层）：检测方框 iframe 并坐标点击
 * 依赖方向：依赖 infrastructure 常量与 dom/clickPoint，被 engine/task-context 委托
 * 设计思路：interaction-only Turnstile（真机实测 ISP IP 一点即过）点方框即完成验证——
 *   点击后 iframe 重渲染期间 CDP 派发会被浏览器拒绝（Invalid parameters），
 *   瞬时错误最多重试 TURNSTILE_CLICK_MAX 次、每次重新取盒（不用旧坐标点已移动的 iframe）
 */
import type { Page } from 'patchright'
import type { Logger } from '../../infrastructure/logger'
import { CDP_TRANSIENT_PATTERN } from '../../infrastructure/constants'
import { clickPoint } from '../dom'

/** 默认方框 iframe 选择器：优先站点自己的容器，兜底任意可见的 Cloudflare 挑战 iframe */
export const TURNSTILE_FRAME_SEL = ['div[data-turnstile-container] iframe:visible', 'iframe[src*="challenges.cloudflare.com"]:visible']

/** 单次「等方框并点击」内允许的最大点击尝试次数（真机实测：被拒后隔一会儿重点一次大多能过） */
export const TURNSTILE_CLICK_MAX = 3

/** 验证方框在页面中的位置与尺寸（视口像素坐标） */
export interface TurnstileBox {
  /** 方框左上角横坐标 */
  x: number
  /** 方框左上角纵坐标 */
  y: number
  /** 方框宽度（像素） */
  width: number
  /** 方框高度（像素） */
  height: number
}

/** Turnstile 操作所需的依赖 */
export interface TurnstileDeps {
  /** 目标页面 */
  page: Page
  /** 日志器：模块内消息为通用措辞，窗口名等上下文由调用方包装注入 */
  logger: Pick<Logger, 'info' | 'warn'>
}

/**
 * 取验证方框的位置盒。
 * 依次尝试各选择器，取首个匹配元素调用 boundingBox；不可见或尺寸过小（宽或高 < 20 像素）
 * 视为没找到，继续下一个选择器。这样重试循环每次都会重新取盒，避免用旧坐标点已经移动过的 iframe。
 * @param page 目标页面
 * @param selectors 候选 iframe 选择器（缺省 TURNSTILE_FRAME_SEL）
 * @returns 方框位置盒；未找到返回 null
 */
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

/**
 * 方框当前是否可见（轻量检查：只数元素个数，不取盒也不点击），适合低频追踪轮询。
 * @param page 目标页面
 * @param selectors 候选 iframe 选择器（缺省 TURNSTILE_FRAME_SEL）
 * @returns 任一方框选择器命中有元素即 true
 */
export async function turnstileVisible(page: Page, selectors: string[] = TURNSTILE_FRAME_SEL): Promise<boolean> {
  for (const sel of selectors) {
    if (await page.locator(sel).first().count() > 0) return true
  }
  return false
}

/**
 * 检测到方框就坐标点击（点击点在方框左侧中部，避开 Cloudflare 图标）。
 * 执行流程：最多尝试 maxAttempts 次——每次重新取盒，取不到直接返回 false（方框未出现）；
 * 取到后按「左侧约 30px、垂直居中」算出坐标并点。若点击被浏览器拒绝且是 CDP 瞬时错误
 * （iframe 重渲染期间派发会失败），记日志、随机等 1-2s 后重试；非瞬时错误（如元素不存在）直接抛。
 * 重试耗尽仍失败则抛出最后一次错误。
 * @param deps 页面与日志器
 * @param opts.selectors 候选 iframe 选择器（缺省 TURNSTILE_FRAME_SEL）
 * @param opts.maxAttempts 点击尝试上限（缺省 TURNSTILE_CLICK_MAX）
 * @returns 成功执行了点击为 true；方框未出现为 false
 * @throws 非瞬时错误；或重试耗尽
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
    deps.logger.info({ step: 'turnstile', x: Math.round(x), y: Math.round(y), attempt }, '检测到人机验证方框，坐标点击')
    try {
      await clickPoint(deps.page, x, y)
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

/**
 * 等验证方框出现并点击（用于触发动作后主动找方框）。
 * 执行流程：在 budgetMs 预算内每 500ms 调用一次 clickTurnstileBox，任一次返回 true 即成功返回；
 * 预算耗尽仍没点到，记一条日志并返回 false。
 * @param deps 页面与日志器
 * @param budgetMs 最长等待毫秒数（缺省 10000；方框通常在触发动作后 1-3s 渲染）
 * @returns 预算内点到方框为 true；否则 false
 */
export async function autoClickTurnstile(deps: TurnstileDeps, budgetMs = 10000): Promise<boolean> {
  const end = Date.now() + budgetMs
  while (Date.now() < end) {
    if (await clickTurnstileBox(deps)) return true
    await deps.page.waitForTimeout(500)
  }
  deps.logger.info({ step: 'turnstile', budgetMs }, '预算内未检测到人机验证方框（可能免验证或方框未渲染）')
  return false
}

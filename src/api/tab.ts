/**
 * 标签页能力（api 层）：打开/切换/关闭新标签页，并在指定标签页等待、竞速、点击
 * 依赖方向：engine TaskContext 类型、automation 坐标点击、./wait 的页面级等待原语
 * 设计思路：主流程仍在 ctx.page 上；站点用 target=_blank 打开的新页面用本模块接管，
 *   不改 ctx.page，也不复制一套页面操作逻辑（等待/竞速复用 waitForOn/raceOn）
 */
import type { Page } from 'patchright'
import type { TaskContext } from '../engine/task-context'
import { clickPoint } from '../automation'
import { raceOn, waitForOn, type Matcher, type WaitMatcher, type WaitOptions } from './wait'

/** 打开新标签页的选项 */
export interface OpenTabOptions {
  /** 等新标签页出现的最长毫秒数（缺省 30000） */
  timeoutMs?: number
  /** 只接受 URL 含该片段的标签页（缺省接受任意非扩展新页；页面跳转中时用于等最终地址） */
  urlIncludes?: string
}

/** 新标签页轮询间隔（毫秒） */
const NEW_TAB_POLL_MS = 300

/**
 * 执行一个会打开新标签页的动作，并接管新标签页。
 * 执行流程：先记录现有页 → 执行动作（如点击 target=_blank 链接）→ 轮询浏览器上下文，
 * 找到「非扩展页、不在旧页集合、URL 命中 urlIncludes」的新页 → 等 DOMContentLoaded 后置前返回。
 * 超时抛错；调用方可据此判断是否站点直接切换到完成态（未开新页）。
 * @param ctx 任务上下文（提供当前页面与所在浏览器上下文）
 * @param trigger 打开新标签页的动作（通常是点击链接/按钮）
 * @param opts 超时与 URL 过滤选项
 * @returns 新标签页
 * @throws 预算内未出现符合条件的新标签页
 */
export async function openTab(ctx: TaskContext, trigger: () => Promise<void>, opts: OpenTabOptions = {}): Promise<Page> {
  const context = ctx.page.context()
  const before = new Set(context.pages())
  await trigger()
  const deadline = Date.now() + (opts.timeoutMs ?? 30000)
  while (Date.now() < deadline) {
    const page = context.pages().find((p) => {
      if (before.has(p)) return false
      if (p.url().startsWith('chrome-extension://')) return false
      return !opts.urlIncludes || p.url().includes(opts.urlIncludes)
    })
    if (page) {
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.bringToFront().catch(() => {})
      return page
    }
    await ctx.page.waitForTimeout(NEW_TAB_POLL_MS)
  }
  const hint = opts.urlIncludes ? `地址含 ${opts.urlIncludes} 的` : ''
  throw new Error(`等待新标签页超时（未出现${hint}新标签）`)
}

/** 在指定标签页等待条件命中（语义同 waitFor） */
export async function waitInTab(ctx: TaskContext, page: Page, matcher: WaitMatcher, opts: WaitOptions = {}): Promise<boolean> {
  return waitForOn(ctx, page, matcher, opts)
}

/** 在指定标签页竞速多个匹配器（语义同 race） */
export async function raceInTab<K extends string>(page: Page, entries: Array<[K, Matcher]>, timeoutMs: number): Promise<K | null> {
  return raceOn(page, entries, timeoutMs)
}

/** 在指定标签页点击：选择器走 locator().click；{ x, y } 走 CDP 坐标点击 */
export async function clickInTab(page: Page, target: string | { x: number; y: number }): Promise<void> {
  if (typeof target === 'string') {
    await page.locator(target).first().click()
    return
  }
  await clickPoint(page, target.x, target.y)
}

/** 把指定标签页置前（不改变 ctx.page） */
export async function focusTab(page: Page): Promise<void> {
  await page.bringToFront().catch(() => {})
}

/** 关闭指定标签页，并把主页面（ctx.page）置前 */
export async function closeTab(ctx: TaskContext, page: Page): Promise<void> {
  await page.close().catch(() => {})
  await ctx.page.bringToFront().catch(() => {})
}

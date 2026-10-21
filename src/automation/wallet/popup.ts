/**
 * 钱包弹窗工具（automation 层）：等待插件弹窗出现
 * 依赖方向：仅依赖 patchright 类型，被 task-context 与 scripts 依赖
 * 设计思路：先查已打开的页面，再同时用事件监听 + 100ms 轮询兜底（部分插件弹窗事件时序不可靠），
 * 任一命中即返回；超时返回 null，由调用方决定后续
 * 说明：这里的真实弹窗对象就是 patchright 的 Page（结构满足 PopupPage），其 getByTestId/getByRole/locator
 * 返回的正是 patchright Locator，因此 PopupLocator.isVisible 的真实实现即原生 Locator.isVisible，
 * 无需额外包装层；适配器分类时优先调用它区分「存在但隐藏」与「可见」。
 */
import type { BrowserContext, Page } from 'patchright'

/**
 * 判断某个页面 URL 是否命中任一钱包弹窗模式。
 * 逐个用模式字符串构造正则去 test 该 URL，命中其一即返回 true。
 * @param url 待判断的页面地址
 * @param patterns 正则字符串列表（来自适配器的 extensionUrlPatterns）
 * @returns 是否命中任一模式
 */
export function matchesWalletUrl(url: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(p).test(url))
}

/**
 * 立即查找已打开的钱包弹窗（不等待）：扫描浏览器全部 context 的现有页面。
 * 用途：竞速循环每轮先看“弹窗是否已经开着”，避免页面上的未连接按钮抢先命中，
 * 导致屏幕上明明开着的弹窗一直没人处理（真机 2026-10-21）。
 * @param context 起始浏览器上下文（其所属浏览器的全部 context 都会被扫描）
 * @param patterns 钱包弹窗 URL 正则列表
 * @returns 命中的弹窗页面；没有返回 null
 */
export function findOpenPopup(context: BrowserContext, patterns: string[]): Page | null {
  // 测试 mock 的 context 可能没有 pages()，按“无弹窗”处理
  if (typeof context.pages !== 'function') return null
  const browser = typeof context.browser === 'function' ? context.browser() : undefined
  const contexts = browser ? browser.contexts() : [context]
  for (const c of contexts) {
    for (const p of c.pages()) {
      if (matchesWalletUrl(p.url(), patterns)) return p
    }
  }
  return null
}

/**
 * 等待钱包弹窗出现并返回该页面。
 * 执行流程：先扫描浏览器全部 context（比特浏览器部分弹窗会开在别的 context，不能只看当前 context），
 * 已存在匹配页则直接返回；否则同时挂两条兜底——监听新页面 'page' 事件，以及每 100ms 轮询一次全部页面，
 * 二者任一命中就返回；超过 timeoutMs 仍未命中也返回（null）。settled 标记保证事件与轮询竞争时只落定一次。
 * @param context 起始浏览器上下文（其所属浏览器的全部 context 都会被扫描）
 * @param patterns 钱包弹窗 URL 正则列表
 * @param timeoutMs 最长等待毫秒数，超时返回 null
 * @returns 命中的弹窗页面；超时返回 null，由调用方决定后续
 */
export async function waitForPopup(context: BrowserContext, patterns: string[], timeoutMs: number): Promise<Page | null> {
  const existing = findOpenPopup(context, patterns)
  if (existing) return existing
  return new Promise(resolve => {
    let settled = false
    // 句柄先声明后赋值：finish 内统一清理轮询定时器与超时定时器
    let timer: ReturnType<typeof setInterval>
    let timeoutHandle: ReturnType<typeof setTimeout>
    const finish = (p: Page | null) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      clearTimeout(timeoutHandle)
      context.off('page', handler)
      resolve(p)
    }
    const handler = (p: Page) => {
      if (matchesWalletUrl(p.url(), patterns)) finish(p)
    }
    context.on('page', handler)
    timer = setInterval(() => {
      const p = findOpenPopup(context, patterns)
      if (p) finish(p)
    }, 100)
    timeoutHandle = setTimeout(() => finish(null), timeoutMs)
  })
}

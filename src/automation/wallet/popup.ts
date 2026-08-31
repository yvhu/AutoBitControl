/**
 * 钱包弹窗工具（automation 层）：等待插件弹窗出现
 * 依赖方向：仅依赖 patchright 类型，被 task-context 与 scripts 依赖
 * 设计思路：先查已打开的页面，再同时用事件监听 + 100ms 轮询兜底（部分插件弹窗事件时序不可靠），
 * 任一命中即返回；超时返回 null，由调用方决定后续
 */
import type { BrowserContext, Page } from 'patchright'

/** 判断页面 URL 是否命中任一钱包弹窗模式 */
export function matchesWalletUrl(url: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(p).test(url))
}

/**
 * 等待钱包弹窗出现（扫描浏览器全部 context——比特浏览器部分弹窗开在别的 context）
 * 先查已打开的页面，再同时用事件监听 + 100ms 轮询兜底；超时返回 null
 * @param timeoutMs 最长等待时间（超时返回 null）
 * @returns 命中的弹窗页面，或超时 null
 * 设计权衡：settled 标记防止事件监听与轮询同时命中导致重复 resolve
 */
export async function waitForPopup(context: BrowserContext, patterns: string[], timeoutMs: number): Promise<Page | null> {
  const find = (): Page | undefined => {
    // context.browser 可能缺失（测试 mock）或返回 null（独立 context），任一情况回退到 [context]
    const browser = context.browser?.()
    const contexts = browser ? browser.contexts() : [context]
    for (const c of contexts) {
      for (const p of c.pages()) {
        if (matchesWalletUrl(p.url(), patterns)) return p
      }
    }
    return undefined
  }
  const existing = find()
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
      const p = find()
      if (p) finish(p)
    }, 100)
    timeoutHandle = setTimeout(() => finish(null), timeoutMs)
  })
}

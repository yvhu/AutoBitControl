/**
 * 页面能力函数（api 层）：打开网页与基础交互
 * 依赖方向：依赖 engine 的 TaskContext 类型与 automation/dom 的坐标点击
 */
import type { TaskContext } from '../engine/task-context'
import { clickPoint } from '../automation'

/** 打开网页：默认 meta.url；失败重试（默认 3 次，2-5s 退避）；可选关闭残留标签页 */
export async function openPage(
  ctx: TaskContext,
  url?: string,
  options: { retries?: number; timeoutMs?: number; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'; closeOtherTabs?: boolean } = {},
): Promise<void> {
  const target = url ?? ctx.task.meta.url
  if (!target) throw new Error('未提供 url（任务 meta.url 为空）')
  if (options.closeOtherTabs) {
    for (const p of ctx.page.context().pages()) {
      if (p !== ctx.page) await p.close().catch(() => {})
    }
  }
  const retries = options.retries ?? 3
  const timeoutMs = options.timeoutMs ?? 45000
  const waitUntil = options.waitUntil ?? 'domcontentloaded'
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await ctx.page.goto(target, { timeout: timeoutMs, waitUntil })
      return
    } catch (e) {
      ctx.log.warn({ url: target, attempt }, `页面加载失败，第 ${attempt}/${retries} 次`)
      if (attempt === retries) throw e
      await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 3000)))
    }
  }
}

/** 点击：选择器字符串走 locator().click；{ x, y } 走 CDP 坐标点击 */
export async function click(ctx: TaskContext, target: string | { x: number; y: number }): Promise<void> {
  if (typeof target === 'string') {
    await ctx.page.locator(target).first().click()
    return
  }
  await clickPoint(ctx.page, target.x, target.y)
}

/** 填入输入框（设置为给定值） */
export async function fill(ctx: TaskContext, selector: string, text: string): Promise<void> {
  await ctx.page.locator(selector).first().fill(text)
}

/** 按键（'Enter' / 'Control+A' 等） */
export async function pressKey(ctx: TaskContext, key: string): Promise<void> {
  await ctx.page.keyboard.press(key)
}

/** 主世界执行 JS 并返回结果（读站点注入的全局变量必须用主世界） */
export async function runJs<T>(ctx: TaskContext, fn: () => T): Promise<T> {
  // patchright 的 evaluate(pageFunction, arg, world, isFunction)：undefined=不传参，{}=默认上下文，false=主世界（同旧 ctx.js）
  return ctx.page.evaluate(fn, undefined, {}, false) as Promise<T>
}

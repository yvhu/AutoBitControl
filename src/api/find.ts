/**
 * 查找能力函数（api 层）：即时判断元素状态/数量/文本（不等待）
 * 依赖方向：依赖 engine 的 TaskContext 类型
 */
import type { TaskContext } from '../engine/task-context'

/** 元素状态：可见 / 隐藏（在 DOM 但不可见）/ 不存在（查询异常按不存在处理） */
export async function elementState(ctx: TaskContext, selector: string): Promise<'visible' | 'hidden' | 'absent'> {
  try {
    const loc = ctx.page.locator(selector).first()
    if ((await loc.count()) === 0) return 'absent'
    return (await loc.isVisible()) ? 'visible' : 'hidden'
  } catch {
    return 'absent'
  }
}

/** 命中元素数量（异常按 0） */
export async function countElements(ctx: TaskContext, selector: string): Promise<number> {
  try {
    return await ctx.page.locator(selector).count()
  } catch {
    return 0
  }
}

/** 取元素文本（首元素，去首尾空格；取不到返回空串） */
export async function getText(ctx: TaskContext, selector: string): Promise<string> {
  try {
    return ((await ctx.page.locator(selector).first().textContent()) ?? '').trim()
  } catch {
    return ''
  }
}

/** 整页是否包含某文案（包含匹配，即时） */
export async function hasText(ctx: TaskContext, text: string): Promise<boolean> {
  try {
    return (await ctx.page.getByText(text, { exact: false }).count()) > 0
  } catch {
    return false
  }
}

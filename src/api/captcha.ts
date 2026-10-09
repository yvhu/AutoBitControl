/**
 * 验证码函数（api 层）：Turnstile 交互式方框点击（仅此一种）
 * 依赖方向：engine TaskContext 类型、automation/captcha 实现
 */
import type { TaskContext } from '../engine/task-context'
import { clickTurnstileBox, autoClickTurnstile } from '../automation'

/** Turnstile 方框：无 waitMs = 单次检测点击；有 waitMs = 预算内轮询等待并点击 */
export async function clickTurnstile(
  ctx: TaskContext,
  options: { waitMs?: number; selectors?: string[]; maxAttempts?: number } = {},
): Promise<boolean> {
  const deps = { page: ctx.page, logger: ctx.log }
  const opts = { selectors: options.selectors, maxAttempts: options.maxAttempts }
  return options.waitMs && options.waitMs > 0 ? autoClickTurnstile(deps, options.waitMs) : clickTurnstileBox(deps, opts)
}

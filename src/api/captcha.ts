/**
 * 验证码函数（api 层）：Turnstile 交互式方框点击（仅此一种）
 * 依赖方向：engine TaskContext 类型、automation/captcha 实现、infrastructure Logger 类型
 */
import type { TaskContext } from '../engine/task-context'
import type { Logger } from '../infrastructure/logger'
import { clickTurnstileBox, autoClickTurnstile } from '../automation'

/** 给 Turnstile 日志补上窗口名：模块内消息是通用措辞，窗口上下文在此统一注入（同旧 TaskContext.turnstileLogger） */
function windowLogger(ctx: TaskContext): Pick<Logger, 'info' | 'warn'> {
  const withWindow = (obj: unknown): Record<string, unknown> => ({ ...(obj as Record<string, unknown>), window: ctx.profile.name })
  return {
    info: (...args: unknown[]): void =>
      typeof args[0] === 'string' ? ctx.log.info(args[0]) : ctx.log.info(withWindow(args[0]), args[1] as string),
    warn: (...args: unknown[]): void =>
      typeof args[0] === 'string' ? ctx.log.warn(args[0]) : ctx.log.warn(withWindow(args[0]), args[1] as string),
  } as Pick<Logger, 'info' | 'warn'>
}

/** Turnstile 方框：无 waitMs = 单次检测点击；有 waitMs = 预算内轮询等待并点击 */
export async function clickTurnstile(
  ctx: TaskContext,
  options: { waitMs?: number; selectors?: string[]; maxAttempts?: number } = {},
): Promise<boolean> {
  const deps = { page: ctx.page, logger: windowLogger(ctx) }
  const opts = { selectors: options.selectors, maxAttempts: options.maxAttempts }
  return options.waitMs && options.waitMs > 0 ? autoClickTurnstile(deps, options.waitMs) : clickTurnstileBox(deps, opts)
}

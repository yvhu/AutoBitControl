/**
 * 运行状态机（engine 层）：RunStatus 转移规则与失败后的下一状态决策
 * 依赖方向：纯函数模块，仅依赖 db 的 RunStatus 类型，被 window-runner 依赖
 * 设计思路：状态转移集中成一张表 + 两个决策函数，避免散落各处的 if-else
 */
import type { RunStatus } from '../infrastructure/db'

/**
 * 合法转移表：
 * pending/running/retry_wait 可前进；success/failed/captcha_failed/skipped 为终态（无出边）
 */
export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ['running'],
  running: ['success', 'failed', 'captcha_failed', 'retry_wait'],
  retry_wait: ['running'],
  success: [],
  failed: [],
  captcha_failed: [],
  skipped: [],
}

/** 判断状态转移是否合法（供外部校验用） */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

/** 失败原因分类：普通错误可重试，验证码失败直接终态 */
export type FailureKind = 'error' | 'captcha'

/**
 * 失败后的下一状态：
 * 验证码失败 → captcha_failed 终态（重试大概率再失败，烧钱无意义）；
 * 普通错误 → 未达到总尝试上限进 retry_wait，否则 failed 终态
 * 注意：attempts 从 1 计数；调用方（window-runner）传入 retryMax + 1 作为总尝试上限
 */
export function nextStateAfterFailure(attempts: number, retryMax: number, kind: FailureKind): RunStatus {
  if (kind === 'captcha') return 'captcha_failed'
  return attempts >= retryMax ? 'failed' : 'retry_wait'
}

/** 熔断判断：窗口连续失败数达到阈值即跳过（阈值来自 execution.circuitBreakerThreshold） */
export function shouldSkipAfterBreaker(failCount: number, threshold: number): boolean {
  return failCount >= threshold
}

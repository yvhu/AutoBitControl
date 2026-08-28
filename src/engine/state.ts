import type { RunStatus } from '../infrastructure/db'

export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ['running'],
  running: ['success', 'failed', 'captcha_failed', 'retry_wait'],
  retry_wait: ['running'],
  success: [],
  failed: [],
  captcha_failed: [],
  skipped: [],
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

export type FailureKind = 'error' | 'captcha'

export function nextStateAfterFailure(attempts: number, retryMax: number, kind: FailureKind): RunStatus {
  if (kind === 'captcha') return 'captcha_failed'
  return attempts >= retryMax ? 'failed' : 'retry_wait'
}

export function shouldSkipAfterBreaker(failCount: number, threshold: number): boolean {
  return failCount >= threshold
}

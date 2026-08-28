import { describe, it, expect } from 'vitest'
import { canTransition, nextStateAfterFailure, shouldSkipAfterBreaker } from '../src/engine/state'

describe('canTransition', () => {
  it('允许 pending→running 与 running→success', () => {
    expect(canTransition('pending', 'running')).toBe(true)
    expect(canTransition('running', 'success')).toBe(true)
  })
  it('拒绝非法转移', () => {
    expect(canTransition('success', 'running')).toBe(false)
    expect(canTransition('failed', 'running')).toBe(false)
    expect(canTransition('pending', 'success')).toBe(false)
  })
})

describe('nextStateAfterFailure', () => {
  it('验证码失败直接 captcha_failed', () => {
    expect(nextStateAfterFailure(1, 2, 'captcha')).toBe('captcha_failed')
  })
  it('普通失败未达上限进入 retry_wait', () => {
    expect(nextStateAfterFailure(1, 2, 'error')).toBe('retry_wait')
  })
  it('达到重试上限进入 failed', () => {
    expect(nextStateAfterFailure(2, 2, 'error')).toBe('failed')
    expect(nextStateAfterFailure(3, 2, 'error')).toBe('failed')
  })
})

describe('shouldSkipAfterBreaker', () => {
  it('达到阈值才熔断', () => {
    expect(shouldSkipAfterBreaker(1, 2)).toBe(false)
    expect(shouldSkipAfterBreaker(2, 2)).toBe(true)
  })
})

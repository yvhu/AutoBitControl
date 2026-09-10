import { describe, it, expect } from 'vitest'
import { CaptchaFailure, ESTIMATED_COST_POINTS } from '../src/integrations/captcha/provider'

describe('provider 共享类型', () => {
  it('CaptchaFailure 是 Error 子类（window-runner 用它判 captcha_failed 终态）', () => {
    const e = new CaptchaFailure('余额不足')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('余额不足')
  })

  it('成本估算表覆盖全部验证码类型（不含 image：官方 ImageToTextTask 本次不迁移）', () => {
    expect(Object.keys(ESTIMATED_COST_POINTS).sort()).toEqual(
      ['turnstile', 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'recaptcha_v2_grid'].sort(),
    )
  })
})

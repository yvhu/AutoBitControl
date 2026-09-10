import { describe, it, expect } from 'vitest'
import { CaptchaFailure, ESTIMATED_COST_POINTS } from '../src/integrations/captcha/provider'

describe('provider 鍏变韩绫诲瀷', () => {
  it('CaptchaFailure 鏄?Error 瀛愮被锛坵indow-runner 鐢ㄥ畠鍒?captcha_failed 缁堟€侊級', () => {
    const e = new CaptchaFailure('浣欓涓嶈冻')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('浣欓涓嶈冻')
  })

  it('鎴愭湰浼扮畻琛ㄨ鐩栧叏閮ㄩ獙璇佺爜绫诲瀷锛堜笉鍚?image锛氬畼鏂?ImageToTextTask 鏈涓嶈縼绉伙級', () => {
    expect(Object.keys(ESTIMATED_COST_POINTS).sort()).toEqual(
      ['turnstile', 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'recaptcha_v2_grid'].sort(),
    )
  })
})
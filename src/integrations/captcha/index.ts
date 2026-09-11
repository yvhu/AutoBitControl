/**
 * 打码平台装配工厂（integrations 层）：按 config.captcha.provider 装配具体平台
 * 依赖方向：依赖 infrastructure/config，仅被 app.ts 使用
 */
import type { CaptchaConfig } from '../../infrastructure/config'
import type { CaptchaPlatform } from './types'
import { createYesCaptchaPlatform } from './yescaptcha'

/** 按配置创建打码平台；无 clientKey / 未知平台返回 null（无 Key 也能跑，面板显示未配置） */
export function createCaptchaPlatform(cfg: CaptchaConfig): CaptchaPlatform | null {
  if (cfg.provider === 'yescaptcha' && cfg.yescaptcha.clientKey) {
    return createYesCaptchaPlatform({ apiBase: cfg.yescaptcha.apiBase, clientKey: cfg.yescaptcha.clientKey })
  }
  return null
}

/**
 * 打码平台装配工厂（integrations 层）：按 config.captcha.provider 装配具体平台实现
 * 依赖方向：依赖 provider 接口与 infrastructure/config，仅被 app.ts 使用
 */
import type { CaptchaProvider } from './provider'
import type { CaptchaConfig } from '../../infrastructure/config'
import { YesCaptchaApiClient } from './yescaptcha/client'
import { YesCaptchaProvider } from './yescaptcha/provider'

/** 按配置创建打码平台实例；无 clientKey / 未知平台返回 null（无 Key 也能跑，任务侧 solveCaptcha 返回 none） */
export function createCaptchaProvider(cfg: CaptchaConfig): CaptchaProvider | null {
  if (cfg.provider === 'yescaptcha' && cfg.yescaptcha.clientKey) {
    const client = new YesCaptchaApiClient({ apiBase: cfg.yescaptcha.apiBase, clientKey: cfg.yescaptcha.clientKey })
    return new YesCaptchaProvider(client, { solveTimeoutMs: cfg.solveTimeoutMs, pollIntervalMs: cfg.pollIntervalMs })
  }
  return null
}

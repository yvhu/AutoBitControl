/**
 * yescaptcha 平台实现（integrations/captcha 层）：当前仅余额查询（插件负责解题）
 * 依赖方向：依赖 infrastructure/http，实现 types.CaptchaPlatform
 * 官方出处：getBalance = wiki 229767（POST /getBalance，body {clientKey}，响应 balance 点数，1 元 1000 点）
 */
import { httpJson } from '../../infrastructure/http'
import type { CaptchaPlatform } from './types'

export interface YesCaptchaCfg {
  apiBase: string
  clientKey: string
}

export function createYesCaptchaPlatform(cfg: YesCaptchaCfg): CaptchaPlatform {
  return {
    platform: 'yescaptcha',
    async getBalance(): Promise<number> {
      const resp = await httpJson<{ balance?: number; errorId?: number; errorCode?: string }>({
        baseUrl: cfg.apiBase, path: '/getBalance', method: 'POST', body: { clientKey: cfg.clientKey }, timeoutMs: 30000,
      })
      if (resp.errorId != null && resp.errorId !== 0) throw new Error(`yescaptcha 查询余额失败: ${resp.errorCode ?? resp.errorId}`)
      return resp.balance ?? 0
    },
  }
}

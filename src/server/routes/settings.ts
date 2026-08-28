/**
 * 设置路由（server 层）：公开非敏感配置（面板展示用）
 * 依赖方向：只读注入的 AppConfig 与版本号；被 app 装配
 * 安全约束：只暴露非敏感项，绝不包含 captcha clientKey / 钱包密码等密钥
 */
import { Router } from 'express'
import type { AppConfig } from '../../infrastructure/config'
import { ok } from '../http/response'

/** 面板公开设置：全部为非敏感配置项（版本号用于侧栏展示） */
export interface PublicSettings {
  bitbrowserApiBase: string
  webPort: number
  timezone: string
  concurrency: number
  circuitBreakerThreshold: number
  probeUrl: string
  version: string
}

export function settingsRouter(deps: { cfg: AppConfig; version: string }): Router {
  const router = Router()
  router.get('/settings', (req, res) => {
    ok(res, {
      bitbrowserApiBase: deps.cfg.bitbrowser.apiBase,
      webPort: deps.cfg.web.port,
      timezone: deps.cfg.execution.timezone,
      concurrency: deps.cfg.execution.concurrency,
      circuitBreakerThreshold: deps.cfg.execution.circuitBreakerThreshold,
      probeUrl: deps.cfg.execution.probeUrl,
      version: deps.version,
    } satisfies PublicSettings)
  })
  return router
}

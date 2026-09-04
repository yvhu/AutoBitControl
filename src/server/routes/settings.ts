/**
 * 设置路由（server 层）：公开非敏感配置（面板展示用）
 * 依赖方向：只读注入的 AppConfig、数据源状态与版本号；被 app 装配
 * 安全约束：只暴露非敏感项，绝不包含 captcha clientKey / 钱包密码等密钥
 */
import { Router } from 'express'
import type { AppConfig } from '../../infrastructure/config'
import { ok } from '../http/response'

/** 面板公开设置：全部为非敏感配置项（版本号用于侧栏展示） */
export interface PublicSettings {
  bitbrowserApiBase: string
  webPort: number
  staggerMaxSec: number
  circuitBreakerThreshold: number
  version: string
  datasource: {
    available: boolean
    error: string
    path: string
    rows: number
    columns: string[]
  }
}

/**
 * @swagger
 * /api/settings:
 *   get:
 *     summary: 公开只读设置（不含任何密钥）+ 数据源状态
 *     responses:
 *       '200':
 *         description: 非敏感配置项
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     bitbrowserApiBase: { type: string }
 *                     webPort: { type: integer }
 *                     staggerMaxSec: { type: integer }
 *                     circuitBreakerThreshold: { type: integer }
 *                     version: { type: string }
 *                     datasource:
 *                       type: object
 *                       properties:
 *                         available: { type: boolean }
 *                         error: { type: string }
 *                         path: { type: string }
 *                         rows: { type: integer }
 *                         columns:
 *                           type: array
 *                           items: { type: string }
 */

/**
 * @swagger
 * /api/datasource/reload:
 *   post:
 *     summary: 重载数据源
 *     responses:
 *       '200':
 *         description: 重载后的数据源信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     available: { type: boolean }
 *                     rows: { type: integer }
 *                     columns:
 *                       type: array
 *                       items: { type: string }
 */

export function settingsRouter(deps: {
  cfg: AppConfig
  version: string
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void>; available: boolean; error: string; path: string }
}): Router {
  const router = Router()
  router.get('/settings', (req, res) => {
    const s = deps.datasource.summary()
    ok(res, {
      bitbrowserApiBase: deps.cfg.bitbrowser.apiBase,
      webPort: deps.cfg.web.port,
      staggerMaxSec: deps.cfg.execution.staggerMaxSec,
      circuitBreakerThreshold: deps.cfg.execution.circuitBreakerThreshold,
      version: deps.version,
      // 数据源状态：面板设置页展示（行数/列名/可用性），路径仅提示用途不泄密
      datasource: {
        available: deps.datasource.available,
        error: deps.datasource.error,
        path: deps.datasource.path,
        rows: s.rows,
        columns: s.columns,
      },
    } satisfies PublicSettings)
  })
  // 数据源重载：面板改完 xlsx 后点「重载」即时生效（无需重启服务）
  router.post('/datasource/reload', async (req, res) => {
    await deps.datasource.reload()
    const s = deps.datasource.summary()
    ok(res, { available: deps.datasource.available, rows: s.rows, columns: s.columns })
  })
  return router
}

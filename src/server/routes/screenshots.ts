/**
 * 截图路由（server 层）：按路径回传截图文件
 * 依赖方向：依赖 infrastructure/config；被 app 装配
 * 设计思路：路径穿越防护——resolve 后必须仍在截图根目录内（startsWith 前缀校验），
 * 文件不存在返回 404（截图可能因失败未生成）
 */
import { Router } from 'express'
import { resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import type { AppConfig } from '../../infrastructure/config'
import { fail, asyncHandler } from '../http/response'

export function screenshotsRouter(deps: { cfg: AppConfig }): Router {
  const router = Router()
  router.get('/screenshots', asyncHandler(async (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : ''
    const root = resolve(deps.cfg.storage.screenshotDir)
    const target = resolve(p)
    // 前缀校验 + sep：防止 /data/screenshots-evil 这类前缀绕过（startsWith 需含路径分隔符）
    if (!target.startsWith(root + sep) || !existsSync(target)) {
      fail(res, 404, 404, '截图不存在')
      return
    }
    res.sendFile(target)
  }))
  return router
}

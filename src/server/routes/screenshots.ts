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
    if (!target.startsWith(root + sep) || !existsSync(target)) {
      fail(res, 404, 404, '截图不存在')
      return
    }
    res.sendFile(target)
  }))
  return router
}

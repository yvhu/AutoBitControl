/**
 * 截图路由（server 层）：按路径回传截图文件
 * 依赖方向：依赖 infrastructure/config；被 app 装配
 * 设计思路：双重路径防护——realpath 解析符号链接后再做前缀校验（防 symlink 逃逸），
 * 比较前统一小写（Windows 盘符大小写）；文件不存在返回 404（截图可能因失败未生成）
 */
import { Router } from 'express'
import { resolve, sep } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import type { AppConfig } from '../../infrastructure/config'
import { fail, asyncHandler } from '../http/response'
import { ERROR_CODES } from '../http/errors'

/**
 * @swagger
 * /api/screenshots:
 *   get:
 *     summary: 取截图文件（path 传截图目录内相对路径，双层防护防目录穿越）
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema: { type: string }
 *         description: 截图目录内的相对路径
 *     responses:
 *       '200':
 *         description: 截图文件二进制流
 *         content:
 *           image/png:
 *             schema: { type: string, format: binary }
 *       '404':
 *         description: 截图不存在或路径越界（业务码 40403）
 */

export function screenshotsRouter(deps: { cfg: AppConfig }): Router {
  const router = Router()
  router.get('/screenshots', asyncHandler(async (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : ''
    const root = resolve(deps.cfg.storage.screenshotDir)
    const target = resolve(p)
    // realpath 解析符号链接（根目录或目标不存在视为 404）：链接指向根目录外时前缀校验拦截
    let rootReal: string
    let targetReal: string
    try {
      rootReal = realpathSync(root)
      targetReal = realpathSync(target)
    } catch {
      fail(res, 404, ERROR_CODES.SCREENSHOT_NOT_FOUND, '截图不存在')
      return
    }
    // 前缀校验 + sep + 统一小写：防 /data/screenshots-evil 前缀绕过与盘符大小写差异
    if (!targetReal.toLowerCase().startsWith((rootReal + sep).toLowerCase()) || !existsSync(target)) {
      fail(res, 404, ERROR_CODES.SCREENSHOT_NOT_FOUND, '截图不存在')
      return
    }
    res.sendFile(target)
  }))
  return router
}

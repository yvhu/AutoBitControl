/**
 * 验证码路由（server 层）：打码余额查询
 * 依赖方向：依赖依赖注入的余额查询函数（app 层提供，失败返回 null）；被 app 装配
 * 设计思路：未配置 clientKey 时返回 configured:false（前端显示"未配置 Key"），
 * 查询失败同样走 null 分支——面板展示容错优先
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'

/**
 * @swagger
 * /api/captcha/balance:
 *   get:
 *     summary: 打码余额（未配置 clientKey 或查询失败时 configured=false）
 *     responses:
 *       '200':
 *         description: 余额信息
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
 *                     configured: { type: boolean }
 *                     points: { type: number }
 *                     yuan: { type: number, description: '1000 点 = ¥1' }
 */

export function captchaRouter(deps: { captchaBalance: () => Promise<{ points: number } | null> }): Router {
  const router = Router()
  router.get('/captcha/balance', asyncHandler(async (req, res) => {
    const balance = await deps.captchaBalance()
    if (balance === null) {
      ok(res, { configured: false, points: 0, yuan: 0 })
      return
    }
    // 点 → 元换算：1000 点 = ¥1（yescaptcha 官方定价单位）
    ok(res, { configured: true, points: balance.points, yuan: Number((balance.points / 1000).toFixed(2)) })
  }))
  return router
}

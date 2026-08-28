/**
 * 比特浏览器路由（server 层）：本地 API 连接测试
 * 依赖方向：依赖注入的 health 探测函数；被 app 装配
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'

export function bitbrowserRouter(deps: { health: () => Promise<boolean> }): Router {
  const router = Router()
  // 面板"设置"页连接测试按钮：健康检查失败不抛错，返回 ok:false
  router.post('/bitbrowser/test', asyncHandler(async (req, res) => {
    ok(res, { ok: await deps.health() })
  }))
  return router
}

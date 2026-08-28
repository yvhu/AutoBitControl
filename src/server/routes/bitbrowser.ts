/**
 * 比特浏览器路由（server 层）：本地 API 连接测试 + 窗口列表同步
 * 依赖方向：依赖注入的 health/sync 函数（闭包由装配层构造，路由不碰 db）；被 app 装配
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'

export function bitbrowserRouter(deps: { health: () => Promise<boolean>; sync: () => Promise<number> }): Router {
  const router = Router()
  // 面板"设置"页连接测试按钮：健康检查失败不抛错，返回 ok:false
  router.post('/bitbrowser/test', asyncHandler(async (req, res) => {
    ok(res, { ok: await deps.health() })
  }))
  // 面板"窗口"页同步按钮：拉取比特浏览器窗口列表并写入 profiles 表，返回同步数量
  router.post('/bitbrowser/sync', asyncHandler(async (req, res) => {
    ok(res, { count: await deps.sync() })
  }))
  return router
}

/**
 * 窗口路由（server 层）：窗口列表、启用开关、整窗口重跑与熔断重置
 * 依赖方向：依赖 engine/infrastructure；被 app 装配
 * 设计思路：find 辅助统一 404 语义；PATCH 幂等局部更新（只改传了的字段）
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError } from '../http/error'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

export function profilesRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  /** 按内部 id 查窗口，不存在抛 404（各端点共用） */
  const find = (id: number): ProfileRow => {
    const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === id)
    if (!profile) throw new HttpError(404, `窗口不存在: ${id}`)
    return profile
  }
  router.get('/profiles', (req, res) => {
    ok(res, deps.db.listProfiles(false))
  })
  router.patch('/profiles/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const profile = find(id)
    const body = req.body as { enabled?: boolean } ?? {}
    // 只更新显式传入的字段：enabled 开关（钱包密码已改为环境变量 WALLET_PASSWORDS 配置，不在此处修改）
    if (typeof body.enabled === 'boolean') deps.db.setProfileEnabled(id, body.enabled)
    ok(res, profile)
  }))
  router.post('/profiles/:id/run', asyncHandler(async (req, res) => {
    const profile = find(Number(req.params.id))
    // 整窗口立即跑：全部启用任务入队（停用任务排除；CoalescingEnqueuer 自动合并为一次开窗会话）
    let count = 0
    for (const task of deps.tasks.values()) {
      if (task.meta.enabled === false) continue
      deps.enqueuer.enqueue(profile, task.meta.key)
      count++
    }
    ok(res, { count })
  }))
  router.post('/profiles/:id/breaker/reset', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    find(id)
    // 手动重置熔断：面板详情抽屉入口（连续失败恢复后放行）
    deps.db.resetCircuitBreaker(id)
    ok(res)
  }))
  return router
}

/**
 * 窗口路由（server 层）：窗口列表、启用开关、整窗口重跑与熔断重置
 * 依赖方向：依赖 engine/infrastructure；被 app 装配
 * 设计思路：find 辅助统一 404 语义；PATCH 幂等局部更新（只改传了的字段）
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

/**
 * @swagger
 * /api/profiles:
 *   get:
 *     summary: 窗口列表（含启用状态与熔断计数）
 *     responses:
 *       '200':
 *         description: 窗口列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       bitbrowserId: { type: string }
 *                       name: { type: string }
 *                       enabled: { type: integer, description: '0/1 开关' }
 *                       circuitBreakerCount: { type: integer }
 */

/**
 * @swagger
 * /api/profiles/{id}:
 *   patch:
 *     summary: 窗口开关（只更新显式传入的 enabled 字段）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *     responses:
 *       '200':
 *         description: 当前窗口记录快照（更新前的字段值）
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
 *                     id: { type: integer }
 *                     bitbrowserId: { type: string }
 *                     name: { type: string }
 *                     enabled: { type: integer }
 *                     circuitBreakerCount: { type: integer }
 *       '404':
 *         description: 窗口不存在（业务码 40402）
 */

/**
 * @swagger
 * /api/profiles/{id}/run:
 *   post:
 *     summary: 该窗口跑全部启用任务（停用任务排除，返回实际入队数）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     responses:
 *       '200':
 *         description: 入队完成
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
 *                     count: { type: integer, description: 实际入队任务数 }
 *       '404':
 *         description: 窗口不存在（业务码 40402）
 */

/**
 * @swagger
 * /api/profiles/{id}/breaker/reset:
 *   post:
 *     summary: 重置该窗口熔断计数
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     responses:
 *       '200':
 *         description: 已重置
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data: { nullable: true }
 *       '404':
 *         description: 窗口不存在（业务码 40402）
 */

export function profilesRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  /** 按内部 id 查窗口，不存在抛 404（各端点共用） */
  const find = async (id: number): Promise<ProfileRow> => {
    const profile = (await deps.db.listProfiles(false)).find((p: ProfileRow) => p.id === id)
    if (!profile) throw new HttpError(404, ERROR_CODES.PROFILE_NOT_FOUND, `窗口不存在: ${id}`)
    return profile
  }
  router.get('/profiles', asyncHandler(async (req, res) => {
    ok(res, await deps.db.listProfiles(false))
  }))
  router.patch('/profiles/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const profile = await find(id)
    const body = req.body as { enabled?: boolean } ?? {}
    // 只更新显式传入的字段：enabled 开关（钱包密码已改为环境变量 WALLET_PASSWORDS 配置，不在此处修改）
    if (typeof body.enabled === 'boolean') await deps.db.setProfileEnabled(id, body.enabled)
    ok(res, profile)
  }))
  router.post('/profiles/:id/run', asyncHandler(async (req, res) => {
    const profile = await find(Number(req.params.id))
    // 整窗口立即跑：全部启用任务入队（停用任务排除；CoalescingEnqueuer 自动合并为一次开窗会话）
    let count = 0
    for (const task of deps.tasks.values()) {
      if (!(await deps.db.getTaskEnabled(task.meta.key, task.meta.enabled ?? true))) continue
      deps.enqueuer.enqueue(profile, task.meta.key)
      count++
    }
    ok(res, { count })
  }))
  router.post('/profiles/:id/breaker/reset', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    await find(id)
    // 手动重置熔断：面板详情抽屉入口（连续失败恢复后放行）
    await deps.db.resetCircuitBreaker(id)
    ok(res)
  }))
  return router
}

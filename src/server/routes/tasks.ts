/**
 * 任务路由（server 层）：任务列表与手动触发
 * 依赖方向：依赖 engine/infrastructure；被 app 装配
 * 设计思路：GET 返回 meta 全字段（缺省字段补 null 保证前端取值的稳定性）；
 * POST trigger 支持单窗口（bitbrowserId）或全部启用窗口两种范围
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import { todayStr } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

/**
 * @swagger
 * /api/tasks:
 *   get:
 *     summary: 任务列表（meta 全字段 + 云端开关状态）
 *     responses:
 *       '200':
 *         description: 任务元信息列表
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
 *                       key: { type: string }
 *                       name: { type: string }
 *                       url: { type: string }
 *                       sourceUrl: { type: string, nullable: true, description: '信息来源页（string 或 string[]，多个页面分别核实不同步骤）' }
 *                       note: { type: string, nullable: true }
 *                       category: { type: string, nullable: true }
 *                       lastUpdated: { type: string, nullable: true }
 *                       deprecated: { type: boolean }
 *                       enabled: { type: boolean }
 *                       inFlight: { type: boolean, description: '是否有在途 run（当天 pending/running/retry_wait 或排队中的窗口会话）' }
 *                       wallet: { type: string, nullable: true }
 *                       timeoutSec: { type: integer, nullable: true }
 *                       retry:
 *                         type: object
 *                         nullable: true
 *                         properties:
 *                           max: { type: integer, description: 额外重试次数 }
 *                           backoffSec: { type: integer, description: 重试间隔（秒） }
 *                       captcha:
 *                         type: object
 *                         nullable: true
 *                         properties:
 *                           auto: { type: boolean, description: 是否自动打码 }
 *                           maxCost: { type: integer, description: 单任务费用上限（点） }
 */

/**
 * @swagger
 * /api/tasks/{key}:
 *   patch:
 *     summary: 任务开关（写云端 task_states，立即生效无需重启）
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *         description: 任务全局唯一 key
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *             required: [enabled]
 *     responses:
 *       '200':
 *         description: 开关已写入
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
 *                     key: { type: string }
 *                     enabled: { type: boolean }
 *       '400':
 *         description: enabled 非布尔值（业务码 40000）
 *       '404':
 *         description: 任务不存在（业务码 40401）
 */

/**
 * @swagger
 * /api/tasks/{key}/trigger:
 *   post:
 *     summary: 手动触发任务（可选指定单窗口）
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *         description: 任务全局唯一 key
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bitbrowserId:
 *                 type: string
 *                 description: 指定窗口 id（缺省跑全部启用窗口）
 *     responses:
 *       '200':
 *         description: 入队成功
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
 *                     scope: { type: string, enum: [single, all] }
 *       '404':
 *         description: 任务或窗口不存在（业务码 40401/40402）
 *       '409':
 *         description: 任务已停用（40901）或执行中（40902）
 */

export function tasksRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  router.get('/tasks', asyncHandler(async (req, res) => {
    const list = []
    for (const t of deps.tasks.values()) {
      const m = t.meta
      list.push({
        key: m.key,
        name: m.name,
        url: m.url,
        sourceUrl: m.sourceUrl ?? null,
        note: m.note ?? null,
        category: m.category ?? null,
        lastUpdated: m.lastUpdated ?? null,
        deprecated: m.deprecated ?? false,
        enabled: await deps.db.getTaskEnabled(m.key, m.enabled ?? true),
        inFlight: (await deps.db.countInFlightRuns(m.key, todayStr())) > 0 || deps.enqueuer.hasTaskInFlight(m.key),
        wallet: m.wallet ?? null,
        timeoutSec: m.timeoutSec ?? null,
        retry: m.retry ?? null,
        captcha: m.captcha ?? null,
      })
    }
    ok(res, list)
  }))
  router.patch('/tasks/:key', asyncHandler(async (req, res) => {
    const key = String(req.params.key)
    const body = (req.body ?? {}) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'enabled 必须为布尔值')
    if (!deps.tasks.has(key)) throw new HttpError(404, ERROR_CODES.TASK_NOT_FOUND, `任务不存在: ${key}`)
    await deps.db.setTaskEnabled(key, body.enabled)
    ok(res, { key, enabled: body.enabled })
  }))
  router.post('/tasks/:key/trigger', asyncHandler(async (req, res) => {
    const key = String(req.params.key)
    if (!deps.tasks.has(key)) throw new HttpError(404, ERROR_CODES.TASK_NOT_FOUND, `任务不存在: ${key}`)
    if (!(await deps.db.getTaskEnabled(key, deps.tasks.get(key)!.meta.enabled ?? true))) throw new HttpError(409, ERROR_CODES.TASK_DISABLED, '任务已停用')
    // Express 5 bodyless 请求时 req.body 可能为 undefined，统一 ?? {} 兜底
    const body = (req.body ?? {}) as { bitbrowserId?: string }
    // 指定窗口：单窗口触发（面板矩阵行级重跑）
    if (body.bitbrowserId) {
      const profile = (await deps.db.listProfiles(false)).find((p: ProfileRow) => p.bitbrowserId === body.bitbrowserId)
      if (!profile) throw new HttpError(404, ERROR_CODES.PROFILE_NOT_FOUND, `窗口不存在: ${body.bitbrowserId}`)
      if ((await deps.db.countInFlightRuns(key, todayStr(), profile.id)) > 0 || deps.enqueuer.hasTaskInFlight(key, profile.id)) {
        throw new HttpError(409, ERROR_CODES.TASK_RUNNING, '该窗口任务执行中，请等待结束后再触发')
      }
      deps.enqueuer.enqueue(profile, key, { immediate: true })
      ok(res, { scope: 'single' })
      return
    }
    // 未指定：全部启用窗口触发
    if ((await deps.db.countInFlightRuns(key, todayStr())) > 0 || deps.enqueuer.hasTaskInFlight(key)) {
      throw new HttpError(409, ERROR_CODES.TASK_RUNNING, '任务执行中，请等待全部窗口结束后再触发')
    }
    for (const p of await deps.db.listProfiles(true)) deps.enqueuer.enqueue(p, key)
    ok(res, { scope: 'all' })
  }))
  return router
}

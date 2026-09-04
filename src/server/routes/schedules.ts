/**
 * 定时计划路由（server 层）：计划的 CRUD 与「立即运行」
 * 依赖方向：依赖 engine/infrastructure；被 server/app 装配
 * 设计思路：GET 返回面板视图（config 解析为对象、任务名与规则摘要、下次执行已算好）；
 * 写接口先校验（mode/config/taskKeys 与任务注册表），失败 400；触发委托 Scheduler.runNow
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import type { AppDb, ScheduleRow } from '../../infrastructure/db'
import type { SiteTask } from '../../tasks/base'
import { ruleText, nextRunText, validateScheduleConfig, type ScheduleConfig, type ScheduleMode } from '../../engine/schedule'
import type { RunNowResult } from '../../engine/scheduler'

const MODES: ScheduleMode[] = ['interval', 'daily', 'weekly', 'monthly']

/** 计划行 → 面板视图（config 解析 + 任务名 + 规则摘要 + 下次执行） */
function toView(deps: { tasks: Map<string, SiteTask>; timezone: string }, s: ScheduleRow) {
  const config = JSON.parse(s.config) as ScheduleConfig
  const taskKeys = JSON.parse(s.taskKeys) as string[]
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled === 1,
    mode: s.mode as ScheduleMode,
    config,
    taskKeys,
    taskNames: taskKeys.map((k) => deps.tasks.get(k)?.meta.name ?? null),
    ruleText: ruleText(s.mode as ScheduleMode, config),
    nextRun: nextRunText(s.mode as ScheduleMode, config, deps.timezone),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

/** 校验请求体并解析出写入参数；非法抛 400 */
function parseBody(deps: { tasks: Map<string, SiteTask> }, body: Record<string, unknown>, existing?: ScheduleRow): { name?: string; enabled?: boolean; mode?: ScheduleMode; config?: ScheduleConfig; taskKeys?: string[] } {
  const out: { name?: string; enabled?: boolean; mode?: ScheduleMode; config?: ScheduleConfig; taskKeys?: string[] } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '计划名称不能为空')
    out.name = body.name.trim()
  } else if (!existing) {
    throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'name 必填')
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'enabled 必须为布尔值')
    out.enabled = body.enabled
  }
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode as ScheduleMode)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'mode 非法')
    out.mode = body.mode as ScheduleMode
  }
  if (body.config !== undefined) {
    out.config = body.config as ScheduleConfig
  }
  if (body.taskKeys !== undefined) {
    if (!Array.isArray(body.taskKeys) || body.taskKeys.length === 0 || !body.taskKeys.every((k) => typeof k === 'string')) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKeys 必须为非空字符串数组')
    }
    out.taskKeys = body.taskKeys as string[]
  } else if (!existing) {
    throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKeys 必填')
  }
  // 合成最终 mode/config 做整体校验（新建与局部更新同规则）
  const finalMode = out.mode ?? (existing?.mode as ScheduleMode | undefined)
  const finalConfig = out.config ?? (existing ? (JSON.parse(existing.config) as ScheduleConfig) : undefined)
  if (!finalMode) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'mode 必填')
  const err = validateScheduleConfig(finalMode, finalConfig ?? {})
  if (err) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, err)
  // 任务 key 必须已注册（与手动触发同守卫，不引用幽灵任务）
  if (out.taskKeys !== undefined) {
    for (const k of out.taskKeys) {
      if (!deps.tasks.has(k)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `任务不存在: ${k}`)
    }
  }
  return out
}

/**
 * @swagger
 * /api/schedules:
 *   get:
 *     summary: 定时计划列表（面板视图）
 *     responses:
 *       '200':
 *         description: 计划列表
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
 *                       name: { type: string }
 *                       enabled: { type: boolean }
 *                       mode: { type: string, enum: [interval, daily, weekly, monthly] }
 *                       config:
 *                         type: object
 *                         properties:
 *                           everyHours: { type: integer, nullable: true }
 *                           times: { type: array, nullable: true, items: { type: string } }
 *                           weekdays: { type: array, nullable: true, items: { type: integer } }
 *                           days: { type: array, nullable: true, items: { type: integer } }
 *                       taskKeys: { type: array, items: { type: string } }
 *                       taskNames:
 *                         type: array
 *                         description: 与 taskKeys 对齐的任务显示名，未知 key 为 null
 *                         items: { type: string, nullable: true }
 *                       ruleText: { type: string, description: '触发规则摘要' }
 *                       nextRun: { type: string, description: '下次执行的墙上时间文本' }
 *                       createdAt: { type: string }
 *                       updatedAt: { type: string }
 */

/**
 * @swagger
 * /api/schedules:
 *   post:
 *     summary: 新建定时计划
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               mode: { type: string, enum: [interval, daily, weekly, monthly] }
 *               config:
 *                 type: object
 *                 properties:
 *                   everyHours: { type: integer, nullable: true }
 *                   times: { type: array, nullable: true, items: { type: string } }
 *                   weekdays: { type: array, nullable: true, items: { type: integer } }
 *                   days: { type: array, nullable: true, items: { type: integer } }
 *               taskKeys: { type: array, items: { type: string } }
 *             required: [name, mode, taskKeys]
 *     responses:
 *       '200':
 *         description: 新建成功（返回面板视图）
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
 *                     name: { type: string }
 *                     enabled: { type: boolean }
 *                     mode: { type: string, enum: [interval, daily, weekly, monthly] }
 *                     config:
 *                       type: object
 *                       properties:
 *                         everyHours: { type: integer, nullable: true }
 *                         times: { type: array, nullable: true, items: { type: string } }
 *                         weekdays: { type: array, nullable: true, items: { type: integer } }
 *                         days: { type: array, nullable: true, items: { type: integer } }
 *                     taskKeys: { type: array, items: { type: string } }
 *                     taskNames: { type: array, items: { type: string, nullable: true } }
 *                     ruleText: { type: string }
 *                     nextRun: { type: string }
 *                     createdAt: { type: string }
 *                     updatedAt: { type: string }
 *       '400':
 *         description: 参数校验失败（业务码 40000）
 */

/**
 * @swagger
 * /api/schedules/{id}:
 *   patch:
 *     summary: 更新定时计划（字段可部分传）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 计划 id
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               enabled: { type: boolean }
 *               mode: { type: string, enum: [interval, daily, weekly, monthly] }
 *               config:
 *                 type: object
 *                 nullable: true
 *                 properties:
 *                   everyHours: { type: integer, nullable: true }
 *                   times: { type: array, nullable: true, items: { type: string } }
 *                   weekdays: { type: array, nullable: true, items: { type: integer } }
 *                   days: { type: array, nullable: true, items: { type: integer } }
 *               taskKeys: { type: array, items: { type: string } }
 *     responses:
 *       '200':
 *         description: 更新成功（返回面板视图）
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
 *                     name: { type: string }
 *                     enabled: { type: boolean }
 *                     mode: { type: string, enum: [interval, daily, weekly, monthly] }
 *                     config:
 *                       type: object
 *                       properties:
 *                         everyHours: { type: integer, nullable: true }
 *                         times: { type: array, nullable: true, items: { type: string } }
 *                         weekdays: { type: array, nullable: true, items: { type: integer } }
 *                         days: { type: array, nullable: true, items: { type: integer } }
 *                     taskKeys: { type: array, items: { type: string } }
 *                     taskNames: { type: array, items: { type: string, nullable: true } }
 *                     ruleText: { type: string }
 *                     nextRun: { type: string }
 *                     createdAt: { type: string }
 *                     updatedAt: { type: string }
 *       '400':
 *         description: 参数校验失败（业务码 40000）
 *       '404':
 *         description: 计划不存在（业务码 40406）
 */

/**
 * @swagger
 * /api/schedules/{id}:
 *   delete:
 *     summary: 删除定时计划
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 计划 id
 *     responses:
 *       '200':
 *         description: 删除成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data: { nullable: true }
 *       '404':
 *         description: 计划不存在（业务码 40406）
 */

/**
 * @swagger
 * /api/schedules/{id}/run:
 *   post:
 *     summary: 立即运行定时计划
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 计划 id
 *     responses:
 *       '200':
 *         description: 触发成功
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
 *                     taskKeys: { type: array, items: { type: string } }
 *                     skipped:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           taskKey: { type: string }
 *                           reason: { type: string, enum: [unknown-task, task-disabled, in-flight] }
 *       '404':
 *         description: 计划不存在（业务码 40406）
 *       '409':
 *         description: 计划已停用（业务码 40903）
 */

export function schedulesRouter(deps: { db: AppDb; scheduler: { runNow(s: ScheduleRow): Promise<RunNowResult> }; tasks: Map<string, SiteTask>; timezone: string }): Router {
  const router = Router()
  router.get('/schedules', asyncHandler(async (_req, res) => {
    const list = []
    for (const s of await deps.db.listSchedules()) {
      try {
        list.push(toView(deps, s))
      } catch {
        // 落库 JSON 损坏的计划跳过展示（防御；正常写入路径不会产生）
      }
    }
    ok(res, list)
  }))
  router.post('/schedules', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const parsed = parseBody(deps, body)
    const s = await deps.db.createSchedule({
      name: parsed.name!,
      mode: parsed.mode!,
      config: JSON.stringify(parsed.config),
      taskKeys: JSON.stringify(parsed.taskKeys),
    })
    ok(res, toView(deps, s))
  }))
  router.patch('/schedules/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    const existing = await deps.db.getSchedule(id)
    if (!existing) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    const parsed = parseBody(deps, (req.body ?? {}) as Record<string, unknown>, existing)
    const s = await deps.db.updateSchedule(id, {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      ...(parsed.config !== undefined ? { config: JSON.stringify(parsed.config) } : {}),
      ...(parsed.taskKeys !== undefined ? { taskKeys: JSON.stringify(parsed.taskKeys) } : {}),
    })
    ok(res, toView(deps, s!))
  }))
  router.delete('/schedules/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const deleted = Number.isInteger(id) && id > 0 ? await deps.db.deleteSchedule(id) : false
    if (!deleted) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    ok(res, null)
  }))
  router.post('/schedules/:id/run', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const s = Number.isInteger(id) && id > 0 ? await deps.db.getSchedule(id) : null
    if (!s) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    if (s.enabled !== 1) throw new HttpError(409, ERROR_CODES.SCHEDULE_DISABLED, '计划已停用')
    ok(res, await deps.scheduler.runNow(s))
  }))
  return router
}

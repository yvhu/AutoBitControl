/**
 * 批次路由（server 层）：运行批次列表与明细（看板批次时间线数据源）
 * 依赖方向：依赖 infrastructure/db 与 engine/queue，被 app 装配
 * 设计思路：列表接口轻量（仅批次行 + 聚合统计 + 全局数字）供 15s 轮询；
 *           明细接口懒加载（展开窗口明细时请求）
 */
import { Router } from 'express'
import { todayStr, type AppDb } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'
import { ok, asyncHandler } from '../http/response'
import { HttpError } from '../http/errors'

/** 运行耗时（秒）：started/finished 任一缺失或解析失败返回 null（墙钟字符串解析与重试恢复同口径） */
function runDurationSec(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null
  const s = new Date(startedAt.replace(' ', 'T')).getTime()
  const f = new Date(finishedAt.replace(' ', 'T')).getTime()
  if (Number.isNaN(s) || Number.isNaN(f)) return null
  return Math.round((f - s) / 1000)
}

/** 7 天前的日期字符串（本地时区） */
function daysAgoStr(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return todayStr(d)
}

/**
 * @swagger
 * /api/batches:
 *   get:
 *     summary: 运行批次列表（含每批统计与全局数字）
 *     parameters:
 *       - in: query
 *         name: range
 *         schema: { type: string, enum: [today, 7d, all] }
 *         description: 时间范围（缺省 today）
 *     responses:
 *       '200':
 *         description: 批次列表
 */

/**
 * @swagger
 * /api/batches/{id}:
 *   get:
 *     summary: 批次明细（窗口运行行）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       '200':
 *         description: 批次明细
 */
export function batchesRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  router.get('/batches', asyncHandler(async (req, res) => {
    const range = typeof req.query.range === 'string' ? req.query.range : 'today'
    const today = todayStr()
    const from = range === 'all' ? null : range === '7d' ? daysAgoStr(6) : today
    const batches = await deps.db.listBatchesForRange(from, today)
    const unbatched = await deps.db.listUnbatchedRuns(from, today)
    // 实时运行：DB 在途行数（跨任务）+ 队列错峰等待窗口数（尚未开窗落库）
    let running = 0
    for (const key of deps.tasks.keys()) {
      running += await deps.db.countInFlightRuns(key, today)
    }
    running += deps.enqueuer.pendingCount()
    const taskNames: Record<string, string> = {}
    for (const [key, t] of deps.tasks) taskNames[key] = t.meta.name
    ok(res, {
      range,
      batches,
      unbatched,
      running,
      captchaToday: await deps.db.captchaStats(today),
      taskNames,
      today,
    })
  }))
  router.get('/batches/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 40001, '批次 id 必须为正整数')
    const batch = await deps.db.getBatch(id)
    if (!batch) throw new HttpError(404, 40401, '批次不存在')
    const rows = await deps.db.listRunsForBatch(id)
    ok(res, {
      batch,
      runs: await Promise.all(rows.map(async (r) => ({
        ...r,
        durationSec: runDurationSec(r.startedAt, r.finishedAt),
        inFlight: (await deps.db.countInFlightRuns(r.taskKey, todayStr(), r.profileId)) > 0 || deps.enqueuer.hasTaskInFlight(r.taskKey, r.profileId),
      }))),
    })
  }))
  return router
}

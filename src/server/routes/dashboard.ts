/**
 * 看板路由（server 层）：今日运行统计与矩阵数据
 * 依赖方向：依赖 infrastructure/db；被 app 装配
 * 设计思路：一次请求返回看板所需的全部数据（统计/矩阵/窗口/打码成本），前端一次渲染
 */
import { Router } from 'express'
import { todayStr, type AppDb, type RunStatus } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import { ok, asyncHandler } from '../http/response'

/**
 * @swagger
 * /api/dashboard:
 *   get:
 *     summary: 看板全部数据（统计/矩阵/窗口/打码成本）
 *     parameters:
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *         description: 查询日期 YYYY-MM-DD（缺省今天）
 *     responses:
 *       '200':
 *         description: 看板数据
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
 *                     date: { type: string, format: date }
 *                     stats:
 *                       type: object
 *                       properties:
 *                         total: { type: integer }
 *                         success: { type: integer }
 *                         failed: { type: integer }
 *                         captchaFailed: { type: integer }
 *                         skipped: { type: integer }
 *                         running: { type: integer }
 *                         pending: { type: integer }
 *                     runs:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           profileId: { type: integer }
 *                           taskKey: { type: string }
 *                           date: { type: string }
 *                           status: { type: string, enum: [pending, running, success, failed, captcha_failed, skipped, retry_wait] }
 *                           attempts: { type: integer }
 *                           error: { type: string, nullable: true }
 *                           screenshot: { type: string, nullable: true }
 *                           startedAt: { type: string, nullable: true }
 *                           slot: { type: number }
 *                           finishedAt: { type: string, nullable: true }
 *                           durationSec: { type: integer, nullable: true, description: '总耗时（秒）；startedAt/finishedAt 任一缺失为 null' }
 *                           profileName: { type: string }
 *                           inFlight: { type: boolean, description: '该窗口该任务是否有在途 run（当天 pending/running/retry_wait 或排队会话）' }
 *                     profiles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           bitbrowserId: { type: string }
 *                           name: { type: string }
 *                           enabled: { type: integer, description: '0/1 开关' }
 *                           circuitBreakerCount: { type: integer }
 *                     captcha:
 *                       type: object
 *                       properties:
 *                         count: { type: integer }
 *                         totalCost: { type: number }
 *                     profilesTotal: { type: integer }
 *                     profilesEnabled: { type: integer }
 */

/** 运行耗时（秒）：started/finished 任一缺失或解析失败返回 null（墙钟字符串解析与重试恢复同口径） */
function runDurationSec(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null
  const s = new Date(startedAt.replace(' ', 'T')).getTime()
  const f = new Date(finishedAt.replace(' ', 'T')).getTime()
  if (Number.isNaN(s) || Number.isNaN(f)) return null
  return Math.round((f - s) / 1000)
}

export function dashboardRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer }): Router {
  const router = Router()
  router.get('/dashboard', asyncHandler(async (req, res) => {
    // date 查询参数缺省为今天（面板日期切换用）
    const date = typeof req.query.date === 'string' ? req.query.date : todayStr()
    const rows = await deps.db.listRunsForDate(date)
    const runs = await Promise.all(rows.map(async (r) => ({
      ...r,
      durationSec: runDurationSec(r.startedAt, r.finishedAt),
      inFlight: (await deps.db.countInFlightRuns(r.taskKey, date, r.profileId)) > 0 || deps.enqueuer.hasTaskInFlight(r.taskKey, r.profileId),
    })))
    const count = (s: RunStatus) => runs.filter(r => r.status === s).length
    const profiles = await deps.db.listProfiles(false)
    ok(res, {
      date,
      stats: {
        total: runs.length,
        success: count('success'),
        failed: count('failed'),
        captchaFailed: count('captcha_failed'),
        skipped: count('skipped'),
        // 执行中口径：running 与 retry_wait 都算"进行中"
        running: count('running') + count('retry_wait'),
        pending: count('pending'),
      },
      runs,
      profiles,
      captcha: await deps.db.captchaStats(date),
      profilesTotal: profiles.length,
      profilesEnabled: profiles.filter(p => p.enabled === 1).length,
    })
  }))
  return router
}

/**
 * 运行记录路由（server 层）：失败重跑
 * 依赖方向：依赖 engine/infrastructure；被 app 装配
 * 设计思路：只重跑 failed/captcha_failed 两类终态（成功与跳过不动），
 * 返回重跑条数供前端提示
 */
import { Router } from 'express'
import { todayStr, type AppDb, type ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import { ok, asyncHandler } from '../http/response'

/**
 * @swagger
 * /api/runs/rerun-failed:
 *   post:
 *     summary: 当日最新轮失败记录重新入队（failed/captcha_failed 两类终态；历史失败轮已被后续轮次取代则不重跑；在途任务跳过）
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               date:
 *                 type: string
 *                 format: date
 *                 description: 指定日期 YYYY-MM-DD（缺省今天）
 *     responses:
 *       '200':
 *         description: 重跑条数
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
 *                     count: { type: integer, description: 重新入队的失败条数 }
 */

export function runsRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer }): Router {
  const router = Router()
  router.post('/runs/rerun-failed', asyncHandler(async (req, res) => {
    // date 缺省今天；body 里可传指定日期（面板日期切换后重跑对应日）
    // Express 5 bodyless 请求时 req.body 可能为 undefined，统一 ?? {} 兜底
    const body = (req.body ?? {}) as { date?: unknown }
    const date = typeof body.date === 'string' ? body.date : todayStr()
    const rows = await deps.db.listRunsForDate(date)
    // 按 (窗口, 任务) 取最新轮（与看板顶层行同口径）：只重跑最新轮失败的任务，
    // 历史失败轮已被后续轮次取代则不重跑（否则会与后续轮重复执行）
    const latestByKey = new Map<string, (typeof rows)[number]>()
    for (const r of rows) {
      const k = `${r.profileId}:${r.taskKey}`
      const cur = latestByKey.get(k)
      if (!cur || r.slot > cur.slot) latestByKey.set(k, r)
    }
    const profiles = await deps.db.listProfiles(false)
    let count = 0
    for (const r of latestByKey.values()) {
      if (r.status !== 'failed' && r.status !== 'captcha_failed') continue
      const profile = profiles.find((p: ProfileRow) => p.id === r.profileId)
      // 窗口已删除则跳过（重跑只对现存窗口生效）
      if (!profile) continue
      // 在途守卫：该窗口该任务正在跑（DB 在途行或队列会话）时跳过，避免 followUp 重复一轮
      if ((await deps.db.countInFlightRuns(r.taskKey, date, r.profileId)) > 0 || deps.enqueuer.hasTaskInFlight(r.taskKey, r.profileId)) continue
      deps.enqueuer.enqueue(profile, r.taskKey)
      count++
    }
    ok(res, { count })
  }))
  return router
}

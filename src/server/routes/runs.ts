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

export function runsRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer }): Router {
  const router = Router()
  router.post('/runs/rerun-failed', asyncHandler(async (req, res) => {
    // date 缺省今天；body 里可传指定日期（面板日期切换后重跑对应日）
    const date = typeof req.body?.date === 'string' ? req.body.date : todayStr()
    const failed = deps.db.listRunsForDate(date).filter(r => r.status === 'failed' || r.status === 'captcha_failed')
    for (const r of failed) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === r.profileId)
      // 窗口已删除则跳过（重跑只对现存窗口生效）
      if (profile) deps.enqueuer.enqueue(profile, r.taskKey)
    }
    ok(res, { count: failed.length })
  }))
  return router
}

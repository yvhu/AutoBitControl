import { Router } from 'express'
import { todayStr, type AppDb, type ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import { ok, asyncHandler } from '../http/response'

export function runsRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer }): Router {
  const router = Router()
  router.post('/runs/rerun-failed', asyncHandler(async (req, res) => {
    const date = typeof req.body?.date === 'string' ? req.body.date : todayStr()
    const failed = deps.db.listRunsForDate(date).filter(r => r.status === 'failed' || r.status === 'captcha_failed')
    for (const r of failed) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === r.profileId)
      if (profile) deps.enqueuer.enqueue(profile, r.taskKey)
    }
    ok(res, { count: failed.length })
  }))
  return router
}

import { Router } from 'express'
import { todayStr, type AppDb, type RunStatus } from '../../infrastructure/db'
import type { SiteTask } from '../../tasks/base'
import { ok, asyncHandler } from '../http/response'

const COUNTED: RunStatus[] = ['success', 'failed', 'captcha_failed', 'skipped', 'running', 'retry_wait', 'pending']

export function dashboardRouter(deps: { db: AppDb; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  router.get('/dashboard', asyncHandler(async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : todayStr()
    const runs = deps.db.listRunsForDate(date)
    const count = (s: RunStatus) => runs.filter(r => r.status === s).length
    const profiles = deps.db.listProfiles(false)
    ok(res, {
      date,
      stats: {
        total: runs.length,
        success: count('success'),
        failed: count('failed'),
        captchaFailed: count('captcha_failed'),
        skipped: count('skipped'),
        running: count('running') + count('retry_wait'),
        pending: count('pending'),
      },
      runs,
      profiles,
      captcha: deps.db.captchaStats(date),
      profilesTotal: profiles.length,
      profilesEnabled: profiles.filter(p => p.enabled === 1).length,
    })
  }))
  return router
}

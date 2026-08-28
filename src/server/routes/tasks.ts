import { Router } from 'express'
import { ok, fail, asyncHandler } from '../http/response'
import { HttpError } from '../http/error'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

export function tasksRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  router.get('/tasks', (req, res) => {
    ok(res, [...deps.tasks.values()].map(t => {
      const m = t.meta
      return {
        key: m.key,
        name: m.name,
        url: m.url,
        sourceUrl: m.sourceUrl ?? null,
        note: m.note ?? null,
        category: m.category ?? null,
        lastUpdated: m.lastUpdated ?? null,
        deprecated: m.deprecated ?? false,
        wallet: m.wallet ?? null,
        schedule: m.schedule ?? null,
        timeoutSec: m.timeoutSec ?? null,
        retry: m.retry ?? null,
        captcha: m.captcha ?? null,
      }
    }))
  })
  router.post('/tasks/:key/trigger', asyncHandler(async (req, res) => {
    const key = String(req.params.key)
    if (!deps.tasks.has(key)) throw new HttpError(404, `任务不存在: ${key}`)
    const { bitbrowserId } = req.body as { bitbrowserId?: string } ?? {}
    if (bitbrowserId) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.bitbrowserId === bitbrowserId)
      if (!profile) throw new HttpError(404, `窗口不存在: ${bitbrowserId}`)
      deps.enqueuer.enqueue(profile, key)
      ok(res, { scope: 'single' })
      return
    }
    for (const p of deps.db.listProfiles(true)) deps.enqueuer.enqueue(p, key)
    ok(res, { scope: 'all' })
  }))
  return router
}

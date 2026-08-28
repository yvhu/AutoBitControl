import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError } from '../http/error'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

export function profilesRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  const find = (id: number): ProfileRow => {
    const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === id)
    if (!profile) throw new HttpError(404, `窗口不存在: ${id}`)
    return profile
  }
  router.get('/profiles', (req, res) => {
    ok(res, deps.db.listProfiles(false))
  })
  router.patch('/profiles/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const profile = find(id)
    const body = req.body as { enabled?: boolean; password?: string | null } ?? {}
    if (typeof body.enabled === 'boolean') deps.db.setProfileEnabled(id, body.enabled)
    if (body.password !== undefined) deps.db.setProfileWalletPassword(id, body.password)
    ok(res, profile)
  }))
  router.post('/profiles/:id/run', asyncHandler(async (req, res) => {
    const profile = find(Number(req.params.id))
    for (const task of deps.tasks.values()) deps.enqueuer.enqueue(profile, task.meta.key)
    ok(res, { count: deps.tasks.size })
  }))
  router.post('/profiles/:id/breaker/reset', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    find(id)
    deps.db.resetCircuitBreaker(id)
    ok(res)
  }))
  return router
}

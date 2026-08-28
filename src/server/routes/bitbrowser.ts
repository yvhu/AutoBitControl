import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'

export function bitbrowserRouter(deps: { health: () => Promise<boolean> }): Router {
  const router = Router()
  router.post('/bitbrowser/test', asyncHandler(async (req, res) => {
    ok(res, { ok: await deps.health() })
  }))
  return router
}

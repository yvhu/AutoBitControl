import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'

export function captchaRouter(deps: { captchaBalance: () => Promise<{ points: number } | null> }): Router {
  const router = Router()
  router.get('/captcha/balance', asyncHandler(async (req, res) => {
    const balance = await deps.captchaBalance()
    if (balance === null) {
      ok(res, { configured: false, points: 0, yuan: 0 })
      return
    }
    ok(res, { configured: true, points: balance.points, yuan: Number((balance.points / 1000).toFixed(2)) })
  }))
  return router
}

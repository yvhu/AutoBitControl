/**
 * 看板路由（server 层）：今日运行统计与矩阵数据
 * 依赖方向：依赖 infrastructure/db；被 app 装配
 * 设计思路：一次请求返回看板所需的全部数据（统计/矩阵/窗口/打码成本），前端一次渲染
 */
import { Router } from 'express'
import { todayStr, type AppDb, type RunStatus } from '../../infrastructure/db'
import { ok, asyncHandler } from '../http/response'

export function dashboardRouter(deps: { db: AppDb }): Router {
  const router = Router()
  router.get('/dashboard', asyncHandler(async (req, res) => {
    // date 查询参数缺省为今天（面板日期切换用）
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
        // 执行中口径：running 与 retry_wait 都算"进行中"
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

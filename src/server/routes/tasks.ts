/**
 * 任务路由（server 层）：任务列表与手动触发
 * 依赖方向：依赖 engine/infrastructure；被 app 装配
 * 设计思路：GET 返回 meta 全字段（缺省字段补 null 保证前端取值的稳定性）；
 * POST trigger 支持单窗口（bitbrowserId）或全部启用窗口两种范围
 */
import { Router } from 'express'
import { ok, fail, asyncHandler } from '../http/response'
import { HttpError } from '../http/error'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

export function tasksRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask>; onToggle?: (key: string, enabled: boolean) => void }): Router {
  const router = Router()
  router.get('/tasks', asyncHandler(async (req, res) => {
    const list = []
    for (const t of deps.tasks.values()) {
      const m = t.meta
      list.push({
        key: m.key,
        name: m.name,
        url: m.url,
        sourceUrl: m.sourceUrl ?? null,
        note: m.note ?? null,
        category: m.category ?? null,
        lastUpdated: m.lastUpdated ?? null,
        deprecated: m.deprecated ?? false,
        enabled: await deps.db.getTaskEnabled(m.key, m.enabled ?? true),
        wallet: m.wallet ?? null,
        schedule: m.schedule ?? null,
        timeoutSec: m.timeoutSec ?? null,
        retry: m.retry ?? null,
        captcha: m.captcha ?? null,
      })
    }
    ok(res, list)
  }))
  router.patch('/tasks/:key', asyncHandler(async (req, res) => {
    const key = String(req.params.key)
    const body = (req.body ?? {}) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须为布尔值')
    if (!deps.tasks.has(key)) throw new HttpError(404, `任务不存在: ${key}`)
    await deps.db.setTaskEnabled(key, body.enabled)
    // 通知调度器即时刷新该任务的 cron（停用即停、启用即注册，无需重启）
    deps.onToggle?.(key, body.enabled)
    ok(res, { key, enabled: body.enabled })
  }))
  router.post('/tasks/:key/trigger', asyncHandler(async (req, res) => {
    const key = String(req.params.key)
    if (!deps.tasks.has(key)) throw new HttpError(404, `任务不存在: ${key}`)
    if (!(await deps.db.getTaskEnabled(key, deps.tasks.get(key)!.meta.enabled ?? true))) throw new HttpError(409, '任务已停用')
    // Express 5 bodyless 请求时 req.body 可能为 undefined，统一 ?? {} 兜底
    const body = (req.body ?? {}) as { bitbrowserId?: string }
    // 指定窗口：单窗口触发（面板矩阵行级重跑）
    if (body.bitbrowserId) {
      const profile = (await deps.db.listProfiles(false)).find((p: ProfileRow) => p.bitbrowserId === body.bitbrowserId)
      if (!profile) throw new HttpError(404, `窗口不存在: ${body.bitbrowserId}`)
      deps.enqueuer.enqueue(profile, key)
      ok(res, { scope: 'single' })
      return
    }
    // 未指定：全部启用窗口触发
    for (const p of await deps.db.listProfiles(true)) deps.enqueuer.enqueue(p, key)
    ok(res, { scope: 'all' })
  }))
  return router
}

import express from 'express'
import { join, dirname, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { todayStr, type AppDb, type ProfileRow, type RunStatus } from '../infrastructure/db'
import type { CoalescingEnqueuer } from '../engine/queue'
import type { SiteTask } from '../tasks/base'
import type { AppConfig } from '../infrastructure/config'

export interface WebDeps {
  db: AppDb
  enqueuer: CoalescingEnqueuer
  tasks: Map<string, SiteTask>
  cfg: AppConfig
  bitbrowser: { health(): Promise<boolean> }
  captchaBalance: () => Promise<{ points: number } | null>
}

const COUNTED: RunStatus[] = ['success', 'failed', 'captcha_failed', 'skipped', 'running', 'retry_wait', 'pending']

export function createApp(deps: WebDeps): express.Express {
  const app = express()
  app.use(express.json())

  app.get('/api/dashboard', (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : todayStr()
    const runs = deps.db.listRunsForDate(date)
    const count = (s: RunStatus) => runs.filter(r => r.status === s).length
    const profiles = deps.db.listProfiles(false)
    res.json({
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
      tasks: [...deps.tasks.values()].map(t => ({
        key: t.meta.key,
        name: t.meta.name,
        wallet: t.meta.wallet ?? null,
        schedule: t.meta.schedule ?? null,
        timeoutSec: t.meta.timeoutSec ?? null,
        retry: t.meta.retry ?? null,
        captcha: t.meta.captcha ?? null,
      })),
    })
  })

  app.post('/api/trigger', (req, res) => {
    const { taskKey, bitbrowserId } = req.body as { taskKey?: string; bitbrowserId?: string }
    if (!taskKey) {
      res.status(400).json({ ok: false, error: '缺少 taskKey' })
      return
    }
    if (bitbrowserId) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.bitbrowserId === bitbrowserId)
      if (!profile) {
        res.status(404).json({ ok: false, error: `窗口不存在: ${bitbrowserId}` })
        return
      }
      deps.enqueuer.enqueue(profile, taskKey)
      res.json({ ok: true, scope: 'single' })
      return
    }
    for (const p of deps.db.listProfiles(true)) deps.enqueuer.enqueue(p, taskKey)
    res.json({ ok: true, scope: 'all' })
  })

  app.post('/api/rerun-failed', (req, res) => {
    const date = typeof req.body?.date === 'string' ? req.body.date : todayStr()
    const failed = deps.db.listRunsForDate(date).filter(r => r.status === 'failed' || r.status === 'captcha_failed')
    for (const r of failed) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === r.profileId)
      if (profile) deps.enqueuer.enqueue(profile, r.taskKey)
    }
    res.json({ ok: true, count: failed.length })
  })

  app.post('/api/profile/:id/toggle', (req, res) => {
    const id = Number(req.params.id)
    const enabled = Boolean(req.body?.enabled)
    deps.db.setProfileEnabled(id, enabled)
    res.json({ ok: true })
  })

  app.post('/api/profile/:id/run', (req, res) => {
    const id = Number(req.params.id)
    const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === id)
    if (!profile) {
      res.status(404).json({ ok: false, error: `窗口不存在: ${id}` })
      return
    }
    for (const task of deps.tasks.values()) deps.enqueuer.enqueue(profile, task.meta.key)
    res.json({ ok: true, count: deps.tasks.size })
  })

  app.post('/api/profile/:id/password', (req, res) => {
    const id = Number(req.params.id)
    const { password } = req.body as { password?: string | null }
    deps.db.setProfileWalletPassword(id, password ?? null)
    res.json({ ok: true })
  })

  app.post('/api/profile/:id/reset-breaker', (req, res) => {
    deps.db.resetCircuitBreaker(Number(req.params.id))
    res.json({ ok: true })
  })

  app.post('/api/bitbrowser/test', async (req, res) => {
    try {
      const ok = await deps.bitbrowser.health()
      res.json({ ok })
    } catch {
      res.json({ ok: false })
    }
  })

  app.get('/api/captcha/balance', async (req, res) => {
    try {
      const balance = await deps.captchaBalance()
      if (balance === null) {
        res.json({ configured: false, points: 0, yuan: 0 })
        return
      }
      res.json({ configured: true, points: balance.points, yuan: Number((balance.points / 1000).toFixed(2)) })
    } catch {
      res.json({ configured: false, points: 0, yuan: 0 })
    }
  })

  app.get('/api/screenshot', (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : ''
    const root = resolve(deps.cfg.storage.screenshotDir)
    const target = resolve(p)
    if (!target.startsWith(root + sep) || !existsSync(target)) {
      res.status(404).json({ ok: false, error: '截图不存在' })
      return
    }
    res.sendFile(target)
  })

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public')
  app.use(express.static(publicDir))
  return app
}

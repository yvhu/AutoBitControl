import express from 'express'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppDb } from '../infrastructure/db'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { CoalescingEnqueuer } from '../engine/queue'
import type { SiteTask } from '../tasks/base'
import { dashboardRouter } from './routes/dashboard'
import { tasksRouter } from './routes/tasks'
import { profilesRouter } from './routes/profiles'
import { runsRouter } from './routes/runs'
import { captchaRouter } from './routes/captcha'
import { bitbrowserRouter } from './routes/bitbrowser'
import { screenshotsRouter } from './routes/screenshots'
import { docsRouter } from './routes/docs'
import { notFoundHandler, errorHandler } from './http/error'

export interface ServerDeps {
  db: AppDb
  enqueuer: CoalescingEnqueuer
  tasks: Map<string, SiteTask>
  cfg: AppConfig
  logger: Logger
  bitbrowser: { health(): Promise<boolean> }
  captchaBalance: () => Promise<{ points: number } | null>
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express()
  app.use(express.json())

  const api = express.Router()
  api.use(dashboardRouter({ db: deps.db, tasks: deps.tasks }))
  api.use(tasksRouter(deps))
  api.use(profilesRouter(deps))
  api.use(runsRouter(deps))
  api.use(captchaRouter(deps))
  api.use(bitbrowserRouter({ health: deps.bitbrowser.health }))
  api.use(screenshotsRouter(deps))
  api.use(docsRouter())
  app.use('/api', api)

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public')
  app.use(express.static(publicDir))
  app.use('/api', notFoundHandler())
  app.use(errorHandler(deps.logger))
  return app
}

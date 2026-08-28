/**
 * Web 服务装配（server 层）：express 应用与路由挂载
 * 依赖方向：server 层依赖 engine/infrastructure，不反向；被 src/app.ts 调用
 * 设计思路：所有业务依赖经 ServerDeps 注入，各路由声明最小依赖子集；
 * /api 前缀统一挂载；静态面板文件由 public 目录直出（单页多视图）
 */
import express from 'express'
import { readFileSync } from 'node:fs'
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
import { settingsRouter } from './routes/settings'
import { notFoundHandler, errorHandler } from './http/error'

// 应用版本号：模块加载时读 package.json 一次，供 /api/settings 与面板侧栏展示
const APP_VERSION = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8')) as { version: string }).version

/** createApp 的依赖集（app.ts 装配时全部提供） */
export interface ServerDeps {
  db: AppDb
  enqueuer: CoalescingEnqueuer
  tasks: Map<string, SiteTask>
  cfg: AppConfig
  logger: Logger
  bitbrowser: { health(): Promise<boolean> }
  captchaBalance: () => Promise<{ points: number } | null>
}

/**
 * 构建 express 应用（不 listen，测试用 supertest 直接注入）
 * 挂载顺序：json 解析 → 各业务子路由 → /api 404 兜底 → 统一错误处理器
 */
export function createApp(deps: ServerDeps): express.Express {
  const app = express()
  app.use(express.json())

  const api = express.Router()
  // 各路由只接收自己需要的依赖（最小依赖面，测试可单独构造）
  api.use(dashboardRouter({ db: deps.db }))
  api.use(tasksRouter(deps))
  api.use(profilesRouter(deps))
  api.use(runsRouter(deps))
  api.use(captchaRouter(deps))
  api.use(bitbrowserRouter({ health: () => deps.bitbrowser.health() }))
  api.use(screenshotsRouter(deps))
  api.use(docsRouter())
  // 公开设置：非敏感配置 + 版本号（面板展示，避免前端硬编码）
  api.use(settingsRouter({ cfg: deps.cfg, version: APP_VERSION }))
  app.use('/api', api)

  // 前端静态资源：面板页面 + js/css/vendor
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public')
  app.use(express.static(publicDir))
  // 错误处理链：/api 未匹配路由 → 404；其余异常 → 统一 500/业务状态码
  app.use('/api', notFoundHandler())
  app.use(errorHandler(deps.logger))
  return app
}

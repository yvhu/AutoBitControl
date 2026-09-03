/**
 * Web 服务装配（server 层）：express 应用与路由挂载
 * 依赖方向：server 层依赖 engine/infrastructure，不反向；被 src/app.ts 调用
 * 设计思路：所有业务依赖经 ServerDeps 注入，各路由声明最小依赖子集；
 * /api 前缀统一挂载；后端只出 API（前端面板由 Vite dev server 提供，端口见 VITE_PORT）
 */
import express from 'express'
import swaggerUi from 'swagger-ui-express'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppDb } from '../infrastructure/db'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { CoalescingEnqueuer } from '../engine/queue'
import type { SiteTask } from '../tasks/base'
import { openapiSpec } from './openapi'
import { dashboardRouter } from './routes/dashboard'
import { tasksRouter } from './routes/tasks'
import { profilesRouter } from './routes/profiles'
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
  bitbrowser: {
    health(): Promise<boolean>
    sync(): Promise<number>
    openBrowser(id: string): Promise<{ http: string; ws: string }>
    closeBrowser(id: string): Promise<void>
    isOpen(id: string): Promise<boolean>
    openPids(ids: string[]): Promise<Set<string>>
  }
  captchaBalance: () => Promise<{ points: number } | null>
  /** 数据源状态与重载（面板设置页展示；app.ts 用闭包包住 DataSource 实例） */
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void>; available: boolean; error: string; path: string }
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
  api.use(dashboardRouter({ db: deps.db, enqueuer: deps.enqueuer }))
  api.use(tasksRouter(deps))
  api.use(profilesRouter(deps))
  api.use(captchaRouter(deps))
  api.use(bitbrowserRouter({ health: () => deps.bitbrowser.health(), sync: () => deps.bitbrowser.sync() }))
  api.use(screenshotsRouter(deps))
  api.use(docsRouter())
  // 公开设置：非敏感配置 + 版本号 + 数据源状态（面板展示，避免前端硬编码）
  api.use(settingsRouter({ cfg: deps.cfg, version: APP_VERSION, datasource: deps.datasource }))
  app.use('/api', api)

  // OpenAPI 文档：spec json 供类型生成；/api-docs 为 swagger-ui 页面（须在 notFoundHandler 之前）
  app.get('/api/docs/openapi.json', (req, res) => res.json(openapiSpec))
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec))
  // 错误处理链：/api 未匹配路由 → 404；其余异常 → 统一 500/业务状态码
  app.use('/api', notFoundHandler())
  app.use(errorHandler(deps.logger))
  return app
}

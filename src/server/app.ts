/**
 * Web 服务装配（server 层）：express 应用与路由挂载
 * 依赖方向：server 层依赖 engine/infrastructure，不反向；被 src/app.ts 调用
 * 设计思路：所有业务依赖经 ServerDeps 注入，各路由声明最小依赖子集；
 * /api 前缀统一挂载；静态面板直出 web/dist（antd 构建产物，唯一前端来源）
 */
import express from 'express'
import swaggerUi from 'swagger-ui-express'
import { readFileSync, existsSync } from 'node:fs'
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
  /** 任务开关 PATCH 成功后回调（key, enabled）：调度器按 key 即时重注册/停止 cron */
  onToggle?: (key: string, enabled: boolean) => void
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
  api.use(bitbrowserRouter({ health: () => deps.bitbrowser.health(), sync: () => deps.bitbrowser.sync() }))
  api.use(screenshotsRouter(deps))
  api.use(docsRouter())
  // 公开设置：非敏感配置 + 版本号 + 数据源状态（面板展示，避免前端硬编码）
  api.use(settingsRouter({ cfg: deps.cfg, version: APP_VERSION, datasource: deps.datasource }))
  app.use('/api', api)

  // 前端静态资源：web/dist 为唯一前端来源（npm run build:web 构建产物；express.static 对不存在目录安全）
  const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')
  app.use(express.static(distDir))
  // OpenAPI 文档：spec json 供 Task 2 类型生成；/api-docs 为 swagger-ui 页面（须在 notFoundHandler 之前）
  app.get('/api/docs/openapi.json', (req, res) => res.json(openapiSpec))
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec))
  // 错误处理链：/api 未匹配路由 → 404；其余异常 → 统一 500/业务状态码
  app.use('/api', notFoundHandler())
  // SPA 回退：BrowserRouter 深链/刷新（如 /profiles）无对应静态文件时回退 dist/index.html 由前端路由接管；
  // 带扩展名的路径视为静态资源缺失（express 默认 404），避免给缺失 js/css 返回 html；
  // 未构建（无 dist/index.html）时返回友好提示页而非 500（npm test 的 GET / 断言亦依赖此行为）
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.includes('.')) return next()
    const indexHtml = join(distDir, 'index.html')
    if (!existsSync(indexHtml)) {
      res
        .status(200)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AutoBitControl</title></head><body><h1>AutoBitControl</h1><p>前端未构建，请先运行 npm run build:web</p></body></html>')
      return
    }
    res.sendFile(indexHtml, (err) => {
      if (err) next(err)
    })
  })
  app.use(errorHandler(deps.logger))
  return app
}

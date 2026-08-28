/**
 * 文档路由（server 层）：面板文档页的只读内容服务（手册与示例源码）
 * 依赖方向：无业务依赖（只读 docs/ 与 src/tasks 文件），被 app 装配
 * 设计思路：白名单限定可读的示例文件，防止任意路径读取；无依赖参数（createApp 里 docsRouter() 裸调用）
 */
import { Router } from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ok, fail, asyncHandler } from '../http/response'

// 项目根目录（src/server/routes 上三级）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GUIDE_PATH = join(ROOT, 'docs', 'API-GUIDE.md')
const TASKS_DIR = join(ROOT, 'src', 'tasks')

// 可展示源码的示例文件白名单（防路径穿越读取任意 .ts）
const EXAMPLE_WHITELIST = ['example-checkin.ts', 'faucet-example.ts', 'mint-example.ts']

export function docsRouter(): Router {
  const router = Router()
  // 使用手册：原样返回 markdown 内容，前端用 marked 渲染
  router.get('/docs/guide', asyncHandler(async (req, res) => {
    ok(res, { content: readFileSync(GUIDE_PATH, 'utf-8') })
  }))
  // 示例文件列表（只列白名单内的文件）
  router.get('/docs/examples', asyncHandler(async (req, res) => {
    const files = readdirSync(TASKS_DIR).filter(f => EXAMPLE_WHITELIST.includes(f))
    ok(res, files.map(f => ({ name: f, label: f.replace('.ts', '') })))
  }))
  // 单个示例源码（白名单校验后读取）
  router.get('/docs/examples/:name', asyncHandler(async (req, res) => {
    const name = String(req.params.name)
    if (!EXAMPLE_WHITELIST.includes(name)) {
      fail(res, 404, 404, `示例不存在: ${name}`)
      return
    }
    ok(res, { content: readFileSync(join(TASKS_DIR, name), 'utf-8') })
  }))
  return router
}

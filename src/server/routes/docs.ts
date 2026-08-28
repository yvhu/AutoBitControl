import { Router } from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ok, fail, asyncHandler } from '../http/response'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GUIDE_PATH = join(ROOT, 'docs', 'API-GUIDE.md')
const TASKS_DIR = join(ROOT, 'src', 'tasks')

const EXAMPLE_WHITELIST = ['example-checkin.ts', 'faucet-example.ts', 'mint-example.ts']

export function docsRouter(): Router {
  const router = Router()
  router.get('/docs/guide', asyncHandler(async (req, res) => {
    ok(res, { content: readFileSync(GUIDE_PATH, 'utf-8') })
  }))
  router.get('/docs/examples', asyncHandler(async (req, res) => {
    const files = readdirSync(TASKS_DIR).filter(f => EXAMPLE_WHITELIST.includes(f))
    ok(res, files.map(f => ({ name: f, label: f.replace('.ts', '') })))
  }))
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

import { describe, it, expect, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnosticsRouter } from '../src/server/routes/diagnostics'
import { errorHandler } from '../src/server/http/error'
import type { Logger } from '../src/infrastructure/logger'
import type { RunRow } from '../src/infrastructure/db'

const dir = mkdtempSync(join(tmpdir(), 'diag-route-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 注入 fake getRunById 的最小应用（路由不触真库） */
function makeApp(getRunById: (id: number) => Promise<RunRow | null>) {
  const app = express()
  app.use(express.json())
  app.use('/api', diagnosticsRouter({ getRunById }))
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {} } as unknown as Logger))
  return app
}

const asRun = (patch: Partial<RunRow>) => patch as RunRow

describe('GET /api/diagnostics/:runId', () => {
  it('有 diagPath 且文件可读 → 200 返回诊断包', async () => {
    const file = join(dir, 'run1.diag.json')
    writeFileSync(file, JSON.stringify({ taskKey: 'k', steps: [{ name: 's', startMs: 0, ms: 1, ok: true }] }), 'utf8')
    const res = await request(makeApp(async () => asRun({ id: 1, diagPath: file }))).get('/api/diagnostics/1')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.taskKey).toBe('k')
    expect(res.body.data.steps).toHaveLength(1)
  })

  it('无 diagPath → 404/40407', async () => {
    const res = await request(makeApp(async () => asRun({ id: 2, diagPath: null }))).get('/api/diagnostics/2')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40407)
  })

  it('run 不存在 → 404/40407', async () => {
    const res = await request(makeApp(async () => null)).get('/api/diagnostics/999')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40407)
  })

  it('diagPath 指向的文件不存在 → 404/40407', async () => {
    const res = await request(makeApp(async () => asRun({ id: 3, diagPath: join(dir, 'nope.diag.json') }))).get('/api/diagnostics/3')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40407)
  })

  it('runId 非法 → 400/40000', async () => {
    const res = await request(makeApp(async () => null)).get('/api/diagnostics/abc')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })
})

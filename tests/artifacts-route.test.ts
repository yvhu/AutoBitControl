import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { artifactsRouter, listRunArtifacts } from '../src/server/routes/artifacts'
import type { AppConfig } from '../src/infrastructure/config'
import type { RunRow } from '../src/infrastructure/db'

const DATE = '2026-10-21'

function makeApp(run: RunRow | null, screenshotDir: string) {
  const app = express()
  app.use('/api', artifactsRouter({
    cfg: { storage: { screenshotDir } } as AppConfig,
    getRunById: async () => run,
  }))
  return app
}

function makeRun(over: Partial<RunRow> = {}): RunRow {
  return { id: 7, date: DATE, bitbrowserId: 'bb-1', taskKey: 'auralaunch-checkin', slot: 0, ...over } as RunRow
}

describe('GET /api/runs/:id/artifacts', () => {
  it('只列出当前 run 的 slot 目录 png（忽略非 png/子目录），路径在截图根目录内', async () => {
    const root = mkdtempSync(join(tmpdir(), 'abc-artifacts-'))
    try {
      const dir = join(root, DATE, 'bb-1', 'auralaunch-checkin', 'slot-0')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'quiz-answer.png'), 'quiz')
      writeFileSync(join(dir, 'claim-success.png'), 'claim')
      writeFileSync(join(dir, '2026-10-21-success.png'), 'success')
      writeFileSync(join(dir, 'notes.txt'), 'ignore')
      mkdirSync(join(dir, 'nested'), { recursive: true })

      const res = await request(makeApp(makeRun(), root)).get('/api/runs/7/artifacts')
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(0)
      expect(res.body.data.runId).toBe(7)
      const files = res.body.data.files as Array<{ name: string; path: string; size: number; mtimeMs: number }>
      expect(files.map((f) => f.name).sort()).toEqual(['2026-10-21-success.png', 'claim-success.png', 'quiz-answer.png'])
      expect(files.every((f) => f.path.startsWith(root) && f.size > 0 && f.mtimeMs > 0)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不同 slot 的截图互不串轮次', async () => {
    const root = mkdtempSync(join(tmpdir(), 'abc-artifacts-'))
    try {
      const base = join(root, DATE, 'bb-1', 'auralaunch-checkin')
      mkdirSync(join(base, 'slot-0'), { recursive: true })
      mkdirSync(join(base, 'slot-1'), { recursive: true })
      writeFileSync(join(base, 'slot-0', '2026-10-21-success.png'), 'old')
      writeFileSync(join(base, 'slot-1', '2026-10-21-success.png'), 'new')
      writeFileSync(join(base, 'slot-1', 'claim-success.png'), 'claim')

      const res0 = await request(makeApp(makeRun({ slot: 0 }), root)).get('/api/runs/7/artifacts')
      const res1 = await request(makeApp(makeRun({ slot: 1 }), root)).get('/api/runs/7/artifacts')
      expect((res0.body.data.files as Array<{ name: string }>).map((f) => f.name)).toEqual(['2026-10-21-success.png'])
      expect((res1.body.data.files as Array<{ name: string }>).map((f) => f.name).sort()).toEqual(['2026-10-21-success.png', 'claim-success.png'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧数据没有 slot 子目录时回退读扁平目录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'abc-artifacts-'))
    try {
      const legacy = join(root, DATE, 'bb-1', 'auralaunch-checkin')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'legacy-success.png'), 'legacy')

      const res = await request(makeApp(makeRun({ slot: 2 }), root)).get('/api/runs/7/artifacts')
      expect(res.status).toBe(200)
      expect((res.body.data.files as Array<{ name: string }>).map((f) => f.name)).toEqual(['legacy-success.png'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('新 slot 目录存在但为空时不回退旧目录（避免串轮次）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'abc-artifacts-'))
    try {
      const legacy = join(root, DATE, 'bb-1', 'auralaunch-checkin')
      mkdirSync(join(legacy, 'slot-3'), { recursive: true })
      writeFileSync(join(legacy, 'legacy-success.png'), 'legacy')

      const res = await request(makeApp(makeRun({ slot: 3 }), root)).get('/api/runs/7/artifacts')
      expect(res.status).toBe(200)
      expect(res.body.data.files).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('目录不存在返回空列表；run 不存在 404；runId 非法 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'abc-artifacts-'))
    try {
      const empty = await request(makeApp(makeRun(), root)).get('/api/runs/7/artifacts')
      expect(empty.status).toBe(200)
      expect(empty.body.data.files).toEqual([])

      const missing = await request(makeApp(null, root)).get('/api/runs/7/artifacts')
      expect(missing.status).toBe(404)
      expect(missing.body.code).toBe(40409)

      const invalid = await request(makeApp(makeRun(), root)).get('/api/runs/abc/artifacts')
      expect(invalid.status).toBe(400)
      expect(invalid.body.code).toBe(40000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('taskKey/date 越界时返回空列表（路径防御）', () => {
    const root = mkdtempSync(join(tmpdir(), 'abc-artifacts-'))
    try {
      expect(listRunArtifacts(root, { date: DATE, bitbrowserId: 'bb-1', taskKey: '../../outside', slot: 0 })).toEqual([])
      expect(listRunArtifacts(root, { date: DATE, bitbrowserId: 'bb-1', taskKey: 'auralaunch-checkin', slot: '../../outside' as never })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

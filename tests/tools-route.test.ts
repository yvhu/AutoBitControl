import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { toolsRouter } from '../src/server/routes/tools'
import { errorHandler } from '../src/server/http/error'
import type { Logger } from '../src/infrastructure/logger'

let dir: string
let xlsxPath: string

function makeApp(xlsxPath: string) {
  const app = express()
  app.use(express.json())
  const reload = vi.fn().mockResolvedValue(undefined)
  const summary = vi.fn().mockReturnValue({ rows: 2, columns: ['窗口名称', '文件地址'] })
  app.use('/api', toolsRouter({ xlsxPath, datasource: { reload, summary } }))
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {} } as unknown as Logger))
  return { app, reload, summary }
}

const template = {
  english: { count: 2, caseMode: 'lower' },
  digits: null,
  special: null,
  position: { type: 'before' },
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tools-route-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  ws.addRow(['02', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  writeFileSync(join(dir, 'c.png'), 'c')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/tools', () => {
  it('返回工具清单', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app).get('/api/tools')
    expect(res.body.code).toBe(0)
    expect(res.body.data.tools).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'file-assign', name: '文件随机分配' })]))
  })
})

describe('POST /api/tools/file-assign/preview', () => {
  it('正常生成预览计划', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app)
      .post('/api/tools/file-assign/preview')
      .send({ sourceDir: dir, column: '文件地址', template })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.accountsCount).toBe(2)
    expect(res.body.data.filesCount).toBe(3)
    expect(res.body.data.plan).toHaveLength(2)
    for (const row of res.body.data.plan) {
      expect(typeof row.rowNumber).toBe('number')
      expect(typeof row.oldName).toBe('string')
      expect(typeof row.newName).toBe('string')
      expect(row.newPath.startsWith(dir)).toBe(true)
    }
  })

  it('源文件夹不存在 → 400/40001', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app)
      .post('/api/tools/file-assign/preview')
      .send({ sourceDir: join(dir, 'nope'), column: '文件地址', template })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40001)
  })

  it('参数缺失 → 400/40000', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app).post('/api/tools/file-assign/preview').send({ sourceDir: dir })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })
})

describe('POST /api/tools/file-assign/apply', () => {
  it('执行成功：改名 + 写回 + 数据源重载', async () => {
    const { app, reload, summary } = makeApp(xlsxPath)
    const prev = await request(app)
      .post('/api/tools/file-assign/preview')
      .send({ sourceDir: dir, column: '文件地址', template })
    const plan = prev.body.data.plan
    const res = await request(app)
      .post('/api/tools/file-assign/apply')
      .send({ sourceDir: dir, column: '文件地址', plan })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.renamedCount).toBe(2)
    expect(res.body.data.updatedRows).toBe(2)
    expect(res.body.data.reloadedRows).toBe(2)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(summary).toHaveBeenCalled()
    for (const row of plan) {
      const { existsSync } = await import('node:fs')
      expect(existsSync(row.newPath)).toBe(true)
    }
  })

  it('计划行数不一致 → 400/40005', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app)
      .post('/api/tools/file-assign/apply')
      .send({ sourceDir: dir, column: '文件地址', plan: [{ rowNumber: 2, window: '01', oldName: 'a.png', newName: 'x.png', newPath: join(dir, 'x.png') }] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40005)
  })
})

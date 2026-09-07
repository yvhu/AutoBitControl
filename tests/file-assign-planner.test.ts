import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { preparePreview, shuffle } from '../src/tools/file-assign/planner'
import type { FileAssignTemplate } from '../src/tools/file-assign/types'

let dir: string
let xlsxPath: string

const template: FileAssignTemplate = {
  english: { count: 2, caseMode: 'lower' },
  digits: null,
  special: null,
  position: { type: 'before' },
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'file-assign-planner-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  ws.addRow(['02', ''])
  ws.addRow(['03', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  writeFileSync(join(dir, 'c.png'), 'c')
  writeFileSync(join(dir, 'd.png'), 'd')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('shuffle', () => {
  it('返回新数组且长度一致', () => {
    const src = [1, 2, 3, 4, 5]
    const out = shuffle(src, () => 0.5)
    expect(out).toHaveLength(5)
    expect([...out].sort()).toEqual([...src].sort())
  })
})

describe('preparePreview', () => {
  it('生成计划：每行一个不重复文件、新名唯一、路径正确', async () => {
    const data = await preparePreview({ sourceDir: dir, column: '文件地址', template, xlsxPath })
    expect(data.accountsCount).toBe(3)
    expect(data.filesCount).toBe(4)
    expect(data.plan).toHaveLength(3)
    const oldNames = data.plan.map((r) => r.oldName)
    expect(new Set(oldNames).size).toBe(3)
    const newNames = data.plan.map((r) => r.newName)
    expect(new Set(newNames.map((n) => n.toLowerCase())).size).toBe(3)
    for (const row of data.plan) {
      expect(row.newPath).toBe(join(dir, row.newName))
      expect(row.oldName).toMatch(/\.png$/)
      expect(row.newName).not.toBe(row.oldName)
      expect(row.window).toMatch(/0[123]/)
    }
  })

  it('sourceDir 盘符大小写变体时仍排除 accounts.xlsx', async () => {
    const variant = (dir[0] === dir[0].toUpperCase() ? dir[0].toLowerCase() : dir[0].toUpperCase()) + dir.slice(1)
    const data = await preparePreview({ sourceDir: variant, column: '文件地址', template, xlsxPath })
    expect(data.filesCount).toBe(4)
    expect(data.plan.map((r) => r.oldName)).not.toContain('accounts.xlsx')
  })

  it('源文件夹不存在 → TOOL_DIR_NOT_FOUND', async () => {
    await expect(
      preparePreview({ sourceDir: join(dir, 'nope'), column: '文件地址', template, xlsxPath }),
    ).rejects.toMatchObject({ code: 40001 })
  })

  it('目标列不存在 → TOOL_COLUMN_NOT_FOUND', async () => {
    await expect(
      preparePreview({ sourceDir: dir, column: '不存在的列', template, xlsxPath }),
    ).rejects.toMatchObject({ code: 40002 })
  })

  it('文件不足 → TOOL_FILES_INSUFFICIENT', async () => {
    const smallDir = mkdtempSync(join(tmpdir(), 'fa-small-'))
    writeFileSync(join(smallDir, 'only.png'), 'x')
    await expect(
      preparePreview({ sourceDir: smallDir, column: '文件地址', template, xlsxPath }),
    ).rejects.toMatchObject({ code: 40003 })
    rmSync(smallDir, { recursive: true, force: true })
  })

  it('空模板 → TOOL_TEMPLATE_INVALID', async () => {
    const empty: FileAssignTemplate = { english: null, digits: null, special: null, position: { type: 'replace' } }
    await expect(
      preparePreview({ sourceDir: dir, column: '文件地址', template: empty, xlsxPath }),
    ).rejects.toMatchObject({ code: 40004 })
  })

  it('after-text 未命中 → TOOL_TEMPLATE_INVALID 且信息含文件名', async () => {
    const t: FileAssignTemplate = { ...template, position: { type: 'after-text', value: 'zzz' } }
    await expect(
      preparePreview({ sourceDir: dir, column: '文件地址', template: t, xlsxPath }),
    ).rejects.toMatchObject({ code: 40004 })
  })
})

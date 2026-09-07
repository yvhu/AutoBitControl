import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { FileAssignService } from '../src/tools/file-assign/applier'
import type { AssignRow } from '../src/tools/file-assign/types'

const dirs: string[] = []

/** 每个用例独立临时目录：目录含 a/b/c 三个文件 + 两行账号 xlsx */
async function setup(): Promise<{ dir: string; xlsxPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'file-assign-applier-'))
  dirs.push(dir)
  const xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  ws.addRow(['02', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  writeFileSync(join(dir, 'c.png'), 'c')
  return { dir, xlsxPath }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function row(dir: string, rowNumber: number, oldName: string, newName: string): AssignRow {
  return { rowNumber, window: '01', oldName, newName, newPath: join(dir, newName) }
}

describe('FileAssignService.apply', () => {
  it('校验通过：改名落盘 + xlsx 写回 + 返回计数', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    const result = await svc.apply({
      sourceDir: dir,
      column: '文件地址',
      xlsxPath,
      plan: [row(dir, 2, 'a.png', 'new-a.png'), row(dir, 3, 'b.png', 'new-b.png')],
    })
    expect(result).toEqual({ renamedCount: 2, updatedRows: 2 })
    expect(existsSync(join(dir, 'new-a.png'))).toBe(true)
    expect(existsSync(join(dir, 'a.png'))).toBe(false)
    expect(existsSync(join(dir, 'c.png'))).toBe(true)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    const ws = wb.worksheets[0]
    expect(ws.getRow(2).getCell(2).text).toBe(join(dir, 'new-a.png'))
    expect(ws.getRow(3).getCell(2).text).toBe(join(dir, 'new-b.png'))
  })

  it('计划行数与账号行数不一致 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'c.png', 'new-c.png')] }),
    ).rejects.toMatchObject({ code: 40005 })
    expect(existsSync(join(dir, 'c.png'))).toBe(true)
  })

  it('计划中文件已不存在 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({
        sourceDir: dir,
        column: '文件地址',
        xlsxPath,
        plan: [row(dir, 2, 'gone.png', 'x.png'), row(dir, 3, 'c.png', 'y.png')],
      }),
    ).rejects.toMatchObject({ code: 40005 })
  })

  it('新名与现存文件冲突 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({
        sourceDir: dir,
        column: '文件地址',
        xlsxPath,
        plan: [row(dir, 2, 'a.png', 'b.png'), row(dir, 3, 'c.png', 'z.png')],
      }),
    ).rejects.toMatchObject({ code: 40005 })
  })

  it('计划行 oldName 指向账号表文件 → TOOL_PLAN_INVALID（防误改名）', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({
        sourceDir: dir,
        column: '文件地址',
        xlsxPath,
        plan: [row(dir, 2, 'accounts.xlsx', 'zzz.xlsx'), row(dir, 3, 'b.png', 'y.png')],
      }),
    ).rejects.toMatchObject({ code: 40005 })
    expect(existsSync(xlsxPath)).toBe(true)
  })

  it('计划行号不属于账号行集合 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({
        sourceDir: dir,
        column: '文件地址',
        xlsxPath,
        plan: [row(dir, 2, 'a.png', 'x.png'), row(dir, 99, 'b.png', 'y.png')],
      }),
    ).rejects.toMatchObject({ code: 40005 })
    expect(existsSync(join(dir, 'a.png'))).toBe(true)
  })

  it('计划 newPath 目录与当前源文件夹不一致 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const other = mkdtempSync(join(tmpdir(), 'file-assign-other-'))
    dirs.push(other)
    const svc = new FileAssignService()
    const plan = [
      { ...row(dir, 2, 'a.png', 'x.png'), newPath: join(other, 'x.png') },
      { ...row(dir, 3, 'b.png', 'y.png'), newPath: join(other, 'y.png') },
    ]
    await expect(svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan })).rejects.toMatchObject({ code: 40005 })
    expect(existsSync(join(dir, 'a.png'))).toBe(true)
  })

  it('计划行字段类型非法 → TOOL_PLAN_INVALID（防 500）', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    const plan = [
      { rowNumber: 2, window: '01', oldName: 123 as unknown as string, newName: 'x.png', newPath: join(dir, 'x.png') },
      row(dir, 3, 'b.png', 'y.png'),
    ]
    await expect(svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan })).rejects.toMatchObject({ code: 40005 })
  })

  it('执行中再次调用 → TOOL_BUSY', async () => {
    const { dir, xlsxPath } = await setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const svc = new FileAssignService({
      renameFile: async () => { await gate },
      writeXlsx: async () => {},
      readXlsx: async () => ({
        columns: ['窗口名称', '文件地址'],
        rows: [{ rowNumber: 2, window: '01' }, { rowNumber: 3, window: '02' }],
      }),
      readDirFiles: async () => ['a.png', 'b.png'],
      existsDir: () => true,
    })
    const p1 = svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'a.png', 'x.png'), row(dir, 3, 'b.png', 'y.png')] })
    await expect(svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'a.png', 'x.png'), row(dir, 3, 'b.png', 'y.png')] })).rejects.toMatchObject({ code: 40904 })
    release()
    await expect(p1).resolves.toEqual({ renamedCount: 2, updatedRows: 2 })
  })

  it('改名中途失败 → TOOL_IO_FAILED 且错误信息附已改名清单', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService({
      renameFile: async (from) => {
        if (from.endsWith('b.png')) throw new Error('磁盘错误')
      },
      writeXlsx: async () => {},
      readXlsx: async () => ({
        columns: ['窗口名称', '文件地址'],
        rows: [{ rowNumber: 2, window: '01' }, { rowNumber: 3, window: '02' }],
      }),
      readDirFiles: async () => ['a.png', 'b.png'],
      existsDir: () => true,
    })
    await expect(
      svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'a.png', 'x.png'), row(dir, 3, 'b.png', 'y.png')] }),
    ).rejects.toMatchObject({ code: 50001 })
  })
})

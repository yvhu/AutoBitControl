import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { readXlsxMeta, writeCells } from '../src/tools/file-assign/xlsx'

let dir: string
let xlsxPath: string

/** 建测试 xlsx：表头 5 列 + 3 个数据行 + 1 个完全空白行 */
async function makeXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '窗口', '邮箱', '图片地址', '文件地址'])
  ws.addRow(['01', '01', 'a@x.com', '', 'C:\\dir\\old1.png'])
  ws.addRow(['02', '02', 'b@x.com', '', 'C:\\dir\\old2.png'])
  ws.addRow(['', '', '', '', ''])
  ws.addRow(['03', '03', 'c@x.com', '', 'C:\\dir\\old3.png'])
  await wb.xlsx.writeFile(path)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'file-assign-xlsx-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  await makeXlsx(xlsxPath)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readXlsxMeta', () => {
  it('返回列清单与非空数据行（跳过空白行）', async () => {
    const meta = await readXlsxMeta(xlsxPath)
    expect(meta.columns).toEqual(['窗口名称', '窗口', '邮箱', '图片地址', '文件地址'])
    expect(meta.rows).toHaveLength(3)
    expect(meta.rows[0]).toEqual({ rowNumber: 2, window: '01' })
    expect(meta.rows[2]).toEqual({ rowNumber: 5, window: '03' })
  })

  it('无窗口名称/窗口列时窗口标识兜底行号', async () => {
    const p2 = join(dir, 'no-win.xlsx')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('accounts')
    ws.addRow(['邮箱'])
    ws.addRow(['a@x.com'])
    await wb.xlsx.writeFile(p2)
    const meta = await readXlsxMeta(p2)
    expect(meta.rows[0]).toEqual({ rowNumber: 2, window: '第2行' })
  })
})

describe('writeCells', () => {
  it('只改目标列单元格，其他列不动', async () => {
    const p3 = join(dir, 'write.xlsx')
    await makeXlsx(p3)
    await writeCells(p3, '文件地址', [
      { rowNumber: 2, value: 'C:\\dir\\new1.png' },
      { rowNumber: 5, value: 'C:\\dir\\new3.png' },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(p3)
    const ws = wb.worksheets[0]
    expect(ws.getRow(2).getCell(5).text).toBe('C:\\dir\\new1.png')
    expect(ws.getRow(2).getCell(1).text).toBe('01')
    expect(ws.getRow(3).getCell(5).text).toBe('C:\\dir\\old2.png')
    expect(ws.getRow(5).getCell(5).text).toBe('C:\\dir\\new3.png')
  })

  it('列不存在抛错', async () => {
    const p4 = join(dir, 'bad-col.xlsx')
    await makeXlsx(p4)
    await expect(writeCells(p4, '不存在的列', [{ rowNumber: 2, value: 'x' }])).rejects.toThrow(/找不到列/)
  })
})

/**
 * 数据源单元测试：内存生成 workbook 写临时 xlsx，验证两种映射模式与容错
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { DataSource } from '../src/infrastructure/datasource'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'abc-datasource-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 内存建表并写临时 xlsx，返回文件路径 */
async function writeXlsx(rows: (string | number)[][]): Promise<string> {
  const file = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  for (const row of rows) ws.addRow(row)
  await wb.xlsx.writeFile(file)
  return file
}

const profiles = [
  { id: 1, bitbrowserId: 'bb-01', name: '窗口01' },
  { id: 2, bitbrowserId: 'bb-02', name: '窗口02' },
  { id: 3, bitbrowserId: 'bb-03', name: '窗口03' },
]
const ordered = [{ bitbrowserId: 'bb-01' }, { bitbrowserId: 'bb-02' }, { bitbrowserId: 'bb-03' }]

describe('DataSource', () => {
  it('无窗口列 → 顺序映射（第 i 个窗口得第 i 行）', async () => {
    const ds = new DataSource()
    await ds.load(await writeXlsx([
      ['邮箱', '邀请码'],
      ['a1@example.com', 'CODE1'],
      ['a2@example.com', 'CODE2'],
      ['a3@example.com', 'CODE3'],
    ]))
    expect(ds.available).toBe(true)
    expect(ds.hasWindowColumn).toBe(false)
    expect(ds.columns).toEqual(['邮箱', '邀请码'])
    expect(ds.rowFor(profiles[0], ordered)?.values['邮箱']).toBe('a1@example.com')
    expect(ds.rowFor(profiles[1], ordered)?.values['邀请码']).toBe('CODE2')
    expect(ds.rowFor(profiles[2], ordered)?.values['邮箱']).toBe('a3@example.com')
    // 窗口不在列表 / 行数不足 → null
    expect(ds.rowFor({ id: 9, bitbrowserId: 'bb-99', name: '窗口99' }, ordered)).toBeNull()
    expect(ds.rowFor(profiles[1], ordered.slice(0, 1))).toBeNull()
  })

  it('有窗口列 → 按窗口名精确匹配（乱序也正确）', async () => {
    const ds = new DataSource()
    await ds.load(await writeXlsx([
      ['窗口', '邮箱'],
      ['窗口03', 'c@example.com'],
      ['窗口01', 'a@example.com'],
      ['窗口02', 'b@example.com'],
    ]))
    expect(ds.available).toBe(true)
    expect(ds.hasWindowColumn).toBe(true)
    expect(ds.rowFor(profiles[0], ordered)?.values['邮箱']).toBe('a@example.com')
    expect(ds.rowFor(profiles[1], ordered)?.values['邮箱']).toBe('b@example.com')
    expect(ds.rowFor(profiles[2], ordered)?.values['邮箱']).toBe('c@example.com')
    // 窗口列也认比特窗口 ID
    const byId = new DataSource()
    await byId.load(await writeXlsx([
      ['窗口', '邮箱'],
      ['bb-01', 'a@example.com'],
    ]))
    expect(byId.rowFor(profiles[0], ordered)?.values['邮箱']).toBe('a@example.com')
    // 无匹配窗口 → null
    expect(ds.rowFor({ id: 9, bitbrowserId: 'bb-99', name: '窗口99' }, ordered)).toBeNull()
  })

  it('文件不存在 → available=false + error 记录原因（不抛错）', async () => {
    const ds = new DataSource()
    await expect(ds.load(join(dir, 'no-such.xlsx'))).resolves.toBeUndefined()
    expect(ds.available).toBe(false)
    expect(ds.error).toBeTruthy()
    expect(ds.summary()).toEqual({ rows: 0, columns: [] })
  })

  it('表头/空行处理：列名去首尾空格、尾部空列裁剪、完全空白行跳过', async () => {
    const ds = new DataSource()
    await ds.load(await writeXlsx([
      [' 邮箱 ', '邀请码', ''],
      ['a@example.com', 'CODE1'],
      ['', '', ''],
      ['', 'CODE2'], // 部分空白但有一列有值 → 保留（邮箱为空串）
    ]))
    expect(ds.available).toBe(true)
    expect(ds.columns).toEqual(['邮箱', '邀请码'])
    expect(ds.rows).toHaveLength(2)
    expect(ds.rows[1].values['邮箱']).toBe('')
    expect(ds.rows[1].values['邀请码']).toBe('CODE2')
  })

  it('summary 返回行数与列名', async () => {
    const ds = new DataSource()
    await ds.load(await writeXlsx([
      ['窗口', '邮箱'],
      ['窗口01', 'a@example.com'],
      ['窗口02', 'b@example.com'],
    ]))
    expect(ds.summary()).toEqual({ rows: 2, columns: ['窗口', '邮箱'] })
  })

  it('单元格值去首尾空格，空串保留', async () => {
    const ds = new DataSource()
    await ds.load(await writeXlsx([
      ['邮箱', '备注'],
      ['  padded@example.com  ', ' note '],
    ]))
    expect(ds.rows[0].values['邮箱']).toBe('padded@example.com')
    expect(ds.rows[0].values['备注']).toBe('note')
  })

  it('加载失败后再次 load 成功会重置错误状态', async () => {
    const ds = new DataSource()
    await ds.load(join(dir, 'no-such.xlsx'))
    expect(ds.available).toBe(false)
    const file = await writeXlsx([['邮箱'], ['a@example.com']])
    await ds.load(file)
    expect(ds.available).toBe(true)
    expect(ds.error).toBe('')
    expect(ds.rows).toHaveLength(1)
  })
})

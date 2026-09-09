import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { buildFileAssignRunner } from '../src/tools/file-assign/runner'
import type { FileAssignConfig } from '../src/tools/file-assign/types'

let dir: string
let xlsxPath: string
const cfg: FileAssignConfig = {
  sourceDir: '',
  column: '文件地址',
  template: { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } },
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'file-assign-runner-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  cfg.sourceDir = dir
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('buildFileAssignRunner', () => {
  it('按 预览 → 执行 → 重载 顺序串联，apply 收到真实预览计划', async () => {
    const apply = vi.fn().mockResolvedValue({ renamedCount: 1, updatedRows: 1 })
    const reload = vi.fn().mockResolvedValue(undefined)
    const run = buildFileAssignRunner({ xlsxPath, apply, reload })
    await run(cfg)
    expect(apply).toHaveBeenCalledTimes(1)
    const params = apply.mock.calls[0][0] as { sourceDir: string; column: string; xlsxPath: string; plan: Array<{ newName: string }> }
    expect(params.sourceDir).toBe(dir)
    expect(params.column).toBe('文件地址')
    expect(params.xlsxPath).toBe(xlsxPath)
    expect(params.plan).toHaveLength(1)
    expect(params.plan[0].newName).toMatch(/^[a-z]{2}[ab]\.png$/)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('预览失败（目录不存在）→ 不执行 apply 与 reload，错误向上抛', async () => {
    const apply = vi.fn()
    const reload = vi.fn()
    const run = buildFileAssignRunner({ xlsxPath, apply, reload })
    await expect(run({ ...cfg, sourceDir: join(dir, '不存在') })).rejects.toThrow(/源文件夹不存在/)
    expect(apply).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('apply 失败 → 不 reload，错误向上抛', async () => {
    const apply = vi.fn().mockRejectedValue(new Error('重命名失败'))
    const reload = vi.fn()
    const run = buildFileAssignRunner({ xlsxPath, apply, reload })
    await expect(run(cfg)).rejects.toThrow('重命名失败')
    expect(reload).not.toHaveBeenCalled()
  })
})

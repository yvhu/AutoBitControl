/**
 * 分配执行（tools 层）：校验回传计划 → 逐个重命名 → 写回 xlsx；带进程内执行锁
 * 依赖方向：依赖 ./xlsx ./errors ./types；IO 经构造注入（默认实现走 node:fs 真盘，测试可替换）
 * 设计思路：apply 是破坏性操作，先全量校验再动手；写盘失败不回滚改名，错误信息附已改名清单
 */
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ApplyParams, ApplyResult } from './types'
import { readXlsxMeta, writeCells, type XlsxMeta } from './xlsx'
import { ToolError, TOOL_ERROR_CODES } from '../errors'

/** 可注入 IO 面：真实实现走本机磁盘，测试替换以验证锁/失败路径 */
export interface FileAssignIo {
  renameFile(from: string, to: string): Promise<void>
  writeXlsx(path: string, column: string, updates: Array<{ rowNumber: number; value: string }>): Promise<void>
  readXlsx(path: string): Promise<XlsxMeta>
  readDirFiles(dir: string): Promise<string[]>
  existsDir(dir: string): boolean
}

/** 默认 IO：node:fs + exceljs 真盘实现 */
export const defaultIo: FileAssignIo = {
  renameFile: async (from, to) => {
    renameSync(from, to)
  },
  writeXlsx: writeCells,
  readXlsx: readXlsxMeta,
  readDirFiles: async (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name),
  existsDir: (dir) => existsSync(dir) && statSync(dir).isDirectory(),
}

export class FileAssignService {
  private busy = false

  constructor(private io: FileAssignIo = defaultIo) {}

  /** 是否正在执行（进程内单服务实例，面板并发点击靠它拦截） */
  get isBusy(): boolean {
    return this.busy
  }

  async apply(params: ApplyParams): Promise<ApplyResult> {
    if (this.busy) throw new ToolError(409, TOOL_ERROR_CODES.TOOL_BUSY, '上一次分配正在执行，请稍候')
    this.busy = true
    try {
      return await this.applyInner(params)
    } finally {
      this.busy = false
    }
  }

  private async applyInner(params: ApplyParams): Promise<ApplyResult> {
    if (!params.sourceDir || !params.column || !Array.isArray(params.plan) || params.plan.length === 0) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, '参数不完整（源文件夹/目标列/计划）')
    }
    const dir = resolve(params.sourceDir)
    if (!this.io.existsDir(dir)) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_DIR_NOT_FOUND, `源文件夹不存在或不是目录: ${params.sourceDir}`)
    }
    const meta = await this.io.readXlsx(params.xlsxPath)
    if (!meta.columns.includes(params.column)) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_COLUMN_NOT_FOUND, `目标列「${params.column}」不存在`)
    }
    if (meta.rows.length !== params.plan.length) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `计划与账号行数不一致（计划 ${params.plan.length} 行，账号 ${meta.rows.length} 行），请重新生成预览`)
    }
    const accountRowNumbers = new Set(meta.rows.map((r) => r.rowNumber))
    if (params.plan.some((r) => !accountRowNumbers.has(r.rowNumber))) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, '计划行号与账号表行不一致（预览后账号表可能已变动），请重新生成预览')
    }
    const dirLower = dir.toLowerCase()
    const xlsxReal = resolve(params.xlsxPath).toLowerCase()
    const existing = new Set((await this.io.readDirFiles(dir)).map((n) => n.toLowerCase()))
    const newLower = new Set<string>()
    for (const row of params.plan) {
      if (!Number.isInteger(row.rowNumber) || typeof row.oldName !== 'string' || typeof row.newName !== 'string' || typeof row.newPath !== 'string') {
        throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, '计划字段格式非法，请重新生成预览')
      }
      if (!existing.has(row.oldName.toLowerCase())) {
        throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `文件已不存在: ${row.oldName}（源文件夹有变动，请重新生成预览）`)
      }
      if (resolve(join(dir, row.oldName)).toLowerCase() === xlsxReal) {
        throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `不允许重命名账号表文件: ${row.oldName}`)
      }
      if (resolve(dirname(row.newPath)).toLowerCase() !== dirLower) {
        throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `计划路径与源文件夹不一致（预览后可能修改了路径），请重新生成预览: ${row.newPath}`)
      }
      const lower = row.newName.toLowerCase()
      if (existing.has(lower) && lower !== row.oldName.toLowerCase()) {
        throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `新文件名与现存文件冲突: ${row.newName}`)
      }
      if (newLower.has(lower)) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `计划中新文件名重复: ${row.newName}`)
      newLower.add(lower)
    }
    // 校验全部通过后执行改名：中途失败不回滚，错误信息附已改名清单
    const renamed: string[] = []
    for (const row of params.plan) {
      try {
        await this.io.renameFile(join(dir, row.oldName), join(dir, row.newName))
        renamed.push(row.oldName)
      } catch (e) {
        throw new ToolError(500, TOOL_ERROR_CODES.TOOL_IO_FAILED, `重命名失败（${(e as Error).message}）；已改名的文件: ${renamed.join(', ') || '无'}`)
      }
    }
    try {
      await this.io.writeXlsx(
        params.xlsxPath,
        params.column,
        params.plan.map((r) => ({ rowNumber: r.rowNumber, value: r.newPath })),
      )
    } catch (e) {
      throw new ToolError(500, TOOL_ERROR_CODES.TOOL_IO_FAILED, `写回 accounts.xlsx 失败（${(e as Error).message}）；文件已改名: ${renamed.join(', ') || '无'}`)
    }
    return { renamedCount: params.plan.length, updatedRows: params.plan.length }
  }
}

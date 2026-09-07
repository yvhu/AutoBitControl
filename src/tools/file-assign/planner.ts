/**
 * 分配计划生成（tools 层）：读目录/读账号表 → 校验 → 洗牌 → 生成预览计划
 * 依赖方向：依赖 ./name-template ./xlsx ./errors；被 server 路由调用
 * 设计思路：纯编排（fs 读取在此层，写操作在 applier）；校验失败抛 ToolError 由路由映射统一响应
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AssignPlan, FileAssignTemplate } from './types'
import { generateUniqueNames, validateTemplate } from './name-template'
import { readXlsxMeta } from './xlsx'
import { ToolError, TOOL_ERROR_CODES } from '../errors'

/** Fisher-Yates 洗牌（返回新数组，不动原数组） */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface PreparePreviewParams {
  sourceDir: string
  column: string
  template: FileAssignTemplate
  xlsxPath: string
}

/** 生成分配预览计划（不落盘）：目录/列/数量/模板校验 + 洗牌取文件 + 唯一名生成 */
export async function preparePreview(p: PreparePreviewParams): Promise<AssignPlan> {
  if (!p.sourceDir) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_DIR_NOT_FOUND, '源文件夹不能为空')
  if (!p.column) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_COLUMN_NOT_FOUND, '目标列不能为空')
  if (!p.template) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_TEMPLATE_INVALID, '名称模板不能为空')
  const dir = resolve(p.sourceDir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_DIR_NOT_FOUND, `源文件夹不存在或不是目录: ${p.sourceDir}`)
  }
  const templateErr = validateTemplate(p.template)
  if (templateErr) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_TEMPLATE_INVALID, templateErr)
  const meta = await readXlsxMeta(p.xlsxPath)
  if (!meta.columns.includes(p.column)) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_COLUMN_NOT_FOUND, `目标列「${p.column}」不存在（现有列: ${meta.columns.join(', ')}）`)
  }
  if (meta.rows.length === 0) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_FILES_INSUFFICIENT, '账号表没有数据行')
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => resolve(join(dir, name)) !== resolve(p.xlsxPath))
  if (files.length < meta.rows.length) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_FILES_INSUFFICIENT, `文件不足：需要 ${meta.rows.length} 个，实际 ${files.length} 个`)
  }
  const picked = shuffle(files).slice(0, meta.rows.length)
  let newNames: string[]
  try {
    newNames = generateUniqueNames(picked, p.template, files)
  } catch (e) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_TEMPLATE_INVALID, (e as Error).message)
  }
  const plan = meta.rows.map((r, i) => ({
    rowNumber: r.rowNumber,
    window: r.window,
    oldName: picked[i],
    newName: newNames[i],
    newPath: join(dir, newNames[i]),
  }))
  return { accountsCount: meta.rows.length, filesCount: files.length, plan }
}

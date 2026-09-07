import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { applyFileAssign, fetchTools, previewFileAssign } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { EnglishCase, FileAssignTemplate, FileAssignRow, PositionType } from '../../types'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

/** 工具清单（工具中心卡片数据源） */
export function useTools() {
  return useQuery({ queryKey: ['tools'], queryFn: fetchTools })
}

/** 文件随机分配预览 */
export function useFileAssignPreview() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: (body: { sourceDir: string; column: string; template: FileAssignTemplate }) => previewFileAssign(body),
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 文件随机分配执行（成功后失效 settings，让数据源状态刷新） */
export function useFileAssignApply() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { sourceDir: string; column: string; plan: FileAssignRow[] }) => applyFileAssign(body),
    onSuccess: (res) => {
      message.success(`已重命名 ${res.renamedCount} 个文件，写回 ${res.updatedRows} 行，数据源已重载（${res.reloadedRows} 行）`)
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 面板表单状态（与 file-assign.tsx 的表单字段一一对应） */
export interface TemplateForm {
  english: boolean
  englishCount: number
  caseMode: EnglishCase
  digits: boolean
  digitsCount: number
  special: boolean
  specialCount: number
  charset: string
  position: PositionType
  positionValue: string
}

/** Windows 文件名非法字符（与后端 name-template 同规则） */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 表单 → 模板对象；校验失败返回 error 文案 */
export function buildTemplate(form: TemplateForm): { template: FileAssignTemplate } | { error: string } {
  const template: FileAssignTemplate = {
    english: form.english ? { count: Math.floor(form.englishCount), caseMode: form.caseMode } : null,
    digits: form.digits ? { count: Math.floor(form.digitsCount) } : null,
    special: form.special ? { count: Math.floor(form.specialCount), charset: form.charset.trim() } : null,
    position: { type: form.position },
  }
  if (form.position === 'after-position') {
    const n = Number(form.positionValue)
    if (!Number.isInteger(n) || n < 1) return { error: '指定位置需为不小于 1 的整数' }
    template.position.value = n
  }
  if (form.position === 'after-text') {
    const text = form.positionValue.trim()
    if (!text) return { error: '指定文本不能为空' }
    template.position.value = text
  }
  if (![template.english, template.digits, template.special].some((c) => c && c.count > 0)) return { error: '至少勾选一个生成组件（英文/数字/特殊字符）' }
  if (form.special) {
    if (!form.charset.trim()) return { error: '特殊字符集不能为空' }
    if (INVALID_FILENAME_CHARS.test(form.charset)) return { error: '特殊字符集含文件名非法字符' }
  }
  for (const c of [template.english, template.digits, template.special]) {
    if (c && (c.count < 1 || c.count > 20)) return { error: '组件个数需在 1-20 之间' }
  }
  return { template }
}

/** 示例名（纯展示）：与后端同规则的轻量实现；after-text 未命中时生成串放末尾 */
export function sampleName(oldName: string, template: FileAssignTemplate, rand: () => number = Math.random): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const pools = { lower, upper: lower.toUpperCase(), mixed: lower + lower.toUpperCase() }
  const pick = (pool: string, count: number) => Array.from({ length: count }, () => pool[Math.floor(rand() * pool.length)]).join('')
  let gen = ''
  if (template.english) gen += pick(pools[template.english.caseMode], template.english.count)
  if (template.digits) gen += pick('0123456789', template.digits.count)
  if (template.special) gen += pick(template.special.charset, template.special.count)
  const dot = oldName.lastIndexOf('.')
  const stem = dot > 0 ? oldName.slice(0, dot) : oldName
  const ext = dot > 0 ? oldName.slice(dot) : ''
  const pos = template.position
  let newStem: string
  if (pos.type === 'replace') newStem = gen
  else if (pos.type === 'before') newStem = gen + stem
  else if (pos.type === 'after') newStem = stem + gen
  else if (pos.type === 'after-position') {
    const n = Number(pos.value)
    newStem = n >= stem.length ? stem + gen : stem.slice(0, n) + gen + stem.slice(n)
  } else {
    const text = String(pos.value)
    const idx = stem.indexOf(text)
    newStem = idx < 0 ? stem + gen : stem.slice(0, idx + text.length) + gen + stem.slice(idx + text.length)
  }
  return newStem + ext
}

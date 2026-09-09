/**
 * 名称模板纯函数与表单类型（components 共享层）：文件随机分配工具页与定时计划弹窗复用
 * 依赖方向：仅依赖 ../types（前端自顶向下）；纯函数无副作用便于单测
 * 生成规则与后端 src/tools/file-assign/name-template.ts 保持一致
 */
import type { EnglishCase, FileAssignTemplate, PositionType } from '../types'

/** 模板编辑表单状态（与后端 FileAssignTemplate 一一对应） */
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

/** 模板编辑默认值（工具页与计划弹窗共用） */
export const DEFAULT_TEMPLATE_FORM: TemplateForm = {
  english: true,
  englishCount: 4,
  caseMode: 'lower',
  digits: true,
  digitsCount: 3,
  special: true,
  specialCount: 2,
  charset: '!@$%^',
  position: 'before',
  positionValue: '',
}

/** 后端模板对象 → 表单状态（编辑计划回填用）；缺失字段按默认值兜底 */
export function templateToForm(t: FileAssignTemplate | null | undefined): TemplateForm {
  if (!t) return { ...DEFAULT_TEMPLATE_FORM }
  return {
    english: t.english != null,
    englishCount: t.english?.count ?? DEFAULT_TEMPLATE_FORM.englishCount,
    caseMode: t.english?.caseMode ?? 'lower',
    digits: t.digits != null,
    digitsCount: t.digits?.count ?? DEFAULT_TEMPLATE_FORM.digitsCount,
    special: t.special != null,
    specialCount: t.special?.count ?? DEFAULT_TEMPLATE_FORM.specialCount,
    charset: t.special?.charset ?? DEFAULT_TEMPLATE_FORM.charset,
    position: t.position?.type ?? 'before',
    positionValue: t.position?.value !== undefined ? String(t.position.value) : '',
  }
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

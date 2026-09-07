/**
 * 名称模板（tools 层）：生成串生成 + 插入位置应用 + 批量唯一名生成
 * 依赖方向：仅依赖 ./types，被 planner/applier 引用；纯函数无副作用便于单测
 * 设计思路：扩展名始终保留；新名不与目录现存文件冲突（Windows 大小写不敏感，比较统一小写）
 */
import type { EnglishCase, FileAssignTemplate, PositionConfig } from './types'

const LOWER_POOL = 'abcdefghijklmnopqrstuvwxyz'
const UPPER_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

const ENGLISH_POOLS: Record<EnglishCase, string> = {
  lower: LOWER_POOL,
  upper: UPPER_POOL,
  mixed: LOWER_POOL + UPPER_POOL,
}

/** 各组件个数上限（防极端参数拖垮生成） */
export const MAX_COMPONENT_COUNT = 20

/** 唯一名生成最大尝试次数 */
const MAX_GEN_ATTEMPTS = 100

/** Windows 文件名非法字符（含控制字符）：用于拦截特殊字符集 */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 从字符池随机取 count 个字符 */
function pick(pool: string, count: number, rand: () => number): string {
  let out = ''
  for (let i = 0; i < count; i++) out += pool[Math.floor(rand() * pool.length)]
  return out
}

/** 校验模板：合法返回 null，否则返回中文错误文案 */
export function validateTemplate(t: FileAssignTemplate): string | null {
  if (!t || !t.position) return '名称模板不能为空'
  const comps = [t.english, t.digits, t.special]
  if (!comps.some((c) => c && c.count > 0)) return '至少勾选一个生成组件（英文/数字/特殊字符）'
  if (t.english && (t.english.count < 1 || t.english.count > MAX_COMPONENT_COUNT)) return `英文个数需在 1-${MAX_COMPONENT_COUNT} 之间`
  if (t.digits && (t.digits.count < 1 || t.digits.count > MAX_COMPONENT_COUNT)) return `数字位数需在 1-${MAX_COMPONENT_COUNT} 之间`
  if (t.special) {
    if (t.special.count < 1 || t.special.count > MAX_COMPONENT_COUNT) return `特殊字符个数需在 1-${MAX_COMPONENT_COUNT} 之间`
    if (!t.special.charset.trim()) return '特殊字符集不能为空'
    if (INVALID_FILENAME_CHARS.test(t.special.charset)) return '特殊字符集含文件名非法字符（\\ / : * ? " < > | 及控制字符）'
  }
  if (t.position.type === 'after-position' && (typeof t.position.value !== 'number' || !Number.isInteger(t.position.value) || t.position.value < 1)) {
    return '指定位置需为不小于 1 的整数'
  }
  if (t.position.type === 'after-text' && (typeof t.position.value !== 'string' || t.position.value.trim() === '')) {
    return '指定文本不能为空'
  }
  return null
}

/** 按模板生成随机生成串：英文 + 数字 + 特殊字符顺序拼接（与面板示例一致） */
export function generateRandomString(t: FileAssignTemplate, rand: () => number = Math.random): string {
  let out = ''
  if (t.english) out += pick(ENGLISH_POOLS[t.english.caseMode], t.english.count, rand)
  if (t.digits) out += pick('0123456789', t.digits.count, rand)
  if (t.special) out += pick(t.special.charset.trim(), t.special.count, rand)
  return out
}

/** 拆分扩展名：'a.png' → {stem:'a', ext:'.png'}；无扩展名 → ext 为空串 */
export function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/** 按插入位置把生成串应用到原文件名（扩展名保留）；after-text 未找到文本时抛错 */
export function applyPosition(oldName: string, gen: string, position: PositionConfig): string {
  const { stem, ext } = splitExt(oldName)
  let newStem: string
  switch (position.type) {
    case 'replace':
      newStem = gen
      break
    case 'before':
      newStem = gen + stem
      break
    case 'after':
      newStem = stem + gen
      break
    case 'after-position': {
      const n = Number(position.value)
      newStem = n >= stem.length ? stem + gen : stem.slice(0, n) + gen + stem.slice(n)
      break
    }
    case 'after-text': {
      const text = String(position.value)
      const idx = stem.indexOf(text)
      if (idx < 0) throw new Error(`指定文本「${text}」未在文件名「${oldName}」中出现`)
      newStem = stem.slice(0, idx + text.length) + gen + stem.slice(idx + text.length)
      break
    }
    default:
      throw new Error(`未知插入位置: ${String(position.type)}`)
  }
  return newStem + ext
}

/**
 * 为旧文件名批量生成新名：互不重复、且不与目录现存文件冲突
 * @param oldNames 按分配顺序排列的旧文件名（与账号行一一对应）
 * @param exists 目录现存文件名集合（含未参与分配的其余文件与旧名本身）
 */
export function generateUniqueNames(
  oldNames: string[],
  t: FileAssignTemplate,
  exists: string[],
  rand: () => number = Math.random,
): string[] {
  const taken = new Set(exists.map((n) => n.toLowerCase()))
  const result: string[] = []
  for (const old of oldNames) {
    let chosen = ''
    for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
      const candidate = applyPosition(old, generateRandomString(t, rand), t.position)
      if (!taken.has(candidate.toLowerCase())) {
        chosen = candidate
        break
      }
    }
    if (!chosen) throw new Error(`为「${old}」生成唯一新名失败（尝试 ${MAX_GEN_ATTEMPTS} 次），请调整模板或字符集`)
    taken.add(chosen.toLowerCase())
    result.push(chosen)
  }
  return result
}

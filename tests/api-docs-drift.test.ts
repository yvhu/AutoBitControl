import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * api 出口漂移守卫：src/api/index.ts 导出的每个能力函数名都必须出现在用户手册 docs/API-GUIDE.md 中。
 *
 * 解析 index.ts 的 `export { ... } from './x'` 行（正则天然跳过 `export type { ... }`，
 * 因为 type 与 { 之间有 token），逐个函数名在手册里按「整词」匹配，避免子串误命中。
 * 这样「新增/删除出口函数」与「手册同步」被测试绑定，防止文档漂移。
 */

/** 从 api 出口源码文本提取导出的函数名（仅 `export { ... } from` 行，不含 type 导出） */
function extractExportedFunctions(src: string): string[] {
  const names: string[] = []
  const re = /export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim()
      if (name !== '') names.push(name)
    }
  }
  return names
}

describe('api 出口漂移守卫', () => {
  const root = process.cwd()
  const indexSrc = readFileSync(join(root, 'src', 'api', 'index.ts'), 'utf8')
  const guide = readFileSync(join(root, 'docs', 'API-GUIDE.md'), 'utf8')
  const functions = extractExportedFunctions(indexSrc)

  it('能解析出预期数量的出口函数（防止解析失效）', () => {
    expect(functions.length).toBeGreaterThanOrEqual(20)
  })

  it('src/api/index.ts 导出的每个函数都出现在 API-GUIDE 中', () => {
    const missing = functions.filter((name) => !new RegExp(`\\b${name}\\b`).test(guide))
    expect(missing, `手册缺少 api 出口函数: ${missing.join(', ')}`).toEqual([])
  })
})

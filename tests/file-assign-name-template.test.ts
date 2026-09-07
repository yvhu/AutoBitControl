import { describe, it, expect } from 'vitest'
import {
  applyPosition,
  generateRandomString,
  generateUniqueNames,
  splitExt,
  validateTemplate,
} from '../src/tools/file-assign/name-template'
import type { FileAssignTemplate } from '../src/tools/file-assign/types'

const base: FileAssignTemplate = {
  english: { count: 2, caseMode: 'lower' },
  digits: null,
  special: null,
  position: { type: 'replace' },
}

const rand0 = () => 0
const randSeq = (vals: number[]) => {
  let i = 0
  return () => vals[i++ % vals.length]
}

describe('validateTemplate', () => {
  it('组件全空 → 报错', () => {
    const t: FileAssignTemplate = { english: null, digits: null, special: null, position: { type: 'replace' } }
    expect(validateTemplate(t)).toMatch(/至少勾选一个生成组件/)
  })

  it('个数越界 → 报错', () => {
    expect(validateTemplate({ ...base, english: { count: 21, caseMode: 'lower' } })).toMatch(/1-20/)
    expect(validateTemplate({ ...base, digits: { count: 0 } })).toMatch(/1-20/)
  })

  it('特殊字符集为空 → 报错', () => {
    expect(validateTemplate({ ...base, special: { count: 2, charset: '  ' } })).toMatch(/字符集不能为空/)
  })

  it('特殊字符集含文件名非法字符 → 报错', () => {
    expect(validateTemplate({ ...base, special: { count: 2, charset: 'ab*c' } })).toMatch(/非法字符/)
    expect(validateTemplate({ ...base, special: { count: 2, charset: 'ab\\c' } })).toMatch(/非法字符/)
    expect(validateTemplate({ ...base, special: { count: 2, charset: 'a:b' } })).toMatch(/非法字符/)
  })

  it('after-position 无合法位置 → 报错', () => {
    expect(validateTemplate({ ...base, position: { type: 'after-position', value: 0 } })).toMatch(/指定位置/)
    expect(validateTemplate({ ...base, position: { type: 'after-position' } })).toMatch(/指定位置/)
  })

  it('after-text 无文本 → 报错', () => {
    expect(validateTemplate({ ...base, position: { type: 'after-text' } })).toMatch(/指定文本/)
  })

  it('合法模板 → null', () => {
    expect(validateTemplate(base)).toBeNull()
  })
})

describe('generateRandomString', () => {
  it('rand=0 时英文取池首字符', () => {
    const t: FileAssignTemplate = { english: { count: 3, caseMode: 'lower' }, digits: null, special: null, position: { type: 'replace' } }
    expect(generateRandomString(t, rand0)).toBe('aaa')
  })

  it('大写池取 A-Z', () => {
    const t: FileAssignTemplate = { english: { count: 2, caseMode: 'upper' }, digits: null, special: null, position: { type: 'replace' } }
    expect(generateRandomString(t, rand0)).toBe('AA')
  })

  it('按 英文+数字+特殊字符 顺序拼接', () => {
    const t: FileAssignTemplate = {
      english: { count: 2, caseMode: 'lower' },
      digits: { count: 2 },
      special: { count: 1, charset: '!@' },
      position: { type: 'replace' },
    }
    expect(generateRandomString(t, rand0)).toBe('aa00!')
  })
})

describe('splitExt', () => {
  it('普通文件名', () => {
    expect(splitExt('a.png')).toEqual({ stem: 'a', ext: '.png' })
  })

  it('多点文件名取最后一段扩展名', () => {
    expect(splitExt('a.b.c.tar.gz')).toEqual({ stem: 'a.b.c.tar', ext: '.gz' })
  })

  it('无扩展名', () => {
    expect(splitExt('README')).toEqual({ stem: 'README', ext: '' })
  })
})

describe('applyPosition', () => {
  const gen = 'xx'
  const withPos = (type: FileAssignTemplate['position']['type'], value?: string | number) => ({
    ...base,
    position: { type, value },
  })

  it('replace：替换 stem 保留扩展名', () => {
    expect(applyPosition('a.png', gen, withPos('replace').position)).toBe('xx.png')
  })

  it('before：生成串在前', () => {
    expect(applyPosition('a.png', gen, withPos('before').position)).toBe('xxa.png')
  })

  it('after：生成串在后', () => {
    expect(applyPosition('a.png', gen, withPos('after').position)).toBe('axx.png')
  })

  it('after-position：第 N 个字符后插入', () => {
    expect(applyPosition('abcd.png', gen, withPos('after-position', 2).position)).toBe('abxxcd.png')
  })

  it('after-position：位置超长放末尾', () => {
    expect(applyPosition('ab.png', gen, withPos('after-position', 9).position)).toBe('abxx.png')
  })

  it('after-text：指定文本后插入', () => {
    expect(applyPosition('file2024x.png', gen, withPos('after-text', '2024').position)).toBe('file2024xxx.png')
  })

  it('after-text：未找到抛错', () => {
    expect(() => applyPosition('a.png', gen, withPos('after-text', 'zzz').position)).toThrow(/未在文件名/)
  })
})

describe('generateUniqueNames', () => {
  const t: FileAssignTemplate = { english: { count: 1, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }

  it('生成互不重复且不撞现存文件的新名', () => {
    const exists = ['x.png', 'ba.png']
    const names = generateUniqueNames(['a.png', 'b.png'], t, exists, randSeq([0, 0.3, 0.6, 0.9]))
    expect(names).toEqual(['aa.png', 'hb.png'])
  })

  it('尝试耗尽抛错', () => {
    const exists = ['aa.png', 'ab.png']
    expect(() => generateUniqueNames(['a.png', 'b.png'], t, exists, rand0)).toThrow(/唯一新名失败/)
  })
})

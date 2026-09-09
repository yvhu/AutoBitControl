import { describe, it, expect } from 'vitest'
import { DEFAULT_TEMPLATE_FORM, templateToForm } from './name-template'

describe('templateToForm', () => {
  it('null/undefined → 默认表单', () => {
    expect(templateToForm(null)).toEqual(DEFAULT_TEMPLATE_FORM)
    expect(templateToForm(undefined)).toEqual(DEFAULT_TEMPLATE_FORM)
  })

  it('模板对象 → 表单状态（组件开关与数值还原）', () => {
    const f = templateToForm({ english: null, digits: { count: 5 }, special: { count: 2, charset: '!@' }, position: { type: 'after' } })
    expect(f.english).toBe(false)
    expect(f.digits).toBe(true)
    expect(f.digitsCount).toBe(5)
    expect(f.special).toBe(true)
    expect(f.specialCount).toBe(2)
    expect(f.position).toBe('after')
  })

  it('after-position 数值回填为字符串', () => {
    const f = templateToForm({ english: { count: 2, caseMode: 'mixed' }, digits: null, special: null, position: { type: 'after-position', value: 3 } })
    expect(f.positionValue).toBe('3')
  })
})

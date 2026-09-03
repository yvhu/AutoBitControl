import { describe, it, expect } from 'vitest'
import { categoryColor, categoryLabel } from './hooks'

describe('categoryColor', () => {
  it('checkin 绿 / faucet 蓝 / mint 金 / other 灰', () => {
    expect(categoryColor('checkin')).toBe('#34D399')
    expect(categoryColor('faucet')).toBe('#38BDF8')
    expect(categoryColor('mint')).toBe('#FBBF24')
    expect(categoryColor('other')).toBe('#BAC5D9')
  })

  it('缺省（null）回退灰色', () => {
    expect(categoryColor(null)).toBe('#BAC5D9')
  })
})

describe('categoryLabel', () => {
  it('四类中文标签', () => {
    expect(categoryLabel('checkin')).toBe('签到')
    expect(categoryLabel('faucet')).toBe('领水')
    expect(categoryLabel('mint')).toBe('铸币')
    expect(categoryLabel('other')).toBe('其他')
  })

  it('缺省（null）回退「其他」', () => {
    expect(categoryLabel(null)).toBe('其他')
  })
})

import { triggerButton } from './index'

describe('triggerButton', () => {
  it('在途 → disabled + 「运行中」', () => {
    expect(triggerButton(true)).toEqual({ disabled: true, label: '运行中' })
  })
  it('非在途 → 可点 + 「立即触发」', () => {
    expect(triggerButton(false)).toEqual({ disabled: false, label: '立即触发' })
  })
})

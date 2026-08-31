import { describe, it, expect } from 'vitest'
import { categoryColor, categoryLabel, scheduleText } from './hooks'

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

describe('scheduleText', () => {
  it('字符串 → cron <值>', () => {
    expect(scheduleText('0 8 * * *')).toBe('cron 0 8 * * *')
  })

  it('对象 → cron <a>-<b> 错峰', () => {
    expect(scheduleText({ stagger: ['10', '20'] })).toBe('cron 10-20 错峰')
  })

  it('null → 手动触发', () => {
    expect(scheduleText(null)).toBe('手动触发')
  })
})

import { describe, it, expect } from 'vitest'
import { datasourceText, formatBalance, pointsToYuan } from './hooks'

describe('pointsToYuan', () => {
  it('1000 点 = ¥1', () => {
    expect(pointsToYuan(1000)).toBe(1)
  })

  it('2500 点 = ¥2.5', () => {
    expect(pointsToYuan(2500)).toBe(2.5)
  })

  it('四舍五入到分', () => {
    expect(pointsToYuan(333)).toBe(0.33)
    expect(pointsToYuan(1)).toBe(0)
  })
})

describe('formatBalance', () => {
  it('已配置 → N 点（¥X）', () => {
    expect(formatBalance({ configured: true, points: 12345, yuan: 12.345 })).toBe('12,345 点（¥12.345）')
  })

  it('未配置 → 未配置 Key', () => {
    expect(formatBalance({ configured: false, points: 0, yuan: 0 })).toBe('未配置 Key')
  })
})

describe('datasourceText', () => {
  it('可用 → N 行（列: a, b, c）', () => {
    expect(datasourceText({ available: true, rows: 3, columns: ['a', 'b', 'c'] })).toBe('3 行（列: a, b, c）')
  })

  it('不可用 → 未配置', () => {
    expect(datasourceText({ available: false, rows: 0, columns: [] })).toBe('未配置')
  })
})

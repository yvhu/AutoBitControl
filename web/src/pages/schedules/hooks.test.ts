/**
 * 定时任务页 hooks 单测：覆盖纯函数 modeLabel / MODE_OPTIONS
 * （数据 hooks 走 react-query 不做单测，与 tasks/hooks 惯例一致）
 */
import { describe, it, expect } from 'vitest'
import { modeLabel, MODE_OPTIONS } from './hooks'

describe('modeLabel', () => {
  it('四种模式中文标签', () => {
    expect(modeLabel('interval')).toBe('每 N 小时')
    expect(modeLabel('daily')).toBe('每日')
    expect(modeLabel('weekly')).toBe('每周')
    expect(modeLabel('monthly')).toBe('每月')
  })
})

describe('MODE_OPTIONS', () => {
  it('四个选项且值与后端模式一致', () => {
    expect(MODE_OPTIONS.map((o) => o.value)).toEqual(['interval', 'daily', 'weekly', 'monthly'])
  })
})

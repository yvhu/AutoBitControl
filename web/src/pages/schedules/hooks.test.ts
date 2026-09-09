/**
 * 定时任务页 hooks 单测：覆盖纯函数 modeLabel / MODE_OPTIONS
 * （数据 hooks 走 react-query 不做单测，与 tasks/hooks 惯例一致）
 */
import { describe, it, expect } from 'vitest'
import dayjs from 'dayjs'
import { modeLabel, MODE_OPTIONS, buildPayload } from './hooks'
import type { FileAssignTemplate } from '../../types'

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

describe('buildPayload', () => {
  const tpl: FileAssignTemplate = { english: null, digits: { count: 3 }, special: null, position: { type: 'before' } }

  it('开启自动分配 → config 携带 fileAssign（daily 模式）', () => {
    const p = buildPayload({ name: 'n', mode: 'daily', taskKeys: ['xyz-shelbynet'], times: [dayjs('09:00', 'HH:mm')], fileAssignEnabled: true, fileAssignSourceDir: 'C:\\f', fileAssignColumn: '文件地址' }, tpl)
    expect(p.config.fileAssign).toEqual({ sourceDir: 'C:\\f', column: '文件地址', template: tpl })
    expect(p.config.times).toEqual(['09:00'])
  })

  it('关闭自动分配 → config 不含 fileAssign', () => {
    const p = buildPayload({ name: 'n', mode: 'daily', taskKeys: ['xyz-shelbynet'], times: [dayjs('09:00', 'HH:mm')], fileAssignEnabled: false }, tpl)
    expect(p.config.fileAssign).toBeUndefined()
  })

  it('interval 模式时间配置保持原语义', () => {
    const p = buildPayload({ name: 'n', mode: 'interval', everyHours: 6, taskKeys: ['xyz-shelbynet'], fileAssignEnabled: true, fileAssignSourceDir: 'C:\\f', fileAssignColumn: '文件地址' }, tpl)
    expect(p.config.everyHours).toBe(6)
    expect(p.config.fileAssign?.template).toEqual(tpl)
  })
})

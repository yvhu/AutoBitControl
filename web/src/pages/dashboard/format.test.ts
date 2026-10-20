import { describe, it, expect } from 'vitest'
import { formatDuration, formatDateTime, failureKindLabel, formatEta } from './format'

describe('formatDateTime 批次时间展示', () => {
  it("'YYYY-MM-DD HH:mm:ss.SSS' → 'YYYY-MM-DD HH:mm'", () => {
    expect(formatDateTime('2026-09-04 09:00:00.000')).toBe('2026-09-04 09:00')
    expect(formatDateTime('2026-09-04 09:26:10.000')).toBe('2026-09-04 09:26')
  })
})

describe('formatDuration 总耗时展示', () => {
  it('null（无结束时间）→ —', () => {
    expect(formatDuration(null)).toBe('—')
  })
  it('60 秒以内 → Xs', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59)).toBe('59s')
  })
  it('60 秒及以上 → Xh Ym Zs', () => {
    expect(formatDuration(60)).toBe('1m 0s')
    expect(formatDuration(92)).toBe('1m 32s')
    expect(formatDuration(605)).toBe('10m 5s')
    expect(formatDuration(3600)).toBe('1h 0m 0s')
    expect(formatDuration(7451)).toBe('2h 4m 11s')
  })
})

describe('formatEta 预计开始展示', () => {
  it('null/undefined → —', () => {
    expect(formatEta(null)).toBe('—')
    expect(formatEta(undefined)).toBe('—')
  })
  it('非法值（NaN/Infinity/0/负数）→ —', () => {
    expect(formatEta(Number.NaN)).toBe('—')
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatEta(Number.NEGATIVE_INFINITY)).toBe('—')
    expect(formatEta(0)).toBe('—')
    expect(formatEta(-1)).toBe('—')
  })
  it('固定时间 → 本地 HH:mm（两位数补零）', () => {
    expect(formatEta(new Date(2026, 9, 19, 9, 5, 30).getTime())).toBe('09:05')
    expect(formatEta(new Date(2026, 0, 2, 0, 7, 0).getTime())).toBe('00:07')
    expect(formatEta(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe('23:59')
  })
})

it('failureKindLabel 中文文案', () => {
  expect(failureKindLabel('environment')).toBe('环境失败')
  expect(failureKindLabel('task')).toBe('任务失败')
  expect(failureKindLabel('timeout')).toBe('超时')
  expect(failureKindLabel('stopped')).toBe('手动停止')
  expect(failureKindLabel('captcha')).toBe('验证码')
  expect(failureKindLabel('breaker')).toBe('熔断跳过')
  expect(failureKindLabel(null)).toBe('—')
  expect(failureKindLabel(undefined)).toBe('—')
})

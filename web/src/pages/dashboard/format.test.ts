import { describe, it, expect } from 'vitest'
import { formatDuration, formatDateTime, failureKindLabel } from './format'

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

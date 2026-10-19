import { describe, it, expect } from 'vitest'
import { breakerView, formatProbeTime } from './breaker'
import type { ProfileRow } from '../../types'

const profile = (over: Partial<ProfileRow> = {}): ProfileRow => ({
  id: 1,
  bitbrowserId: 'bb-1',
  name: '窗口1',
  enabled: 1,
  circuitBreakerCount: 0,
  breakerState: 'closed',
  breakerNextProbeAt: null,
  breakerReason: null,
  breakerUpdatedAt: null,
  ...over,
} as ProfileRow)

describe('breakerView', () => {
  it('关闭熔断配置时显示已关闭', () => {
    expect(breakerView(profile({ breakerState: 'open' }), 2, false)).toMatchObject({ color: 'default', text: '熔断已关闭' })
  })

  it('open 显示熔断中和探测时间', () => {
    const v = breakerView(profile({ breakerState: 'open', breakerNextProbeAt: '2026-10-19 14:30:00.000', breakerReason: 'CDP 连接失败' }), 2, true)
    expect(v.text).toBe('熔断中 · 14:30 探测')
    expect(v.title).toBe('CDP 连接失败')
  })

  it('half_open 显示探测中', () => {
    expect(breakerView(profile({ breakerState: 'half_open' }), 2, true).text).toBe('探测中')
  })

  it('closed 有计数时显示环境失败次数', () => {
    expect(breakerView(profile({ circuitBreakerCount: 1 }), 2, true).text).toBe('环境失败 1/2')
  })

  it('closed 且计数为 0 时显示正常', () => {
    expect(breakerView(profile({ circuitBreakerCount: 0 }), 2, true)).toMatchObject({ color: 'green', text: '正常' })
  })

  it('open 且无探测时间时仅显示熔断中', () => {
    expect(breakerView(profile({ breakerState: 'open', breakerNextProbeAt: null }), 2, true)).toMatchObject({ color: 'red', text: '熔断中' })
  })

  it('formatProbeTime 只取 HH:mm', () => {
    expect(formatProbeTime('2026-10-19 14:30:00.000')).toBe('14:30')
  })
})

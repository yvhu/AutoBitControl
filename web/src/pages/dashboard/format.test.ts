import { describe, it, expect } from 'vitest'
import { formatDuration } from './format'

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

import { describe, it, expect } from 'vitest'
import { filterProfiles } from './hooks'
import type { ProfileRow } from '../../types'

const mk = (id: number, name: string, bitbrowserId: string): ProfileRow => ({
  id,
  name,
  bitbrowserId,
  enabled: 1,
  circuitBreakerCount: 0,
})

describe('filterProfiles', () => {
  const profiles = [
    mk(1, '窗口A', 'bb-abc123'),
    mk(2, '窗口B', 'bb-def456'),
    mk(3, 'Test', 'bb-abc789'),
  ]

  it('空查询/纯空白返回全部', () => {
    expect(filterProfiles(profiles, '')).toHaveLength(3)
    expect(filterProfiles(profiles, '   ')).toHaveLength(3)
  })

  it('按名称过滤（大小写不敏感）', () => {
    expect(filterProfiles(profiles, 'test')).toEqual([profiles[2]])
    expect(filterProfiles(profiles, '窗口a')).toEqual([profiles[0]])
  })

  it('按 bitbrowserId 过滤', () => {
    expect(filterProfiles(profiles, 'abc123')).toEqual([profiles[0]])
    expect(filterProfiles(profiles, 'BB-ABC')).toEqual([profiles[0], profiles[2]])
  })

  it('无匹配返回空数组', () => {
    expect(filterProfiles(profiles, '不存在的窗口')).toEqual([])
  })
})

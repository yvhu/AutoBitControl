import { describe, it, expect } from 'vitest'
import { filterProfiles, profileSorters } from './hooks'
import type { ProfileRow } from '../../types'

const mk = (id: number, name: string, bitbrowserId: string): ProfileRow => ({
  id,
  name,
  bitbrowserId,
  enabled: 1,
  circuitBreakerCount: 0,
  open: false,
  remark: null,
  seq: null,
  lastIp: null,
  lastCountry: null,
  coreVersion: null,
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

describe('profileSorters', () => {
  const sorted = (items: ProfileRow[], fn: (a: ProfileRow, b: ProfileRow) => number): ProfileRow[] =>
    [...items].sort(fn)

  it('name 按中文拼音升序', () => {
    const rows = [mk(1, '窗口B', 'b'), mk(2, '窗口A', 'a'), mk(3, '窗口C', 'c')]
    expect(sorted(rows, profileSorters.name).map((p) => p.name)).toEqual(['窗口A', '窗口B', '窗口C'])
  })

  it('breaker 按熔断计数升序', () => {
    const rows = [
      { ...mk(1, '窗口A', 'a'), circuitBreakerCount: 2 },
      { ...mk(2, '窗口B', 'b'), circuitBreakerCount: 0 },
      { ...mk(3, '窗口C', 'c'), circuitBreakerCount: 1 },
    ]
    expect(sorted(rows, profileSorters.breaker).map((p) => p.circuitBreakerCount)).toEqual([0, 1, 2])
  })

  it('enabled 停用在前（0 < 1）', () => {
    const rows = [
      { ...mk(1, '窗口A', 'a'), enabled: 1 },
      { ...mk(2, '窗口B', 'b'), enabled: 0 },
    ]
    expect(sorted(rows, profileSorters.enabled).map((p) => p.enabled)).toEqual([0, 1])
  })

  it('success 按传入的成功数函数升序', () => {
    const rows = [
      mk(1, '窗口A', 'a'),
      mk(2, '窗口B', 'b'),
      mk(3, '窗口C', 'c'),
    ]
    const successOf = (p: ProfileRow) => (p.id === 1 ? 3 : p.id === 2 ? 1 : 2)
    expect(sorted(rows, profileSorters.success(successOf)).map((p) => p.id)).toEqual([2, 3, 1])
  })
})

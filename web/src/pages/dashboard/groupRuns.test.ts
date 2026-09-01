import { describe, it, expect } from 'vitest'
import { groupRuns, latestStats, historyMap } from './groupRuns'
import type { RunRow } from '../../types'

/** 造一行：slot 与状态必填，其余字段给默认值 */
function makeRun(over: Partial<RunRow>): RunRow {
  return {
    id: over.id ?? 1,
    profileId: over.profileId ?? 1,
    taskKey: over.taskKey ?? 't',
    date: '2026-09-01',
    slot: over.slot ?? 0,
    status: over.status ?? 'success',
    attempts: 1,
    error: null,
    screenshot: null,
    startedAt: null,
    finishedAt: null,
    durationSec: null,
    profileName: '窗口1',
    ...over,
  } as RunRow
}

describe('groupRuns 多轮折叠', () => {
  it('同窗口同任务多轮 → 一组；latest 为最大 slot；history 按 slot 倒序', () => {
    const groups = groupRuns([
      makeRun({ id: 1, profileId: 1, taskKey: 't1', slot: 0, status: 'failed' }),
      makeRun({ id: 2, profileId: 1, taskKey: 't1', slot: 1, status: 'success' }),
      makeRun({ id: 3, profileId: 1, taskKey: 't1', slot: 2, status: 'success' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].latest.id).toBe(3)
    expect(groups[0].history.map((r) => r.id)).toEqual([2, 1])
  })

  it('不同窗口/不同任务各成一组；组顺序按首次出现', () => {
    const groups = groupRuns([
      makeRun({ id: 1, profileId: 1, taskKey: 't1' }),
      makeRun({ id: 2, profileId: 2, taskKey: 't1' }),
      makeRun({ id: 3, profileId: 1, taskKey: 't2' }),
    ])
    expect(groups.map((g) => g.latest.id)).toEqual([1, 2, 3])
    expect(groups.every((g) => g.history.length === 0)).toBe(true)
  })

  it('单轮组不产生 history', () => {
    const groups = groupRuns([makeRun({ id: 9 })])
    expect(groups[0].history).toEqual([])
  })
})

describe('latestStats 最新轮统计口径', () => {
  it('只按每窗口每任务最新一轮计数（历史轮次不参与）', () => {
    const stats = latestStats([
      // 组 A：历史 failed、最新 success → 计 1 成功
      makeRun({ id: 1, profileId: 1, taskKey: 't1', slot: 0, status: 'failed' }),
      makeRun({ id: 2, profileId: 1, taskKey: 't1', slot: 1, status: 'success' }),
      // 组 B：历史 success、最新 failed → 计 1 失败
      makeRun({ id: 3, profileId: 2, taskKey: 't1', slot: 0, status: 'success' }),
      makeRun({ id: 4, profileId: 2, taskKey: 't1', slot: 1, status: 'failed' }),
      // 组 C：最新 retry_wait → 计 1 进行中
      makeRun({ id: 5, profileId: 3, taskKey: 't1', slot: 0, status: 'retry_wait' }),
    ])
    expect(stats.total).toBe(3)
    expect(stats.success).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.running).toBe(1)
    expect(stats.skipped).toBe(0)
  })
})

describe('historyMap 历史轮次索引', () => {
  it('key = 最新行 id；单轮组不入表', () => {
    const map = historyMap([
      makeRun({ id: 1, profileId: 1, taskKey: 't1', slot: 0 }),
      makeRun({ id: 2, profileId: 1, taskKey: 't1', slot: 1 }),
      makeRun({ id: 3, profileId: 2, taskKey: 't1', slot: 0 }),
    ])
    expect(map.get(2)?.map((r) => r.id)).toEqual([1])
    expect(map.has(3)).toBe(false)
  })
})

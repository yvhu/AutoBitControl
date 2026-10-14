import { describe, it, expect } from 'vitest'
import { buildTaskInfo, batchInFlight } from './hooks'
import type { BatchItem, TaskMetaView } from '../../types'

describe('buildTaskInfo', () => {
  it('名称与分组名映射', () => {
    const tasks = [
      { key: 'a', name: '任务A', group: { key: 'g1', name: '组1' } },
      { key: 'b', name: '任务B', group: null },
    ] as unknown as TaskMetaView[]
    expect(buildTaskInfo(tasks)).toEqual({
      a: { name: '任务A', groupName: '组1' },
      b: { name: '任务B', groupName: null },
    })
  })

  it('空数组返回空映射', () => {
    expect(buildTaskInfo([])).toEqual({})
  })
})

describe('batchInFlight', () => {
  const mk = (stats: Partial<BatchItem['stats']>): BatchItem =>
    ({ stats: { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, retryWait: 0, pending: 0, ...stats } }) as unknown as BatchItem

  it('running/pending/retryWait 任一 > 0 为 true', () => {
    expect(batchInFlight(mk({ running: 1 }))).toBe(true)
    expect(batchInFlight(mk({ pending: 1 }))).toBe(true)
    expect(batchInFlight(mk({ retryWait: 1 }))).toBe(true)
  })
  it('全为 0 为 false', () => {
    expect(batchInFlight(mk({ success: 3 }))).toBe(false)
  })
})

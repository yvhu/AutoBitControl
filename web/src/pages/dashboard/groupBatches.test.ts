import { describe, it, expect } from 'vitest'
import { splitBatches, batchProgress, batchTiming } from './groupBatches'
import type { BatchItem } from '../../types'

function makeBatch(over: Partial<BatchItem>): BatchItem {
  return {
    id: over.id ?? 1,
    kind: over.kind ?? 'bulk',
    taskKey: over.taskKey ?? 't1',
    source: over.source ?? 'trigger-all',
    createdAt: over.createdAt ?? '2026-09-04 09:00:00.000',
    lastFinishedAt: over.lastFinishedAt ?? null,
    stats: over.stats ?? { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 },
  } as BatchItem
}

describe('splitBatches 散批聚合', () => {
  it('bulk 与 single 分流', () => {
    const { bulk, single } = splitBatches([
      makeBatch({ id: 1 }),
      makeBatch({ id: 2, kind: 'single', source: 'trigger-single' }),
      makeBatch({ id: 3 }),
      makeBatch({ id: 4, kind: 'single', source: 'task-run' }),
    ])
    expect(bulk.map((b) => b.id)).toEqual([1, 3])
    expect(single.map((b) => b.id)).toEqual([2, 4])
  })

  it('kind=schedule 归入 bulk 主列表', () => {
    const { bulk, single } = splitBatches([
      makeBatch({ id: 5, kind: 'schedule', source: '计划#1 每日签到' }),
    ])
    expect(bulk.map((b) => b.id)).toEqual([5])
    expect(single).toHaveLength(0)
  })
})

describe('batchProgress 批次完成率', () => {
  it('done = 终态行数；pct 四舍五入；total=0 时 pct=0', () => {
    const p = batchProgress(makeBatch({ stats: { total: 50, success: 40, failed: 3, captchaFailed: 2, skipped: 1, running: 2, pending: 2, retryWait: 0 } }))
    expect(p.done).toBe(46)
    expect(p.pct).toBe(92)
    expect(batchProgress(makeBatch({})).pct).toBe(0)
  })
})

describe('batchTiming 批次时间信息', () => {
  it('终态批次：finished=true 且耗时为 lastFinishedAt - createdAt', () => {
    const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: '2026-09-04 09:26:10.000', stats: { total: 50, success: 43, failed: 3, captchaFailed: 2, skipped: 2, running: 0, pending: 0, retryWait: 0 } }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBe(1570)
  })

  it('进行中/重试中/待执行批次：finished=false 且 durationSec=null', () => {
    for (const stats of [
      { total: 50, success: 10, failed: 0, captchaFailed: 0, skipped: 0, running: 3, pending: 37, retryWait: 0 },
      { total: 50, success: 10, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 5 },
    ]) {
      const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: '2026-09-04 09:26:10.000', stats }))
      expect(t.finished).toBe(false)
      expect(t.durationSec).toBeNull()
    }
  })

  it('终态但缺 lastFinishedAt：durationSec=null', () => {
    const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: null, stats: { total: 1, success: 1, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 } }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBeNull()
  })
})

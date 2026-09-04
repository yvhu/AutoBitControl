import { describe, it, expect } from 'vitest'
import { splitBatches, batchProgress } from './groupBatches'
import type { BatchItem } from '../../types'

function makeBatch(over: Partial<BatchItem>): BatchItem {
  return {
    id: over.id ?? 1,
    kind: over.kind ?? 'bulk',
    taskKey: over.taskKey ?? 't1',
    source: over.source ?? 'trigger-all',
    createdAt: over.createdAt ?? '2026-09-04 09:00:00.000',
    stats: over.stats ?? { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0 },
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
})

describe('batchProgress 批次完成率', () => {
  it('done = 终态行数；pct 四舍五入；total=0 时 pct=0', () => {
    const p = batchProgress(makeBatch({ stats: { total: 50, success: 40, failed: 3, captchaFailed: 2, skipped: 1, running: 2, pending: 2 } }))
    expect(p.done).toBe(46)
    expect(p.pct).toBe(92)
    expect(batchProgress(makeBatch({})).pct).toBe(0)
  })
})

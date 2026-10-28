import { describe, it, expect } from 'vitest'
import { splitBatches, batchProgress, batchTiming, canRerunFailed, hasRecentActivity, latestOnly, isRunActionable, runActionTarget } from './groupBatches'
import type { BatchItem } from '../../types'

function makeBatch(over: Partial<BatchItem>): BatchItem {
  return {
    id: over.id ?? 1,
    kind: over.kind ?? 'bulk',
    taskKey: over.taskKey ?? 't1',
    source: over.source ?? 'trigger-all',
    createdAt: over.createdAt ?? '2026-09-04 09:00:00.000',
    lastActivityAt: over.lastActivityAt ?? over.createdAt ?? '2026-09-04 09:00:00.000',
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

describe('canRerunFailed 重跑失败按钮可见性', () => {
  const stats = (failed: number, captchaFailed = 0) => ({ total: 5, success: 4, failed, captchaFailed, skipped: 0, running: 0, pending: 0, retryWait: 0 })

  it('任意批次类型有失败即显示', () => {
    for (const kind of ['bulk', 'schedule', 'single'] as const) {
      expect(canRerunFailed(makeBatch({ kind, stats: stats(1) }))).toBe(true)
    }
  })

  it('验证码失败同样显示', () => {
    expect(canRerunFailed(makeBatch({ kind: 'schedule', stats: stats(0, 1) }))).toBe(true)
  })

  it('无失败不显示', () => {
    for (const kind of ['bulk', 'schedule', 'single'] as const) {
      expect(canRerunFailed(makeBatch({ kind, stats: stats(0) }))).toBe(false)
    }
  })
})

describe('latestOnly 历史轮次过滤', () => {
  it('保留 isLatest 为 true 或缺失的行', () => {
    const runs = [
      { id: 1, isLatest: false },
      { id: 2, isLatest: true },
      { id: 3 },
    ] as never
    expect(latestOnly(runs).map((r) => r.id)).toEqual([2, 3])
  })
})

describe('行级操作路由', () => {
  it('历史轮次不可操作，最新轮次可操作', () => {
    expect(isRunActionable({ isLatest: false } as never)).toBe(false)
    expect(isRunActionable({ isLatest: true } as never)).toBe(true)
    expect(isRunActionable({} as never)).toBe(true)
  })

  it('有 batchId 走原批次重跑，无 batchId 走单窗口触发', () => {
    expect(runActionTarget({ batchId: 2 } as never)).toBe('batch')
    expect(runActionTarget({ batchId: null } as never)).toBe('single')
    expect(runActionTarget({} as never)).toBe('single')
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

describe('hasRecentActivity 最近活动提示', () => {
  it('比创建时间晚 61 秒 → 展示', () => {
    expect(hasRecentActivity(makeBatch({
      createdAt: '2026-09-04 09:00:00.000',
      lastActivityAt: '2026-09-04 09:01:01.000',
    }))).toBe(true)
  })

  it('比创建时间晚 60 秒 → 不展示', () => {
    expect(hasRecentActivity(makeBatch({
      createdAt: '2026-09-04 09:00:00.000',
      lastActivityAt: '2026-09-04 09:01:00.000',
    }))).toBe(false)
  })

  it('跨日重跑 → 展示', () => {
    expect(hasRecentActivity(makeBatch({
      createdAt: '2026-09-04 09:00:00.000',
      lastActivityAt: '2026-09-05 09:00:00.000',
    }))).toBe(true)
  })

  it('lastActivityAt 缺失或等于 createdAt → 不展示', () => {
    const missing = makeBatch({})
    delete (missing as Partial<BatchItem>).lastActivityAt
    expect(hasRecentActivity(missing)).toBe(false)
    expect(hasRecentActivity(makeBatch({
      createdAt: '2026-09-04 09:00:00.000',
      lastActivityAt: '2026-09-04 09:00:00.000',
    }))).toBe(false)
  })
})

describe('batchTiming 批次时间信息', () => {
  it('终态批次：finished=true 且耗时从最近一轮入队起算', () => {
    const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: '2026-09-04 09:26:10.000', stats: { total: 50, success: 43, failed: 3, captchaFailed: 2, skipped: 2, running: 0, pending: 0, retryWait: 0 } }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBe(1570)
  })

  it('跨日重跑后耗时从最近活动起算', () => {
    const t = batchTiming(makeBatch({
      createdAt: '2026-09-04 09:00:00.000',
      lastActivityAt: '2026-09-05 09:00:00.000',
      lastFinishedAt: '2026-09-05 09:26:10.000',
      stats: { total: 1, success: 1, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 },
    }))
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

  it('lastFinishedAt 早于最近活动：durationSec=null', () => {
    const t = batchTiming(makeBatch({
      createdAt: '2026-09-04 09:00:00.000',
      lastActivityAt: '2026-09-05 09:00:00.000',
      lastFinishedAt: '2026-09-04 09:26:10.000',
      stats: { total: 1, success: 1, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 },
    }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBeNull()
  })

  it('终态但缺 lastFinishedAt：durationSec=null', () => {
    const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: null, stats: { total: 1, success: 1, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 } }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBeNull()
  })
})

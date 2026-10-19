import { describe, it, expect, vi } from 'vitest'
import { recoverRuns } from '../src/engine/run-recovery'

describe('recoverRuns', () => {
  it('先结算跨日残留与旧 slot，再把当天 running 重置为 pending', async () => {
    const settleOldQueuedRuns = vi.fn().mockResolvedValue(3)
    const settleOldRunningRuns = vi.fn().mockResolvedValue(2)
    const settleSupersededRuns = vi.fn().mockResolvedValue(4)
    const requeueStaleRunning = vi.fn().mockResolvedValue(1)
    const db = { settleOldQueuedRuns, settleOldRunningRuns, settleSupersededRuns, requeueStaleRunning }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    const r = await recoverRuns({ db: db as never, logger, now: new Date('2026-10-19T00:00:00Z') })
    expect(settleOldQueuedRuns).toHaveBeenCalledWith('2026-10-19')
    expect(settleOldRunningRuns).toHaveBeenCalledWith('2026-10-19')
    expect(settleSupersededRuns).toHaveBeenCalledWith('2026-10-19')
    expect(requeueStaleRunning).toHaveBeenCalledWith('2026-10-19', Date.parse('2026-10-19T00:00:00Z'))
    // 旧日期必须先于当天 running 重排（否则旧 running 会被误重置成 pending）
    expect(settleOldRunningRuns.mock.invocationCallOrder[0]).toBeLessThan(requeueStaleRunning.mock.invocationCallOrder[0])
    expect(r).toEqual({ oldQueued: 3, oldRunning: 2, superseded: 4, requeued: 1 })
  })
})

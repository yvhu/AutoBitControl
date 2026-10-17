/**
 * task-stopper 单测（注入假库 + 假关窗，不连真机）
 * 覆盖：非终态行结算 skipped、终态行不动、置取消标记、关窗、清开窗登记
 */
import { describe, it, expect, vi } from 'vitest'
import { createTaskStopper } from '../src/engine/task-stopper'
import { CancelRegistry } from '../src/engine/cancel-registry'
import type { AppDb, ProfileRow, RunRow } from '../src/infrastructure/db'

const profile: ProfileRow = { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }

function makeDeps(over: { existing?: Partial<RunRow> | null; open?: { http: string } | null } = {}) {
  const db = {
    listProfiles: vi.fn().mockResolvedValue([profile]),
    getLatestRun: vi.fn().mockResolvedValue(over.existing ?? null),
    upsertRun: vi.fn().mockResolvedValue(null),
    getOpenWindow: vi.fn().mockResolvedValue(over.open ?? null),
    clearOpenWindow: vi.fn().mockResolvedValue(undefined),
    listRunsForBatch: vi.fn().mockResolvedValue([]),
    nextRunSlot: vi.fn().mockResolvedValue(0),
  }
  const registry = new CancelRegistry()
  const closeBrowser = vi.fn().mockResolvedValue(undefined)
  const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
  return { db, registry, closeBrowser, logger }
}

const run = (status: RunRow['status'], slot = 0): Partial<RunRow> => ({ id: 9, profileId: 1, taskKey: 't', date: '2026-10-13', slot, status, attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, batchId: 5, diagPath: null, profileName: '窗口1', bitbrowserId: 'bb-1' })

function makeStopper(d: ReturnType<typeof makeDeps>, cancelQueued = vi.fn().mockReturnValue([])) {
  return createTaskStopper({
    db: d.db as unknown as AppDb,
    registry: d.registry,
    logger: d.logger,
    closeBrowser: d.closeBrowser,
    getOpenWindow: (id) => d.db.getOpenWindow(id),
    clearOpenWindow: (id) => d.db.clearOpenWindow(id),
    cancelQueued,
  })
}

describe('TaskStopper', () => {
  it('非终态行：置标记 + 结算 skipped（手动停止）+ 关窗 + 清登记', async () => {
    const d = makeDeps({ existing: run('running'), open: { http: '127.0.0.1:61234' } })
    const stopper = makeStopper(d)
    const stopped = await stopper.stop(1, 't')
    expect(stopped).toBe(true)
    expect(d.registry.isCancelled(1, 't')).toBe(true)
    expect(d.db.upsertRun).toHaveBeenCalledWith(1, 't', expect.any(String), 0, 'skipped', expect.objectContaining({ error: '手动停止' }))
    expect(d.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(d.db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('终态行：不置标记、不结算、不关窗，返回 false', async () => {
    const d = makeDeps({ existing: run('success') })
    const stopper = makeStopper(d)
    expect(await stopper.stop(1, 't')).toBe(false)
    expect(d.registry.isCancelled(1, 't')).toBe(false)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.closeBrowser).not.toHaveBeenCalled()
  })

  it('批次停止：在途行走 stop（关窗），纯排队窗口补 skipped 但不置取消标记', async () => {
    const d = makeDeps()
    const active = run('running')
    d.db.listRunsForBatch.mockResolvedValue([active, run('success')])
    d.db.getLatestRun.mockImplementation((pid: number) => Promise.resolve(pid === 1 ? active : null))
    d.db.nextRunSlot.mockResolvedValue(3)
    const cancelQueued = vi.fn().mockReturnValue([{ profileId: 2, taskKey: 't', running: false }])
    const stopper = makeStopper(d, cancelQueued)
    expect(await stopper.stopBatch(5)).toBe(2)
    expect(cancelQueued).toHaveBeenCalledWith(5)
    expect(d.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(d.registry.isCancelled(1, 't')).toBe(true)
    expect(d.registry.isCancelled(2, 't')).toBe(false)
    expect(d.db.upsertRun).toHaveBeenCalledWith(2, 't', expect.any(String), 3, 'skipped', expect.objectContaining({ error: '手动停止', batchId: 5 }))
  })

  it('批次停止：运行竞态下尚未落行的窗口置取消标记并补 skipped', async () => {
    const d = makeDeps()
    d.db.getLatestRun.mockResolvedValue(null)
    const stopper = makeStopper(d, vi.fn().mockReturnValue([{ profileId: 2, taskKey: 't', running: true }]))
    expect(await stopper.stopBatch(5)).toBe(1)
    expect(d.registry.isCancelled(2, 't')).toBe(true)
    expect(d.db.upsertRun).toHaveBeenCalledWith(2, 't', expect.any(String), 0, 'skipped', expect.objectContaining({ batchId: 5 }))
  })

  it('批次停止：排队窗口当天已有终态行时仍补本批次 skipped 行', async () => {
    const d = makeDeps()
    d.db.getLatestRun.mockResolvedValue(run('success'))
    const stopper = makeStopper(d, vi.fn().mockReturnValue([{ profileId: 2, taskKey: 't', running: false }]))
    expect(await stopper.stopBatch(5)).toBe(1)
    expect(d.db.upsertRun).toHaveBeenCalledWith(2, 't', expect.any(String), 0, 'skipped', expect.objectContaining({ error: '手动停止', batchId: 5 }))
    expect(d.registry.isCancelled(2, 't')).toBe(false)
  })
})

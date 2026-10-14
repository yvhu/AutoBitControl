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
  } as unknown as AppDb
  const registry = new CancelRegistry()
  const closeBrowser = vi.fn().mockResolvedValue(undefined)
  const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
  return { db, registry, closeBrowser, logger }
}

const run = (status: RunRow['status'], slot = 0): Partial<RunRow> => ({ id: 9, profileId: 1, taskKey: 't', date: '2026-10-13', slot, status, attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, batchId: 5, diagPath: null, profileName: '窗口1', bitbrowserId: 'bb-1' })

describe('TaskStopper', () => {
  it('非终态行：置标记 + 结算 skipped（手动停止）+ 关窗 + 清登记', async () => {
    const d = makeDeps({ existing: run('running'), open: { http: '127.0.0.1:61234' } })
    const stopper = createTaskStopper({
      db: d.db,
      registry: d.registry,
      logger: d.logger,
      closeBrowser: d.closeBrowser,
      getOpenWindow: (id) => d.db.getOpenWindow(id),
      clearOpenWindow: (id) => d.db.clearOpenWindow(id),
    })
    const stopped = await stopper.stop(1, 't')
    expect(stopped).toBe(true)
    expect(d.registry.isCancelled(1, 't')).toBe(true)
    expect(d.db.upsertRun).toHaveBeenCalledWith(1, 't', expect.any(String), 0, 'skipped', expect.objectContaining({ error: '手动停止' }))
    expect(d.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(d.db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('终态行：不置标记、不结算、不关窗，返回 false', async () => {
    const d = makeDeps({ existing: run('success') })
    const stopper = createTaskStopper({
      db: d.db,
      registry: d.registry,
      logger: d.logger,
      closeBrowser: d.closeBrowser,
      getOpenWindow: (id) => d.db.getOpenWindow(id),
      clearOpenWindow: (id) => d.db.clearOpenWindow(id),
    })
    expect(await stopper.stop(1, 't')).toBe(false)
    expect(d.registry.isCancelled(1, 't')).toBe(false)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.closeBrowser).not.toHaveBeenCalled()
  })
})

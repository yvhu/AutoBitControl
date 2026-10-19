/**
 * task-stopper 单测（注入假库 + 假关窗，不连真机）
 * 覆盖：running 行结算 skipped + 置取消标记 + 关窗、queued 行只结算不关窗、终态行不动、批次停止计数
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
    stopQueuedRun: vi.fn().mockResolvedValue(true),
    stopRunningRun: vi.fn().mockResolvedValue(true),
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

function makeStopper(d: ReturnType<typeof makeDeps>, cancelQueued = vi.fn().mockResolvedValue(0)) {
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
  it('running 行：置标记 + 结算 skipped（手动停止）+ 关窗 + 清登记', async () => {
    const d = makeDeps({ existing: run('running'), open: { http: '127.0.0.1:61234' } })
    const stopper = makeStopper(d)
    const stopped = await stopper.stop(1, 't')
    expect(stopped).toBe(true)
    expect(d.registry.isCancelled(1, 't')).toBe(true)
    expect(d.registry.isSessionCancelled(1)).toBe(true)
    expect(d.db.stopRunningRun).toHaveBeenCalledWith(1, 't', expect.any(String), 0)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(d.db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
    // 会话标记可被 runner 消费清理
    d.registry.clearSession(1)
    expect(d.registry.isSessionCancelled(1)).toBe(false)
  })

  it('跨午夜停止：按行所属日期能停旧日期 running 行，按今天查找则找不到', async () => {
    const d = makeDeps({ existing: run('running'), open: { http: '127.0.0.1:61234' } })
    const yesterday = '2026-10-13'
    const today = '2026-10-14'
    d.db.getLatestRun.mockImplementation((_profileId: number, _taskKey: string, date: string) => Promise.resolve(date === yesterday ? run('running') : null))
    const stopper = makeStopper(d)
    expect(await stopper.stop(1, 't', yesterday)).toBe(true)
    expect(d.db.stopRunningRun).toHaveBeenCalledWith(1, 't', yesterday, 0)
    expect(d.registry.isCancelled(1, 't')).toBe(true)
    // 用今天的日期查不到旧日期行（会话仍按旧日期自行结算，不产生孤儿）
    expect(await stopper.stop(1, 't', today)).toBe(false)
    expect(d.db.stopRunningRun).toHaveBeenCalledTimes(1)
  })

  it.each(['pending', 'retry_wait'] as const)('%s 行：只结算 skipped，不置标记、不关窗（即使窗口开着）', async (status) => {
    const d = makeDeps({ existing: run(status), open: { http: '127.0.0.1:61234' } })
    const stopper = makeStopper(d)
    const stopped = await stopper.stop(1, 't')
    expect(stopped).toBe(true)
    expect(d.db.stopQueuedRun).toHaveBeenCalledWith(1, 't', expect.any(String), 0)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.registry.isCancelled(1, 't')).toBe(false)
    expect(d.registry.isSessionCancelled(1)).toBe(false)
    expect(d.closeBrowser).not.toHaveBeenCalled()
    expect(d.db.clearOpenWindow).not.toHaveBeenCalled()
  })

  it.each(['pending', 'retry_wait'] as const)('%s 行条件更新输给认领：重读为 running 后走运行分支', async (status) => {
    const d = makeDeps({ existing: run(status), open: { http: '127.0.0.1:61234' } })
    d.db.stopQueuedRun.mockResolvedValue(false)
    d.db.getLatestRun.mockResolvedValueOnce(run(status)).mockResolvedValueOnce(run('running'))
    const stopper = makeStopper(d)
    expect(await stopper.stop(1, 't')).toBe(true)
    expect(d.db.stopQueuedRun).toHaveBeenCalledWith(1, 't', expect.any(String), 0)
    expect(d.registry.isCancelled(1, 't')).toBe(true)
    expect(d.registry.isSessionCancelled(1)).toBe(true)
    expect(d.db.stopRunningRun).toHaveBeenCalledWith(1, 't', expect.any(String), 0)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(d.db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('running 行已变终态（CAS 失败）：撤销标记、不关窗、不覆盖终态', async () => {
    const d = makeDeps({ existing: run('running'), open: { http: '127.0.0.1:61234' } })
    d.db.stopRunningRun.mockResolvedValue(false)
    const stopper = makeStopper(d)
    expect(await stopper.stop(1, 't')).toBe(false)
    expect(d.db.stopRunningRun).toHaveBeenCalledWith(1, 't', expect.any(String), 0)
    expect(d.registry.isCancelled(1, 't')).toBe(false)
    expect(d.registry.isSessionCancelled(1)).toBe(false)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.closeBrowser).not.toHaveBeenCalled()
    expect(d.db.clearOpenWindow).not.toHaveBeenCalled()
  })

  it.each([
    ['终态行', run('success')],
    ['行已不存在', null],
  ])('%s：条件更新失败后重读无可停止行，返回 false', async (_label, latest) => {
    const d = makeDeps({ existing: run('pending'), open: { http: '127.0.0.1:61234' } })
    d.db.stopQueuedRun.mockResolvedValue(false)
    d.db.getLatestRun.mockResolvedValueOnce(run('pending')).mockResolvedValueOnce(latest as Partial<RunRow> | null)
    const stopper = makeStopper(d)
    expect(await stopper.stop(1, 't')).toBe(false)
    expect(d.registry.isCancelled(1, 't')).toBe(false)
    expect(d.registry.isSessionCancelled(1)).toBe(false)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.closeBrowser).not.toHaveBeenCalled()
  })

  it('终态行：不置标记、不结算、不关窗，返回 false', async () => {
    const d = makeDeps({ existing: run('success') })
    const stopper = makeStopper(d)
    expect(await stopper.stop(1, 't')).toBe(false)
    expect(d.registry.isCancelled(1, 't')).toBe(false)
    expect(d.registry.isSessionCancelled(1)).toBe(false)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
    expect(d.closeBrowser).not.toHaveBeenCalled()
  })

  it('批次停止：排队结算数 + running 停止数，queued 行不逐个关窗', async () => {
    const d = makeDeps()
    const active = run('running')
    d.db.listRunsForBatch.mockResolvedValue([run('pending', 1), run('retry_wait', 2), active, run('success')])
    d.db.getLatestRun.mockResolvedValue(active)
    const cancelQueued = vi.fn().mockResolvedValue(2)
    const stopper = makeStopper(d, cancelQueued)
    expect(await stopper.stopBatch(5)).toBe(3)
    expect(cancelQueued).toHaveBeenCalledWith(5)
    expect(d.closeBrowser).toHaveBeenCalledTimes(1)
    expect(d.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(d.registry.isCancelled(1, 't')).toBe(true)
    expect(d.db.stopRunningRun).toHaveBeenCalledTimes(1)
    // 批次停止按行内日期停止（跨午夜仍能命中旧日期 running 行）
    expect(d.db.stopRunningRun).toHaveBeenCalledWith(1, 't', '2026-10-13', 0)
    expect(d.db.upsertRun).not.toHaveBeenCalled()
  })

  it('批次停止：await 排队结算结果后再返回', async () => {
    const d = makeDeps()
    d.db.listRunsForBatch.mockResolvedValue([run('running')])
    d.db.getLatestRun.mockResolvedValue(run('running'))
    let resolveQueued!: (n: number) => void
    const cancelQueued = vi.fn(() => new Promise<number>((r) => { resolveQueued = r }))
    const stopper = makeStopper(d, cancelQueued)
    let done = false
    const pending = stopper.stopBatch(5).then((n) => { done = true; return n })
    await Promise.resolve()
    expect(done).toBe(false)
    resolveQueued(3)
    await expect(pending).resolves.toBe(4)
  })

  it('批次停止：只对 running 行调用 stop，其它状态不计', async () => {
    const d = makeDeps()
    d.db.listRunsForBatch.mockResolvedValue([run('retry_wait'), run('pending'), run('success')])
    const cancelQueued = vi.fn().mockResolvedValue(2)
    const stopper = makeStopper(d, cancelQueued)
    expect(await stopper.stopBatch(5)).toBe(2)
    expect(d.closeBrowser).not.toHaveBeenCalled()
    expect(d.db.upsertRun).not.toHaveBeenCalled()
  })
})

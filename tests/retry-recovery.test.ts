import { describe, it, expect, vi, afterEach } from 'vitest'
import { todayStr, type RunRow } from '../src/infrastructure/db'
import { recoverRetryTasks } from '../src/engine/retry-recovery'

function makeRetryRow(over: Partial<RunRow> = {}): RunRow {
  const date = todayStr()
  return {
    id: 1,
    profileId: 1,
    taskKey: 't',
    date,
    slot: 0,
    status: 'retry_wait',
    attempts: 1,
    error: 'boom',
    screenshot: null,
    startedAt: `${date} 09:00:00.000`,
    finishedAt: `${date} 09:05:00.000`,
    profileName: '窗口1',
    ...over,
  }
}

function makeDeps(rows: RunRow[], latest: Partial<RunRow> | null) {
  const profile = { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }
  return {
    db: {
      listRunsForDate: vi.fn().mockResolvedValue(rows),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      getLatestRun: vi.fn().mockResolvedValue(latest),
      upsertRun: vi.fn().mockResolvedValue(null),
    },
    tasks: new Map<string, { meta: { retry?: { backoffSec?: number } } }>(),
    enqueuer: { enqueue: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    retryBackoffSec: 600,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('recoverRetryTasks', () => {
  it('陈旧 retry_wait 行（已有更新 slot）结算 failed 且不入队', async () => {
    const stale = makeRetryRow()
    const deps = makeDeps([stale], { status: 'success', slot: 1 } as Partial<RunRow>)
    const count = await recoverRetryTasks(deps as never)
    expect(count).toBe(0)
    expect(deps.db.upsertRun).toHaveBeenCalledWith(1, 't', todayStr(), 0, 'failed', expect.objectContaining({ error: '重试已被后续轮次取代' }))
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it('无后续轮次的 retry_wait 行照常重新入队（退避已过期立即入队）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02 10:00:00'))
    const row = makeRetryRow({ finishedAt: '2026-09-02 08:00:00.000' })
    const deps = makeDeps([row], { status: 'retry_wait', slot: 0 } as Partial<RunRow>)
    const count = await recoverRetryTasks(deps as never)
    expect(count).toBe(1)
    expect(deps.db.upsertRun).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueuer.enqueue.mock.calls[0][1]).toBe('t')
  })

  it('崩溃残留 running 行：结算 failed 并重新入队（自愈）', async () => {
    vi.useFakeTimers()
    const row = makeRetryRow({ status: 'running', finishedAt: null })
    const deps = makeDeps([row], null)
    deps.tasks.set('t', { meta: { retry: { backoffSec: 600 } } })
    const count = await recoverRetryTasks(deps as never)
    expect(count).toBe(1)
    expect(deps.db.upsertRun).toHaveBeenCalledWith(1, 't', todayStr(), 0, 'failed', expect.objectContaining({ error: expect.stringContaining('崩溃残留') }))
    await vi.runAllTimersAsync()
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
  })

  it('崩溃残留 pending 行：同样结算 failed 并重新入队', async () => {
    vi.useFakeTimers()
    const row = makeRetryRow({ status: 'pending', finishedAt: null })
    const deps = makeDeps([row], null)
    deps.tasks.set('t', { meta: { retry: { backoffSec: 600 } } })
    const count = await recoverRetryTasks(deps as never)
    expect(count).toBe(1)
    await vi.runAllTimersAsync()
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDb, localWallNow, todayStr, type ProfileRow, type RunRow } from '../src/infrastructure/db'
import { CoalescingEnqueuer, type SessionTask } from '../src/engine/queue'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}
const logger = makeLogger() as never
const TERMINAL = ['success', 'failed', 'captcha_failed', 'skipped']
let db: AppDb
let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'abc-enq-'))
  db = await AppDb.open(`file:${join(dir, 'q.db').split('\\').join('/')}`)
})
afterEach(() => {
  db.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 下 libsql 句柄可能延迟释放，best-effort 清理
  }
})

/** 假 runner：把本次会话的任务行结算为成功，模拟真实 runner 落库（避免同批 pending 行被反复拾取） */
async function settleSuccess(profile: ProfileRow, tasks: SessionTask[]): Promise<void> {
  const date = todayStr()
  for (const t of tasks) {
    const row = await db.getLatestRun(profile.id, t.taskKey, date)
    if (!row || TERMINAL.includes(row.status)) continue
    await db.upsertRun(profile.id, t.taskKey, date, Number(row.slot), 'success', { finishedAt: localWallNow() })
  }
}

/** 立即完成的 runner：结算为成功 */
function makeSuccessRunner() {
  return {
    runWindowTasks: vi.fn(async (profile: ProfileRow, tasks: SessionTask[]) => {
      await settleSuccess(profile, tasks)
    }),
  }
}

/** 可控 runner：runWindowTasks 挂起直到 release，随后结算为成功 */
function makeGatedRunner() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const runner = {
    runWindowTasks: vi.fn(async (profile: ProfileRow, tasks: SessionTask[]) => {
      await gate
      await settleSuccess(profile, tasks)
    }),
  }
  return { runner, release: () => release() }
}

/** 多会话可控 runner：每次调用独立挂起，按调用顺序 release 后结算成功 */
function makeMultiGatedRunner() {
  const releases: Array<() => void> = []
  const startedProfiles: number[] = []
  const runner = {
    runWindowTasks: vi.fn(async (profile: ProfileRow, tasks: SessionTask[]) => {
      startedProfiles.push(profile.id)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      await settleSuccess(profile, tasks)
    }),
  }
  return { runner, startedProfiles, release: (index: number) => releases[index]?.() }
}

/** 首次会话抛错、之后成功的 runner（验证异常回队后额度释放可继续） */
function makeRejectOnceRunner() {
  const runner = {
    runWindowTasks: vi.fn(async (profile: ProfileRow, tasks: SessionTask[]) => {
      if (runner.runWindowTasks.mock.calls.length === 1) throw new Error('boom')
      await settleSuccess(profile, tasks)
    }),
  }
  return { runner }
}

describe('CoalescingEnqueuer DB 队列', () => {
  it('enqueue 立即写 pending 行；tick 只启动到期窗口', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    await q.enqueue(p, 't1', { immediate: true })
    const rows = await db.listRunsForDate(todayStr())
    expect(rows[0].status).toBe('pending')
    await q.tick()
    expect(runner.runWindowTasks).toHaveBeenCalledTimes(1)
    q.stop()
  })

  it('同一窗口 pending 任务合并成一次会话', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    await q.enqueue(p, 't1', { immediate: true })
    await q.enqueue(p, 't2', { immediate: true })
    await q.tick()
    expect(runner.runWindowTasks).toHaveBeenCalledTimes(1)
    expect((runner.runWindowTasks.mock.calls[0][1] as SessionTask[]).map((t) => t.taskKey)).toEqual(['t1', 't2'])
    q.stop()
  })

  it('running 窗口不会被重复启动；释放后可启动下一轮', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const { runner, release } = makeGatedRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    await q.enqueue(p, 't1', { immediate: true })
    await q.tick()
    await q.enqueue(p, 't2', { immediate: true })
    await q.tick()
    expect(runner.runWindowTasks).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(async () => {
      const first = (await db.listRunsForDate(todayStr())).find((row) => row.taskKey === 't1')
      expect(first?.status).toBe('success')
    })
    await q.tick()
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(2))
    q.stop()
  })

  it('调用方传入的 notBeforeMs 直接写入；未到时间不启动', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    const notBeforeMs = Date.now() + 60_000
    await q.enqueue(p, 't1', { notBeforeMs })
    const row = (await db.listRunsForDate(todayStr()))[0]
    expect(row.notBeforeMs).toBe(notBeforeMs)
    await q.tick()
    expect(runner.runWindowTasks).not.toHaveBeenCalled()
    q.stop()
  })

  it('cancelBatch 结算排队行', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const q = new CoalescingEnqueuer(db, { runWindowTasks: vi.fn() } as never, logger, new Map([['t1', 1]]), 1)
    await q.enqueue(p, 't1', { immediate: true, batchId: 9 })
    expect(await q.cancelBatch(9)).toBe(1)
    expect((await db.getLatestRun(p.id, 't1', todayStr()))?.status).toBe('skipped')
    q.stop()
  })

  it('enqueue 遇到最新行 running 时不改写并入并告警', async () => {
    const p = await db.upsertProfile('bb-running', '窗口1')
    const log = makeLogger()
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, log as never, new Map([['t1', 1]]), 1)
    await q.enqueue(p, 't1', { immediate: true, batchId: 7 })
    const before = (await db.listRunsForDate(todayStr()))[0]
    await db.claimQueuedRuns([before.id], Date.now())

    await q.enqueue(p, 't1', { immediate: true, batchId: 9, notBeforeMs: 999 })
    const after = (await db.listRunsForDate(todayStr()))[0]
    expect(after.status).toBe('running')
    expect(after.batchId).toBe(7)
    expect(after.notBeforeMs).toBe(before.notBeforeMs)
    expect(log.warn).toHaveBeenCalled()
    q.stop()
  })

  it('tick 先结算未注册任务的到期行并告警', async () => {
    const p = await db.upsertProfile('bb-ghost', '窗口1')
    const log = makeLogger()
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, log as never, new Map([['t1', 1]]), 1)
    await db.enqueueRun(p.id, 'ghost', todayStr(), null, 0)

    await q.tick()

    const row = await db.getLatestRun(p.id, 'ghost', todayStr())
    expect(row?.status).toBe('skipped')
    expect(row?.error).toBe('任务未注册')
    expect(runner.runWindowTasks).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), '已结算未注册任务的到期行')
    q.stop()
  })

  it('retry_wait 行再次 enqueueRun 时提升为 pending，tick 可调度', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    const date = todayStr()
    await db.enqueueRun(p.id, 't1', date, 7, 0)
    await db.upsertRun(p.id, 't1', date, 0, 'retry_wait', {
      notBeforeMs: Date.now() + 99_999,
      error: '上次失败',
      failureKind: 'task',
      finishedAt: localWallNow(),
    })

    const promoted = await db.enqueueRun(p.id, 't1', date, 8, Date.now())
    expect(promoted.status).toBe('pending')
    expect(promoted.notBeforeMs).toBeLessThanOrEqual(Date.now())
    expect(promoted.batchId).toBe(8)
    expect(promoted.finishedAt).toBeNull()
    expect(promoted.failureKind).toBeNull()
    expect(promoted.error).toBeNull()

    await q.tick()
    expect(runner.runWindowTasks).toHaveBeenCalledTimes(1)
    q.stop()
  })

  it('到期的 retry_wait 行被 dispatcher 直接认领执行', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    const date = todayStr()
    await db.enqueueRun(p.id, 't1', date, 7, Date.now())
    await db.upsertRun(p.id, 't1', date, 0, 'retry_wait', {
      notBeforeMs: Date.now() - 1,
      error: '上次失败',
      failureKind: 'task',
      finishedAt: localWallNow(),
    })

    await q.tick()
    expect(runner.runWindowTasks).toHaveBeenCalledTimes(1)
    q.stop()
  })

  it('stop 后运行中会话结束也不再调度；start 可恢复调度', async () => {
    const p1 = await db.upsertProfile('bb-1', '窗口1')
    const p2 = await db.upsertProfile('bb-2', '窗口2')
    const { runner, release } = makeMultiGatedRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 4], ['t2', 4]]), 1)
    await q.enqueue(p1, 't1', { immediate: true })
    await q.enqueue(p2, 't2', { immediate: true })
    await q.tick()
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(1))
    q.stop()
    release(0)
    await vi.waitFor(async () => expect((await db.getLatestRun(p1.id, 't1', todayStr()))?.status).toBe('success'))
    expect(runner.runWindowTasks).toHaveBeenCalledTimes(1)
    q.start()
    await q.tick()
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(2))
    release(1)
    q.stop()
  })

  it('任务级闸门饱和：同任务不同窗口先跑一个，释放后续跑', async () => {
    const p1 = await db.upsertProfile('bb-1', '窗口1')
    const p2 = await db.upsertProfile('bb-2', '窗口2')
    const { runner, release } = makeMultiGatedRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 1]]), 5)
    await q.enqueue(p1, 't1', { immediate: true })
    await q.enqueue(p2, 't1', { immediate: true })
    await q.tick()
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(1))
    release(0)
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(2))
    release(1)
    q.stop()
  })

  it('全局窗口闸门饱和：上限 1 时不同窗口先跑一个，释放后续跑', async () => {
    const p1 = await db.upsertProfile('bb-1', '窗口1')
    const p2 = await db.upsertProfile('bb-2', '窗口2')
    const { runner, release } = makeMultiGatedRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 4], ['t2', 4]]), 1)
    await q.enqueue(p1, 't1', { immediate: true })
    await q.enqueue(p2, 't2', { immediate: true })
    await q.tick()
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(1))
    release(0)
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(2))
    release(1)
    q.stop()
  })

  it('runner 拒绝时认领行退回 pending，且额度释放后可继续', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const { runner } = makeRejectOnceRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 1]]), 1)
    await q.enqueue(p, 't1', { immediate: true })
    await q.tick()
    q.stop()

    const requeued = await vi.waitFor(async () => {
      const row = await db.getLatestRun(p.id, 't1', todayStr())
      expect(row?.status).toBe('pending')
      expect(row?.error).toBe('boom')
      return row!
    })
    // 回队带退避：不能立即被下一 tick 重新认领（持久故障不热循环）
    expect(requeued.notBeforeMs).toBeGreaterThan(Date.now())
    expect(await db.countRunningProfiles()).toBe(0)

    // 退避到期后（测试直接清零 not_before_ms）同一行可再次被认领执行
    await db.upsertRun(p.id, 't1', todayStr(), requeued.slot, 'pending', { notBeforeMs: 0 })
    q.start()
    await q.tick()
    await vi.waitFor(() => expect(runner.runWindowTasks).toHaveBeenCalledTimes(2))
    q.stop()
  })

  it('跨日：旧日期 pending/retry_wait 结算 skipped，running 保持不动', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const oldDate = '2000-01-01'
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    await db.enqueueRun(p.id, 'old-pending', oldDate, null, 0)
    await db.enqueueRun(p.id, 'old-retry', oldDate, null, 0)
    await db.upsertRun(p.id, 'old-retry', oldDate, 0, 'retry_wait', { notBeforeMs: 0 })
    const running = await db.enqueueRun(p.id, 'old-running', oldDate, null, 0)
    await db.claimQueuedRuns([running.id], Date.now())

    await q.tick()

    expect((await db.getLatestRun(p.id, 'old-pending', oldDate))?.status).toBe('skipped')
    expect((await db.getLatestRun(p.id, 'old-retry', oldDate))?.status).toBe('skipped')
    // running 由正在执行的会话按认领日期自行结算，调度器不得越权改写
    expect((await db.getLatestRun(p.id, 'old-running', oldDate))?.status).toBe('running')
    expect(runner.runWindowTasks).not.toHaveBeenCalled()
    q.stop()
  })

  it('认领行日期传给 runner（跨午夜不按 todayStr 重新推导）', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const oldDate = '2000-01-01'
    const seen: SessionTask[] = []
    const runner = {
      runWindowTasks: vi.fn(async (_profile: ProfileRow, tasks: SessionTask[]) => {
        seen.push(...tasks)
      }),
    }
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    // 先跑一次空 tick 建立 lastDate，避免首次 tick 的跨日结算把旧行清掉
    await q.tick()
    const row = await db.enqueueRun(p.id, 't1', oldDate, null, 0)
    vi.spyOn(db, 'claimDueRuns').mockResolvedValueOnce([row])

    await q.tick()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ taskKey: 't1', date: oldDate })
    q.stop()
  })

  it('stop 发生在 tick 等待期间：不再认领或启动会话', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    // 先跑一次空 tick 建立 lastDate，确保本轮 tick 直接进入 claimDueRuns
    await q.tick()
    await q.enqueue(p, 't1', { immediate: true })

    const original = db.claimDueRuns.bind(db)
    let resolveClaim!: (rows: RunRow[]) => void
    const paused = new Promise<RunRow[]>((resolve) => { resolveClaim = resolve })
    let claimStarted!: () => void
    const started = new Promise<void>((resolve) => { claimStarted = resolve })
    vi.spyOn(db, 'claimDueRuns').mockImplementationOnce(() => {
      claimStarted()
      return paused
    })

    const ticking = q.tick()
    await started
    q.stop()
    resolveClaim(await original({ date: todayStr(), nowMs: Date.now(), limits: new Map([['t1', 2], ['t2', 2]]), maxConcurrentWindows: 2 }))
    await ticking

    expect(runner.runWindowTasks).not.toHaveBeenCalled()
    expect((await db.listRunsForDate(todayStr()))[0].status).toBe('pending')
  })

  it('tick 前被取消的行不会启动（认领只含仍 pending 的行）', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    await q.enqueue(p, 't1', { immediate: true, batchId: 9 })
    await db.stopQueuedRuns(9)
    await q.tick()
    expect(runner.runWindowTasks).not.toHaveBeenCalled()
    expect((await db.listRunsForDate(todayStr()))[0].status).toBe('skipped')
    q.stop()
  })

  it('claimQueuedRuns 只认领仍待执行的行（pending/retry_wait）', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const date = todayStr()
    const row = await db.enqueueRun(p.id, 't1', date, null, 0)
    const claimed = await db.claimQueuedRuns([row.id], Date.now())
    expect(claimed.map((r) => r.id)).toEqual([row.id])
    expect(claimed[0].status).toBe('running')
    // started_at 由 runTask 真正开始时写入，认领阶段不抢写
    expect(claimed[0].startedAt).toBeNull()
    expect(await db.claimQueuedRuns([row.id], Date.now())).toEqual([])

    const retryRow = await db.enqueueRun(p.id, 't2', date, null, 0)
    await db.upsertRun(p.id, 't2', date, 0, 'retry_wait', { notBeforeMs: 0 })
    const claimedRetry = await db.claimQueuedRuns([retryRow.id], Date.now())
    expect(claimedRetry.map((r) => r.id)).toEqual([retryRow.id])
    expect(claimedRetry[0].status).toBe('running')
  })

  it('enqueue 的 DB 写失败向调用方 reject（不会产生未处理 rejection）', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 2], ['t2', 2]]), 2)
    vi.spyOn(db, 'enqueueRun').mockRejectedValueOnce(new Error('disk full'))
    await expect(q.enqueue(p, 't1', { immediate: true })).rejects.toThrow('disk full')
    q.stop()
  })

  it('取窗口列表失败发生在认领前：不会留下无人执行的 running 行', async () => {
    const p = await db.upsertProfile('bb-list-fail', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 1]]), 1)
    await q.enqueue(p, 't1', { immediate: true })
    vi.spyOn(db, 'listProfiles').mockRejectedValueOnce(new Error('db down'))

    await q.tick()

    expect(runner.runWindowTasks).not.toHaveBeenCalled()
    expect((await db.listRunsForDate(todayStr()))[0].status).toBe('pending')
    q.stop()
  })

  it('认领后窗口不存在：行按退避回队，不留下 running', async () => {
    const p = await db.upsertProfile('bb-orphan', '窗口1')
    const runner = makeSuccessRunner()
    const q = new CoalescingEnqueuer(db, runner as never, logger, new Map([['t1', 1]]), 1)
    await q.enqueue(p, 't1', { immediate: true })
    vi.spyOn(db, 'listProfiles').mockResolvedValueOnce([])

    await q.tick()

    expect(runner.runWindowTasks).not.toHaveBeenCalled()
    const row = (await db.listRunsForDate(todayStr()))[0]
    expect(row.status).toBe('pending')
    expect(row.error).toBe('窗口不存在')
    expect(row.notBeforeMs).toBeGreaterThan(Date.now())
    q.stop()
  })

})

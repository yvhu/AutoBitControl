/**
 * 窗口池调度器单测：真实 AppDb（内存库）+ 假执行器/比特探测/内存；
 * 覆盖任务复用、轮转、无任务级并发、内存/健康门禁、探测租约、窗口对账与幂等回收
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppDb, localWallNow, todayStr, type ProfileRow, type RunRow } from '../src/infrastructure/db'
import type { WindowPoolConfig } from '../src/infrastructure/config'
import type { MemoryGovernor, MemoryState } from '../src/engine/memory-governor'
import { GlobalHealthGate } from '../src/engine/global-health'
import { WindowPoolScheduler } from '../src/engine/window-pool'
import type { SessionTask } from '../src/engine/queue'

const BASE_CFG: WindowPoolConfig = {
  enabled: true,
  maxOpenWindows: 4,
  memoryReserveMb: 100,
  perWindowMb: 1024,
  criticalFreeMb: 1024,
  resumeFreeMb: 2048,
  checkIntervalMs: 5000,
  openCooldownMs: 0,
  idleCloseSec: 0,
  windowMaxTasks: 0,
  windowMaxLifetimeSec: 0,
  cohortMaxSec: 0,
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

type RunnerBehavior = 'success' | 'env' | 'skip' | 'empty' | 'throw'

interface HarnessOptions {
  windows?: number
  cfg?: Partial<WindowPoolConfig>
  taskKeys?: string[]
  /** 指定窗口/任务返回环境级失败（验证失败窗口回收） */
  failure?: (profile: ProfileRow, taskKey: string) => boolean
  /** 统一执行结果（默认 success；env/skip/empty/throw 用于探测与会话异常用例） */
  behavior?: RunnerBehavior
  /** 会话注册窗口后挂起，直到 releaseAll（验证 opening 不重复计数） */
  holdSessions?: boolean
  /** 前 N 次关窗失败（验证失败保留登记并重试） */
  closeFailures?: number
  /** 模拟 WindowRunner 的窗口级半开探测：claimWindowProbe + 成功 recordWindowSuccess */
  recoverBreakerOnRun?: boolean
}

async function makeHarness(opts: HarnessOptions = {}) {
  const db = await AppDb.open('file::memory:')
  const windowCount = opts.windows ?? 4
  const profiles: ProfileRow[] = []
  for (let i = 0; i < windowCount; i++) {
    profiles.push(await db.upsertProfile(`bb-${i + 1}`, `窗口${i + 1}`))
  }
  let nowMs = new Date(2026, 9, 22, 10, 0, 0).getTime()
  const date = () => todayStr(new Date(nowMs))
  const openIds = new Set<string>()
  /** 模拟「比特客户端里直接打开、open_windows 无登记」的外部窗口 */
  const extraLive = new Set<string>()
  const openEvents: string[] = []
  const closeCalls: Array<{ bitbrowserId: string; reason: string }> = []
  const gates: Array<() => void> = []
  let gateCount = 0
  let gatesReleased = false
  const gate = () => {
    if (gatesReleased) return Promise.resolve()
    return new Promise<void>((resolve) => {
      gateCount++
      gates.push(resolve)
    })
  }
  const releaseAll = () => {
    gatesReleased = true
    while (gates.length > 0) gates.shift()!()
  }
  const waitForGates = async (count: number) => {
    while (gateCount < count) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  let closeFailures = opts.closeFailures ?? 0
  const behavior = opts.behavior ?? 'success'
  const failure = opts.failure

  const runner = {
    runWindowTasks: vi.fn(async (profile: ProfileRow, tasks: SessionTask[], runOpts?: { keepWindowOpen?: boolean }) => {
      const results = new Map<string, RunRow | null>()
      for (const task of tasks) {
        if (behavior === 'throw') throw new Error('模拟执行器异常')
        if (behavior === 'empty') continue
        const taskDate = task.date ?? date()
        const latest = await db.getLatestRun(profile.id, task.taskKey, taskDate)
        if (!latest) continue
        if (opts.recoverBreakerOnRun) await db.claimWindowProbe(profile.id, { leaseMs: 60_000, nowMs })
        if (runOpts?.keepWindowOpen) {
          if (!openIds.has(profile.bitbrowserId)) {
            openIds.add(profile.bitbrowserId)
            openEvents.push(profile.bitbrowserId)
          }
          await db.reserveOpenWindow(profile.bitbrowserId, process.pid, 'pool')
          await db.setOpenWindow(profile.bitbrowserId, `127.0.0.1:${60000 + profile.id}`, process.pid, 'open')
        }
        if (opts.holdSessions) await gate()
        const failed = behavior === 'env' || (failure?.(profile, task.taskKey) ?? false)
        const skipped = behavior === 'skip'
        const status = failed ? 'failed' : skipped ? 'skipped' : 'success'
        const baseAttempts = Number(latest.attempts ?? 0)
        const row = await db.upsertRun(profile.id, task.taskKey, taskDate, Number(latest.slot), status, {
          error: failed ? '模拟环境失败' : skipped ? '手动停止' : null,
          failureKind: failed ? 'environment' : skipped ? 'stopped' : null,
          attempts: failed ? baseAttempts + 1 : baseAttempts,
          finishedAt: localWallNow(),
        })
        if (runOpts?.keepWindowOpen) await db.incrementWindowUsage(profile.bitbrowserId)
        if (opts.recoverBreakerOnRun && row.status === 'success') await db.recordWindowSuccess(profile.id)
        results.set(task.taskKey, row)
      }
      return results
    }),
    closePoolWindow: vi.fn(async (profile: ProfileRow, reason: string) => {
      closeCalls.push({ bitbrowserId: profile.bitbrowserId, reason })
      if (closeFailures > 0) {
        closeFailures--
        throw new Error('模拟关窗失败')
      }
      openIds.delete(profile.bitbrowserId)
      await db.clearOpenWindow(profile.bitbrowserId)
    }),
  }

  const bitbrowser = {
    openPids: vi.fn(async (ids: string[]) => {
      const live = new Set(ids.filter((id) => openIds.has(id)))
      for (const id of extraLive) live.add(id)
      return live
    }),
  }

  const memory = {
    state: 'normal' as MemoryState,
    perWindowMb: 1024,
    effectiveOverride: undefined as number | undefined,
    update(input: { freeMb: number; actualOpen: number; maxOpenWindows: number }) {
      const effectivePool = memory.state === 'critical'
        ? input.actualOpen
        : memory.effectiveOverride ?? input.maxOpenWindows
      return { state: memory.state, effectivePool, perWindowMb: memory.perWindowMb }
    },
  }

  const health = new GlobalHealthGate({
    windowSec: 300,
    threshold: 3,
    backoffSec: [30, 60, 120],
    probeEnabled: true,
  })

  const cfg: WindowPoolConfig = { ...BASE_CFG, ...opts.cfg }
  const taskKeys = opts.taskKeys ?? ['task1', 'task2', 'warm', 'same']
  const scheduler = new WindowPoolScheduler({
    db,
    runner,
    bitbrowser,
    logger: makeLogger() as never,
    memory: memory as unknown as MemoryGovernor,
    health,
    cfg,
    limits: new Map(taskKeys.map((key) => [key, 100])),
    now: () => new Date(nowMs),
    tickMs: 1000,
    freeMemMb: () => 8192,
    autoTick: false,
  })

  const advance = (ms: number) => {
    nowMs += ms
  }
  const tick = async (ms = 0) => {
    advance(ms)
    await scheduler.tick()
    await scheduler.waitForIdle()
  }
  const tickNoWait = async (ms = 0) => {
    advance(ms)
    await scheduler.tick()
  }
  const enqueueAll = async (targets: ProfileRow[], taskKey: string, extra?: { batchId?: number; skipIfSuccess?: boolean }) => {
    for (const profile of targets) await scheduler.enqueue(profile, taskKey, extra)
  }
  const runCalls = (taskKey: string) =>
    runner.runWindowTasks.mock.calls.filter((call) =>
      (call[1] as SessionTask[]).some((task) => task.taskKey === taskKey),
    )
  const latest = (profile: ProfileRow, taskKey: string) => db.getLatestRun(profile.id, taskKey, date())

  return {
    db,
    profiles,
    scheduler,
    runner,
    bitbrowser,
    memory,
    health,
    cfg,
    openIds,
    extraLive,
    openEvents,
    closeCalls,
    advance,
    tick,
    tickNoWait,
    releaseAll,
    waitForGates,
    enqueueAll,
    runCalls,
    latest,
    date,
  }
}

let cleanups: Array<() => Promise<void> | void> = []
beforeEach(() => {
  cleanups = []
})
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
})

async function harness(opts?: HarnessOptions) {
  const h = await makeHarness(opts)
  cleanups.push(async () => {
    h.releaseAll()
    await h.scheduler.waitForIdle().catch(() => {})
    h.scheduler.stop()
    h.db.close()
  })
  return h
}

describe('WindowPoolScheduler 任务复用与轮转', () => {
  it('任务1 在 4 个窗口运行后，任务2 复用同一池窗口且不新开窗', async () => {
    const h = await harness({ windows: 4 })
    await h.enqueueAll(h.profiles, 'task1')
    for (let i = 0; i < 8; i++) await h.tick(1000)

    expect(h.openEvents).toHaveLength(4)
    expect(h.runCalls('task1')).toHaveLength(4)
    for (const profile of h.profiles) expect((await h.latest(profile, 'task1'))?.status).toBe('success')
    const opensBeforeTask2 = h.openEvents.length

    await h.enqueueAll(h.profiles, 'task2')
    await h.tick(1000)

    expect(h.runCalls('task2')).toHaveLength(4)
    for (const profile of h.profiles) expect((await h.latest(profile, 'task2'))?.status).toBe('success')
    expect(h.openEvents).toHaveLength(opensBeforeTask2)
  })

  it('关闭窗口的 task2 入队后，池满时轮转关闭空闲窗口，再按队列打开', async () => {
    const h = await harness({ windows: 4, cfg: { maxOpenWindows: 2 } })
    await h.enqueueAll(h.profiles.slice(0, 2), 'task1')
    for (let i = 0; i < 5; i++) await h.tick(1000)
    expect(h.openEvents).toHaveLength(2)
    const opensBeforeTask2 = h.openEvents.length

    await h.enqueueAll(h.profiles.slice(2), 'task2')
    for (let i = 0; i < 8; i++) await h.tick(1000)

    expect(h.closeCalls.length).toBeGreaterThanOrEqual(2)
    for (const profile of h.profiles.slice(2)) expect((await h.latest(profile, 'task2'))?.status).toBe('success')
    expect(h.openEvents).toHaveLength(opensBeforeTask2 + 2)
    expect(await h.db.getOpenWindow(h.profiles[0].bitbrowserId)).toBeNull()
  })

  it('4 个窗口可同时执行同一个任务（无任务级并发限制）', async () => {
    const h = await harness({ windows: 4 })
    await h.enqueueAll(h.profiles, 'warm')
    for (let i = 0; i < 6; i++) await h.tick(1000)
    expect(h.openEvents).toHaveLength(4)

    await h.enqueueAll(h.profiles, 'same')
    await h.tick(1000)

    const sameCalls = h.runCalls('same')
    expect(sameCalls).toHaveLength(4)
    expect(new Set(sameCalls.map((call) => (call[0] as ProfileRow).id)).size).toBe(4)
    for (const profile of h.profiles) expect((await h.latest(profile, 'same'))?.status).toBe('success')
  })

  it('cohortMaxSec：连续占用超限且存在非池窗口排队时轮转让位', async () => {
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
    const h = await harness({
      windows: 2,
      cfg: { maxOpenWindows: 1, cohortMaxSec: 10 },
      taskKeys: ['warm', 'task2', ...tasks],
    })
    // 先打开窗口1，再入队：p2 的任务排在 p1 剩余任务之前（轮转后优先打开 p2）
    await h.enqueueAll(h.profiles.slice(0, 1), 'warm')
    await h.tick(0)
    await h.enqueueAll(h.profiles.slice(1), 'task2')
    for (const task of tasks) await h.enqueueAll(h.profiles.slice(0, 1), task)

    for (let i = 0; i < 13; i++) await h.tick(1000)

    expect(h.closeCalls.some((call) => call.reason.includes('连续占用'))).toBe(true)
    expect((await h.latest(h.profiles[1], 'task2'))?.status).toBe('success')
  })
})

describe('WindowPoolScheduler 内存与全局健康门禁', () => {
  it('内存 critical 停止补池，恢复后继续按池上限开窗', async () => {
    const h = await harness({ windows: 4 })
    h.memory.state = 'critical'
    await h.enqueueAll(h.profiles, 'task1')

    for (let i = 0; i < 3; i++) await h.tick(1000)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect(h.openEvents).toHaveLength(0)
    expect(h.scheduler.getStatus().memoryState).toBe('critical')
    for (const profile of h.profiles) expect((await h.latest(profile, 'task1'))?.status).toBe('pending')

    h.memory.state = 'normal'
    for (let i = 0; i < 6; i++) await h.tick(1000)
    expect(h.openEvents).toHaveLength(4)
    for (const profile of h.profiles) expect((await h.latest(profile, 'task1'))?.status).toBe('success')
  })

  it('内存 critical 时已有池窗口也不再分配新任务，并关闭空闲窗口', async () => {
    const h = await harness({ windows: 1 })
    await h.enqueueAll(h.profiles, 'warm')
    await h.tick(0)
    expect(h.openEvents).toHaveLength(1)

    h.memory.state = 'critical'
    await h.enqueueAll(h.profiles, 'task1')
    await h.tick(0)

    expect(h.runCalls('task1')).toHaveLength(0)
    expect(h.closeCalls).toHaveLength(1)
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('pending')
  })

  it('全局健康 paused 时不补池；到点只启动一个探测，探测成功后恢复', async () => {
    const h = await harness({ windows: 4 })
    const base = new Date(2026, 9, 22, 10, 0, 0).getTime()
    for (const id of ['a', 'b', 'c']) h.health.recordEnvironmentFailure(id, base)
    expect(h.health.state).toBe('paused')
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(0)

    // 越过 30s 退避：paused → probing，只允许一个探测会话
    await h.tick(31_000)
    expect(h.runCalls('task1')).toHaveLength(1)
    expect(h.health.state).toBe('normal')
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('success')

    for (let i = 0; i < 4; i++) await h.tick(1000)
    expect(h.openEvents).toHaveLength(4)
    for (const profile of h.profiles) expect((await h.latest(profile, 'task1'))?.status).toBe('success')
  })

  it('探测环境失败：重新暂停并把任务行退回 pending', async () => {
    const h = await harness({ windows: 1, behavior: 'env' })
    const base = new Date(2026, 9, 22, 10, 0, 0).getTime()
    for (const id of ['a', 'b', 'c']) h.health.recordEnvironmentFailure(id, base)
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(31_000)

    expect(h.runCalls('task1')).toHaveLength(1)
    expect(h.health.state).toBe('paused')
    expect(h.closeCalls).toHaveLength(1)
    const row = await h.latest(h.profiles[0], 'task1')
    expect(row?.status).toBe('pending')
    expect(Number(row?.notBeforeMs)).toBeGreaterThan(base + 31_000)
  })

  it('探测被 skipped（手动停止/熔断）不算成功', async () => {
    const h = await harness({ windows: 1, behavior: 'skip' })
    const base = new Date(2026, 9, 22, 10, 0, 0).getTime()
    for (const id of ['a', 'b', 'c']) h.health.recordEnvironmentFailure(id, base)
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(31_000)

    expect(h.health.state).toBe('paused')
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('skipped')
  })

  it('探测空结果不算成功，认领行退回 pending', async () => {
    const h = await harness({ windows: 1, behavior: 'empty' })
    const base = new Date(2026, 9, 22, 10, 0, 0).getTime()
    for (const id of ['a', 'b', 'c']) h.health.recordEnvironmentFailure(id, base)
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(31_000)

    expect(h.health.state).toBe('paused')
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('pending')
  })

  it('环境级失败回收窗口、任务行退回 pending，多窗口失败后暂停全局健康', async () => {
    const h = await harness({
      windows: 3,
      failure: () => true,
    })
    await h.enqueueAll(h.profiles, 'task1')
    for (let i = 0; i < 8; i++) await h.tick(1000)

    expect(h.closeCalls.length).toBeGreaterThanOrEqual(3)
    expect(h.health.state).toBe('paused')
    expect(h.openEvents).toHaveLength(3)
    for (const profile of h.profiles) {
      const row = await h.latest(profile, 'task1')
      expect(row?.status).toBe('pending')
      expect(Number(row?.notBeforeMs)).toBeGreaterThan(0)
    }
  })

  it('实测存活但未登记的窗口计入 actualOpen，阻止继续开窗', async () => {
    const h = await harness({ windows: 1, cfg: { maxOpenWindows: 1 } })
    // 外部直接打开、open_windows 无登记的窗口（profile 存在，任务队列不会给它派任务）
    const external = await h.db.upsertProfile('bb-extra', '外部窗口')
    h.extraLive.add(external.bitbrowserId)
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect(h.openEvents).toHaveLength(0)

    h.extraLive.delete(external.bitbrowserId)
    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(1)
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('success')
  })

  it('环境级失败超过 retryMax 仍可重排（attempts 归零，不落任务终态）', async () => {
    const h = await harness({ windows: 1, behavior: 'env' })
    await h.enqueueAll(h.profiles, 'task1')

    for (let i = 0; i < 5; i++) {
      await h.tick(i === 0 ? 0 : 31_000)
      const row = await h.latest(h.profiles[0], 'task1')
      expect(row?.status).toBe('pending')
      expect(row?.attempts).toBe(0)
      expect(row?.failureKind).toBeNull()
    }
  })

  it('窗口熔断 open 时不认领任务，行保持 pending', async () => {
    const h = await harness({ windows: 1 })
    const profile = h.profiles[0]
    const base = new Date(2026, 9, 22, 10, 0, 0).getTime()
    await h.db.recordWindowEnvironmentFailure(profile.id, '测试熔断', {
      threshold: 1,
      cooldownMs: 60_000,
      maxCooldownMs: 60_000,
    }, base)
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect((await h.latest(profile, 'task1'))?.status).toBe('pending')
  })

  it('窗口熔断探测到期：放行一次半开探测，成功后后续任务正常', async () => {
    const h = await harness({ windows: 1, recoverBreakerOnRun: true })
    const profile = h.profiles[0]
    const base = new Date(2026, 9, 22, 10, 0, 0).getTime()
    await h.db.recordWindowEnvironmentFailure(profile.id, '测试熔断', {
      threshold: 1,
      cooldownMs: 0,
      maxCooldownMs: 60_000,
    }, base)
    expect((await h.db.getWindowHealth(profile.id)).state).toBe('open')
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(1)
    expect((await h.latest(profile, 'task1'))?.status).toBe('success')
    expect((await h.db.getWindowHealth(profile.id)).state).toBe('closed')

    await h.enqueueAll(h.profiles, 'task2')
    await h.tick(0)
    expect(h.runCalls('task2')).toHaveLength(1)
    expect((await h.latest(profile, 'task2'))?.status).toBe('success')
  })

  it('内存 warning 停止普通任务分配，任务保持 pending', async () => {
    const h = await harness({ windows: 1 })
    await h.enqueueAll(h.profiles, 'warm')
    await h.tick(0)
    expect(h.openEvents).toHaveLength(1)

    h.memory.state = 'warning'
    await h.enqueueAll(h.profiles, 'task1')
    await h.tick(0)

    expect(h.runCalls('task1')).toHaveLength(0)
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('pending')
  })

  it('half-open 探测受 effectivePool 限制；恢复内存后才启动', async () => {
    const h = await harness({ windows: 1 })
    const base = new Date(2026, 9, 22, 10, 0, 0).getTime()
    for (const id of ['a', 'b', 'c']) h.health.recordEnvironmentFailure(id, base)
    await h.enqueueAll(h.profiles, 'task1')

    h.memory.state = 'warning'
    h.memory.effectiveOverride = 0
    await h.tick(31_000)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect(h.health.state).toBe('probing')

    h.memory.state = 'normal'
    h.memory.effectiveOverride = undefined
    await h.tick(1000)
    expect(h.runCalls('task1')).toHaveLength(1)
    expect(h.health.state).toBe('normal')
  })

  it('比特 API 探测失败上报全局健康暂停，恢复后探测放行', async () => {
    const h = await harness({ windows: 1 })
    h.bitbrowser.openPids.mockRejectedValueOnce(new Error('本地 API 不可用'))
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect(h.health.state).toBe('paused')
    expect(h.scheduler.getStatus().globalHealthState).toBe('paused')

    await h.tick(31_000)
    expect(h.runCalls('task1')).toHaveLength(1)
    expect(h.health.state).toBe('normal')
  })

  it('普通会话空结果：认领行退回 pending 并退避', async () => {
    const h = await harness({ windows: 1, behavior: 'empty' })
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(1)
    const row = await h.latest(h.profiles[0], 'task1')
    expect(row?.status).toBe('pending')
    expect(Number(row?.notBeforeMs)).toBeGreaterThan(new Date(2026, 9, 22, 10, 0, 0).getTime())
  })
})

describe('WindowPoolScheduler 幂等、对账与回收', () => {
  it('success 行不会被重新分配；skipIfSuccess 不产生新轮次', async () => {
    const h = await harness({ windows: 2 })
    await h.enqueueAll(h.profiles, 'task1')
    for (let i = 0; i < 5; i++) await h.tick(1000)
    expect(h.runCalls('task1')).toHaveLength(2)

    for (let i = 0; i < 4; i++) await h.tick(1000)
    expect(h.runCalls('task1')).toHaveLength(2)

    await h.scheduler.enqueue(h.profiles[0], 'task1', { skipIfSuccess: true })
    let rows = await h.db.listRunsForDate(h.date())
    expect(rows.filter((row) => row.profileId === h.profiles[0].id && row.taskKey === 'task1')).toHaveLength(1)

    await h.scheduler.enqueue(h.profiles[0], 'task1')
    rows = await h.db.listRunsForDate(h.date())
    const p1Rows = rows.filter((row) => row.profileId === h.profiles[0].id && row.taskKey === 'task1')
    expect(p1Rows).toHaveLength(2)
    expect(p1Rows.some((row) => row.slot === 1 && row.status === 'pending')).toBe(true)
  })

  it('窗口空闲超过 idleCloseSec 后关闭', async () => {
    const h = await harness({ windows: 1, cfg: { idleCloseSec: 10 } })
    await h.enqueueAll(h.profiles, 'warm')
    await h.tick(0)
    await h.tick(0)
    expect(h.closeCalls).toHaveLength(0)

    await h.tick(9000)
    expect(h.closeCalls).toHaveLength(0)
    await h.tick(1000)
    expect(h.closeCalls).toHaveLength(1)
    expect(h.closeCalls[0].reason).toContain('空闲')
  })

  it('手动存活窗口的排队任务不阻止空闲池窗口回收', async () => {
    const h = await harness({ windows: 2, cfg: { maxOpenWindows: 2, idleCloseSec: 5 } })
    await h.enqueueAll(h.profiles.slice(0, 1), 'warm')
    await h.tick(0)
    expect(h.openEvents).toHaveLength(1)

    // 窗口2 由面板手动打开（无池登记），且有到期任务；它不在池里也不会被池开窗
    const manual = h.profiles[1]
    h.extraLive.add(manual.bitbrowserId)
    await h.enqueueAll([manual], 'task2')
    await h.tick(0)
    await h.tick(5000)

    expect(h.closeCalls.some((call) => call.bitbrowserId === h.profiles[0].bitbrowserId)).toBe(true)
    expect((await h.latest(manual, 'task2'))?.status).toBe('pending')
  })

  it('窗口达到 windowMaxTasks 后关闭', async () => {
    const h = await harness({ windows: 1, cfg: { windowMaxTasks: 1 } })
    await h.enqueueAll(h.profiles, 'warm')
    await h.tick(0)
    expect(h.closeCalls).toHaveLength(0)

    await h.tick(0)
    expect(h.closeCalls).toHaveLength(1)
    expect(h.closeCalls[0].reason).toContain('任务上限')
  })

  it('窗口超过 windowMaxLifetimeSec 后关闭', async () => {
    const h = await harness({ windows: 1, cfg: { windowMaxLifetimeSec: 10 } })
    await h.enqueueAll(h.profiles, 'warm')
    await h.tick(0)
    expect(h.closeCalls).toHaveLength(0)

    await h.tick(9000)
    expect(h.closeCalls).toHaveLength(0)
    await h.tick(1000)
    expect(h.closeCalls).toHaveLength(1)
    expect(h.closeCalls[0].reason).toContain('存活')
  })

  it('opening 超时且窗口不存在 → 清行；超时后重探存活 → 转 open', async () => {
    const dead = await harness({ windows: 1 })
    await dead.db.reserveOpenWindow(dead.profiles[0].bitbrowserId, process.pid, 'pool')
    await dead.tick(0)
    expect(await dead.db.getOpenWindow(dead.profiles[0].bitbrowserId)).not.toBeNull()
    await dead.tick(61_000)
    expect(await dead.db.getOpenWindow(dead.profiles[0].bitbrowserId)).toBeNull()

    const live = await harness({ windows: 1 })
    // opening 行带有效调试地址，超时重探存活后才允许 promote 为 open
    await live.db.setOpenWindow(live.profiles[0].bitbrowserId, '127.0.0.1:61111', process.pid, 'open')
    await live.db.setWindowState(live.profiles[0].bitbrowserId, 'opening')
    let probes = 0
    live.bitbrowser.openPids.mockImplementation(async () => {
      probes++
      // 第 1 次 tick 与超时后的批量探测都看不到；超时后的单窗口重探返回存活
      return probes >= 3 ? new Set([live.profiles[0].bitbrowserId]) : new Set<string>()
    })
    await live.tick(0)
    await live.tick(61_000)
    const row = await live.db.getOpenWindow(live.profiles[0].bitbrowserId)
    expect(row?.state).toBe('open')
  })

  it('外部/DB opening 预留占用池容量并排除候选；写 http 前不分配，写后可正常使用', async () => {
    const h = await harness({ windows: 1, cfg: { maxOpenWindows: 1 } })
    const id = h.profiles[0].bitbrowserId
    await h.db.reserveOpenWindow(id, process.pid, 'pool')
    expect((await h.db.getOpenWindow(id))?.state).toBe('opening')
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect(h.openEvents).toHaveLength(0)
    expect((await h.db.getOpenWindow(id))?.state).toBe('opening')

    // pids 已存活但 http 为空：仍是 opening 预留，不得分配/复用
    h.openIds.add(id)
    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect((await h.db.getOpenWindow(id))?.state).toBe('opening')

    // 执行器补写调试地址后才转 open 并分配任务
    await h.db.setOpenWindow(id, '127.0.0.1:61222', process.pid, 'open')
    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(1)
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('success')
  })

  it('opening 存活但长期空 http：超时关窗并清登记释放容量', async () => {
    const h = await harness({ windows: 1, cfg: { maxOpenWindows: 1 } })
    const id = h.profiles[0].bitbrowserId
    await h.db.reserveOpenWindow(id, process.pid, 'pool')
    h.openIds.add(id)

    await h.tick(0)
    expect(h.closeCalls).toHaveLength(0)
    expect((await h.db.getOpenWindow(id))?.state).toBe('opening')

    await h.tick(61_000)
    expect(h.closeCalls).toHaveLength(1)
    expect(h.closeCalls[0].reason).toContain('调试地址')
    expect(await h.db.getOpenWindow(id)).toBeNull()
  })

  it('closing 登记仍存活时到点重试关窗并清行', async () => {
    const h = await harness({ windows: 1 })
    const id = h.profiles[0].bitbrowserId
    await h.db.reserveOpenWindow(id, process.pid, 'pool')
    await h.db.setWindowState(id, 'closing')
    h.openIds.add(id)

    await h.tick(0)
    expect(h.closeCalls).toHaveLength(0)
    expect(await h.db.getOpenWindow(id)).not.toBeNull()

    await h.tick(30_000)
    expect(h.closeCalls).toHaveLength(1)
    expect(h.closeCalls[0].reason).toContain('关闭超时')
    expect(await h.db.getOpenWindow(id)).toBeNull()
  })

  it('关窗失败保留登记与池状态，下轮重试成功后清理', async () => {
    const h = await harness({ windows: 1, cfg: { idleCloseSec: 5 }, closeFailures: 1 })
    await h.enqueueAll(h.profiles, 'warm')
    await h.tick(0)
    await h.tick(0)

    await h.tick(5000)
    expect(h.closeCalls).toHaveLength(1)
    expect(await h.db.getOpenWindow(h.profiles[0].bitbrowserId)).not.toBeNull()

    await h.tick(1000)
    expect(h.closeCalls).toHaveLength(2)
    expect(await h.db.getOpenWindow(h.profiles[0].bitbrowserId)).toBeNull()
  })

  it('执行器同步抛错：认领行退回 pending 并退避', async () => {
    const h = await harness({ windows: 1 })
    h.runner.runWindowTasks.mockImplementationOnce(() => {
      throw new Error('同步异常')
    })
    await h.enqueueAll(h.profiles, 'task1')
    await h.tick(0)

    const row = await h.latest(h.profiles[0], 'task1')
    expect(row?.status).toBe('pending')
    expect(Number(row?.notBeforeMs)).toBeGreaterThan(new Date(2026, 9, 22, 10, 0, 0).getTime())
  })

  it('认领竞争失败不启动会话，下一 tick 重试成功', async () => {
    const h = await harness({ windows: 1 })
    const spy = vi.spyOn(h.db, 'claimQueuedRuns').mockResolvedValueOnce([])
    await h.enqueueAll(h.profiles, 'task1')

    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(0)
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('pending')

    spy.mockRestore()
    await h.tick(0)
    expect(h.runCalls('task1')).toHaveLength(1)
    expect((await h.latest(h.profiles[0], 'task1'))?.status).toBe('success')
  })

  it('opening 只代表开窗请求在途：会话挂起期间窗口已存活则不再占额度', async () => {
    const h = await harness({ windows: 2, cfg: { maxOpenWindows: 2 }, holdSessions: true })
    await h.enqueueAll(h.profiles, 'task1')

    await h.tickNoWait(0)
    expect(h.runCalls('task1')).toHaveLength(1)

    // 第一个会话仍挂起，但窗口已登记存活；不应再计入 opening 预留，第二个窗口可以补池
    await h.tickNoWait(0)
    expect(h.runCalls('task1')).toHaveLength(2)

    await h.waitForGates(2)
    h.releaseAll()
    await h.scheduler.waitForIdle()
    for (const profile of h.profiles) expect((await h.latest(profile, 'task1'))?.status).toBe('success')
  })
})

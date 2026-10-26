/**
 * window-runner 单测（注入假驱动，不连真库）
 * 文件顶部共享夹具：makeProfile/makeDb/okPage/makeDriver/bitbrowser(bb)/logger/cfg/artifactsDir/walletPasswords
 * 多个 describe：基础会话编排（mock db）+ 批次透传与 pending 预写（有状态内存假库）
 * + 开窗失败兜底关窗 + runs 即队列端到端交接（真实临时库）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowRunner, type BrowserDriver } from '../src/engine/window-runner'
import { takeScreenshot } from '../src/api'
import { SerialQueue } from '../src/engine/serial-queue'
import { CancelRegistry } from '../src/engine/cancel-registry'
import { AppDb, todayStr, type ProfileRow, type RunRow } from '../src/infrastructure/db'
import { TaskContext, type SiteTask } from '../src/tasks/base'
import { WalletRegistry } from '../src/automation/wallet/types'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { WalletActions } from '../src/automation/wallet/actions'

function makeProfile(over: Partial<ProfileRow> = {}): ProfileRow {
  return { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0, ...over }
}

const closedHealth = { state: 'closed' as const, failures: 0, level: 0, nextProbeMs: null, probeStartedMs: null, reason: null, updatedAt: null }

function makeDb(over: Partial<Record<keyof AppDb, unknown>> = {}): AppDb {
  const db = {
    upsertRun: vi.fn(async (profileId: number, taskKey: string, date: string, slot: number, status: string, patch: Record<string, unknown> = {}) => ({
      id: 1,
      profileId,
      taskKey,
      date,
      slot,
      status,
      attempts: Number(patch.attempts ?? 0),
      error: (patch.error as string | null | undefined) ?? null,
      screenshot: (patch.screenshot as string | null | undefined) ?? null,
      startedAt: (patch.startedAt as string | null | undefined) ?? null,
      finishedAt: (patch.finishedAt as string | null | undefined) ?? null,
      batchId: (patch.batchId as number | null | undefined) ?? null,
      diagPath: (patch.diagPath as string | null | undefined) ?? null,
      failureKind: (patch.failureKind as string | null | undefined) ?? null,
      profileName: '窗口1',
      bitbrowserId: 'bb-1',
    })),
    getWindowHealth: vi.fn().mockResolvedValue(closedHealth),
    claimWindowProbe: vi.fn().mockResolvedValue(true),
    releaseWindowProbe: vi.fn().mockResolvedValue(undefined),
    recordWindowEnvironmentFailure: vi.fn().mockResolvedValue(closedHealth),
    recordWindowSuccess: vi.fn().mockResolvedValue(closedHealth),
    resetWindowHealth: vi.fn().mockResolvedValue(undefined),
    listProfiles: vi.fn().mockResolvedValue([]),
    getLatestRun: vi.fn().mockResolvedValue(null),
    nextRunSlot: vi.fn().mockResolvedValue(0),
    enqueueRun: vi.fn(async (profileId: number, taskKey: string, date: string, batchId: number | null, notBeforeMs: number) => ({
      id: 1,
      profileId,
      taskKey,
      date,
      slot: 0,
      status: 'pending',
      attempts: 0,
      error: null,
      screenshot: null,
      startedAt: null,
      finishedAt: null,
      batchId,
      diagPath: null,
      failureKind: null,
      notBeforeMs,
      profileName: '窗口1',
      bitbrowserId: 'bb-1',
    })),
    claimQueuedRuns: vi.fn(async (runIds: number[]) => runIds.map((id) => ({ id, status: 'running' }))),
    clearRunDiag: vi.fn().mockResolvedValue(undefined),
    reserveOpenWindow: vi.fn().mockResolvedValue(undefined),
    setOpenWindow: vi.fn().mockResolvedValue(undefined),
    setWindowState: vi.fn().mockResolvedValue(undefined),
    incrementWindowUsage: vi.fn().mockResolvedValue(undefined),
    clearOpenWindow: vi.fn().mockResolvedValue(undefined),
    listOpenWindows: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as AppDb
  // 条件更新默认委托 upsertRun：既有用例仍通过 upsertRun 断言状态序列，竞态用例单独覆盖
  const mutable = db as unknown as Record<string, unknown>
  if (typeof mutable.updateRunIfRunning !== 'function') {
    mutable.updateRunIfRunning = vi.fn((...args: unknown[]) => (mutable.upsertRun as (...a: unknown[]) => unknown)(...args))
  }
  return db
}

const okPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue('https://x.io'),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
}

function makeDriver(over: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    connect: vi.fn().mockResolvedValue({ page: okPage, close: vi.fn().mockResolvedValue(undefined) }),
    ...over,
  } as unknown as BrowserDriver
}

const open = { http: '127.0.0.1:61234', ws: '' }
const bitbrowser = {
  openBrowser: vi.fn().mockResolvedValue(open),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
  listBrowsers: vi.fn().mockResolvedValue([]),
  openPids: vi.fn().mockResolvedValue(new Set<string>()),
  health: vi.fn().mockResolvedValue(true),
}
/** 共享比特浏览器假件别名（新增批次用例直接用 bb） */
const bb = bitbrowser

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
const cfg = {
  bitbrowser: { apiBase: '', openTimeoutMs: 0, maxRetries: 3, retryBackoffMs: [0, 0, 0] },
  execution: {
    taskTimeoutMs: 5000,
    retryMax: 2,
    retryBackoffSec: 30,
    circuitBreakerThreshold: 2,
    circuitBreakerEnabled: true,
    circuitBreakerCooldownSec: 1800,
    circuitBreakerMaxCooldownSec: 7200,
    windowTimeoutMs: 60000,
  },
  ai: { apiKey: '' },
} as never
const artifactsDir = join(tmpdir(), 'abc-window-runner-artifacts')
const walletPasswords: Record<string, string> = {}

function makeRunner(over: { db?: AppDb; driver?: BrowserDriver; tasks?: Map<string, SiteTask>; cfgOver?: never; reuseOpen?: (bitbrowserId: string) => Promise<{ http: string } | null>; wallets?: WalletRegistry; cancelRegistry?: CancelRegistry; bitbrowser?: unknown; openCloseQueue?: SerialQueue; openOwnerKind?: 'pool' | 'manual' | 'taskrun' }) {
  return new WindowRunner({
    cfg: over.cfgOver ?? cfg,
    db: over.db ?? makeDb(),
    bitbrowser: (over.bitbrowser ?? bitbrowser) as never,
    driver: over.driver ?? makeDriver(),
    tasks: over.tasks ?? new Map([['ok-task', new OkTask()]]),
    wallets: over.wallets ?? (null as never),
    logger,
    artifactsDir,
    walletPasswords,
    reuseOpen: over.reuseOpen,
    cancelRegistry: over.cancelRegistry,
    openCloseQueue: over.openCloseQueue,
    openOwnerKind: over.openOwnerKind,
  })
}

class OkTask implements SiteTask {
  meta = { key: 'ok-task', name: 'OK', url: 'https://x.io' }
  run = vi.fn().mockResolvedValue(undefined)
}

class FailTask implements SiteTask {
  meta = { key: 'fail-task', name: 'FAIL', url: 'https://x.io' }
  run = vi.fn().mockRejectedValue(new Error('boom'))
}

/** 成功前主动截图：验证任务截图优先、框架不再重复补成功图 */
class ShottedOkTask implements SiteTask {
  meta = { key: 'shot-task', name: 'SHOT', url: 'https://x.io' }
  run = vi.fn(async (ctx: TaskContext) => {
    await takeScreenshot(ctx, 'task-success')
  })
}

/** 钱包探针任务 fixture：run 内经 ctx 字段装配 WalletActions 并 ready，验证 WalletSession 注入链路（TaskContext 已无 wallet 命名空间） */
class WalletProbeTask implements SiteTask {
  meta = { key: 'wallet-probe', name: 'WP', url: 'https://x.io', wallet: 'metamask' }
  run = vi.fn(async (ctx: TaskContext) => {
    const actions = new WalletActions({
      page: ctx.page,
      walletKey: ctx.task.meta.wallet,
      wallets: ctx.wallets,
      walletPasswords: ctx.walletPasswords,
      walletSession: ctx.walletSession,
      log: ctx.log,
      recover: async () => false,
    })
    await actions.ready()
  })
}

/** 提取 upsertRun 调用序列的状态列 */
function statuses(db: AppDb): string[] {
  return (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[4])
}

describe('WindowRunner', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('任务成功后写 success 并关窗', async () => {
    const db = makeDb()
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(statuses(db)).toContain('success')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('任务已截图时不再补框架成功图，run.screenshot 指向任务截图', async () => {
    const db = makeDb()
    const page = { ...okPage, screenshot: vi.fn().mockResolvedValue(Buffer.from('')) }
    const driver = makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) })
    const runner = makeRunner({ db, driver, tasks: new Map([['shot-task', new ShottedOkTask()]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'shot-task' }])
    const success = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[4] === 'success')
    expect(success![5].screenshot).toBe(join(artifactsDir, todayStr(), 'bb-1', 'shot-task', 'slot-0', 'task-success.png'))
    expect(page.screenshot).toHaveBeenCalledTimes(1)
  })

  it('任务没截图时框架补成功图，且落在当前 slot 目录', async () => {
    const db = makeDb()
    const page = { ...okPage, screenshot: vi.fn().mockResolvedValue(Buffer.from('')) }
    const driver = makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) })
    const runner = makeRunner({ db, driver })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const success = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[4] === 'success')
    expect(success![5].screenshot).toBe(join(artifactsDir, todayStr(), 'bb-1', 'ok-task', 'slot-0', `${todayStr()}-success.png`))
    expect(page.screenshot).toHaveBeenCalledTimes(1)
  })

  it('每小时/手动重跑按新 slot 分目录（不在旧轮次目录覆盖）', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'success', attempts: 1, slot: 1 } as Partial<RunRow>),
      nextRunSlot: vi.fn().mockResolvedValue(2),
    })
    const page = { ...okPage, screenshot: vi.fn().mockResolvedValue(Buffer.from('')) }
    const driver = makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) })
    const runner = makeRunner({ db, driver })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const success = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[4] === 'success')
    expect(success![5].screenshot).toBe(join(artifactsDir, todayStr(), 'bb-1', 'ok-task', 'slot-2', `${todayStr()}-success.png`))
  })

  it('失败截图与诊断包落在当前 slot 目录', async () => {
    const db = makeDb()
    const page = { ...okPage, screenshot: vi.fn().mockResolvedValue(Buffer.from('')) }
    const driver = makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) })
    const runner = makeRunner({ db, driver, tasks: new Map([['fail-task', new FailTask()]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    const fail = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[4] === 'retry_wait')
    expect(fail![5].screenshot).toBe(join(artifactsDir, todayStr(), 'bb-1', 'fail-task', 'slot-0', `${todayStr()}-attempt1.png`))
    expect(fail![5].diagPath).toContain(join('fail-task', 'slot-0'))
  })

  it('开窗成功后登记 state=open', async () => {
    const db = makeDb()
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(db.setOpenWindow).toHaveBeenCalledWith('bb-1', open.http, process.pid, 'open')
  })

  it('可指定开窗归属（task:run 脚本登记 taskrun）', async () => {
    const db = makeDb()
    const runner = makeRunner({ db, openOwnerKind: 'taskrun' })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(db.reserveOpenWindow).toHaveBeenCalledWith('bb-1', process.pid, 'taskrun')
  })

  it('关窗先标记 closing，确认 pids 消失后清登记', async () => {
    const db = makeDb()
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const setState = db.setWindowState as ReturnType<typeof vi.fn>
    const clear = db.clearOpenWindow as ReturnType<typeof vi.fn>
    const close = bitbrowser.closeBrowser as ReturnType<typeof vi.fn>
    const pids = bitbrowser.openPids as ReturnType<typeof vi.fn>
    expect(setState).toHaveBeenCalledWith('bb-1', 'closing')
    expect(pids).toHaveBeenCalledWith(['bb-1'])
    expect(setState.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0])
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0])
  })

  it('开窗与关窗都经串行队列', async () => {
    const db = makeDb()
    const queue = new SerialQueue(0)
    const runSpy = vi.spyOn(queue, 'run')
    const runner = makeRunner({ db, openCloseQueue: queue })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(runSpy).toHaveBeenCalledTimes(2)
    // 开窗保留冷却，关窗不等待开窗冷却
    expect(runSpy.mock.calls[0][1]).toBeUndefined()
    expect(runSpy.mock.calls[1][1]).toEqual({ cooldown: false })
    expect(bitbrowser.openBrowser).toHaveBeenCalledWith('bb-1')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('关窗时 pids 仍存活：等待其消失后再清登记', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb()
      const bb2 = {
        ...bitbrowser,
        openPids: vi.fn().mockResolvedValueOnce(new Set(['bb-1'])).mockResolvedValue(new Set<string>()),
      }
      const runner = makeRunner({ db, bitbrowser: bb2 })
      const p = runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
      await vi.advanceTimersByTimeAsync(1000)
      await p
      expect(bb2.openPids).toHaveBeenCalledTimes(2)
      expect(db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('关窗等待 pids 超时：保留 closing 登记不清行', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb()
      const bb2 = {
        ...bitbrowser,
        openPids: vi.fn().mockResolvedValue(new Set(['bb-1'])),
      }
      const runner = makeRunner({ db, bitbrowser: bb2 })
      const p = runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
      await vi.advanceTimersByTimeAsync(30_000)
      await p
      expect(db.setWindowState).toHaveBeenCalledWith('bb-1', 'closing')
      expect(db.clearOpenWindow).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('开窗失败清除预留登记', async () => {
    const db = makeDb()
    const bb2 = {
      ...bitbrowser,
      openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')),
      openPids: vi.fn().mockResolvedValue(new Set<string>()),
    }
    const runner = makeRunner({ db, bitbrowser: bb2 })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('runManual 先入队并原子认领任务行，再执行任务', async () => {
    const db = makeDb({
      listProfiles: vi.fn().mockResolvedValue([makeProfile()]),
      enqueueRun: vi.fn().mockResolvedValue({ id: 42, status: 'pending' } as Partial<RunRow>),
      claimQueuedRuns: vi.fn().mockResolvedValue([{ id: 42, status: 'running' } as Partial<RunRow>]),
      getLatestRun: vi.fn().mockResolvedValue({ status: 'running', attempts: 0, slot: 0 } as Partial<RunRow>),
    })
    const task = new OkTask()
    const runner = makeRunner({ db, tasks: new Map([['ok-task', task]]) })
    const row = await runner.runManual('bb-1', 'ok-task')
    expect(db.enqueueRun).toHaveBeenCalledWith(1, 'ok-task', todayStr(), null, 0)
    expect(db.claimQueuedRuns).toHaveBeenCalledWith([42], expect.any(Number))
    expect(task.run).toHaveBeenCalledTimes(1)
    expect(statuses(db)).toEqual(['running', 'success'])
    expect(row?.status).toBe('success')
  })

  it('runManual 认领失败（行已被其它调度器执行）时报错且不执行任务', async () => {
    const db = makeDb({
      listProfiles: vi.fn().mockResolvedValue([makeProfile()]),
      enqueueRun: vi.fn().mockResolvedValue({ id: 42, status: 'pending' } as Partial<RunRow>),
      claimQueuedRuns: vi.fn().mockResolvedValue([]),
    })
    const task = new OkTask()
    const runner = makeRunner({ db, tasks: new Map([['ok-task', task]]) })
    await expect(runner.runManual('bb-1', 'ok-task')).rejects.toThrow('任务正在被其他调度器执行，请稍后重试')
    expect(task.run).not.toHaveBeenCalled()
    expect(db.upsertRun).not.toHaveBeenCalled()
  })

  it('任务失败写入 retry_wait 与 notBeforeMs（不占窗）', async () => {
    const db = makeDb()
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    // 单窗口会话内每任务只跑一次：失败后 retry_wait 立即返回，重试由 dispatcher 按 not_before_ms 拾取
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait'])
    expect(task.run).toHaveBeenCalledTimes(1)
    const failCall = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[4] === 'retry_wait')
    expect(failCall![5].notBeforeMs).toBeGreaterThan(Date.now())
    expect(failCall![5].notBeforeMs).toBeLessThanOrEqual(Date.now() + 30_000)
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('任务失败采集诊断包并随 run 落库 diagPath', async () => {
    const db = makeDb()
    const page = { ...okPage, evaluate: vi.fn().mockResolvedValue('可见文本') }
    const task = new FailTask()
    const runner = makeRunner({
      db,
      tasks: new Map([['fail-task', task]]),
      driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }),
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    // 失败分支的 upsertRun 须携带 diagPath，且指向 artifacts 目录下的 .diag.json
    const failCall = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[4] === 'retry_wait')
    expect(failCall).toBeTruthy()
    const diagPath = failCall![5].diagPath as string
    expect(diagPath.startsWith(artifactsDir)).toBe(true)
    expect(diagPath.endsWith('.diag.json')).toBe(true)
    // 诊断文件已落盘，含 steps/error/url 关键排障字段
    expect(existsSync(diagPath)).toBe(true)
    const bundle = JSON.parse(readFileSync(diagPath, 'utf8'))
    expect(Array.isArray(bundle.steps)).toBe(true)
    expect(bundle.error).toBe('boom')
    expect(bundle.url).toBe('https://x.io')
  })

  it('重试会话从上次 attempts 继续并先复位页面', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 0 } as Partial<RunRow>),
    })
    const task = new FailTask()
    const page = { ...okPage, goto: vi.fn().mockResolvedValue(undefined) }
    const runner = makeRunner({
      db,
      tasks: new Map([['fail-task', task]]),
      driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }),
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['running', 'retry_wait'])
    // attempts 从上次的 1 续到 2（重试上限跨会话生效）
    const runningCall = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[4] === 'running')
    expect(runningCall![5].attempts).toBe(2)
    // 重试前页面复位 about:blank，且发生在任务执行之前
    const blankIdx = page.goto.mock.calls.findIndex(c => c[0] === 'about:blank')
    expect(blankIdx).toBeGreaterThanOrEqual(0)
    expect(page.goto.mock.calls[blankIdx][1]).toEqual({ timeout: 10000 })
    expect(page.goto.mock.invocationCallOrder[blankIdx]).toBeLessThan(task.run.mock.invocationCallOrder[0])
  })

  it('最后一次尝试失败标记 failed', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>),
    })
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['running', 'failed'])
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
  })

  it('重试跨会话续算并最终 failed', async () => {
    const db = makeDb()
    const getLatestRun = db.getLatestRun as ReturnType<typeof vi.fn>
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    // 第 1 会话：无历史记录 → attempt=1 → retry_wait
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait'])
    // 第 2 会话：上一轮 attempts=1 → 从 2 续跑 → 再 retry_wait
    getLatestRun.mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 0 } as Partial<RunRow>)
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait', 'running', 'retry_wait'])
    // 第 3 会话：上一轮 attempts=2 → 从 3 续跑 → 达上限 failed 终态
    getLatestRun.mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>)
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait', 'running', 'retry_wait', 'running', 'failed'])
    // 三次 running 的 attempts 依次 1/2/3（重试上限跨会话生效，共 3 次尝试）
    const runningAttempts = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
      .filter(c => c[4] === 'running').map(c => c[5].attempts)
    expect(runningAttempts).toEqual([1, 2, 3])
  })

  it('历史 attempts 已耗尽重试预算时直接 failed', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 3, slot: 0 } as Partial<RunRow>),
    })
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    // retryMax=2 时预算为 3 次尝试，attempts=3 已耗尽：不跑任务、不进循环
    expect(statuses(db)).toEqual(['failed'])
    expect(task.run).not.toHaveBeenCalled()
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
  })

  it('开窗失败重试后跳过窗口', async () => {
    const db = makeDb()
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bb.openBrowser).toHaveBeenCalledTimes(3)
    expect(statuses(db)).toEqual(['pending', 'skipped'])
  })

  it('每次开窗失败后都关闭窗口清理残留（比特开窗异步：报错≠窗口没开）', async () => {
    const db = makeDb()
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bb.openBrowser).toHaveBeenCalledTimes(3)
    expect(bb.closeBrowser).toHaveBeenCalledTimes(3)
    expect(bb.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('开窗失败清理时 closeBrowser 自身报错不阻断重试流程', async () => {
    const db = makeDb()
    const bb = {
      openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')),
      closeBrowser: vi.fn().mockRejectedValue(new Error('关闭也失败')),
    }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bb.openBrowser).toHaveBeenCalledTimes(3)
    expect(bb.closeBrowser).toHaveBeenCalledTimes(3)
    expect(statuses(db)).toEqual(['pending', 'skipped'])
  })

  it('窗口级跳过结算待重试行：retry_wait 行沿用原 slot 落终态（不新开轮次）', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 3 } as Partial<RunRow>),
    })
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][3]).toBe(3) // 沿用 retry_wait 行的 slot，而非 nextRunSlot 新开轮
    expect(calls[0][4]).toBe('skipped')
    expect(db.nextRunSlot).not.toHaveBeenCalled()
  })

  it('窗口级跳过无待重试行时仍新开轮次（终态行为不变）', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'success', attempts: 1, slot: 1 } as Partial<RunRow>),
      nextRunSlot: vi.fn().mockResolvedValue(2),
    })
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][3]).toBe(2) // 预写 pending 也开新轮次 slot
    expect(calls[0][4]).toBe('pending')
    expect(calls[1][3]).toBe(2)
    expect(calls[1][4]).toBe('skipped')
  })

  it('CDP 连接失败标记 failed 且不抛异常', async () => {
    const db = makeDb()
    const runner = makeRunner({ db, driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('连接被拒绝')) }) })
    await expect(runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])).resolves.toBeInstanceOf(Map)
    expect(statuses(db)).toEqual(['pending', 'failed'])
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('窗口超时后剩余任务全部标 skipped（窗口超时）', async () => {
    const db = makeDb()
    const ok1 = new OkTask()
    const ok2 = new OkTask()
    const cfgZero = {
      bitbrowser: { apiBase: '', openTimeoutMs: 0, maxRetries: 3, retryBackoffMs: [0, 0, 0] },
      execution: { taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 0 },
      ai: { apiKey: '' },
    } as never
    const runner = new WindowRunner({ cfg: cfgZero, db, bitbrowser: bitbrowser as never, driver: makeDriver(), tasks: new Map([['ok-task', ok1], ['ok2', ok2]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }, { taskKey: 'ok2' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map(c => c[4])).toEqual(['pending', 'pending', 'skipped', 'skipped'])
    const skipped = calls.filter(c => c[4] === 'skipped')
    expect(skipped.every(c => c[5].error === '窗口超时')).toBe(true)
    expect(ok1.run).not.toHaveBeenCalled()
    expect(ok2.run).not.toHaveBeenCalled()
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('CDP 连接 close 失败不影响关窗流程', async () => {
    const db = makeDb()
    const close = vi.fn().mockRejectedValue(new Error('close boom'))
    const runner = makeRunner({ db, driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page: okPage, close }) }) })
    await expect(runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])).resolves.toBeInstanceOf(Map)
    expect(close).toHaveBeenCalled()
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('reuseOpen 返回地址时复用窗口：不开窗、不关窗、任务正常执行', async () => {
    const db = makeDb()
    const reuseOpen = vi.fn().mockResolvedValue({ http: '127.0.0.1:61234' })
    const runner = makeRunner({ db, reuseOpen })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(statuses(db)).toContain('success')
    expect(reuseOpen).toHaveBeenCalledWith('bb-1')
    expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
    expect(bitbrowser.closeBrowser).not.toHaveBeenCalled()
  })

  it('reuseOpen 返回地址时 CDP 连接失败仍落 failed 且不关窗', async () => {
    const db = makeDb()
    const runner = makeRunner({
      db,
      reuseOpen: vi.fn().mockResolvedValue({ http: '127.0.0.1:61234' }),
      driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('连接被拒绝')) }),
    })
    await expect(runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])).resolves.toBeInstanceOf(Map)
    expect(statuses(db)).toEqual(['pending', 'failed'])
    expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
    expect(bitbrowser.closeBrowser).not.toHaveBeenCalled()
  })

  it('reuseOpen 返回 null 时行为不变（正常开窗并关窗）', async () => {
    const db = makeDb()
    const runner = makeRunner({ db, reuseOpen: vi.fn().mockResolvedValue(null) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(statuses(db)).toContain('success')
    expect(bitbrowser.openBrowser).toHaveBeenCalledWith('bb-1')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('reuseOpen 返回空 http 时忽略复用并正常开窗（避免 http:// Invalid URL）', async () => {
    const db = makeDb()
    const runner = makeRunner({ db, reuseOpen: vi.fn().mockResolvedValue({ http: '' }) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bitbrowser.openBrowser).toHaveBeenCalledWith('bb-1')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(statuses(db)).toContain('success')
  })

  it('复用地址 CDP 失败时清除 open_windows 登记，避免下次继续复用坏地址', async () => {
    const db = makeDb()
    const runner = makeRunner({
      db,
      reuseOpen: vi.fn().mockResolvedValue({ http: '127.0.0.1:27240' }),
      driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) }),
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
    expect(bitbrowser.closeBrowser).not.toHaveBeenCalled()
  })

  it('keep-open 复用窗口 CDP 失败：串行关窗并清登记，避免留下无登记存活窗口', async () => {
    const db = makeDb()
    const runner = makeRunner({
      db,
      reuseOpen: vi.fn().mockResolvedValue({ http: '127.0.0.1:61234' }),
      driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('连接被拒绝')) }),
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }], { keepWindowOpen: true })
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })

  it('keep-open 手动复用窗口 CDP 失败：不关窗也不清登记', async () => {
    const db = makeDb()
    const runner = makeRunner({
      db,
      reuseOpen: vi.fn().mockResolvedValue({ http: '127.0.0.1:61234' }),
      driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('连接被拒绝')) }),
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }], { keepWindowOpen: true, manualReused: true })
    expect(bitbrowser.closeBrowser).not.toHaveBeenCalled()
    expect(db.clearOpenWindow).not.toHaveBeenCalled()
  })

  it('keep-open 成功：不关窗、回写 open 并累加窗口使用次数', async () => {
    const db = makeDb()
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }], { keepWindowOpen: true })
    expect(statuses(db)).toContain('success')
    expect(bitbrowser.closeBrowser).not.toHaveBeenCalled()
    expect(db.incrementWindowUsage).toHaveBeenCalledWith('bb-1')
    const setOpen = db.setOpenWindow as ReturnType<typeof vi.fn>
    expect(setOpen).toHaveBeenCalledTimes(2)
    expect(setOpen).toHaveBeenLastCalledWith('bb-1', open.http, process.pid, 'open')
    expect(db.setWindowState).not.toHaveBeenCalledWith('bb-1', 'closing')
  })

  it('keepWindowOpen=false：会话结束仍关窗且不累加窗口使用次数', async () => {
    const db = makeDb()
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }], { keepWindowOpen: false })
    expect(statuses(db)).toContain('success')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(db.incrementWindowUsage).not.toHaveBeenCalled()
  })

  it('keep-open 任务级失败：保留窗口并累加窗口使用次数', async () => {
    const db = makeDb()
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }], { keepWindowOpen: true })
    expect(statuses(db)).toContain('retry_wait')
    expect(bitbrowser.closeBrowser).not.toHaveBeenCalled()
    expect(db.incrementWindowUsage).toHaveBeenCalledWith('bb-1')
  })

  it('keep-open 环境级失败：仍关闭窗口且不累加使用次数', async () => {
    class WindowFailTask implements SiteTask {
      meta = { key: 'window-fail', name: 'WF', url: 'https://x.io' }
      run = vi.fn().mockRejectedValue(new Error('Target closed'))
    }
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>),
      recordWindowEnvironmentFailure: vi.fn().mockResolvedValue({
        ...closedHealth,
        state: 'open',
        failures: 3,
        nextProbeMs: Date.now() + 60_000,
        reason: 'Target closed',
      }),
    })
    const runner = makeRunner({ db, tasks: new Map([['window-fail', new WindowFailTask()]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'window-fail' }], { keepWindowOpen: true })
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(db.incrementWindowUsage).not.toHaveBeenCalled()
  })

  it('keep-open 但 CDP 连接失败：仍按原逻辑关窗', async () => {
    const db = makeDb()
    const runner = makeRunner({ db, driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('连接被拒绝')) }) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }], { keepWindowOpen: true })
    expect(statuses(db)).toEqual(['pending', 'failed'])
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
    expect(db.incrementWindowUsage).not.toHaveBeenCalled()
  })

  it('keep-open 复用已开窗口：不关窗但仍累加窗口使用次数', async () => {
    const db = makeDb()
    const reuseOpen = vi.fn().mockResolvedValue({ http: '127.0.0.1:61234' })
    const runner = makeRunner({ db, reuseOpen })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }], { keepWindowOpen: true })
    expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
    expect(bitbrowser.closeBrowser).not.toHaveBeenCalled()
    expect(db.incrementWindowUsage).toHaveBeenCalledWith('bb-1')
  })

  it('closePoolWindow 经串行队列关窗、等待 pids 消失并清登记', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb()
      const bb2 = {
        ...bitbrowser,
        openPids: vi.fn().mockResolvedValueOnce(new Set(['bb-1'])).mockResolvedValue(new Set<string>()),
      }
      const queue = new SerialQueue(0)
      const runSpy = vi.spyOn(queue, 'run')
      const runner = makeRunner({ db, bitbrowser: bb2, openCloseQueue: queue })
      const p = runner.closePoolWindow(makeProfile(), '池轮转')
      await vi.advanceTimersByTimeAsync(1000)
      await p
      expect(runSpy).toHaveBeenCalledWith(expect.any(Function), { cooldown: false })
      expect(bb2.closeBrowser).toHaveBeenCalledWith('bb-1')
      expect(bb2.openPids).toHaveBeenCalledTimes(2)
      expect(db.setWindowState).toHaveBeenCalledWith('bb-1', 'closing')
      expect(db.clearOpenWindow).toHaveBeenCalledWith('bb-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('closePoolWindow pids 确认超时：保留登记待对账', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb()
      const bb2 = { ...bitbrowser, openPids: vi.fn().mockResolvedValue(new Set(['bb-1'])) }
      const runner = makeRunner({ db, bitbrowser: bb2 })
      const p = runner.closePoolWindow(makeProfile(), '池轮转')
      await vi.advanceTimersByTimeAsync(30_000)
      await p
      expect(bb2.closeBrowser).toHaveBeenCalledWith('bb-1')
      expect(db.clearOpenWindow).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('新轮次使用 nextRunSlot（终态行后开新轮），续跑沿用原 slot', async () => {
    const db = makeDb()
    const getLatestRun = db.getLatestRun as ReturnType<typeof vi.fn>
    getLatestRun.mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 2 } as Partial<RunRow>)
    const runner = makeRunner({ db, tasks: new Map([['t', new FailTask()]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 't' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.every(c => c[3] === 2)).toBe(true) // 续跑沿用 slot=2
    expect(db.nextRunSlot).not.toHaveBeenCalled()
  })

  it('终态行后开新轮：slot 取 nextRunSlot 返回值', async () => {
    const db = makeDb()
    const getLatestRun = db.getLatestRun as ReturnType<typeof vi.fn>
    const nextRunSlot = db.nextRunSlot as ReturnType<typeof vi.fn>
    getLatestRun.mockResolvedValue({ status: 'success', attempts: 1, slot: 1 } as Partial<RunRow>)
    nextRunSlot.mockResolvedValue(2)
    const runner = makeRunner({ db, tasks: new Map([['ok-task', new OkTask()]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.every(c => c[3] === 2)).toBe(true) // 新轮次沿用 nextRunSlot 计算出的 slot=2
    expect(nextRunSlot).toHaveBeenCalledWith(1, 'ok-task', expect.any(String))
  })

  it('WalletSession 注入任务：扩展缺失时任务快速失败（错误提示重启窗口）', async () => {
    const db = makeDb()
    // fake 页面：provider 缺失（evaluate 恒 false）、CDP 探测失败（newCDPSession reject）、
    // waitForTimeout 立即返回——完整探测路径在 mock 下瞬时完成
    const page = {
      ...okPage,
      evaluate: vi.fn().mockResolvedValue(false),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      context: () => ({ newCDPSession: vi.fn().mockRejectedValue(new Error('no extension')) }),
    }
    const wallets = new WalletRegistry()
    wallets.register(new MetaMaskAdapter())
    const task = new WalletProbeTask()
    const runner = makeRunner({
      db,
      wallets,
      tasks: new Map([['wallet-probe', task]]),
      driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }),
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'wallet-probe' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map(c => c[4])).toEqual(['pending', 'running', 'retry_wait'])
    expect(String(calls[2][5].error)).toContain('钱包扩展未加载')
    expect(task.run).toHaveBeenCalledTimes(1)
  })

  it('会话开始前已请求停止：不开窗、不跑任务、不重试', async () => {
    const db = makeDb()
    const task = new OkTask()
    const reg = new CancelRegistry()
    reg.request(1, 'ok-task')
    const runner = makeRunner({ db, tasks: new Map([['ok-task', task]]), cancelRegistry: reg })
    const results = await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
    expect(task.run).not.toHaveBeenCalled()
    // 已认领 pending 行必须就地结算，不能只清标记留下孤儿行
    expect(results.get('ok-task')?.status).toBe('skipped')
    expect(results.get('ok-task')?.failureKind).toBe('stopped')
    expect(reg.isCancelled(1, 'ok-task')).toBe(false)
  })

  it('运行中被停止（关窗打断）：落 skipped、不重试、不计熔断', async () => {
    const db = makeDb()
    const reg = new CancelRegistry()
    class AbortTask implements SiteTask {
      meta = { key: 'abort-task', name: 'A', url: 'https://x.io' }
      run = vi.fn(async () => {
        reg.request(1, 'abort-task')
        throw new Error('Target closed')
      })
    }
    const runner = makeRunner({
      db,
      tasks: new Map([['abort-task', new AbortTask()]]),
      cancelRegistry: reg,
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'abort-task' }])
    expect(statuses(db)).toContain('skipped')
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
    expect(reg.isCancelled(1, 'abort-task')).toBe(false)
  })

  it('停止落在开窗阶段（开窗失败）：标记被终端结算清理，不残留', async () => {
    const db = makeDb()
    const reg = new CancelRegistry()
    const bb2 = {
      openBrowser: vi.fn(async () => { reg.request(1, 'ok-task'); throw new Error('open boom') }),
      closeBrowser: vi.fn().mockResolvedValue(undefined),
      listBrowsers: vi.fn().mockResolvedValue([]),
    }
    const runner = makeRunner({ db, bitbrowser: bb2 as never, tasks: new Map([['ok-task', new OkTask()]]), cancelRegistry: reg })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(reg.isCancelled(1, 'ok-task')).toBe(false)
  })

  it('停止落在开窗期间（开窗成功但已请求停止）：不执行任务、落 skipped、清标记', async () => {
    const db = makeDb()
    const reg = new CancelRegistry()
    const task = new OkTask()
    const bb2 = {
      openBrowser: vi.fn(async () => {
        reg.request(1, 'ok-task')
        return open
      }),
      closeBrowser: vi.fn().mockResolvedValue(undefined),
      listBrowsers: vi.fn().mockResolvedValue([]),
    }
    const runner = makeRunner({ db, bitbrowser: bb2 as never, tasks: new Map([['ok-task', task]]), cancelRegistry: reg })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(task.run).not.toHaveBeenCalled()
    expect(reg.isCancelled(1, 'ok-task')).toBe(false)
  })

  it('停止落在成功路径：任务正常结束仍清理取消标记', async () => {
    const db = makeDb()
    const reg = new CancelRegistry()
    class SuccessFlagTask implements SiteTask {
      meta = { key: 'ok-task', name: 'OK', url: 'https://x.io' }
      run = vi.fn(async () => { reg.request(1, 'ok-task') })
    }
    const runner = makeRunner({ db, tasks: new Map([['ok-task', new SuccessFlagTask()]]), cancelRegistry: reg })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(reg.isCancelled(1, 'ok-task')).toBe(false)
    expect(statuses(db)).toContain('success')
  })

  it('停止任务 B 时任务 A 因关窗 Target closed：A/剩余任务均按 stopped 结算且不计熔断', async () => {
    const db = makeDb()
    const reg = new CancelRegistry()
    class StoppedDuringRunTask implements SiteTask {
      meta = { key: 'a-task', name: 'A', url: 'https://x.io' }
      run = vi.fn(async () => {
        // 模拟 TaskStopper.stop(profile, 'b-task')：置会话级 + 任务级标记后关窗
        reg.request(1, 'b-task')
        reg.requestSession(1)
        throw new Error('Target closed')
      })
    }
    const a = new StoppedDuringRunTask()
    const b = new OkTask()
    const c = new OkTask()
    const runner = makeRunner({
      db,
      tasks: new Map([['a-task', a], ['b-task', b], ['c-task', c]]),
      cancelRegistry: reg,
    })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'a-task' }, { taskKey: 'b-task' }, { taskKey: 'c-task' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    const byTask = (key: string) => calls.filter((call) => call[1] === key).at(-1)!
    const aRow = byTask('a-task')
    expect(aRow[4]).toBe('skipped')
    expect(aRow[5]).toMatchObject({ error: '手动停止', failureKind: 'stopped' })
    expect(byTask('b-task')[5]).toMatchObject({ error: '手动停止', failureKind: 'stopped' })
    expect(byTask('c-task')[5]).toMatchObject({ error: '手动停止', failureKind: 'stopped' })
    expect(b.run).not.toHaveBeenCalled()
    expect(c.run).not.toHaveBeenCalled()
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
    // 会话标记在 finally 清理，不泄漏到下一次会话
    expect(reg.isSessionCancelled(1)).toBe(false)
  })

  it('会话开始前已置会话停止标记：不开窗、全部 skipped/stopped、清标记', async () => {
    const db = makeDb()
    const task = new OkTask()
    const reg = new CancelRegistry()
    reg.requestSession(1)
    const runner = makeRunner({ db, tasks: new Map([['ok-task', task]]), cancelRegistry: reg })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
    expect(task.run).not.toHaveBeenCalled()
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][4]).toBe('skipped')
    expect(calls[0][5]).toMatchObject({ error: '手动停止', failureKind: 'stopped' })
    expect(reg.isSessionCancelled(1)).toBe(false)
  })

  it('停止发生在开窗失败阶段：不记环境失败，全部 skipped/stopped', async () => {
    const db = makeDb()
    const reg = new CancelRegistry()
    const bb2 = {
      openBrowser: vi.fn(async () => { reg.requestSession(1); throw new Error('open boom') }),
      closeBrowser: vi.fn().mockResolvedValue(undefined),
      listBrowsers: vi.fn().mockResolvedValue([]),
    }
    const runner = makeRunner({ db, bitbrowser: bb2 as never, tasks: new Map([['ok-task', new OkTask()]]), cancelRegistry: reg })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.at(-1)![4]).toBe('skipped')
    expect(calls.at(-1)![5]).toMatchObject({ error: '手动停止', failureKind: 'stopped' })
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
    expect(reg.isSessionCancelled(1)).toBe(false)
  })

  it('停止发生在 CDP 连接失败阶段：不记环境失败，全部 skipped/stopped', async () => {
    const db = makeDb()
    const reg = new CancelRegistry()
    const driver = makeDriver({ connect: vi.fn(async () => { reg.requestSession(1); throw new Error('connect boom') }) })
    const runner = makeRunner({ db, driver, tasks: new Map([['ok-task', new OkTask()]]), cancelRegistry: reg })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.at(-1)![4]).toBe('skipped')
    expect(calls.at(-1)![5]).toMatchObject({ error: '手动停止', failureKind: 'stopped' })
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
    expect(reg.isSessionCancelled(1)).toBe(false)
  })

  it('open 且未到探测时间：不开窗，任务落 skipped', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({
        ...closedHealth,
        state: 'open',
        failures: 2,
        nextProbeMs: Date.now() + 60_000,
        reason: 'CDP 连接失败',
      }),
    })
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.at(-1)![4]).toBe('skipped')
    expect(calls.at(-1)![5].failureKind).toBe('breaker')
    expect(String(calls.at(-1)![5].error)).toContain('下次探测')
  })

  it('open 到期：抢占 half_open 并执行探测任务，成功后关闭熔断', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({
        ...closedHealth,
        state: 'open',
        failures: 2,
        nextProbeMs: Date.now() - 1,
        reason: 'CDP 连接失败',
      }),
    })
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(db.claimWindowProbe).toHaveBeenCalled()
    expect(db.recordWindowSuccess).toHaveBeenCalled()
    expect(bitbrowser.openBrowser).toHaveBeenCalled()
  })

  it('closed 下任务失败不计熔断；环境终态失败才计', async () => {
    const db = makeDb()
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()

    class WindowFailTask implements SiteTask {
      meta = { key: 'window-fail', name: 'WF', url: 'https://x.io' }
      run = vi.fn().mockRejectedValue(new Error('Target closed'))
    }
    const db2 = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>),
      recordWindowEnvironmentFailure: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() + 60_000, reason: 'Target closed' }),
    })
    const runner2 = makeRunner({ db: db2, tasks: new Map([['window-fail', new WindowFailTask()]]) })
    await runner2.runWindowTasks(makeProfile(), [{ taskKey: 'window-fail' }])
    expect(db2.recordWindowEnvironmentFailure).toHaveBeenCalled()
  })

  it('half_open 环境失败进入 retry_wait：保持 half_open、释放 retry 租约、剩余任务跳过', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'half_open', failures: 2, reason: 'Target closed' }),
    })
    class WindowFailTask implements SiteTask {
      meta = { key: 'window-fail', name: 'WF', url: 'https://x.io' }
      run = vi.fn().mockRejectedValue(new Error('Target closed'))
    }
    const ok = new OkTask()
    const runner = makeRunner({ db, tasks: new Map([['window-fail', new WindowFailTask()], ['ok-task', ok]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'window-fail' }, { taskKey: 'ok-task' }])
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
    expect(db.releaseWindowProbe).toHaveBeenCalledWith(1, 'retry')
    expect(ok.run).not.toHaveBeenCalled()
  })

  it('half_open 任务级失败视为窗口可用，关闭熔断', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'half_open', failures: 2 }),
    })
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(db.recordWindowSuccess).toHaveBeenCalled()
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
  })

  it('half_open 环境终态失败：打开熔断并跳过剩余任务', async () => {
    class WindowFailTask implements SiteTask {
      meta = { key: 'window-fail', name: 'WF', url: 'https://x.io' }
      run = vi.fn().mockRejectedValue(new Error('Target closed'))
    }
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'half_open', failures: 2 }),
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>),
      recordWindowEnvironmentFailure: vi.fn().mockResolvedValue({
        ...closedHealth,
        state: 'open',
        failures: 3,
        nextProbeMs: Date.now() + 60_000,
        reason: 'Target closed',
      }),
    })
    const ok = new OkTask()
    const runner = makeRunner({ db, tasks: new Map([['window-fail', new WindowFailTask()], ['ok-task', ok]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'window-fail' }, { taskKey: 'ok-task' }])
    expect(db.recordWindowEnvironmentFailure).toHaveBeenCalled()
    expect(ok.run).not.toHaveBeenCalled()
  })

  it('开窗失败：全局健康时记环境失败；全局不健康时不记', async () => {
    const unhealthyDb = makeDb()
    const unhealthyBb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')), health: vi.fn().mockResolvedValue(false) }
    const runner1 = makeRunner({ db: unhealthyDb, bitbrowser: unhealthyBb })
    await runner1.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(unhealthyDb.recordWindowEnvironmentFailure).not.toHaveBeenCalled()

    const healthyDb = makeDb()
    const healthyBb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')), health: vi.fn().mockResolvedValue(true) }
    const runner2 = makeRunner({ db: healthyDb, bitbrowser: healthyBb })
    await runner2.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(healthyDb.recordWindowEnvironmentFailure).toHaveBeenCalled()
  })

  it('FORCE_BREAKER=1 绕过 open 拦截', async () => {
    process.env.FORCE_BREAKER = '1'
    try {
      const db = makeDb({
        getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() + 60_000 }),
      })
      const runner = makeRunner({ db })
      await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
      expect(bitbrowser.openBrowser).toHaveBeenCalled()
    } finally {
      delete process.env.FORCE_BREAKER
    }
  })

  it('探测抢占失败：全部 skipped/breaker，不开窗', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() - 1, reason: 'CDP 连接失败' }),
      claimWindowProbe: vi.fn().mockResolvedValue(false),
    })
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bitbrowser.openBrowser).not.toHaveBeenCalled()
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.at(-1)![4]).toBe('skipped')
    expect(calls.at(-1)![5].failureKind).toBe('breaker')
  })

  it('抢占后开窗失败：恰好释放一次 aborted 探测租约', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() - 1 }),
      claimWindowProbe: vi.fn().mockResolvedValue(true),
    })
    const bb2 = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('open boom')) }
    const runner = makeRunner({ db, bitbrowser: bb2 })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const aborted = (db.releaseWindowProbe as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === 'aborted')
    expect(aborted).toHaveLength(1)
  })

  it('抢占后 CDP 失败：恰好释放一次 aborted 探测租约', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() - 1 }),
      claimWindowProbe: vi.fn().mockResolvedValue(true),
    })
    const driver = makeDriver({ connect: vi.fn().mockRejectedValue(new Error('connect boom')) })
    const runner = makeRunner({ db, driver })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    const aborted = (db.releaseWindowProbe as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === 'aborted')
    expect(aborted).toHaveLength(1)
  })

  it('抢占后正常成功：关闭熔断且不释放 aborted 租约', async () => {
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() - 1 }),
      claimWindowProbe: vi.fn().mockResolvedValue(true),
    })
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(db.recordWindowSuccess).toHaveBeenCalled()
    const aborted = (db.releaseWindowProbe as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === 'aborted')
    expect(aborted).toHaveLength(0)
  })

  it('circuitBreakerEnabled=false：raw open 不拦截、不计数', async () => {
    const disabledCfg = {
      ...(cfg as unknown as Record<string, unknown>),
      execution: { ...((cfg as unknown as Record<string, unknown>).execution as Record<string, unknown>), circuitBreakerEnabled: false },
    } as never
    const db = makeDb({
      getWindowHealth: vi.fn().mockResolvedValue({ ...closedHealth, state: 'open', failures: 2, nextProbeMs: Date.now() + 60_000 }),
    })
    const bb2 = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('open boom')) }
    const runner = makeRunner({ db, cfgOver: disabledCfg, bitbrowser: bb2 })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bb2.openBrowser).toHaveBeenCalled()
    expect(db.claimWindowProbe).not.toHaveBeenCalled()
    expect(db.recordWindowEnvironmentFailure).not.toHaveBeenCalled()
  })
})

describe('批次透传与 pending 预写', () => {
  /** 有状态内存假库：getLatestRun/nextRunSlot/upsertRun 联动并模拟 ON CONFLICT COALESCE 语义，供批次透传用例断言 */
  function makeFakeDb(): AppDb {
    const rows: RunRow[] = []
    const db = {
      createBatch: async (kind: string, taskKey: string, source: string) => ({
        id: 1,
        kind: kind as 'bulk' | 'single',
        taskKey,
        source,
        createdAt: `${todayStr()} 09:00:00.000`,
      }),
      getLatestRun: async (profileId: number, taskKey: string, date: string) => {
        const matched = rows.filter(r => r.profileId === profileId && r.taskKey === taskKey && r.date === date)
        return matched.length > 0 ? matched[matched.length - 1] : null
      },
      nextRunSlot: async (profileId: number, taskKey: string, date: string) => {
        const matched = rows.filter(r => r.profileId === profileId && r.taskKey === taskKey && r.date === date)
        return matched.length > 0 ? Math.max(...matched.map(r => r.slot)) + 1 : 0
      },
      upsertRun: async (profileId: number, taskKey: string, date: string, slot: number, status: string, patch: Partial<RunRow> = {}) => {
        const idx = rows.findIndex(r => r.profileId === profileId && r.taskKey === taskKey && r.date === date && r.slot === slot)
        const base: RunRow = idx >= 0 ? rows[idx] : {
          id: rows.length + 1,
          profileId,
          taskKey,
          date,
          slot,
          batchId: null,
          diagPath: null,
          bitbrowserId: 'bb-1',
          status: status as RunRow['status'],
          attempts: 0,
          error: null,
          screenshot: null,
          startedAt: null,
          finishedAt: null,
          profileName: '窗口1',
          failureKind: null,
        }
        const merged: RunRow = {
          ...base,
          status: status as RunRow['status'],
          attempts: patch.attempts && patch.attempts > 0 ? patch.attempts : base.attempts,
          error: patch.error ?? base.error,
          screenshot: patch.screenshot ?? base.screenshot,
          startedAt: patch.startedAt ?? base.startedAt,
          finishedAt: patch.finishedAt ?? base.finishedAt,
          batchId: patch.batchId ?? base.batchId,
          failureKind: patch.failureKind ?? base.failureKind,
        }
        if (idx >= 0) rows[idx] = merged
        else rows.push(merged)
        return merged
      },
      getWindowHealth: async () => closedHealth,
      claimWindowProbe: async () => true,
      releaseWindowProbe: async () => undefined,
      resetWindowHealth: async () => undefined,
      recordWindowEnvironmentFailure: async () => closedHealth,
      recordWindowSuccess: async () => closedHealth,
      clearRunDiag: async () => undefined,
      listProfiles: async () => [] as ProfileRow[],
      reserveOpenWindow: async () => undefined,
      setOpenWindow: async () => undefined,
      setWindowState: async () => undefined,
      clearOpenWindow: async () => undefined,
      listOpenWindows: async () => [],
    }
    // 条件更新：仅 running 行可被结算；否则返回当前行（可能是 stop 写入的 skipped）
    Object.assign(db, {
      updateRunIfRunning: async (profileId: number, taskKey: string, date: string, slot: number, status: string, patch: Partial<RunRow> = {}) => {
        const existing = rows.find(r => r.profileId === profileId && r.taskKey === taskKey && r.date === date && r.slot === slot)
        if (!existing || existing.status !== 'running') return existing ?? null
        return db.upsertRun(profileId, taskKey, date, slot, status, patch)
      },
    })
    return db as unknown as AppDb
  }

  it('新轮次会话启动时预写 pending 行并带 batchId', async () => {
    const db = makeFakeDb()
    const b = await db.createBatch('bulk', 'ok-task', 'trigger-all')
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task', batchId: b.id }])
    const row = await db.getLatestRun(1, 'ok-task', todayStr())
    expect(row?.batchId).toBe(b.id)
    expect(row?.status).toBe('success')
  })

  it('开窗失败时预写的 pending 行被结算为 skipped 且沿用 batchId', async () => {
    const db = makeFakeDb()
    const b = await db.createBatch('bulk', 't', 'trigger-all')
    const runner = new WindowRunner({ cfg, db, bitbrowser: { openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) } as never, driver: makeDriver(), tasks: new Map(), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 't', batchId: b.id }])
    const row = await db.getLatestRun(1, 't', todayStr())
    expect(row?.status).toBe('skipped')
    expect(row?.batchId).toBe(b.id)
    expect(row?.error).toContain('开窗失败')
  })

  it('retry_wait 续跑不预写新行、沿用原 batchId', async () => {
    const db = makeFakeDb()
    const b = await db.createBatch('bulk', 'fail-task', 'trigger-all')
    const first = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['fail-task', new FailTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords })
    await first.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task', batchId: b.id }])
    // 第二次会话（重试恢复，不带 batchId）→ 续跑同一 slot，batchId 沿用
    await first.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    const row = await db.getLatestRun(1, 'fail-task', todayStr())
    expect(row?.batchId).toBe(b.id)
    expect(row?.attempts).toBe(2)
  })

  it('未注册任务就地结算预写 pending 行（沿用 slot 与 batchId，不留孤儿行）', async () => {
    const db = makeFakeDb()
    const b = await db.createBatch('bulk', 'ghost-task', 'trigger-all')
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map(), wallets: null as never, logger, artifactsDir, walletPasswords })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ghost-task', batchId: b.id }])
    const row = await db.getLatestRun(1, 'ghost-task', todayStr())
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('任务未注册')
    // 预写 pending 行就地结算：批次归属保留（COALESCE），不归入未分批
    expect(row?.batchId).toBe(b.id)
  })

  it('未注册任务无预写行时兜底新轮次落 failed（nextRunSlot，行为同旧）', async () => {
    const db = makeDb({ nextRunSlot: vi.fn().mockResolvedValue(3) })
    const runner = makeRunner({ db, tasks: new Map() })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ghost-task' }])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map((c) => c[4])).toEqual(['pending', 'failed'])
    expect(calls[1][3]).toBe(3) // 兜底按 nextRunSlot 新开轮（无预写可结算时）
    expect(String(calls[1][5].error)).toBe('任务未注册: ghost-task')
    expect(db.nextRunSlot).toHaveBeenCalled()
  })
})

describe('WindowRunner 开窗失败兜底关窗', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const cfgObj = cfg as unknown as { execution: Record<string, unknown>; bitbrowser: Record<string, unknown> }

  it('开窗耗尽：延迟 90s 兜底补关一次，清理可能半开的窗口', async () => {
    vi.useFakeTimers()
    try {
      const bbFake = {
        openBrowser: vi.fn().mockRejectedValue(new Error('请求失败: The operation was aborted due to timeout')),
        closeBrowser: vi.fn().mockResolvedValue(undefined),
        openPids: vi.fn().mockResolvedValue(new Set<string>()),
      }
      const queue = new SerialQueue(0)
      const runSpy = vi.spyOn(queue, 'run')
      const runner = new WindowRunner({
        cfg: { ...cfgObj, bitbrowser: { ...cfgObj.bitbrowser, maxRetries: 1 } } as never,
        db: makeDb(), bitbrowser: bbFake as never, driver: makeDriver(),
        tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, logger, artifactsDir, walletPasswords,
        openCloseQueue: queue,
      })
      await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
      const closesAfterFail = bbFake.closeBrowser.mock.calls.length // 开窗重试前清理
      await vi.advanceTimersByTimeAsync(90000)
      expect(bbFake.closeBrowser.mock.calls.length).toBe(closesAfterFail + 1)
      // 开窗失败后的清理与延迟兜底关窗都不应等待开窗冷却
      expect(runSpy.mock.calls[0][1]).toBeUndefined()
      expect(runSpy.mock.calls.slice(1).every((call) => (call[1] as { cooldown?: boolean } | undefined)?.cooldown === false)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 端到端交接：真实 AppDb（临时文件）+ 真实 WindowRunner + 假驱动/比特浏览器，
 * 覆盖 dispatcher 认领后的行生命周期（不重复 slot、取消标记不再留下 running 孤儿）
 */
describe('runs 即队列端到端交接', () => {
  let dir: string
  let realDb: AppDb

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'abc-rq-handoff-'))
    realDb = await AppDb.open(`file:${join(dir, 'handoff.db').split('\\').join('/')}`)
  })
  afterEach(() => {
    realDb.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 下 libsql 句柄可能延迟释放，best-effort 清理
    }
  })

  it('enqueue → claim → runWindowTasks 落 success，且不产生重复 slot', async () => {
    const profile = await realDb.upsertProfile('bb-1', '窗口1')
    const date = todayStr()
    const queued = await realDb.enqueueRun(profile.id, 'ok-task', date, null, Date.now())
    const claimed = await realDb.claimQueuedRuns([queued.id], Date.now())
    expect(claimed).toHaveLength(1)

    const task = new OkTask()
    const runner = makeRunner({ db: realDb, tasks: new Map([['ok-task', task]]) })
    await runner.runWindowTasks(profile, claimed.map((r) => ({ taskKey: r.taskKey, date: r.date })))

    const rows = await realDb.listRunsForDate(date)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('success')
    expect(task.run).toHaveBeenCalledTimes(1)
  })

  it('已认领 running 行 + 任务取消标记：会话启动时结算 skipped，不残留 running', async () => {
    const profile = await realDb.upsertProfile('bb-1', '窗口1')
    const date = todayStr()
    const queued = await realDb.enqueueRun(profile.id, 'ok-task', date, null, Date.now())
    const claimed = await realDb.claimQueuedRuns([queued.id], Date.now())
    expect(claimed[0].status).toBe('running')

    const registry = new CancelRegistry()
    registry.request(profile.id, 'ok-task')
    const task = new OkTask()
    const runner = makeRunner({ db: realDb, tasks: new Map([['ok-task', task]]), cancelRegistry: registry })
    await runner.runWindowTasks(profile, claimed.map((r) => ({ taskKey: r.taskKey, date: r.date })))

    const row = await realDb.getRun(profile.id, 'ok-task', date, claimed[0].slot)
    expect(row?.status).toBe('skipped')
    expect(row?.failureKind).toBe('stopped')
    expect(task.run).not.toHaveBeenCalled()
    expect(registry.isCancelled(profile.id, 'ok-task')).toBe(false)
  })

  it('任务运行中停止先结算 skipped：成功写入不覆盖 stop 结果', async () => {
    const profile = await realDb.upsertProfile('bb-1', '窗口1')
    const date = todayStr()
    const queued = await realDb.enqueueRun(profile.id, 'ok-task', date, null, Date.now())
    const claimed = await realDb.claimQueuedRuns([queued.id], Date.now())

    class StopWhileRunningTask implements SiteTask {
      meta = { key: 'ok-task', name: 'OK', url: 'https://x.io' }
      run = vi.fn(async () => {
        // 模拟 TaskStopper：任务仍返回成功，但 stop 已把 running 行结算为 skipped
        await realDb.stopRunningRun(profile.id, 'ok-task', date, claimed[0].slot)
      })
    }
    const task = new StopWhileRunningTask()
    const runner = makeRunner({ db: realDb, tasks: new Map([['ok-task', task]]) })
    const results = await runner.runWindowTasks(profile, claimed.map((r) => ({ taskKey: r.taskKey, date: r.date })))

    const row = await realDb.getRun(profile.id, 'ok-task', date, claimed[0].slot)
    expect(row?.status).toBe('skipped')
    expect(row?.failureKind).toBe('stopped')
    expect(results.get('ok-task')?.status).toBe('skipped')
    expect(task.run).toHaveBeenCalledTimes(1)
  })

  it('最新行已是 stopped skipped：重复结算不新开 slot', async () => {
    const profile = await realDb.upsertProfile('bb-1', '窗口1')
    const date = todayStr()
    await realDb.upsertRun(profile.id, 'ok-task', date, 0, 'skipped', { error: '手动停止', failureKind: 'stopped', finishedAt: '2026-10-20 10:00:00.000' })

    const registry = new CancelRegistry()
    registry.requestSession(profile.id)
    const runner = makeRunner({ db: realDb, tasks: new Map([['ok-task', new OkTask()]]), cancelRegistry: registry })
    const results = await runner.runWindowTasks(profile, [{ taskKey: 'ok-task' }])

    const rows = await realDb.listRunsForDate(date)
    expect(rows).toHaveLength(1)
    expect(rows[0].slot).toBe(0)
    expect(results.get('ok-task')?.status).toBe('skipped')
  })
})

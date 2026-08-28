import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowRunner, type BrowserDriver } from '../src/engine/window-runner'
import type { AppDb, ProfileRow, RunRow } from '../src/infrastructure/db'
import type { SiteTask } from '../src/tasks/base'

function makeProfile(over: Partial<ProfileRow> = {}): ProfileRow {
  return { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0, ...over }
}

function makeDb(over: Partial<Record<keyof AppDb, unknown>> = {}): AppDb {
  return {
    upsertRun: vi.fn(),
    resetCircuitBreaker: vi.fn(),
    incrCircuitBreaker: vi.fn(),
    listProfiles: vi.fn().mockReturnValue([]),
    getRun: vi.fn().mockReturnValue(null),
    ...over,
  } as unknown as AppDb
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
}

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
const cfg = {
  bitbrowser: { apiBase: '', openTimeoutMs: 0, maxRetries: 3, retryBackoffMs: [0, 0, 0] },
  execution: { probeUrl: 'https://probe.io', taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 60000 },
} as never
const artifactsDir = join(tmpdir(), 'abc-window-runner-artifacts')
const walletPasswords: Record<string, string> = {}
const scheduleRetry = vi.fn()

function makeRunner(over: { db?: AppDb; driver?: BrowserDriver; tasks?: Map<string, SiteTask>; cfgOver?: never }) {
  return new WindowRunner({
    cfg: over.cfgOver ?? cfg,
    db: over.db ?? makeDb(),
    bitbrowser: bitbrowser as never,
    driver: over.driver ?? makeDriver(),
    tasks: over.tasks ?? new Map([['ok-task', new OkTask()]]),
    wallets: null as never,
    captcha: null as never,
    logger,
    artifactsDir,
    walletPasswords,
    scheduleRetry,
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

/** 提取 upsertRun 调用序列的状态列 */
function statuses(db: AppDb): string[] {
  return (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
}

describe('WindowRunner', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('任务成功后写 success 并关窗', async () => {
    const db = makeDb()
    const runner = makeRunner({ db })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    expect(statuses(db)).toContain('success')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('任务失败进入 retry_wait 并调度重试（不占窗）', async () => {
    const db = makeDb()
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), ['fail-task'])
    // 单窗口会话内每任务只跑一次：失败后 retry_wait 立即返回，重试交给 scheduleRetry
    expect(statuses(db)).toEqual(['running', 'retry_wait'])
    expect(task.run).toHaveBeenCalledTimes(1)
    expect(scheduleRetry).toHaveBeenCalledTimes(1)
    expect(scheduleRetry.mock.calls[0][0].bitbrowserId).toBe('bb-1')
    expect(scheduleRetry.mock.calls[0][1]).toBe('fail-task')
    expect(scheduleRetry.mock.calls[0][2]).toBe(0)
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('重试会话从上次 attempts 继续并先复位页面', async () => {
    const db = makeDb({
      getRun: vi.fn().mockReturnValue({ status: 'retry_wait', attempts: 1 } as Partial<RunRow>),
    })
    const task = new FailTask()
    const page = { ...okPage, goto: vi.fn().mockResolvedValue(undefined) }
    const runner = makeRunner({
      db,
      tasks: new Map([['fail-task', task]]),
      driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }),
    })
    await runner.runWindowTasks(makeProfile(), ['fail-task'])
    expect(statuses(db)).toEqual(['running', 'retry_wait'])
    // attempts 从上次的 1 续到 2（重试上限跨会话生效）
    const runningCall = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.find(c => c[3] === 'running')
    expect(runningCall![4].attempts).toBe(2)
    // 重试前页面复位 about:blank，且发生在任务执行之前
    const blankIdx = page.goto.mock.calls.findIndex(c => c[0] === 'about:blank')
    expect(blankIdx).toBeGreaterThanOrEqual(0)
    expect(page.goto.mock.calls[blankIdx][1]).toEqual({ timeout: 10000 })
    expect(page.goto.mock.invocationCallOrder[blankIdx]).toBeLessThan(task.run.mock.invocationCallOrder[0])
    expect(scheduleRetry).toHaveBeenCalledTimes(1)
  })

  it('最后一次尝试失败标记 failed 且不再调度重试', async () => {
    const db = makeDb({
      getRun: vi.fn().mockReturnValue({ status: 'retry_wait', attempts: 2 } as Partial<RunRow>),
    })
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), ['fail-task'])
    expect(statuses(db)).toEqual(['running', 'failed'])
    expect(db.incrCircuitBreaker).toHaveBeenCalledWith(1)
    expect(scheduleRetry).not.toHaveBeenCalled()
  })

  it('开窗失败重试后跳过窗口', async () => {
    const db = makeDb()
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    expect(bb.openBrowser).toHaveBeenCalledTimes(3)
    expect(statuses(db)).toEqual(['skipped'])
  })

  it('IP 探活失败熔断所有任务', async () => {
    const db = makeDb()
    const page = { ...okPage, goto: vi.fn().mockRejectedValue(new Error('网络错误')) }
    const runner = makeRunner({ db, driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }) })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    expect(statuses(db)).toEqual(['skipped'])
  })

  it('CDP 连接失败标记 failed 且不抛异常', async () => {
    const db = makeDb()
    const runner = makeRunner({ db, driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('连接被拒绝')) }) })
    await expect(runner.runWindowTasks(makeProfile(), ['ok-task'])).resolves.toBeUndefined()
    expect(statuses(db)).toEqual(['failed'])
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('窗口超时后剩余任务全部标 skipped（窗口超时）', async () => {
    const db = makeDb()
    const ok1 = new OkTask()
    const ok2 = new OkTask()
    const cfgZero = {
      bitbrowser: { apiBase: '', openTimeoutMs: 0, maxRetries: 3, retryBackoffMs: [0, 0, 0] },
      execution: { probeUrl: 'https://probe.io', taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 0 },
    } as never
    const runner = new WindowRunner({ cfg: cfgZero, db, bitbrowser: bitbrowser as never, driver: makeDriver(), tasks: new Map([['ok-task', ok1], ['ok2', ok2]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), ['ok-task', 'ok2'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map(c => c[3])).toEqual(['skipped', 'skipped'])
    expect(calls.every(c => c[4].error === '窗口超时')).toBe(true)
    expect(ok1.run).not.toHaveBeenCalled()
    expect(ok2.run).not.toHaveBeenCalled()
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('CDP 连接 close 失败不影响关窗流程', async () => {
    const db = makeDb()
    const close = vi.fn().mockRejectedValue(new Error('close boom'))
    const runner = makeRunner({ db, driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page: okPage, close }) }) })
    await expect(runner.runWindowTasks(makeProfile(), ['ok-task'])).resolves.toBeUndefined()
    expect(close).toHaveBeenCalled()
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })
})

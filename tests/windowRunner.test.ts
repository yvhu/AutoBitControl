import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowRunner, type BrowserDriver } from '../src/engine/window-runner'
import type { AppDb, ProfileRow, RunRow } from '../src/infrastructure/db'
import type { SiteTask } from '../src/tasks/base'

function makeProfile(over: Partial<ProfileRow> = {}): ProfileRow {
  return { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 0, ...over }
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

class OkTask implements SiteTask {
  meta = { key: 'ok-task', name: 'OK', url: 'https://x.io' }
  run = vi.fn().mockResolvedValue(undefined)
}

class FailTask implements SiteTask {
  meta = { key: 'fail-task', name: 'FAIL', url: 'https://x.io' }
  run = vi.fn().mockRejectedValue(new Error('boom'))
}

describe('WindowRunner', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('任务成功后写 success 并关窗', async () => {
    const db = makeDb()
    const runner = new WindowRunner({ cfg, db, bitbrowser: bitbrowser as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toContain('success')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('任务失败重试后标记 failed', async () => {
    const db = makeDb()
    const runner = new WindowRunner({ cfg, db, bitbrowser: bitbrowser as never, driver: makeDriver(), tasks: new Map([['fail-task', new FailTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir })
    await runner.runWindowTasks(makeProfile(), ['fail-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toEqual(['running', 'retry_wait', 'running', 'retry_wait', 'running', 'failed'])
  })

  it('开窗失败重试后跳过窗口', async () => {
    const db = makeDb()
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    expect(bb.openBrowser).toHaveBeenCalledTimes(3)
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toEqual(['skipped'])
  })

  it('IP 探活失败熔断所有任务', async () => {
    const db = makeDb()
    const page = { ...okPage, goto: vi.fn().mockRejectedValue(new Error('网络错误')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bitbrowser as never, driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toEqual(['skipped'])
  })

  it('CDP 连接失败标记 failed 且不抛异常', async () => {
    const db = makeDb()
    const runner = new WindowRunner({ cfg, db, bitbrowser: bitbrowser as never, driver: makeDriver({ connect: vi.fn().mockRejectedValue(new Error('连接被拒绝')) }), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir })
    await expect(runner.runWindowTasks(makeProfile(), ['ok-task'])).resolves.toBeUndefined()
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toEqual(['failed'])
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })
})

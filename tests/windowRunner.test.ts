/**
 * window-runner 单测（注入假驱动，不连真库）
 * 文件顶部共享夹具：makeProfile/makeDb/okPage/makeDriver/bitbrowser(bb)/logger/cfg/artifactsDir/walletPasswords/scheduleRetry
 * 两个 describe：基础会话编排（mock db）+ 批次透传与 pending 预写（有状态内存假库）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowRunner, type BrowserDriver } from '../src/engine/window-runner'
import { todayStr, type AppDb, type ProfileRow, type RunRow } from '../src/infrastructure/db'
import { TaskContext, type SiteTask } from '../src/tasks/base'
import { WalletRegistry } from '../src/automation/wallet/types'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'

function makeProfile(over: Partial<ProfileRow> = {}): ProfileRow {
  return { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0, ...over }
}

function makeDb(over: Partial<Record<keyof AppDb, unknown>> = {}): AppDb {
  return {
    upsertRun: vi.fn().mockResolvedValue(null),
    resetCircuitBreaker: vi.fn().mockResolvedValue(undefined),
    incrCircuitBreaker: vi.fn().mockResolvedValue(0),
    listProfiles: vi.fn().mockResolvedValue([]),
    getLatestRun: vi.fn().mockResolvedValue(null),
    nextRunSlot: vi.fn().mockResolvedValue(0),
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
/** 共享比特浏览器假件别名（新增批次用例直接用 bb） */
const bb = bitbrowser

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
const cfg = {
  bitbrowser: { apiBase: '', openTimeoutMs: 0, maxRetries: 3, retryBackoffMs: [0, 0, 0] },
  execution: { taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 60000 },
} as never
const artifactsDir = join(tmpdir(), 'abc-window-runner-artifacts')
const walletPasswords: Record<string, string> = {}
const scheduleRetry = vi.fn()

function makeRunner(over: { db?: AppDb; driver?: BrowserDriver; tasks?: Map<string, SiteTask>; cfgOver?: never; reuseOpen?: (bitbrowserId: string) => Promise<{ http: string } | null>; wallets?: WalletRegistry }) {
  return new WindowRunner({
    cfg: over.cfgOver ?? cfg,
    db: over.db ?? makeDb(),
    bitbrowser: bitbrowser as never,
    driver: over.driver ?? makeDriver(),
    tasks: over.tasks ?? new Map([['ok-task', new OkTask()]]),
    wallets: over.wallets ?? (null as never),
    captcha: null as never,
    logger,
    artifactsDir,
    walletPasswords,
    scheduleRetry,
    reuseOpen: over.reuseOpen,
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

/** 钱包探针任务 fixture：run 内调用 ensureWalletReady，验证 WalletSession 注入链路 */
class WalletProbeTask implements SiteTask {
  meta = { key: 'wallet-probe', name: 'WP', url: 'https://x.io', wallet: 'metamask' }
  run = vi.fn(async (ctx: TaskContext) => { await ctx.ensureWalletReady() })
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

  it('任务失败进入 retry_wait 并调度重试（不占窗）', async () => {
    const db = makeDb()
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    // 单窗口会话内每任务只跑一次：失败后 retry_wait 立即返回，重试交给 scheduleRetry
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait'])
    expect(task.run).toHaveBeenCalledTimes(1)
    expect(scheduleRetry).toHaveBeenCalledTimes(1)
    expect(scheduleRetry.mock.calls[0][0].bitbrowserId).toBe('bb-1')
    expect(scheduleRetry.mock.calls[0][1]).toBe('fail-task')
    expect(scheduleRetry.mock.calls[0][2]).toBe(0)
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
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
    expect(scheduleRetry).toHaveBeenCalledTimes(1)
  })

  it('最后一次尝试失败标记 failed 且不再调度重试', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>),
    })
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['running', 'failed'])
    expect(db.incrCircuitBreaker).toHaveBeenCalledWith(1)
    expect(scheduleRetry).not.toHaveBeenCalled()
  })

  it('重试跨会话续算并最终 failed', async () => {
    const db = makeDb()
    const getLatestRun = db.getLatestRun as ReturnType<typeof vi.fn>
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    // 第 1 会话：无历史记录 → attempt=1 → retry_wait + scheduleRetry
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait'])
    expect(scheduleRetry).toHaveBeenCalledTimes(1)
    // 第 2 会话：上一轮 attempts=1 → 从 2 续跑 → 再 retry_wait + scheduleRetry
    getLatestRun.mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 0 } as Partial<RunRow>)
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait', 'running', 'retry_wait'])
    expect(scheduleRetry).toHaveBeenCalledTimes(2)
    // 第 3 会话：上一轮 attempts=2 → 从 3 续跑 → 达上限 failed 终态，不再调度
    getLatestRun.mockResolvedValue({ status: 'retry_wait', attempts: 2, slot: 0 } as Partial<RunRow>)
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    expect(statuses(db)).toEqual(['pending', 'running', 'retry_wait', 'running', 'retry_wait', 'running', 'failed'])
    expect(scheduleRetry).toHaveBeenCalledTimes(2)
    // 三次 running 的 attempts 依次 1/2/3（重试上限跨会话生效，共 3 次尝试）
    const runningAttempts = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
      .filter(c => c[4] === 'running').map(c => c[5].attempts)
    expect(runningAttempts).toEqual([1, 2, 3])
  })

  it('历史 attempts 已耗尽重试预算时直接 failed 且不调度重试', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 3, slot: 0 } as Partial<RunRow>),
    })
    const task = new FailTask()
    const runner = makeRunner({ db, tasks: new Map([['fail-task', task]]) })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    // retryMax=2 时预算为 3 次尝试，attempts=3 已耗尽：不跑任务、不进循环
    expect(statuses(db)).toEqual(['failed'])
    expect(task.run).not.toHaveBeenCalled()
    expect(scheduleRetry).not.toHaveBeenCalled()
    expect(db.incrCircuitBreaker).not.toHaveBeenCalled()
  })

  it('开窗失败重试后跳过窗口', async () => {
    const db = makeDb()
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task' }])
    expect(bb.openBrowser).toHaveBeenCalledTimes(3)
    expect(statuses(db)).toEqual(['pending', 'skipped'])
  })

  it('窗口级跳过结算待重试行：retry_wait 行沿用原 slot 落终态（不新开轮次）', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 3 } as Partial<RunRow>),
    })
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
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
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
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
    } as never
    const runner = new WindowRunner({ cfg: cfgZero, db, bitbrowser: bitbrowser as never, driver: makeDriver(), tasks: new Map([['ok-task', ok1], ['ok2', ok2]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
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
          bitbrowserId: 'bb-1',
          status: status as RunRow['status'],
          attempts: 0,
          error: null,
          screenshot: null,
          startedAt: null,
          finishedAt: null,
          profileName: '窗口1',
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
        }
        if (idx >= 0) rows[idx] = merged
        else rows.push(merged)
        return merged
      },
      resetCircuitBreaker: async () => undefined,
      incrCircuitBreaker: async () => 0,
      listProfiles: async () => [] as ProfileRow[],
    }
    return db as unknown as AppDb
  }

  it('新轮次会话启动时预写 pending 行并带 batchId', async () => {
    const db = makeFakeDb()
    const b = await db.createBatch('bulk', 'ok-task', 'trigger-all')
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task', batchId: b.id }])
    const row = await db.getLatestRun(1, 'ok-task', todayStr())
    expect(row?.batchId).toBe(b.id)
    expect(row?.status).toBe('success')
  })

  it('开窗失败时预写的 pending 行被结算为 skipped 且沿用 batchId', async () => {
    const db = makeFakeDb()
    const b = await db.createBatch('bulk', 't', 'trigger-all')
    const runner = new WindowRunner({ cfg, db, bitbrowser: { openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) } as never, driver: makeDriver(), tasks: new Map(), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 't', batchId: b.id }])
    const row = await db.getLatestRun(1, 't', todayStr())
    expect(row?.status).toBe('skipped')
    expect(row?.batchId).toBe(b.id)
    expect(row?.error).toContain('开窗失败')
  })

  it('retry_wait 续跑不预写新行、沿用原 batchId', async () => {
    const db = makeFakeDb()
    const b = await db.createBatch('bulk', 'fail-task', 'trigger-all')
    const first = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['fail-task', new FailTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await first.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task', batchId: b.id }])
    // 第二次会话（重试恢复，不带 batchId）→ 续跑同一 slot，batchId 沿用
    await first.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    const row = await db.getLatestRun(1, 'fail-task', todayStr())
    expect(row?.batchId).toBe(b.id)
    expect(row?.attempts).toBe(2)
  })
})

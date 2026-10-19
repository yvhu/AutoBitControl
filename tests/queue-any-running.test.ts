import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDb, localWallNow, todayStr, type ProfileRow } from '../src/infrastructure/db'
import { CoalescingEnqueuer, type SessionTask } from '../src/engine/queue'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const TERMINAL = ['success', 'failed', 'captcha_failed', 'skipped']

let db: AppDb
let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'abc-anyrun-'))
  db = await AppDb.open(`file:${join(dir, 'any.db').split('\\').join('/')}`)
})
afterEach(() => {
  db.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 下 libsql 句柄可能延迟释放，best-effort 清理
  }
})

/** 可控 runner：挂起直到 release，随后把任务行结算为成功，模拟会话结束 */
function makeRunner() {
  let release!: () => void
  const started = vi.fn()
  const gate = new Promise<void>((r) => { release = r })
  const runner = {
    runWindowTasks: vi.fn(async (profile: ProfileRow, tasks: SessionTask[]) => {
      started()
      await gate
      const date = todayStr()
      for (const t of tasks) {
        const row = await db.getLatestRun(profile.id, t.taskKey, date)
        if (!row || TERMINAL.includes(row.status)) continue
        await db.upsertRun(profile.id, t.taskKey, date, Number(row.slot), 'success', { finishedAt: localWallNow() })
      }
    }),
  }
  return { runner, started, release: () => release() }
}

describe('CoalescingEnqueuer.anyRunning', () => {
  it('无会话时 false', () => {
    const { runner } = makeRunner()
    const q = new CoalescingEnqueuer(db, runner, logger as never, () => 1, 0)
    expect(q.anyRunning()).toBe(false)
  })

  it('会话运行时 anyRunning=true，结束后 false', async () => {
    const { runner, started, release } = makeRunner()
    const q = new CoalescingEnqueuer(db, runner, logger as never, () => 1, 0)
    const p = await db.upsertProfile('bb-1', '窗口1')
    await q.enqueue(p, 'demo', { immediate: true })
    await q.tick()
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    expect(q.anyRunning()).toBe(true)
    release()
    await vi.waitFor(() => expect(q.anyRunning()).toBe(false))
    q.stop()
  })
})

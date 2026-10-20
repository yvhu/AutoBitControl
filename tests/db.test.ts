import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { AppDb, todayStr } from '../src/infrastructure/db'

let db: AppDb
// file::memory: 走 @libsql/client 本地引擎：测试无需凭据，每个用例独立空库
beforeEach(async () => { db = await AppDb.open('file::memory:') })
afterEach(() => { db.close() })

describe('AppDb', () => {
  it('upsertRun 插入后 getRun 可读回', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    await db.upsertRun(p.id, 'task-a', '2026-08-28', 0, 'running')
    const r = await db.getRun(p.id, 'task-a', '2026-08-28', 0)
    expect(r).not.toBeNull()
    expect(r!.status).toBe('running')
    expect(r!.attempts).toBe(0)
  })

  it('upsertRun 更新已有记录且不重复插入', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    await db.upsertRun(p.id, 'task-a', '2026-08-28', 0, 'running')
    await db.upsertRun(p.id, 'task-a', '2026-08-28', 0, 'success', { attempts: 1, error: null, screenshot: 's.png' })
    const list = await db.listRunsForDate('2026-08-28')
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('success')
    expect(list[0].attempts).toBe(1)
    expect(list[0].screenshot).toBe('s.png')
  })

  it('upsertRun 写入 diagPath 并可经 getRunById 取回', async () => {
    const p = await db.upsertProfile('bb-diag', '窗口')
    const row = await db.upsertRun(p.id, 'k', '2026-10-09', 0, 'failed', { error: 'e', diagPath: 'D:/x/diag.json' })
    expect(row.diagPath).toBe('D:/x/diag.json')
    const byId = await db.getRunById(row.id)
    expect(byId?.diagPath).toBe('D:/x/diag.json')
  })

  it('clearRunDiag 清空诊断路径（成功重试后不再残留失败包）', async () => {
    const p = await db.upsertProfile('bb-diag-clear', '窗口')
    const row = await db.upsertRun(p.id, 'k', '2026-10-09', 0, 'failed', { error: 'e', diagPath: 'D:/x/diag.json' })
    expect(row.diagPath).toBe('D:/x/diag.json')
    await db.clearRunDiag(p.id, 'k', '2026-10-09', 0)
    const after = await db.getRunById(row.id)
    expect(after?.diagPath).toBeNull()
    // 成功 upsert 因 COALESCE 不再写 diag_path：已被 clearRunDiag 清空后保持 null（不被旧值回填）
    const ok = await db.upsertRun(p.id, 'k', '2026-10-09', 0, 'success', { error: null })
    expect(ok.diagPath).toBeNull()
  })

  it('更新省略 attempts 时保留原值', async () => {
    const p = await db.upsertProfile('bb-1', 'A')
    await db.upsertRun(p.id, 't', '2026-08-28', 0, 'running', { attempts: 2 })
    await db.upsertRun(p.id, 't', '2026-08-28', 0, 'retry_wait')
    const r = await db.getRun(p.id, 't', '2026-08-28', 0)
    expect(r!.attempts).toBe(2)
  })

  it('listProfiles 过滤启用状态', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    await db.upsertProfile('bb-2', 'B')
    await db.setProfileEnabled(p1.id, false)
    const enabled = await db.listProfiles(true)
    expect(enabled.map(p => p.bitbrowserId)).toEqual(['bb-2'])
  })

  it('getTaskEnabled 无覆盖记录时返回 fallback', async () => {
    expect(await db.getTaskEnabled('task-a', true)).toBe(true)
    expect(await db.getTaskEnabled('task-a', false)).toBe(false)
  })

  it('setTaskEnabled 写入 false 后读回 false', async () => {
    await db.setTaskEnabled('task-a', false)
    expect(await db.getTaskEnabled('task-a', true)).toBe(false)
  })

  it('setTaskEnabled 改回 true 覆盖之前的值', async () => {
    await db.setTaskEnabled('task-a', false)
    await db.setTaskEnabled('task-a', true)
    expect(await db.getTaskEnabled('task-a', false)).toBe(true)
  })

  it('熔断计数递增与重置', async () => {
    const p = await db.upsertProfile('bb-1', 'A')
    expect(await db.incrCircuitBreaker(p.id)).toBe(1)
    expect(await db.incrCircuitBreaker(p.id)).toBe(2)
    await db.resetCircuitBreaker(p.id)
    expect(await db.incrCircuitBreaker(p.id)).toBe(1)
  })

  it('resetMeltedCircuitBreakers 归零所有 count>0 并返回数量', async () => {
    const p = await db.upsertProfile('bb-reset-1', 'w1')
    const q = await db.upsertProfile('bb-reset-2', 'w2')
    await db.incrCircuitBreaker(p.id)
    await db.incrCircuitBreaker(p.id)
    await db.incrCircuitBreaker(q.id)
    const n = await db.resetMeltedCircuitBreakers()
    expect(n).toBe(2)
    const after = (await db.listProfiles()).find((x) => x.id === p.id)
    expect(after?.circuitBreakerCount).toBe(0)
    const afterQ = (await db.listProfiles()).find((x) => x.id === q.id)
    expect(afterQ?.circuitBreakerCount).toBe(0)
    // 再次调用无可重置行，返回 0
    expect(await db.resetMeltedCircuitBreakers()).toBe(0)
  })

  it('open_windows 登记/覆盖读取/清除 roundtrip', async () => {
    expect(await db.getOpenWindow('bb-1')).toBeNull()
    await db.setOpenWindow('bb-1', '127.0.0.1:61234')
    expect(await db.getOpenWindow('bb-1')).toEqual({ http: '127.0.0.1:61234' })
    // 同窗口重复登记覆盖 http（幂等 upsert，不产生第二行）
    await db.setOpenWindow('bb-1', '127.0.0.1:61235')
    expect(await db.getOpenWindow('bb-1')).toEqual({ http: '127.0.0.1:61235' })
    await db.clearOpenWindow('bb-1')
    expect(await db.getOpenWindow('bb-1')).toBeNull()
  })

  it('upsertProfile 带元数据写入并可读回', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1', { remark: '测试备注', seq: 100, lastIp: '1.2.3.4', lastCountry: 'US', coreVersion: '150' })
    expect(p.remark).toBe('测试备注')
    expect(p.seq).toBe(100)
    expect(p.lastIp).toBe('1.2.3.4')
    expect(p.lastCountry).toBe('US')
    expect(p.coreVersion).toBe('150')
    // 再次同步不带元数据：旧值被覆盖为 null（与比特客户端当前数据保持一致）
    const p2 = await db.upsertProfile('bb-1', '窗口1')
    expect(p2.remark).toBeNull()
    expect(p2.lastIp).toBeNull()
  })

  it('老库无元数据列时 migrate 自动补列（ALTER TABLE 幂等）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-legacy-'))
    const fileUrl = `file:${join(dir, 'legacy.db').split('\\').join('/')}`
    const raw = createClient({ url: fileUrl })
    await raw.execute(`CREATE TABLE profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bitbrowser_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      circuit_breaker_count INTEGER NOT NULL DEFAULT 0
    )`)
    raw.close()
    const legacy = await AppDb.open(fileUrl)
    const p = await legacy.upsertProfile('bb-1', '窗口1', { remark: '老库补列', seq: 7, lastIp: '9.9.9.9', lastCountry: 'US', coreVersion: '150' })
    expect(p.remark).toBe('老库补列')
    expect(p.seq).toBe(7)
    expect(p.coreVersion).toBe('150')
    // 再次 open（重复迁移）不报错、数据仍在
    legacy.close()
    const again = await AppDb.open(fileUrl)
    const list = await again.listProfiles(false)
    expect(list).toHaveLength(1)
    expect(list[0].lastIp).toBe('9.9.9.9')
    again.close()
    // 注：Windows 下 libsql 关闭连接后文件句柄延迟释放，临时目录交由系统清理（与 upload 夹具同策略）
  })

  describe('窗口健康状态', () => {
    const policy = { threshold: 2, cooldownMs: 1800_000, maxCooldownMs: 7200_000 }
    let healthDb: AppDb
    let healthDir: string

    // 用到 file: 临时库：client.transaction() 在 file::memory: 下会开新连接读不到内存库
    beforeEach(async () => {
      healthDir = mkdtempSync(join(tmpdir(), 'abc-health-'))
      healthDb = await AppDb.open(join(healthDir, 'health.db'))
    })
    afterEach(() => {
      healthDb.close()
      try {
        rmSync(healthDir, { recursive: true, force: true })
      } catch {
        // Windows 下 libsql 关闭连接后文件句柄延迟释放，临时目录交由系统清理
      }
    })

    it('默认 closed，环境失败达到阈值后 open，成功重置', async () => {
      const p = await healthDb.upsertProfile('bb-health', '窗口')
      expect((await healthDb.getWindowHealth(p.id)).state).toBe('closed')

      let h = await healthDb.recordWindowEnvironmentFailure(p.id, 'CDP 连接失败', policy, 1000)
      expect(h.state).toBe('closed')
      expect(h.failures).toBe(1)
      expect((await healthDb.getWindowHealth(p.id)).failures).toBe(1)

      h = await healthDb.recordWindowEnvironmentFailure(p.id, 'CDP 连接失败', policy, 2000)
      expect(h.state).toBe('open')
      expect(h.failures).toBe(2)
      expect(h.nextProbeMs).toBe(2000 + 1800_000)
      expect(h.reason).toBe('CDP 连接失败')
      const opened = await healthDb.getWindowHealth(p.id)
      expect(opened.state).toBe('open')
      expect(opened.failures).toBe(2)
      expect(opened.nextProbeMs).toBe(2000 + 1800_000)

      h = await healthDb.recordWindowSuccess(p.id)
      expect(h.state).toBe('closed')
      expect(h.failures).toBe(0)
      expect(h.nextProbeMs).toBeNull()
      const reset = await healthDb.getWindowHealth(p.id)
      expect(reset.state).toBe('closed')
      expect(reset.failures).toBe(0)
      expect(reset.nextProbeMs).toBeNull()
    })

    it('半开环境失败：等级 +1，冷却翻倍', async () => {
      const p = await healthDb.upsertProfile('bb-health-half', '窗口')
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
      expect(await healthDb.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: 2000 + 1800_000 })).toBe(true)

      const h = await healthDb.recordWindowEnvironmentFailure(p.id, '探测失败', policy, 2000 + 1800_000 + 1)
      expect(h.state).toBe('open')
      expect(h.level).toBe(1)
      expect(h.nextProbeMs).toBe(2000 + 1800_000 + 1 + 3600_000)
      const stored = await healthDb.getWindowHealth(p.id)
      expect(stored.state).toBe('open')
      expect(stored.level).toBe(1)
      expect(stored.nextProbeMs).toBe(2000 + 1800_000 + 1 + 3600_000)
    })

    it('半开连续失败冷却封顶于 maxCooldownMs', async () => {
      const capped = { threshold: 2, cooldownMs: 1800_000, maxCooldownMs: 5_000_000 }
      const p = await healthDb.upsertProfile('bb-cap', '窗口')
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e1', capped, 1000)
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e2', capped, 2000)
      const due1 = 2000 + 1800_000
      expect(await healthDb.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due1 })).toBe(true)
      const first = await healthDb.recordWindowEnvironmentFailure(p.id, 'half-1', capped, due1 + 1)
      expect(first.level).toBe(1)
      expect(first.nextProbeMs).toBe(due1 + 1 + 3600_000)

      const due2 = first.nextProbeMs!
      expect(await healthDb.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due2 })).toBe(true)
      const second = await healthDb.recordWindowEnvironmentFailure(p.id, 'half-2', capped, due2 + 1)
      expect(second.state).toBe('open')
      expect(second.level).toBe(2)
      expect(second.nextProbeMs).toBe(due2 + 1 + capped.maxCooldownMs)
      const stored = await healthDb.getWindowHealth(p.id)
      expect(stored.level).toBe(2)
      expect(stored.nextProbeMs).toBe(due2 + 1 + capped.maxCooldownMs)
    })

    it('探测租约：未过期不能重复抢占，retry 释放后保持 half_open', async () => {
      const p = await healthDb.upsertProfile('bb-claim', '窗口')
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
      const due = 2000 + 1800_000
      expect(await healthDb.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due })).toBe(true)
      expect(await healthDb.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due + 1 })).toBe(false)

      await healthDb.releaseWindowProbe(p.id, 'retry')
      const h = await healthDb.getWindowHealth(p.id)
      expect(h.state).toBe('half_open')
      expect(h.probeStartedMs).toBeNull()
    })

    it('探测中断：退回 open 并 1 分钟后允许再探测', async () => {
      const p = await healthDb.upsertProfile('bb-abort', '窗口')
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
      const due = 2000 + 1800_000
      await healthDb.claimWindowProbe(p.id, { leaseMs: 60_000, nowMs: due })
      await healthDb.releaseWindowProbe(p.id, 'aborted', due + 10)
      const h = await healthDb.getWindowHealth(p.id)
      expect(h.state).toBe('open')
      expect(h.nextProbeMs).toBe(due + 10 + 60_000)
    })

    it('recoverStaleWindowProbes 只回收过期半开探测（退回 open，1 分钟后重探）', async () => {
      const stale = await healthDb.upsertProfile('bb-probe-stale', '过期')
      const fresh = await healthDb.upsertProfile('bb-probe-fresh', '新鲜')
      for (const p of [stale, fresh]) {
        await healthDb.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
        await healthDb.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
      }
      const due = 2000 + 1800_000
      expect(await healthDb.claimWindowProbe(stale.id, { leaseMs: 60_000, nowMs: due })).toBe(true)
      expect(await healthDb.claimWindowProbe(fresh.id, { leaseMs: 60_000, nowMs: due + 40_000 })).toBe(true)

      const nowMs = due + 60_001
      expect(await healthDb.recoverStaleWindowProbes(60_000, nowMs)).toBe(1)

      const recovered = await healthDb.getWindowHealth(stale.id)
      expect(recovered.state).toBe('open')
      expect(recovered.probeStartedMs).toBeNull()
      expect(recovered.nextProbeMs).toBe(nowMs + 60_000)

      const untouched = await healthDb.getWindowHealth(fresh.id)
      expect(untouched.state).toBe('half_open')
      expect(untouched.probeStartedMs).toBe(due + 40_000)
    })

    it('resetWindowHealth 将单个窗口恢复 closed 且清空计数', async () => {
      const p = await healthDb.upsertProfile('bb-reset-one', '窗口')
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e1', policy, 1000)
      await healthDb.recordWindowEnvironmentFailure(p.id, 'e2', policy, 2000)
      await healthDb.resetWindowHealth(p.id)
      const h = await healthDb.getWindowHealth(p.id)
      expect(h.state).toBe('closed')
      expect(h.failures).toBe(0)
      expect(h.level).toBe(0)
      expect(h.nextProbeMs).toBeNull()
      expect(h.probeStartedMs).toBeNull()
      expect(h.reason).toBeNull()
    })

    it('resetAllWindowHealth 重置所有非 closed 或计数 > 0 的窗口', async () => {
      const a = await healthDb.upsertProfile('bb-reset-a', 'A')
      const b = await healthDb.upsertProfile('bb-reset-b', 'B')
      await healthDb.recordWindowEnvironmentFailure(a.id, 'e1', policy, 1000)
      await healthDb.recordWindowEnvironmentFailure(a.id, 'e2', policy, 2000)
      await healthDb.recordWindowEnvironmentFailure(b.id, 'e1', policy, 1000)
      expect(await healthDb.resetAllWindowHealth()).toBe(2)
      expect((await healthDb.getWindowHealth(a.id)).state).toBe('closed')
      expect((await healthDb.getWindowHealth(b.id)).failures).toBe(0)
    })

    it('迁移标记阻止再次清零：重开库保留健康计数', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'abc-health-once-'))
      const fileUrl = `file:${join(dir, 'health.db').split('\\').join('/')}`
      try {
        const first = await AppDb.open(fileUrl)
        const p = await first.upsertProfile('bb-once', '窗口')
        const h = await first.recordWindowEnvironmentFailure(p.id, 'CDP 连接失败', policy, 1000)
        expect(h.failures).toBe(1)
        first.close()

        const reopened = await AppDb.open(fileUrl)
        try {
          const retained = await reopened.getWindowHealth(p.id)
          expect(retained.state).toBe('closed')
          expect(retained.failures).toBe(1)
          expect((await reopened.listProfiles(false))[0].circuitBreakerCount).toBe(1)
        } finally {
          reopened.close()
        }
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // Windows 下文件句柄延迟释放，临时目录交由系统清理
        }
      }
    })
  })

  describe('runs.failureKind', () => {
    it('写入、读回并在成功时清空', async () => {
      const p = await db.upsertProfile('bb-kind', '窗口')
      const failed = await db.upsertRun(p.id, 't', '2026-10-19', 0, 'failed', { error: 'x', failureKind: 'environment' })
      expect(failed.failureKind).toBe('environment')
      expect((await db.getRunById(failed.id))?.failureKind).toBe('environment')

      const ok = await db.upsertRun(p.id, 't', '2026-10-19', 0, 'success', { failureKind: null })
      expect(ok.failureKind).toBeNull()
    })
  })

  it('老库迁移补熔断健康列并一次性清零旧计数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-breaker-legacy-'))
    const fileUrl = `file:${join(dir, 'legacy.db').split('\\').join('/')}`
    const raw = createClient({ url: fileUrl })
    await raw.execute(`CREATE TABLE profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bitbrowser_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      circuit_breaker_count INTEGER NOT NULL DEFAULT 0
    )`)
    await raw.execute(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      task_key TEXT NOT NULL,
      date TEXT NOT NULL,
      slot INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      screenshot TEXT,
      started_at TEXT,
      finished_at TEXT,
      batch_id INTEGER,
      diag_path TEXT,
      UNIQUE(profile_id, task_key, date, slot)
    )`)
    await raw.execute(`INSERT INTO profiles (bitbrowser_id, name, circuit_breaker_count) VALUES ('bb-old', '旧窗口', 2)`)
    raw.close()

    const opened = await AppDb.open(fileUrl)
    try {
      const p = (await opened.listProfiles())[0]
      expect(p.circuitBreakerCount).toBe(0)
      expect(p.circuitBreakerState).toBe('closed')
      expect((await opened.getWindowHealth(p.id)).state).toBe('closed')
      const kind = await opened.upsertRun(p.id, 't', '2026-10-19', 0, 'failed', { failureKind: 'task' })
      expect(kind.failureKind).toBe('task')
    } finally {
      opened.close()
    }
  })

  it('Windows 绝对路径（反斜杠）转换为 file: URL 后可正常读写且落盘持久', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-winpath-'))
    const absPath = join(dir, 'app.db')
    const db2 = await AppDb.open(absPath)
    const p = await db2.upsertProfile('bb-wp', '窗口')
    expect(p.bitbrowserId).toBe('bb-wp')
    db2.close()
    // 重新打开同一文件：数据仍在（真实落盘验证）
    const db3 = await AppDb.open(absPath)
    const list = await db3.listProfiles(false)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('窗口')
    db3.close()
  })
})

describe('runs slot 多轮次', () => {
  it('nextRunSlot 无记录返回 0，有记录返回 MAX+1', async () => {
    const db = await AppDb.open('file::memory:')
    const p = await db.upsertProfile('bb-slot', 'slot窗口')
    expect(await db.nextRunSlot(p.id, 't', '2026-08-31')).toBe(0)
    await db.upsertRun(p.id, 't', '2026-08-31', 0, 'running')
    await db.upsertRun(p.id, 't', '2026-08-31', 1, 'running')
    expect(await db.nextRunSlot(p.id, 't', '2026-08-31')).toBe(2)
    db.close()
  })

  it('同一天不同 slot 的行互不覆盖', async () => {
    const db = await AppDb.open('file::memory:')
    const p = await db.upsertProfile('bb-slot2', 'slot窗口2')
    await db.upsertRun(p.id, 't', '2026-08-31', 0, 'success')
    await db.upsertRun(p.id, 't', '2026-08-31', 1, 'failed', { error: 'e' })
    const latest = await db.getLatestRun(p.id, 't', '2026-08-31')
    expect(latest?.slot).toBe(1)
    expect(latest?.status).toBe('failed')
    const r0 = await db.getRun(p.id, 't', '2026-08-31', 0)
    expect(r0?.status).toBe('success')
    db.close()
  })
})

describe('runs 老库迁移', () => {
  it('缺 slot 列的旧表重建后数据保留且 slot=0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-migrate-'))
    const file = join(dir, 'app.db')
    // 手工造旧版表（无 slot、无 last_fired_at）
    const raw = createClient({ url: `file:${file}` })
    await raw.execute(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, task_key TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, screenshot TEXT, started_at TEXT, finished_at TEXT, UNIQUE(profile_id, task_key, date))`)
    await raw.execute(`CREATE TABLE task_states (task_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`)
    await raw.execute(`CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, bitbrowser_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, circuit_breaker_count INTEGER NOT NULL DEFAULT 0)`)
    await raw.execute(`INSERT INTO profiles (id, bitbrowser_id, name) VALUES (1, 'bb-1', '老库窗口')`)
    await raw.execute(`INSERT INTO runs (profile_id, task_key, date, status) VALUES (1, 't', '2026-08-30', 'success')`)
    raw.close()
    const db = await AppDb.open(`file:${file}`)
    const info = await (db as unknown as { client: { execute: (sql: string) => Promise<{ rows: Array<{ name: string }> }> } }).client.execute(`PRAGMA table_info(runs)`)
    expect(info.rows.map((r) => r.name)).toContain('slot')
    expect(info.rows.map((r) => r.name)).toContain('diag_path')
    const rows = await db.listRunsForDate('2026-08-30')
    expect(rows.length).toBe(1)
    expect(rows[0].slot).toBe(0)
    db.close()
    // 重新打开已迁移库：第二次 migrate() 幂等无错、数据仍在、slot 仍为 0
    const db2 = await AppDb.open(`file:${file}`)
    const rows2 = await db2.listRunsForDate('2026-08-30')
    expect(rows2.length).toBe(1)
    expect(rows2[0].slot).toBe(0)
    db2.close()
  })
})

describe('countInFlightRuns', () => {
  it('计入 pending/running/retry_wait，终态不计', async () => {
    const db = await AppDb.open('file::memory:')
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    await db.upsertRun(p1.id, 't', '2026-09-02', 0, 'pending')
    await db.upsertRun(p2.id, 't', '2026-09-02', 0, 'running')
    await db.upsertRun(p1.id, 't', '2026-09-02', 1, 'retry_wait')
    await db.upsertRun(p2.id, 't', '2026-09-02', 1, 'success')
    await db.upsertRun(p1.id, 't', '2026-09-02', 2, 'failed')
    await db.upsertRun(p1.id, 't', '2026-09-02', 3, 'skipped')
    expect(await db.countInFlightRuns('t', '2026-09-02')).toBe(3)
    db.close()
  })

  it('date 与 profileId 过滤', async () => {
    const db = await AppDb.open('file::memory:')
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    await db.upsertRun(p1.id, 't', '2026-09-02', 0, 'running')
    await db.upsertRun(p2.id, 't', '2026-09-02', 0, 'running')
    await db.upsertRun(p1.id, 't', '2026-09-01', 0, 'running')
    expect(await db.countInFlightRuns('t', '2026-09-02')).toBe(2)
    expect(await db.countInFlightRuns('t', '2026-09-02', p1.id)).toBe(1)
    expect(await db.countInFlightRuns('t', '2026-09-02', p2.id)).toBe(1)
    expect(await db.countInFlightRuns('t', '2026-09-01', p1.id)).toBe(1)
    expect(await db.countInFlightRuns('other', '2026-09-02')).toBe(0)
    db.close()
  })
})

describe('批次（batches）', () => {
  it('createBatch 落库并可读回', async () => {
    const b = await db.createBatch('bulk', 't1', 'trigger-all')
    expect(b.id).toBeGreaterThan(0)
    expect(b.kind).toBe('bulk')
    expect(b.taskKey).toBe('t1')
    expect(b.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })

  it('upsertRun 带 batchId 写入新行；不带 batchId 更新时沿用旧值', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const b1 = await db.createBatch('bulk', 't1', 'trigger-all')
    const b2 = await db.createBatch('single', 't1', 'trigger-single')
    await db.upsertRun(p.id, 't1', '2026-09-04', 0, 'pending', { batchId: b1.id })
    // 不带 batchId 更新（续跑）→ 保留 b1
    const r = await db.upsertRun(p.id, 't1', '2026-09-04', 0, 'success', { attempts: 1 })
    expect(r.batchId).toBe(b1.id)
    // 新 slot 带 batchId b2 → 写入 b2
    const r2 = await db.upsertRun(p.id, 't1', '2026-09-04', 1, 'pending', { batchId: b2.id })
    expect(r2.batchId).toBe(b2.id)
    // 不带 batchId 的新行 → null
    const r3 = await db.upsertRun(p.id, 't2', '2026-09-04', 0, 'running')
    expect(r3.batchId).toBeNull()
  })

  it('listBatchesForRange 按时间倒序返回批次并聚合状态统计', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    const b1 = await db.createBatch('bulk', 't1', 'trigger-all', '2026-09-04 08:00:00.000')
    const b2 = await db.createBatch('bulk', 't2', 'trigger-all', '2026-09-04 09:00:00.000')
    const b3 = await db.createBatch('bulk', 't3', 'trigger-all', '2026-09-05 09:00:00.000')
    await db.upsertRun(p1.id, 't1', '2026-09-04', 0, 'success', { batchId: b1.id })
    await db.upsertRun(p2.id, 't1', '2026-09-04', 0, 'failed', { batchId: b1.id })
    await db.upsertRun(p1.id, 't2', '2026-09-04', 0, 'running', { batchId: b2.id })
    await db.upsertRun(p1.id, 't3', '2026-09-05', 0, 'success', { batchId: b3.id })
    await db.upsertRun(p2.id, 't1', '2026-09-04', 1, 'retry_wait', { batchId: b1.id, finishedAt: '2026-09-04 08:05:00.000' })
    const list = await db.listBatchesForRange('2026-09-04', '2026-09-04')
    expect(list.map((b) => b.id)).toEqual([b2.id, b1.id])
    expect(list[1].stats.total).toBe(3)
    expect(list[1].stats.success).toBe(1)
    expect(list[1].stats.failed).toBe(1)
    expect(list[1].stats.retryWait).toBe(1)
    expect(list[1].stats.running).toBe(0)
    expect(list[1].lastFinishedAt).toBe('2026-09-04 08:05:00.000')
    expect(list[0].stats.running).toBe(1)
  })

  it('无行的批次 lastFinishedAt 为 null', async () => {
    await db.createBatch('bulk', 't9', 'trigger-all', '2026-09-04 10:00:00.000')
    const list = await db.listBatchesForRange('2026-09-04', '2026-09-04')
    expect(list[0].lastFinishedAt).toBeNull()
    expect(list[0].stats.total).toBe(0)
  })

  it('listBatchesForRange from=null 查全部区间', async () => {
    const b1 = await db.createBatch('bulk', 't1', 'trigger-all', '2026-08-01 08:00:00.000')
    await db.createBatch('single', 't2', 'trigger-single', '2026-09-04 09:00:00.000')
    const list = await db.listBatchesForRange(null, '2026-09-04')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBeGreaterThan(b1.id)
  })

  it('listRunsForBatch 返回该批次全部 run 行（含 profileName/bitbrowserId）', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    const b = await db.createBatch('bulk', 't1', 'trigger-all')
    await db.upsertRun(p1.id, 't1', '2026-09-04', 0, 'success', { batchId: b.id })
    await db.upsertRun(p2.id, 't1', '2026-09-04', 0, 'failed', { batchId: b.id })
    const rows = await db.listRunsForBatch(b.id)
    expect(rows).toHaveLength(2)
    expect(rows[0].profileName).toBe('A')
    expect(rows[0].bitbrowserId).toBe('bb-1')
    expect(rows[0].batchId).toBe(b.id)
  })

  it('listUnbatchedRuns 返回区间内 batch_id IS NULL 的行', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    const b = await db.createBatch('bulk', 't1', 'trigger-all')
    await db.upsertRun(p1.id, 't1', '2026-09-04', 0, 'success', { batchId: b.id })
    await db.upsertRun(p1.id, 't2', '2026-09-04', 0, 'success')
    await db.upsertRun(p1.id, 't2', '2026-09-01', 0, 'success')
    const rows = await db.listUnbatchedRuns('2026-09-04', '2026-09-04')
    expect(rows).toHaveLength(1)
    expect(rows[0].taskKey).toBe('t2')
  })

  it('老库 runs 无 batch_id 列时 migrate 自动补列', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-batch-'))
    const file = join(dir, 'app.db')
    const raw = createClient({ url: `file:${file}` })
    await raw.execute(`CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, bitbrowser_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, circuit_breaker_count INTEGER NOT NULL DEFAULT 0)`)
    await raw.execute(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, task_key TEXT NOT NULL, date TEXT NOT NULL, slot INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, screenshot TEXT, started_at TEXT, finished_at TEXT, UNIQUE(profile_id, task_key, date, slot))`)
    raw.close()
    const legacy = await AppDb.open(`file:${file}`)
    const info = await (legacy as unknown as { client: { execute: (sql: string) => Promise<{ rows: Array<{ name: string }> }> } }).client.execute(`PRAGMA table_info(runs)`)
    expect(info.rows.map((r) => r.name)).toContain('batch_id')
    expect(info.rows.map((r) => r.name)).toContain('diag_path')
    const b = await legacy.createBatch('bulk', 't', 'trigger-all')
    expect(b.id).toBeGreaterThan(0)
    legacy.close()
  })
})

describe('cleanupOld 历史数据清理', () => {
  it('删除超期 runs/batches，保留期内数据不动', async () => {
    const db = await AppDb.open('file::memory:')
    const p = await db.upsertProfile('bb-clean', 'A')
    // 超期：400 天前（runs.date 直接造；batches.created_at 带时间戳）
    const oldDate = todayStr(new Date(Date.now() - 400 * 86400000))
    const today = todayStr()
    await db.upsertRun(p.id, 't', oldDate, 0, 'success')
    await db.upsertRun(p.id, 't', today, 0, 'success')
    await db.createBatch('bulk', 't', 'trigger-all', `${oldDate} 08:00:00.000`)
    await db.createBatch('bulk', 't', 'trigger-all', `${today} 08:00:00.000`)
    const result = await db.cleanupOld(90)
    expect(result.runs).toBe(1)
    expect(result.batches).toBe(1)
    expect(await db.listRunsForDate(today)).toHaveLength(1)
    expect(await db.listRunsForDate(oldDate)).toHaveLength(0)
    const batches = await db.listBatchesForRange(null, today)
    expect(batches).toHaveLength(1)
    db.close()
  })

  it('retainDays 为负数按 0 处理：当天数据保留、更早数据删除', async () => {
    const db = await AppDb.open('file::memory:')
    const p = await db.upsertProfile('bb-neg', 'A')
    const oldDate = todayStr(new Date(Date.now() - 400 * 86400000))
    const today = todayStr()
    await db.upsertRun(p.id, 't', oldDate, 0, 'success')
    await db.upsertRun(p.id, 't', today, 0, 'success')
    const result = await db.cleanupOld(-5)
    expect(result.runs).toBe(1)
    expect(await db.listRunsForDate(today)).toHaveLength(1)
    expect(await db.listRunsForDate(oldDate)).toHaveLength(0)
    db.close()
  })

  it('日期恰好等于 cutoff 的行保留（date < cutoff 语义）', async () => {
    const db = await AppDb.open('file::memory:')
    const p = await db.upsertProfile('bb-cut', 'A')
    const cutoff = todayStr(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1))
    await db.upsertRun(p.id, 't', cutoff, 0, 'success')
    const result = await db.cleanupOld(1)
    expect(result.runs).toBe(0)
    expect(await db.listRunsForDate(cutoff)).toHaveLength(1)
    db.close()
  })
})

describe('runs 即队列', () => {
  let qdb: AppDb
  let qdir: string
  // Windows 上 libsql 的文件句柄要等进程退出才释放，测试内删不掉；
  // 用固定前缀在下一轮运行开始时清理上次遗留的临时库
  const QUEUE_TMP_PREFIX = 'abc-queue-'
  const removeDirQuietly = (dir: string): void => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 当前进程仍持有句柄，留待下次运行前清理
    }
  }
  beforeEach(async () => {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith(QUEUE_TMP_PREFIX)) removeDirQuietly(join(tmpdir(), name))
    }
    qdir = mkdtempSync(join(tmpdir(), QUEUE_TMP_PREFIX))
    const url = `file:${join(qdir, 'queue.db').split('\\').join('/')}`
    qdb = await AppDb.open(url)
  })
  afterEach(() => {
    qdb.close()
    removeDirQuietly(qdir)
  })

  it('enqueueRun 写入 pending/slot/notBefore/queuedAt；terminal 后新轮次 slot+1', async () => {
    const p = await qdb.upsertProfile('bb-q', '队列窗口')
    const a = await qdb.enqueueRun(p.id, 't', '2026-10-19', 7, 1000)
    expect(a.status).toBe('pending')
    expect(a.slot).toBe(0)
    expect(a.batchId).toBe(7)
    expect(a.notBeforeMs).toBe(1000)
    expect(a.queuedAt).not.toBeNull()

    await qdb.upsertRun(p.id, 't', '2026-10-19', 0, 'success', { finishedAt: '2026-10-19 12:00:00.000' })
    const b = await qdb.enqueueRun(p.id, 't', '2026-10-19', 8, 2000)
    expect(b.slot).toBe(1)
    expect(b.batchId).toBe(8)
  })

  it('listDueRuns 只返回到期、最新 slot 的行', async () => {
    const p = await qdb.upsertProfile('bb-due', '窗口')
    await qdb.enqueueRun(p.id, 'a', '2026-10-19', 1, 1000)
    await qdb.enqueueRun(p.id, 'b', '2026-10-19', 1, 5000)
    const due = await qdb.listDueRuns('2026-10-19', 2000)
    expect(due.map((r) => r.taskKey)).toEqual(['a'])

    await qdb.upsertRun(p.id, 'a', '2026-10-19', 0, 'success')
    await qdb.enqueueRun(p.id, 'a', '2026-10-19', 2, 1500)
    const due2 = await qdb.listDueRuns('2026-10-19', 2000)
    expect(due2.filter((r) => r.taskKey === 'a').map((r) => r.slot)).toEqual([1])
  })

  it('listDueRuns 对同一任务多轮 pending 只返回到期的最新 slot', async () => {
    const p = await qdb.upsertProfile('bb-latest', '窗口')
    await qdb.upsertRun(p.id, 'a', '2026-10-19', 0, 'pending', { notBeforeMs: 1000 })
    await qdb.upsertRun(p.id, 'a', '2026-10-19', 1, 'pending', { notBeforeMs: 1000 })
    const due = await qdb.listDueRuns('2026-10-19', 2000)
    expect(due.map((r) => r.slot)).toEqual([1])
  })

  it('minPendingNotBefore 无 pending 返回 null，有则取 pending 最小值', async () => {
    const p = await qdb.upsertProfile('bb-min', '窗口')
    expect(await qdb.minPendingNotBefore(p.id, '2026-10-19')).toBeNull()
    await qdb.upsertRun(p.id, 'a', '2026-10-19', 0, 'pending', { notBeforeMs: 3000 })
    await qdb.upsertRun(p.id, 'b', '2026-10-19', 0, 'pending', { notBeforeMs: 1000 })
    await qdb.upsertRun(p.id, 'c', '2026-10-19', 0, 'running', { notBeforeMs: 0 })
    expect(await qdb.minPendingNotBefore(p.id, '2026-10-19')).toBe(1000)
  })

  it('hasRunningRunsForProfile 无 running 返回 false，有则 true', async () => {
    const p = await qdb.upsertProfile('bb-running', '窗口')
    expect(await qdb.hasRunningRunsForProfile(p.id, '2026-10-19')).toBe(false)
    await qdb.upsertRun(p.id, 'a', '2026-10-19', 0, 'running')
    expect(await qdb.hasRunningRunsForProfile(p.id, '2026-10-19')).toBe(true)
  })

  it('stopQueuedRuns 把 pending/retry_wait 结算为 skipped', async () => {
    const p = await qdb.upsertProfile('bb-stop', '窗口')
    await qdb.enqueueRun(p.id, 'a', '2026-10-19', 9, 0)
    await qdb.enqueueRun(p.id, 'b', '2026-10-19', 9, 0)
    await qdb.upsertRun(p.id, 'b', '2026-10-19', 0, 'retry_wait', { notBeforeMs: 99999 })
    expect(await qdb.stopQueuedRuns(9)).toBe(2)
    const rows = await qdb.listRunsForDate('2026-10-19')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'skipped' && r.failureKind === 'stopped')).toBe(true)
  })

  it('requeueStaleRunning 把 running 重置为 pending；settleSupersededRuns 结算旧 slot', async () => {
    const p = await qdb.upsertProfile('bb-recover', '窗口')
    await qdb.upsertRun(p.id, 'a', '2026-10-19', 0, 'running', { attempts: 1 })
    await qdb.upsertRun(p.id, 'a', '2026-10-19', 1, 'pending')
    expect(await qdb.requeueStaleRunning('2026-10-19', 5000)).toBe(1)
    expect((await qdb.getRun(p.id, 'a', '2026-10-19', 0))?.status).toBe('pending')
    expect(await qdb.settleSupersededRuns('2026-10-19')).toBe(1)
    expect((await qdb.getRun(p.id, 'a', '2026-10-19', 0))?.status).toBe('failed')
  })

  it('老库迁移补齐队列字段并创建队列索引', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), QUEUE_TMP_PREFIX))
    const url = `file:${join(legacyDir, 'legacy.db').split('\\').join('/')}`
    const raw = createClient({ url })
    // 模拟入队功能上线前的 runs 表：已有 slot/batch_id/diag_path/failure_kind，缺 not_before_ms/queued_at
    await raw.execute(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      task_key TEXT NOT NULL,
      date TEXT NOT NULL,
      slot INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      screenshot TEXT,
      started_at TEXT,
      finished_at TEXT,
      batch_id INTEGER,
      diag_path TEXT,
      failure_kind TEXT,
      UNIQUE(profile_id, task_key, date, slot)
    )`)
    const legacy = await AppDb.open(url)
    try {
      const p = await legacy.upsertProfile('bb-legacy', '老库窗口')
      const run = await legacy.enqueueRun(p.id, 't', '2026-10-19', 3, 1000)
      expect(run.notBeforeMs).toBe(1000)

      const cols = await raw.execute(`PRAGMA table_info(runs)`)
      const names = cols.rows.map((r) => String(r.name))
      expect(names).toContain('not_before_ms')
      expect(names).toContain('queued_at')

      const indexes = await raw.execute(`PRAGMA index_list(runs)`)
      expect(indexes.rows.some((r) => String(r.name) === 'idx_runs_queue')).toBe(true)
      expect(indexes.rows.some((r) => String(r.name) === 'idx_runs_status_date_profile')).toBe(true)
      expect(indexes.rows.some((r) => String(r.name) === 'idx_runs_status_date_task')).toBe(true)
    } finally {
      legacy.close()
      raw.close()
      removeDirQuietly(legacyDir)
    }
  })

  it('stopRunningRun 只结算 running 行，不覆盖 success 终态', async () => {
    const p = await qdb.upsertProfile('bb-stop', '窗口')
    const date = '2026-10-19'
    await qdb.enqueueRun(p.id, 't', date, null, 0)
    await qdb.claimQueuedRuns([(await qdb.getLatestRun(p.id, 't', date))!.id], Date.now())

    expect(await qdb.stopRunningRun(p.id, 't', date, 0)).toBe(true)
    const stopped = await qdb.getLatestRun(p.id, 't', date)
    expect(stopped?.status).toBe('skipped')
    expect(stopped?.error).toBe('手动停止')
    expect(stopped?.failureKind).toBe('stopped')

    // 已终态：CAS 失败，返回 false 且不覆盖 success
    await qdb.upsertRun(p.id, 't', date, 0, 'success', { finishedAt: '2026-10-19 10:00:00.000' })
    expect(await qdb.stopRunningRun(p.id, 't', date, 0)).toBe(false)
    expect((await qdb.getLatestRun(p.id, 't', date))?.status).toBe('success')
  })

  it('settleOldQueuedRuns/settleOldRunningRuns 只结算旧日期，保留当天行', async () => {
    const p = await qdb.upsertProfile('bb-old', '窗口')
    const old = '2026-10-18'
    const today = '2026-10-19'
    await qdb.enqueueRun(p.id, 'old-pending', old, null, 0)
    await qdb.enqueueRun(p.id, 'old-retry', old, null, 0)
    await qdb.upsertRun(p.id, 'old-retry', old, 0, 'retry_wait', { notBeforeMs: 0 })
    const running = await qdb.enqueueRun(p.id, 'old-running', old, null, 0)
    await qdb.claimQueuedRuns([running.id], Date.now())
    await qdb.enqueueRun(p.id, 'today-pending', today, null, 0)

    expect(await qdb.settleOldQueuedRuns(today)).toBe(2)
    expect(await qdb.settleOldRunningRuns(today)).toBe(1)
    expect((await qdb.getLatestRun(p.id, 'old-pending', old))?.status).toBe('skipped')
    expect((await qdb.getLatestRun(p.id, 'old-retry', old))?.status).toBe('skipped')
    const oldRunning = await qdb.getLatestRun(p.id, 'old-running', old)
    expect(oldRunning?.status).toBe('failed')
    expect(oldRunning?.failureKind).toBe('task')
    expect((await qdb.getLatestRun(p.id, 'today-pending', today))?.status).toBe('pending')
  })

  describe('claimDueRuns DB 并发阀门', () => {
    const DATE = '2026-10-19'

    it('claimDueRuns 遵守全局上限并合并同窗口任务', async () => {
      const p1 = await qdb.upsertProfile('bb-g1', '窗口1')
      const p2 = await qdb.upsertProfile('bb-g2', '窗口2')
      await qdb.enqueueRun(p1.id, 'A', DATE, 1, 0)
      await qdb.enqueueRun(p1.id, 'B', DATE, 1, 0)
      await qdb.enqueueRun(p2.id, 'A', DATE, 2, 0)
      const limits = new Map([['A', 2], ['B', 1]])

      const first = await qdb.claimDueRuns({ date: DATE, nowMs: 1000, limits, maxConcurrentWindows: 1 })
      expect(first).toHaveLength(2)
      expect(new Set(first.map((r) => r.profileId))).toEqual(new Set([p1.id]))
      expect(first.map((r) => r.taskKey).sort()).toEqual(['A', 'B'])
      expect(first.every((r) => r.status === 'running' && r.startedAt !== null)).toBe(true)

      const second = await qdb.claimDueRuns({ date: DATE, nowMs: 1001, limits, maxConcurrentWindows: 2 })
      expect(second).toHaveLength(1)
      expect(second[0].profileId).toBe(p2.id)
      expect(second[0].taskKey).toBe('A')
    })

    it('claimDueRuns 遵守任务级上限', async () => {
      const p1 = await qdb.upsertProfile('bb-t1', '窗口1')
      const p2 = await qdb.upsertProfile('bb-t2', '窗口2')
      await qdb.enqueueRun(p1.id, 'A', DATE, null, 0)
      await qdb.enqueueRun(p2.id, 'A', DATE, null, 0)
      const limits = new Map([['A', 1]])

      const first = await qdb.claimDueRuns({ date: DATE, nowMs: 1000, limits, maxConcurrentWindows: 5 })
      expect(first).toHaveLength(1)
      expect(first[0].profileId).toBe(p1.id)

      const second = await qdb.claimDueRuns({ date: DATE, nowMs: 1001, limits, maxConcurrentWindows: 5 })
      expect(second).toHaveLength(0)
      expect((await qdb.getLatestRun(p2.id, 'A', DATE))?.status).toBe('pending')
    })

    it('claimDueRuns 跳过已有 running 行的窗口', async () => {
      const p1 = await qdb.upsertProfile('bb-r1', '窗口1')
      const p2 = await qdb.upsertProfile('bb-r2', '窗口2')
      const running = await qdb.enqueueRun(p1.id, 'B', DATE, null, 0)
      await qdb.claimQueuedRuns([running.id], 500)
      await qdb.enqueueRun(p1.id, 'A', DATE, null, 0)
      await qdb.enqueueRun(p2.id, 'A', DATE, null, 0)

      const claimed = await qdb.claimDueRuns({ date: DATE, nowMs: 1000, limits: new Map([['A', 5], ['B', 5]]), maxConcurrentWindows: 5 })
      expect(claimed.map((r) => r.profileId)).toEqual([p2.id])
      expect(claimed.map((r) => r.taskKey)).toEqual(['A'])
      expect((await qdb.getLatestRun(p1.id, 'A', DATE))?.status).toBe('pending')
    })

    it('claimDueRuns 只认领最新 slot 的到期行', async () => {
      const p = await qdb.upsertProfile('bb-latest-slot', '窗口')
      await qdb.upsertRun(p.id, 'A', DATE, 0, 'pending', { notBeforeMs: 0 })
      await qdb.upsertRun(p.id, 'A', DATE, 1, 'pending', { notBeforeMs: 0 })

      const claimed = await qdb.claimDueRuns({ date: DATE, nowMs: 1000, limits: new Map([['A', 1]]), maxConcurrentWindows: 1 })
      expect(claimed.map((r) => r.slot)).toEqual([1])
    })

    it('claimDueRuns 不改写终态行', async () => {
      const p = await qdb.upsertProfile('bb-g3', '窗口')
      await qdb.upsertRun(p.id, 'A', DATE, 0, 'success')

      const claimed = await qdb.claimDueRuns({ date: DATE, nowMs: 1000, limits: new Map([['A', 1]]), maxConcurrentWindows: 1 })
      expect(claimed).toHaveLength(0)
      expect((await qdb.getRun(p.id, 'A', DATE, 0))?.status).toBe('success')
    })

    it('两个 AppDb 实例共享同一库文件时并发认领不重复', async () => {
      const url = `file:${join(qdir, 'queue.db').split('\\').join('/')}`
      const p1 = await qdb.upsertProfile('bb-s1', '窗口1')
      const p2 = await qdb.upsertProfile('bb-s2', '窗口2')
      await qdb.enqueueRun(p1.id, 'A', DATE, null, 0)
      await qdb.enqueueRun(p2.id, 'A', DATE, null, 0)

      // 真实并发认领（非顺序调用）：libsql 本地引擎是同步绑定，同一线程内 Promise.all 会在
      // BEGIN IMMEDIATE 处互相阻塞；这里用两个 worker 线程各开一个 AppDb 连接，两边就绪后
      // 同时 claim，由 SQLite 写锁 + WAL/busy_timeout 串行化。
      const startSignal = new SharedArrayBuffer(4)
      const signal = new Int32Array(startSignal)
      const workerUrl = new URL('./helpers/concurrent-claim.worker.mjs', import.meta.url)
      const workerData = {
        url,
        date: DATE,
        nowMs: 1000,
        maxConcurrentWindows: 1,
        limits: [['A', 5]] as Array<[string, number]>,
        startSignal,
        timeoutMs: 5000,
      }
      const results: Array<Array<{ id: number; profileId: number }>> = []
      let readyCount = 0
      const workers = [0, 1].map(() => new Worker(workerUrl, { workerData }))
      try {
        await Promise.all(
          workers.map(
            (worker) =>
              new Promise<void>((resolve, reject) => {
                worker.on('message', (msg: { type: string; rows?: Array<{ id: number; profileId: number }>; message?: string }) => {
                  if (msg.type === 'ready') {
                    readyCount++
                    if (readyCount === 2) {
                      Atomics.store(signal, 0, 1)
                      Atomics.notify(signal, 0, 2)
                    }
                  } else if (msg.type === 'result') {
                    results.push(msg.rows ?? [])
                  } else if (msg.type === 'error') {
                    reject(new Error(msg.message ?? 'claim worker 执行失败'))
                  }
                })
                worker.on('error', reject)
                worker.on('exit', (code) => {
                  if (code === 0) resolve()
                  else reject(new Error(`claim worker 退出码 ${code}`))
                })
              }),
          ),
        )

        const all = results.flat()
        expect(all).toHaveLength(1)
        expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()))
      }
    })

    it('countRunningProfiles 只统计去重后的运行窗口', async () => {
      const p1 = await qdb.upsertProfile('bb-c1', '窗口1')
      const p2 = await qdb.upsertProfile('bb-c2', '窗口2')
      expect(await qdb.countRunningProfiles()).toBe(0)

      await qdb.upsertRun(p1.id, 'A', DATE, 0, 'running')
      await qdb.upsertRun(p1.id, 'B', DATE, 0, 'running')
      await qdb.upsertRun(p2.id, 'A', DATE, 0, 'pending')
      expect(await qdb.countRunningProfiles()).toBe(1)

      await qdb.upsertRun(p2.id, 'A', DATE, 0, 'running')
      expect(await qdb.countRunningProfiles()).toBe(2)
    })

    it('跨午夜：昨天的 running 行仍占同窗口与全局额度，countRunningProfiles 可见', async () => {
      const OLD = '2026-10-18'
      const p1 = await qdb.upsertProfile('bb-x1', '窗口1')
      const p2 = await qdb.upsertProfile('bb-x2', '窗口2')
      const oldRunning = await qdb.enqueueRun(p1.id, 'B', OLD, null, 0)
      await qdb.claimQueuedRuns([oldRunning.id], 500)

      expect(await qdb.countRunningProfiles()).toBe(1)

      // 同一窗口今天到期：旧会话仍在跑，不得重复开窗
      await qdb.enqueueRun(p1.id, 'A', DATE, null, 0)
      const sameWindow = await qdb.claimDueRuns({
        date: DATE,
        nowMs: 1000,
        limits: new Map([['A', 5], ['B', 5]]),
        maxConcurrentWindows: 5,
      })
      expect(sameWindow).toHaveLength(0)
      expect((await qdb.getLatestRun(p1.id, 'A', DATE))?.status).toBe('pending')

      // 另一窗口今天到期：旧 running 已占满全局上限 1
      await qdb.enqueueRun(p2.id, 'A', DATE, null, 0)
      const capped = await qdb.claimDueRuns({
        date: DATE,
        nowMs: 1001,
        limits: new Map([['A', 5]]),
        maxConcurrentWindows: 1,
      })
      expect(capped).toHaveLength(0)
      expect((await qdb.getLatestRun(p2.id, 'A', DATE))?.status).toBe('pending')
    })
  })
})

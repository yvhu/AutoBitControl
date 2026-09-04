import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

  it('验证码统计聚合（按本地日期过滤）', async () => {
    const p = await db.upsertProfile('bb-1', 'A')
    await db.logCaptcha(p.id, 'task-a', 'turnstile', 0.03, true)
    await db.logCaptcha(p.id, 'task-a', 'hcaptcha', 0.05, false)
    await db.logCaptcha(p.id, 'task-b', 'turnstile', 0.03, true)
    const stats = await db.captchaStats(todayStr())
    expect(stats.count).toBe(3)
    expect(stats.totalCost).toBeCloseTo(0.11)
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
    const list = await db.listBatchesForRange('2026-09-04', '2026-09-04')
    expect(list.map((b) => b.id)).toEqual([b2.id, b1.id])
    expect(list[1].stats.total).toBe(2)
    expect(list[1].stats.success).toBe(1)
    expect(list[1].stats.failed).toBe(1)
    expect(list[0].stats.running).toBe(1)
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
    const b = await legacy.createBatch('bulk', 't', 'trigger-all')
    expect(b.id).toBeGreaterThan(0)
    legacy.close()
  })
})

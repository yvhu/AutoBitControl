import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDb, todayStr } from '../src/infrastructure/db'

let db: AppDb
// file::memory: 走 @libsql/client 本地引擎：测试无需云库凭据，每个用例独立空库
beforeEach(async () => { db = await AppDb.open({ url: 'file::memory:', authToken: '' }) })
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
    const legacy = await AppDb.open({ url: fileUrl, authToken: '' })
    const p = await legacy.upsertProfile('bb-1', '窗口1', { remark: '老库补列', seq: 7, lastIp: '9.9.9.9', lastCountry: 'US', coreVersion: '150' })
    expect(p.remark).toBe('老库补列')
    expect(p.seq).toBe(7)
    expect(p.coreVersion).toBe('150')
    // 再次 open（重复迁移）不报错、数据仍在
    legacy.close()
    const again = await AppDb.open({ url: fileUrl, authToken: '' })
    const list = await again.listProfiles(false)
    expect(list).toHaveLength(1)
    expect(list[0].lastIp).toBe('9.9.9.9')
    again.close()
    // 注：Windows 下 libsql 关闭连接后文件句柄延迟释放，临时目录交由系统清理（与 upload 夹具同策略）
  })
})

describe('runs slot 多轮次', () => {
  it('nextRunSlot 无记录返回 0，有记录返回 MAX+1', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
    const p = await db.upsertProfile('bb-slot', 'slot窗口')
    expect(await db.nextRunSlot(p.id, 't', '2026-08-31')).toBe(0)
    await db.upsertRun(p.id, 't', '2026-08-31', 0, 'running')
    await db.upsertRun(p.id, 't', '2026-08-31', 1, 'running')
    expect(await db.nextRunSlot(p.id, 't', '2026-08-31')).toBe(2)
    db.close()
  })

  it('同一天不同 slot 的行互不覆盖', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
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

describe('task_states 间隔锚点', () => {
  it('setTaskFiredAt 只增不减且不覆盖 enabled', async () => {
    const db = await AppDb.open({ url: 'file::memory:', authToken: '' })
    await db.setTaskEnabled('t', false)
    await db.setTaskFiredAt('t', '2026-08-31T09:00:00.000Z')
    expect(await db.getTaskFiredAt('t')).toBe('2026-08-31T09:00:00.000Z')
    await db.setTaskFiredAt('t', '2026-08-31T08:00:00.000Z')
    expect(await db.getTaskFiredAt('t')).toBe('2026-08-31T09:00:00.000Z')
    expect(await db.getTaskEnabled('t', true)).toBe(false)
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
    const db = await AppDb.open({ url: `file:${file}`, authToken: '' })
    const info = await (db as unknown as { client: { execute: (sql: string) => Promise<{ rows: Array<{ name: string }> }> } }).client.execute(`PRAGMA table_info(runs)`)
    expect(info.rows.map((r) => r.name)).toContain('slot')
    const rows = await db.listRunsForDate('2026-08-30')
    expect(rows.length).toBe(1)
    expect(rows[0].slot).toBe(0)
    await db.setTaskFiredAt('t', '2026-08-31T09:00:00.000Z')
    db.close()
  })
})

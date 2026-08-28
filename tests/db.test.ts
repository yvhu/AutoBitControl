import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { AppDb, todayStr } from '../src/infrastructure/db'

let db: AppDb
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'abc-db-')); db = AppDb.open(join(dir, 't.db')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('AppDb', () => {
  it('upsertRun 插入后 getRun 可读回', () => {
    const p = db.upsertProfile('bb-1', '窗口1')
    db.upsertRun(p.id, 'task-a', '2026-08-28', 'running')
    const r = db.getRun(p.id, 'task-a', '2026-08-28')
    expect(r).not.toBeNull()
    expect(r!.status).toBe('running')
    expect(r!.attempts).toBe(0)
  })

  it('upsertRun 更新已有记录且不重复插入', () => {
    const p = db.upsertProfile('bb-1', '窗口1')
    db.upsertRun(p.id, 'task-a', '2026-08-28', 'running')
    db.upsertRun(p.id, 'task-a', '2026-08-28', 'success', { attempts: 1, error: null, screenshot: 's.png' })
    const list = db.listRunsForDate('2026-08-28')
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('success')
    expect(list[0].attempts).toBe(1)
    expect(list[0].screenshot).toBe('s.png')
  })

  it('listProfiles 过滤启用状态', () => {
    const p1 = db.upsertProfile('bb-1', 'A')
    db.upsertProfile('bb-2', 'B')
    db.setProfileEnabled(p1.id, false)
    const enabled = db.listProfiles(true)
    expect(enabled.map(p => p.bitbrowserId)).toEqual(['bb-2'])
  })

  it('熔断计数递增与重置', () => {
    const p = db.upsertProfile('bb-1', 'A')
    expect(db.incrCircuitBreaker(p.id)).toBe(1)
    expect(db.incrCircuitBreaker(p.id)).toBe(2)
    db.resetCircuitBreaker(p.id)
    expect(db.incrCircuitBreaker(p.id)).toBe(1)
  })

  it('验证码统计聚合（按本地日期过滤）', () => {
    const p = db.upsertProfile('bb-1', 'A')
    db.logCaptcha(p.id, 'task-a', 'turnstile', 0.03, true)
    db.logCaptcha(p.id, 'task-a', 'hcaptcha', 0.05, false)
    db.logCaptcha(p.id, 'task-b', 'turnstile', 0.03, true)
    const stats = db.captchaStats(todayStr())
    expect(stats.count).toBe(3)
    expect(stats.totalCost).toBeCloseTo(0.11)
  })

  it('任务开关默认值与覆盖读写', () => {
    expect(db.getTaskEnabled('t-x', true)).toBe(true)
    db.setTaskEnabled('t-x', false)
    expect(db.getTaskEnabled('t-x', true)).toBe(false)
    db.setTaskEnabled('t-x', true)
    expect(db.getTaskEnabled('t-x', false)).toBe(true)
  })

  it('旧库含 wallet_password 列时打开自动 DROP 该列', () => {
    // 用独立临时目录构造旧版库（含 wallet_password 列与数据）再走 open 迁移
    const oldDir = mkdtempSync(join(tmpdir(), 'abc-db-old-'))
    try {
      const raw = new Database(join(oldDir, 'old.db'))
      raw.exec(`CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bitbrowser_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        wallet_password TEXT,
        circuit_breaker_count INTEGER NOT NULL DEFAULT 0
      )`)
      raw.prepare(`INSERT INTO profiles (bitbrowser_id, name, wallet_password) VALUES ('bb-1', '旧窗口', 'secret')`).run()
      raw.close()
      const migrated = AppDb.open(join(oldDir, 'old.db'))
      const profiles = migrated.listProfiles(false)
      expect(profiles).toHaveLength(1)
      expect(profiles[0].bitbrowserId).toBe('bb-1')
      expect(profiles[0]).not.toHaveProperty('walletPassword')
      migrated.close()
      const verify = new Database(join(oldDir, 'old.db'))
      const cols = (verify.prepare(`PRAGMA table_info(profiles)`).all() as { name: string }[]).map(c => c.name)
      verify.close()
      expect(cols).not.toContain('wallet_password')
    } finally {
      rmSync(oldDir, { recursive: true, force: true })
    }
  })
})

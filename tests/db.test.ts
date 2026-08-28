import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDb, type RunStatus } from '../src/infrastructure/db'

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

  it('验证码统计聚合', () => {
    const p = db.upsertProfile('bb-1', 'A')
    db.logCaptcha(p.id, 'task-a', 'turnstile', 0.03, true)
    db.logCaptcha(p.id, 'task-a', 'hcaptcha', 0.05, false)
    db.logCaptcha(p.id, 'task-b', 'turnstile', 0.03, true)
    const utcDate = new Date().toISOString().slice(0, 10)
    const stats = db.captchaStats(utcDate)
    expect(stats.count).toBe(3)
    expect(stats.totalCost).toBeCloseTo(0.11)
  })
})

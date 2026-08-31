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
    await db.upsertRun(p.id, 'task-a', '2026-08-28', 'running')
    const r = await db.getRun(p.id, 'task-a', '2026-08-28')
    expect(r).not.toBeNull()
    expect(r!.status).toBe('running')
    expect(r!.attempts).toBe(0)
  })

  it('upsertRun 更新已有记录且不重复插入', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    await db.upsertRun(p.id, 'task-a', '2026-08-28', 'running')
    await db.upsertRun(p.id, 'task-a', '2026-08-28', 'success', { attempts: 1, error: null, screenshot: 's.png' })
    const list = await db.listRunsForDate('2026-08-28')
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('success')
    expect(list[0].attempts).toBe(1)
    expect(list[0].screenshot).toBe('s.png')
  })

  it('更新省略 attempts 时保留原值', async () => {
    const p = await db.upsertProfile('bb-1', 'A')
    await db.upsertRun(p.id, 't', '2026-08-28', 'running', { attempts: 2 })
    await db.upsertRun(p.id, 't', '2026-08-28', 'retry_wait')
    const r = await db.getRun(p.id, 't', '2026-08-28')
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

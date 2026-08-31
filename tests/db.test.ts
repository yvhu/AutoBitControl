import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})

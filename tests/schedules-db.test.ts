import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AppDb } from '../src/infrastructure/db'

let db: AppDb
// file::memory: 走 @libsql/client 本地引擎：测试无需凭据，每个用例独立空库
beforeEach(async () => { db = await AppDb.open('file::memory:') })
afterEach(() => { db.close() })

describe('AppDb · schedules 表', () => {
  it('createSchedule 后 listSchedules 读回（JSON 原文不变）', async () => {
    await db.createSchedule({ name: '每日签到', mode: 'daily', config: '{"times":["09:00","15:00"]}', taskKeys: '["task-a","task-b"]' })
    const list = await db.listSchedules()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('每日签到')
    expect(list[0].enabled).toBe(1)
    expect(list[0].mode).toBe('daily')
    expect(JSON.parse(list[0].config)).toEqual({ times: ['09:00', '15:00'] })
    expect(JSON.parse(list[0].taskKeys)).toEqual(['task-a', 'task-b'])
    expect(list[0].createdAt).toBeTruthy()
  })

  it('getSchedule 命中与未命中', async () => {
    const s = await db.createSchedule({ name: 'A', mode: 'interval', config: '{"everyHours":6}', taskKeys: '["task-a"]' })
    expect((await db.getSchedule(s.id))?.name).toBe('A')
    expect(await db.getSchedule(999)).toBeNull()
  })

  it('updateSchedule 部分更新（enabled=false 持久化，其余字段不动）', async () => {
    const s = await db.createSchedule({ name: 'A', mode: 'daily', config: '{"times":["09:00"]}', taskKeys: '["task-a"]' })
    const u = await db.updateSchedule(s.id, { enabled: false, name: 'B' })
    expect(u).not.toBeNull()
    expect(u!.enabled).toBe(0)
    expect(u!.name).toBe('B')
    expect(u!.mode).toBe('daily')
    expect(JSON.parse(u!.config)).toEqual({ times: ['09:00'] })
    expect(u!.updatedAt >= s.updatedAt).toBe(true)
    expect(await db.updateSchedule(999, { enabled: false })).toBeNull()
  })

  it('deleteSchedule 删除并返回布尔', async () => {
    const s = await db.createSchedule({ name: 'A', mode: 'daily', config: '{"times":["09:00"]}', taskKeys: '[]' })
    expect(await db.deleteSchedule(s.id)).toBe(true)
    expect(await db.deleteSchedule(s.id)).toBe(false)
    expect(await db.listSchedules()).toHaveLength(0)
  })

  it('createBatch 支持 kind=schedule 且 getBatch 读回', async () => {
    const b = await db.createBatch('schedule', 'task-a', '计划#1 每日签到')
    expect(b.kind).toBe('schedule')
    expect((await db.getBatch(b.id))?.kind).toBe('schedule')
  })
})

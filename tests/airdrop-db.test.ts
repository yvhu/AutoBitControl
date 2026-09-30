import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AppDb } from '../src/infrastructure/db'

let db: AppDb
beforeEach(async () => { db = await AppDb.open('file::memory:') })
afterEach(() => { db.close() })

describe('AppDb · airdrop 表', () => {
  it('首次打开种入默认五列且按序', async () => {
    const list = await db.listAirdropStatuses()
    expect(list.map((s) => s.name)).toEqual(['关注中', '待参与', '进行中', '已完成', '已放弃'])
    expect(list[0].projectCount).toBe(0)
    for (const s of list) expect(s.createdAt).toBeTruthy()
  })

  it('createAirdropStatus 追加列并取 max+1 排序；重名返回 null', async () => {
    const s = await db.createAirdropStatus('空投已到账')
    expect(s).not.toBeNull()
    expect(s!.sortOrder).toBe(5)
    const list = await db.listAirdropStatuses()
    expect(list).toHaveLength(6)
    expect(list[5].name).toBe('空投已到账')
    expect(await db.createAirdropStatus('空投已到账')).toBeNull()
  })

  it('updateAirdropStatus 改名与换序；不存在返回 null', async () => {
    const list = await db.listAirdropStatuses()
    const u = await db.updateAirdropStatus(list[0].id, { name: '观察中', sortOrder: 9 })
    expect(u).not.toBeNull()
    expect(u!.name).toBe('观察中')
    expect(u!.sortOrder).toBe(9)
    expect(await db.updateAirdropStatus(999, { name: 'x' })).toBeNull()
  })

  it('deleteAirdropStatus：空列删除、非空列 not_empty、不存在 not_found', async () => {
    const list = await db.listAirdropStatuses()
    expect(await db.deleteAirdropStatus(list[0].id)).toBe('deleted')
    const s = await db.createAirdropStatus('临时')
    await db.createAirdropProject({ name: 'X', statusId: s!.id, priority: 'mid' })
    expect(await db.deleteAirdropStatus(s!.id)).toBe('not_empty')
    expect(await db.deleteAirdropStatus(999)).toBe('not_found')
  })

  it('createAirdropProject 读回（含 statusName 与空子项数组）', async () => {
    const list = await db.listAirdropStatuses()
    const p = await db.createAirdropProject({
      name: 'Inception', statusId: list[2].id, priority: 'high',
      deadline: '2026-10-05', link: 'https://inception.dachain.life', note: '质押额度已达标',
    })
    expect(p.id).toBeGreaterThan(0)
    expect(p.statusName).toBe('进行中')
    expect(p.priority).toBe('high')
    expect(p.deadline).toBe('2026-10-05')
    expect(p.link).toBe('https://inception.dachain.life')
    expect(p.note).toBe('质押额度已达标')
    expect(p.todos).toEqual([])
    expect(p.createdAt).toBeTruthy()
    expect(p.updatedAt).toBeTruthy()
  })

  it('listAirdropProjects 按列排序且列内按优先级→deadline→创建时间', async () => {
    const st = await db.listAirdropStatuses()
    await db.createAirdropProject({ name: '低优先', statusId: st[0].id, priority: 'low' })
    await db.createAirdropProject({ name: '高优先', statusId: st[0].id, priority: 'high' })
    await db.createAirdropProject({ name: '中优先无期限', statusId: st[0].id, priority: 'mid' })
    await db.createAirdropProject({ name: '中优先近期限', statusId: st[0].id, priority: 'mid', deadline: '2026-10-01' })
    await db.createAirdropProject({ name: '中优先远期限', statusId: st[0].id, priority: 'mid', deadline: '2026-11-01' })
    await db.createAirdropProject({ name: '其他列', statusId: st[4].id, priority: 'low' })
    const list = await db.listAirdropProjects()
    expect(list.map((p) => p.name)).toEqual(['高优先', '中优先近期限', '中优先远期限', '中优先无期限', '低优先', '其他列'])
  })

  it('updateAirdropProject 部分更新（null 清空 deadline；undefined 不动）', async () => {
    const st = await db.listAirdropStatuses()
    const p = await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid', deadline: '2026-10-01' })
    const u = await db.updateAirdropProject(p.id, { statusId: st[1].id, deadline: null })
    expect(u!.statusId).toBe(st[1].id)
    expect(u!.deadline).toBeNull()
    const u2 = await db.updateAirdropProject(p.id, { note: '新备注' })
    expect(u2!.note).toBe('新备注')
    expect(u2!.deadline).toBeNull()
    expect(await db.updateAirdropProject(999, { name: 'x' })).toBeNull()
  })

  it('deleteAirdropProject 级联删子项', async () => {
    const st = await db.listAirdropStatuses()
    const p = await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid' })
    await db.createAirdropTodo(p.id, { content: '签到', priority: 'mid' })
    expect(await db.deleteAirdropProject(p.id)).toBe(true)
    expect(await db.getAirdropTodo(1)).toBeNull()
    expect(await db.deleteAirdropProject(p.id)).toBe(false)
  })

  it('createAirdropTodo 项目不存在返回 null；updateAirdropTodo 勾选与改字段', async () => {
    const st = await db.listAirdropStatuses()
    const p = await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid' })
    const t = await db.createAirdropTodo(p.id, { content: '领水', dueDate: '2026-10-02', priority: 'high' })
    expect(t).not.toBeNull()
    expect(t!.done).toBe(0)
    expect(await db.createAirdropTodo(999, { content: 'x', priority: 'low' })).toBeNull()
    const u = await db.updateAirdropTodo(t!.id, { done: true, content: '领水+任务' })
    expect(u!.done).toBe(1)
    expect(u!.content).toBe('领水+任务')
    const u2 = await db.updateAirdropTodo(t!.id, { dueDate: null })
    expect(u2!.dueDate).toBeNull()
    expect(await db.updateAirdropTodo(999, { done: true })).toBeNull()
  })

  it('deleteAirdropTodo 返回布尔', async () => {
    const st = await db.listAirdropStatuses()
    const p = await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid' })
    const t = await db.createAirdropTodo(p.id, { content: 'x', priority: 'low' })
    expect(await db.deleteAirdropTodo(t!.id)).toBe(true)
    expect(await db.deleteAirdropTodo(t!.id)).toBe(false)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AppDb } from '../src/infrastructure/db'
import { airdropRouter } from '../src/server/routes/airdrop'
import { errorHandler } from '../src/server/http/error'
import type { Logger } from '../src/infrastructure/logger'

let db: AppDb
function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', airdropRouter({ db }))
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {} } as unknown as Logger))
  return app
}

beforeAll(async () => { db = await AppDb.open('file::memory:') })
afterAll(() => { db.close() })

/** 造一个项目并返回其视图（默认列索引 0=关注中） */
async function seedProject(name = 'Inception', statusIdx = 0) {
  const st = await db.listAirdropStatuses()
  return db.createAirdropProject({ name, statusId: st[statusIdx].id, priority: 'high' })
}

describe('GET /api/airdrop/statuses', () => {
  it('返回种子的五列（含项目数）', async () => {
    const res = await request(makeApp()).get('/api/airdrop/statuses')
    expect(res.body.code).toBe(0)
    expect(res.body.data.map((s: { name: string }) => s.name)).toEqual(['关注中', '待参与', '进行中', '已完成', '已放弃'])
    expect(res.body.data[0].projectCount).toBe(0)
  })
})

describe('POST /api/airdrop/statuses', () => {
  it('新增列成功且排最后', async () => {
    const res = await request(makeApp()).post('/api/airdrop/statuses').send({ name: '空投已到账' })
    expect(res.status).toBe(200)
    expect(res.body.data.sortOrder).toBe(5)
  })

  it('重名 → 400/40000', async () => {
    const res = await request(makeApp()).post('/api/airdrop/statuses').send({ name: '关注中' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })

  it('缺 name → 400/40000', async () => {
    const res = await request(makeApp()).post('/api/airdrop/statuses').send({})
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })
})

describe('PATCH /api/airdrop/statuses/:id', () => {
  it('改名成功；不存在 → 404/40407', async () => {
    const st = await db.listAirdropStatuses()
    const res = await request(makeApp()).patch(`/api/airdrop/statuses/${st[5].id}`).send({ name: '观察中' })
    expect(res.body.data.name).toBe('观察中')
    const miss = await request(makeApp()).patch('/api/airdrop/statuses/999').send({ name: 'x' })
    expect(miss.status).toBe(404)
    expect(miss.body.code).toBe(40407)
  })
})

describe('DELETE /api/airdrop/statuses/:id', () => {
  it('空列删除成功；非空列 409/40905；不存在 404/40407', async () => {
    const st = await db.listAirdropStatuses()
    await seedProject('占用项目', 4)
    const busy = await request(makeApp()).delete(`/api/airdrop/statuses/${st[4].id}`)
    expect(busy.status).toBe(409)
    expect(busy.body.code).toBe(40905)
    const okRes = await request(makeApp()).delete(`/api/airdrop/statuses/${st[5].id}`)
    expect(okRes.body.code).toBe(0)
    const miss = await request(makeApp()).delete(`/api/airdrop/statuses/${st[5].id}`)
    expect(miss.status).toBe(404)
    expect(miss.body.code).toBe(40407)
  })
})

describe('POST /api/airdrop/projects', () => {
  it('新建成功（含可选字段）', async () => {
    const st = await db.listAirdropStatuses()
    const res = await request(makeApp())
      .post('/api/airdrop/projects')
      .send({ name: 'Inception', statusId: st[2].id, priority: 'high', deadline: '2026-10-05', link: 'https://x.io', note: '备注' })
    expect(res.body.code).toBe(0)
    expect(res.body.data.statusName).toBe('进行中')
    expect(res.body.data.todos).toEqual([])
  })

  it('statusId 不存在 → 404/40407', async () => {
    const res = await request(makeApp()).post('/api/airdrop/projects').send({ name: 'X', statusId: 999, priority: 'mid' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(40407)
  })

  it('缺 name → 400；priority 非法 → 400；deadline 格式错 → 400', async () => {
    const st = await db.listAirdropStatuses()
    const noName = await request(makeApp()).post('/api/airdrop/projects').send({ statusId: st[0].id, priority: 'mid' })
    expect(noName.body.code).toBe(40000)
    const badPrio = await request(makeApp()).post('/api/airdrop/projects').send({ name: 'X', statusId: st[0].id, priority: 'urgent' })
    expect(badPrio.body.code).toBe(40000)
    const badDate = await request(makeApp()).post('/api/airdrop/projects').send({ name: 'X', statusId: st[0].id, deadline: '10/05/2026' })
    expect(badDate.body.code).toBe(40000)
  })
})

describe('GET /api/airdrop/projects', () => {
  it('返回含子项与状态名的视图', async () => {
    const p = await seedProject()
    await db.createAirdropTodo(p.id, { content: '领水', dueDate: '2026-10-02', priority: 'high' })
    const res = await request(makeApp()).get('/api/airdrop/projects')
    expect(res.body.code).toBe(0)
    const item = res.body.data.find((x: { id: number }) => x.id === p.id)
    expect(item.statusName).toBe('关注中')
    expect(item.todos).toHaveLength(1)
    expect(item.todos[0].content).toBe('领水')
  })
})

describe('PATCH /api/airdrop/projects/:id', () => {
  it('流转状态列与清空 deadline（null）', async () => {
    const st = await db.listAirdropStatuses()
    const p = await seedProject('A', 0)
    const res = await request(makeApp()).patch(`/api/airdrop/projects/${p.id}`).send({ statusId: st[1].id, deadline: null })
    expect(res.body.data.statusId).toBe(st[1].id)
    expect(res.body.data.statusName).toBe('待参与')
    expect(res.body.data.deadline).toBeNull()
  })

  it('statusId 不存在 → 404/40407；项目不存在 → 404/40407', async () => {
    const p = await seedProject()
    const badStatus = await request(makeApp()).patch(`/api/airdrop/projects/${p.id}`).send({ statusId: 999 })
    expect(badStatus.body.code).toBe(40407)
    const miss = await request(makeApp()).patch('/api/airdrop/projects/999').send({ name: 'x' })
    expect(miss.body.code).toBe(40407)
  })
})

describe('DELETE /api/airdrop/projects/:id', () => {
  it('删除成功；再删 404', async () => {
    const p = await seedProject()
    expect((await request(makeApp()).delete(`/api/airdrop/projects/${p.id}`)).body.code).toBe(0)
    const miss = await request(makeApp()).delete(`/api/airdrop/projects/${p.id}`)
    expect(miss.status).toBe(404)
    expect(miss.body.code).toBe(40407)
  })
})

describe('POST /api/airdrop/projects/:id/todos', () => {
  it('新增子项；项目不存在 404', async () => {
    const p = await seedProject()
    const res = await request(makeApp()).post(`/api/airdrop/projects/${p.id}/todos`).send({ content: '签到', dueDate: '2026-10-01', priority: 'mid' })
    expect(res.body.code).toBe(0)
    expect(res.body.data.content).toBe('签到')
    const miss = await request(makeApp()).post('/api/airdrop/projects/999/todos').send({ content: 'x', priority: 'low' })
    expect(miss.body.code).toBe(40407)
  })

  it('缺 content → 400', async () => {
    const p = await seedProject()
    const res = await request(makeApp()).post(`/api/airdrop/projects/${p.id}/todos`).send({ priority: 'low' })
    expect(res.body.code).toBe(40000)
  })
})

describe('PATCH /api/airdrop/todos/:id', () => {
  it('勾选与改字段；不存在 404', async () => {
    const p = await seedProject()
    const t = await db.createAirdropTodo(p.id, { content: 'x', priority: 'low' })
    const res = await request(makeApp()).patch(`/api/airdrop/todos/${t!.id}`).send({ done: true })
    expect(res.body.data.done).toBe(1)
    const miss = await request(makeApp()).patch('/api/airdrop/todos/999').send({ done: true })
    expect(miss.body.code).toBe(40407)
  })
})

describe('DELETE /api/airdrop/todos/:id', () => {
  it('删除成功；再删 404', async () => {
    const p = await seedProject()
    const t = await db.createAirdropTodo(p.id, { content: 'x', priority: 'low' })
    expect((await request(makeApp()).delete(`/api/airdrop/todos/${t!.id}`)).body.code).toBe(0)
    const miss = await request(makeApp()).delete(`/api/airdrop/todos/${t!.id}`)
    expect(miss.body.code).toBe(40407)
  })
})

describe('GET /api/airdrop/reminders', () => {
  it('汇总项目与子项到期/过期', async () => {
    const p = await seedProject('临近项目')
    await db.updateAirdropProject(p.id, { deadline: '2026-10-04' })
    const t = await db.createAirdropTodo(p.id, { content: '过期子项', dueDate: '2026-09-29', priority: 'low' })
    const res = await request(makeApp()).get('/api/airdrop/reminders')
    expect(res.body.code).toBe(0)
    expect(res.body.data.overdue.some((i: { id: number }) => i.id === t!.id)).toBe(true)
    expect(res.body.data.upcoming.some((i: { id: number }) => i.id === p.id)).toBe(true)
  })
})

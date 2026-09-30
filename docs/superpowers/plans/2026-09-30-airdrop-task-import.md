# 空投追踪「从系统任务导入」实施计划（airdrop-task-import）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 空投追踪页支持把系统已登记任务批量导入为项目卡片（逐行指定状态列/优先级），项目与任务建立「可绑定可解绑」的 task_key 软关联，已导入任务置灰防重复。

**Architecture:** 沿用既有分层：`airdrop_projects` 加可空 `task_key` 列（部分唯一索引保证一个任务只绑一个项目）；路由层校验任务存在性与占用（deps 加 tasks 注册表）；新增批量 import 接口逐条创建返回失败清单；前端新增 ImportModal（逐行 Select）+ 编辑弹窗关联下拉。spec：`docs/superpowers/specs/2026-09-30-airdrop-task-import-design.md`。

**Tech Stack:** TypeScript（strict）、express 5、@libsql/client、vitest + supertest、React 18 + antd 5 + react-query。

## Global Constraints

- 注释/文档/commit 全部中文；无分号、单引号、2 空格缩进；命名 camelCase、文件 kebab-case
- 唯一性靠**部分唯一索引**：`CREATE UNIQUE INDEX IF NOT EXISTS idx_airdrop_projects_task_key ON airdrop_projects(task_key) WHERE task_key IS NOT NULL`（NULL 不参与唯一；老库 ALTER 补列 + 幂等建索引）
- taskKey 语义：字符串=绑定、null=解绑/清空、undefined=不动；绑定已占用任务 → 400 INVALID_ARGUMENT（40000）文案「该任务已关联其他项目」；任务不存在 → 400 文案「任务不存在: {taskKey}」
- import 接口：body `{items:[{taskKey,statusId,priority?}]}` 非空数组；逐条处理单项失败进 failed 清单（不整体回滚）；priority 缺省 mid；导入项目 name=meta.name、link=meta.url ?? null、deadline/note 空
- airdropRouter deps 加 `tasks: Map<string, SiteTask>`（server → tasks 走 type-only import，同 schedulesRouter 惯例）
- 后端测试命令 `npm test -- tests/<file>`；前端 `npm run test:web -- src/pages/airdrop`；每 Task 结束前 typecheck + 相关测试全绿才 commit
- 上轮已确认的项目背景：`board.test.ts` 的 `proj()` 工厂返回 `AirdropProjectView` 字面量（Task 3 加 taskKey 字段后必须同步补 `taskKey: null` 否则 typecheck 失败）；`hooks.test.tsx` 的 endpoints mock 无类型标注不受影响

---

### Task 1: db 层 task_key 列、部分唯一索引与 CRUD 扩展

**Files:**
- Modify: `src/infrastructure/db.ts`
- Test: `tests/airdrop-db.test.ts`（追加 describe）

**Interfaces:**
- Produces（后续 Task 依赖，签名以本节为准）：
  - `AirdropProjectRow.taskKey: string | null`、`AirdropProjectView.taskKey: string | null`
  - `createAirdropProject(input: { name; statusId; priority; deadline?; link?; note?; taskKey?: string | null })`
  - `updateAirdropProject(id, patch: { name?; statusId?; priority?; deadline?; link?; note?; taskKey?: string | null })`（taskKey null=清空、undefined=不动）

- [ ] **Step 1: 写失败测试**

在 `tests/airdrop-db.test.ts` 末尾追加（沿用该文件 `beforeEach` 的内存库）：

```ts
describe('AppDb · airdrop_projects.task_key', () => {
  it('create 带 taskKey 读回；不带为 null', async () => {
    const st = await db.listAirdropStatuses()
    const p1 = await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid', taskKey: 'inception-dachain' })
    expect(p1.taskKey).toBe('inception-dachain')
    const p2 = await db.createAirdropProject({ name: 'B', statusId: st[0].id, priority: 'mid' })
    expect(p2.taskKey).toBeNull()
  })

  it('update：taskKey 绑定 / null 解绑 / undefined 不动', async () => {
    const st = await db.listAirdropStatuses()
    const p = await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid' })
    const u1 = await db.updateAirdropProject(p.id, { taskKey: 'task-x' })
    expect(u1!.taskKey).toBe('task-x')
    const u2 = await db.updateAirdropProject(p.id, { note: '只改备注' })
    expect(u2!.taskKey).toBe('task-x')
    const u3 = await db.updateAirdropProject(p.id, { taskKey: null })
    expect(u3!.taskKey).toBeNull()
  })

  it('部分唯一索引：多个 NULL 共存；同 taskKey 第二行抛约束错误', async () => {
    const st = await db.listAirdropStatuses()
    await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid' })
    await db.createAirdropProject({ name: 'B', statusId: st[0].id, priority: 'mid' })
    await db.createAirdropProject({ name: 'C', statusId: st[0].id, priority: 'mid', taskKey: 'dup-key' })
    await expect(db.createAirdropProject({ name: 'D', statusId: st[0].id, priority: 'mid', taskKey: 'dup-key' })).rejects.toThrow()
    const u = await db.createAirdropProject({ name: 'E', statusId: st[0].id, priority: 'mid' })
    await expect(db.updateAirdropProject(u.id, { taskKey: 'dup-key' })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/airdrop-db.test.ts`
Expected: FAIL（`Property 'taskKey' does not exist on type 'AirdropProjectView'` 编译错误）

- [ ] **Step 3: 实现 db 层**

修改 `src/infrastructure/db.ts`：

（a）`AirdropProjectRow` 接口加字段（`updatedAt` 之后）：

```ts
  /** 绑定的系统任务 key（可空；null=纯手动追踪项目）；唯一性由部分唯一索引保证 */
  taskKey: string | null
```

（b）SCHEMA 的 `airdrop_projects` 建表（`updated_at TEXT NOT NULL` 之后加）：

```ts
    task_key TEXT,
```

（c）migrate() 末尾（空投种子之后、`}` 之前）追加老库补列 + 索引（顺序：先补列后建索引，索引必须列存在后创建）：

```ts
    // 老库补列：airdrop_projects.task_key（系统任务绑定，可空）——
    // SQLite ALTER 无法加表级 UNIQUE，唯一性用部分唯一索引（NULL 不参与，手动项目不受限）
    const apInfo = await this.client.execute(`PRAGMA table_info(airdrop_projects)`)
    if (!apInfo.rows.some((r) => String(r.name) === 'task_key')) {
      await this.client.execute(`ALTER TABLE airdrop_projects ADD COLUMN task_key TEXT`)
    }
    await this.client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_airdrop_projects_task_key ON airdrop_projects(task_key) WHERE task_key IS NOT NULL`)
```

（d）`SELECT_PROJECT` 常量改为（加 `p.task_key AS taskKey`）：

```ts
  private static readonly SELECT_PROJECT = `SELECT p.id, p.name, p.status_id AS statusId, p.priority, p.deadline, p.link, p.note, p.task_key AS taskKey, p.created_at AS createdAt, p.updated_at AS updatedAt, s.name AS statusName FROM airdrop_projects p JOIN airdrop_statuses s ON s.id = p.status_id`
```

（e）`listReminderSources` 的 projects 内联 SELECT 同步加 `task_key AS taskKey`：

```ts
    const projects = await this.exec(`SELECT id, name, status_id AS statusId, priority, deadline, link, note, task_key AS taskKey, created_at AS createdAt, updated_at AS updatedAt FROM airdrop_projects`)
```

（f）`createAirdropProject` 签名与 INSERT：

```ts
  async createAirdropProject(input: { name: string; statusId: number; priority: AirdropPriority; deadline?: string | null; link?: string | null; note?: string | null; taskKey?: string | null }): Promise<AirdropProjectView> {
    const now = localWallNow()
    const rs = await this.client.execute({
      sql: `INSERT INTO airdrop_projects (name, status_id, priority, deadline, link, note, task_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [input.name, input.statusId, input.priority, input.deadline ?? null, input.link ?? null, input.note ?? null, input.taskKey ?? null, now, now],
    })
    return (await this.getAirdropProject(Number(rs.lastInsertRowid)))!
  }
```

（g）`updateAirdropProject` 签名与 UPDATE（taskKey undefined 不动、null 清空）：

```ts
  async updateAirdropProject(id: number, patch: { name?: string; statusId?: number; priority?: AirdropPriority; deadline?: string | null; link?: string | null; note?: string | null; taskKey?: string | null }): Promise<AirdropProjectView | null> {
    const current = await this.getAirdropProject(id)
    if (!current) return null
    await this.exec(
      `UPDATE airdrop_projects SET name = ?, status_id = ?, priority = ?, deadline = ?, link = ?, note = ?, task_key = ?, updated_at = ? WHERE id = ?`,
      [
        patch.name ?? current.name,
        patch.statusId ?? current.statusId,
        patch.priority ?? current.priority,
        patch.deadline === undefined ? current.deadline : patch.deadline,
        patch.link === undefined ? current.link : patch.link,
        patch.note === undefined ? current.note : patch.note,
        patch.taskKey === undefined ? current.taskKey : patch.taskKey,
        localWallNow(),
        id,
      ],
    )
    return this.getAirdropProject(id)
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/airdrop-db.test.ts`
Expected: PASS（原 12 用例 + 新 3 用例全绿）

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add src/infrastructure/db.ts tests/airdrop-db.test.ts
git commit -m "feat: 空投项目 task_key 列与部分唯一索引（可绑定可解绑）"
```

---

### Task 2: 路由 taskKey 校验与 import 批量接口

**Files:**
- Modify: `src/server/routes/airdrop.ts`
- Modify: `src/server/app.ts`（挂载传 tasks）
- Test: `tests/airdrop-route.test.ts`（makeApp 补 tasks + 追加 describe）

**Interfaces:**
- Consumes：Task 1 的 db 签名；`SiteTask`（`src/tasks/base.ts` 导出，type-only import）
- Produces：`airdropRouter(deps: { db: AppDb; tasks: Map<string, SiteTask> })`；`POST /api/airdrop/projects/import` 响应 `{ imported: number; failed: Array<{ taskKey: string; reason: string }> }`

- [ ] **Step 1: 写失败测试**

修改 `tests/airdrop-route.test.ts`：

（a）文件顶部 import 加 `import type { SiteTask } from '../src/tasks/base'`；makeApp 改为：

```ts
const fakeTasks = new Map<string, SiteTask>([
  ['task-one', { meta: { key: 'task-one', name: '任务一', url: 'https://one.io' } } as unknown as SiteTask],
  ['task-two', { meta: { key: 'task-two', name: '任务二', url: '' } } as unknown as SiteTask],
])

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', airdropRouter({ db, tasks: fakeTasks }))
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {} } as unknown as Logger))
  return app
}
```

（b）末尾追加 describe（沿用共享内存库与既有 seedProject 辅助；注意别破坏既有用例共享状态——新用例创建的项目留在库里不影响既有断言）：

```ts
describe('POST /api/airdrop/projects · taskKey', () => {
  it('带合法 taskKey 创建成功且视图返回 taskKey', async () => {
    const st = await db.listAirdropStatuses()
    const res = await request(makeApp()).post('/api/airdrop/projects').send({ name: 'X', statusId: st[0].id, priority: 'mid', taskKey: 'task-one' })
    expect(res.body.code).toBe(0)
    expect(res.body.data.taskKey).toBe('task-one')
  })

  it('任务不存在 → 400；重复绑定 → 400', async () => {
    const st = await db.listAirdropStatuses()
    const bad = await request(makeApp()).post('/api/airdrop/projects').send({ name: 'X', statusId: st[0].id, priority: 'mid', taskKey: 'ghost-task' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe(40000)
    await request(makeApp()).post('/api/airdrop/projects').send({ name: 'Y', statusId: st[0].id, priority: 'mid', taskKey: 'task-two' })
    const dup = await request(makeApp()).post('/api/airdrop/projects').send({ name: 'Z', statusId: st[0].id, priority: 'mid', taskKey: 'task-two' })
    expect(dup.status).toBe(400)
    expect(dup.body.code).toBe(40000)
    expect(dup.body.message).toBe('该任务已关联其他项目')
  })
})

describe('PATCH /api/airdrop/projects/:id · taskKey', () => {
  it('绑定成功；解绑（null）成功', async () => {
    const p = await seedProject('绑定测试')
    const bind = await request(makeApp()).patch(`/api/airdrop/projects/${p.id}`).send({ taskKey: 'task-two' })
    expect(bind.body.data.taskKey).toBe('task-two')
    const unbind = await request(makeApp()).patch(`/api/airdrop/projects/${p.id}`).send({ taskKey: null })
    expect(unbind.body.data.taskKey).toBeNull()
  })

  it('绑定已占用任务 → 400；绑定不存在的任务 → 400', async () => {
    const st = await db.listAirdropStatuses()
    const holder = await db.createAirdropProject({ name: '持有者', statusId: st[0].id, priority: 'mid', taskKey: 'task-one' })
    const p = await seedProject('绑定冲突')
    const dup = await request(makeApp()).patch(`/api/airdrop/projects/${p.id}`).send({ taskKey: 'task-one' })
    expect(dup.status).toBe(400)
    expect(dup.body.code).toBe(40000)
    expect(holder.id).toBeGreaterThan(0)
    const ghost = await request(makeApp()).patch(`/api/airdrop/projects/${p.id}`).send({ taskKey: 'nope' })
    expect(ghost.body.code).toBe(40000)
  })
})

describe('POST /api/airdrop/projects/import', () => {
  it('全成功：导入两项（name=任务名、link=url、taskKey 写入）', async () => {
    const st = await db.listAirdropStatuses()
    const res = await request(makeApp())
      .post('/api/airdrop/projects/import')
      .send({ items: [{ taskKey: 'task-one', statusId: st[0].id, priority: 'high' }, { taskKey: 'task-two', statusId: st[1].id }] })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.imported).toBe(2)
    expect(res.body.data.failed).toEqual([])
    const list = await request(makeApp()).get('/api/airdrop/projects')
    const one = list.body.data.find((x: { taskKey: string | null }) => x.taskKey === 'task-one')
    expect(one.name).toBe('任务一')
    expect(one.link).toBe('https://one.io')
    expect(one.priority).toBe('high')
    const two = list.body.data.find((x: { taskKey: string | null }) => x.taskKey === 'task-two')
    expect(two.link).toBeNull()
    expect(two.priority).toBe('mid')
  })

  it('部分失败：坏项进 failed 清单不拖累好项', async () => {
    const st = await db.listAirdropStatuses()
    const res = await request(makeApp())
      .post('/api/airdrop/projects/import')
      .send({ items: [{ taskKey: 'task-one', statusId: st[0].id }, { taskKey: 'ghost', statusId: st[0].id }, { taskKey: 'task-two', statusId: 999 }] })
    expect(res.body.data.imported).toBe(1)
    expect(res.body.data.failed).toEqual([
      { taskKey: 'ghost', reason: '任务不存在: ghost' },
      { taskKey: 'task-two', reason: '状态列不存在' },
    ])
  })

  it('items 非数组/空数组 → 400', async () => {
    const bad = await request(makeApp()).post('/api/airdrop/projects/import').send({ items: 'x' })
    expect(bad.body.code).toBe(40000)
    const empty = await request(makeApp()).post('/api/airdrop/projects/import').send({ items: [] })
    expect(empty.body.code).toBe(40000)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/airdrop-route.test.ts`
Expected: FAIL（`airdropRouter` 传参类型不匹配：缺少 tasks / import 接口 404）

- [ ] **Step 3: 实现路由与挂载**

修改 `src/server/routes/airdrop.ts`：

（a）import 加（已有 import 行合并）：

```ts
import type { SiteTask } from '../../tasks/base'
```

（b）parseProjectBody 返回类型与逻辑加 taskKey（在 `note` 校验之后）：

```ts
  if (body.taskKey !== undefined && body.taskKey !== null && (typeof body.taskKey !== 'string' || !body.taskKey.trim())) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKey 须为非空字符串')
  return { name: body.name.trim(), statusId: body.statusId, priority, deadline: d.value, link: (body.link as string | null) ?? null, note: (body.note as string | null) ?? null, taskKey: (body.taskKey as string | null) ?? null }
```

返回类型声明同步加 `taskKey: string | null`。

（c）parseProjectPatch 加 taskKey 分支（out 类型加 `taskKey?: string | null`）：

```ts
  if (body.taskKey !== undefined) {
    if (body.taskKey !== null && (typeof body.taskKey !== 'string' || !body.taskKey.trim())) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKey 须为非空字符串')
    out.taskKey = body.taskKey
  }
```

（d）新增校验 helper（parseId 之后）：

```ts
/** 校验 taskKey 可绑定：任务须存在且未被其他项目绑定；非法抛 400 */
async function assertTaskKeyBindable(deps: { db: AppDb; tasks: Map<string, SiteTask> }, taskKey: string, excludeProjectId?: number): Promise<void> {
  if (!deps.tasks.has(taskKey)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `任务不存在: ${taskKey}`)
  const projects = await deps.db.listAirdropProjects()
  const holder = projects.find((p) => p.taskKey === taskKey && p.id !== excludeProjectId)
  if (holder) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '该任务已关联其他项目')
}
```

（e）`airdropRouter(deps: { db: AppDb; tasks: Map<string, SiteTask> })`；POST projects handler 在 statusId 校验之后加：

```ts
    if (parsed.taskKey) await assertTaskKeyBindable(deps, parsed.taskKey)
```

（f）PATCH projects handler 在 statusId 校验之后加：

```ts
    if (parsed.taskKey) await assertTaskKeyBindable(deps, parsed.taskKey, id)
```

（g）import 接口（GET projects 之后）：

```ts
  router.post('/airdrop/projects/import', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { items?: unknown }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'items 须为非空数组')
    }
    const imported = 0
    const failed: Array<{ taskKey: string; reason: string }> = []
    for (const item of body.items as Array<Record<string, unknown>>) {
      const taskKey = typeof item?.taskKey === 'string' ? item.taskKey.trim() : ''
      if (!taskKey) {
        failed.push({ taskKey: String(item?.taskKey ?? ''), reason: 'taskKey 须为非空字符串' })
        continue
      }
      const meta = deps.tasks.get(taskKey)?.meta
      if (!meta) {
        failed.push({ taskKey, reason: `任务不存在: ${taskKey}` })
        continue
      }
      const holder = (await deps.db.listAirdropProjects()).find((p) => p.taskKey === taskKey)
      if (holder) {
        failed.push({ taskKey, reason: '该任务已关联其他项目' })
        continue
      }
      const statusId = Number(item?.statusId)
      if (!Number.isInteger(statusId) || statusId <= 0 || !(await deps.db.getAirdropStatus(statusId))) {
        failed.push({ taskKey, reason: '状态列不存在' })
        continue
      }
      const priority = item?.priority === 'high' || item?.priority === 'mid' || item?.priority === 'low' ? item.priority : 'mid'
      await deps.db.createAirdropProject({ name: meta.name, statusId, priority, link: meta.url || null, taskKey })
    }
    ok(res, { imported: (body.items as unknown[]).length - failed.length, failed })
  }))
```

（h）swagger 注解：
- POST /api/airdrop/projects 的注解里补 taskKey 属性（`taskKey: { type: string, nullable: true }`）
- PATCH /api/airdrop/projects/{id} 注解补 taskKey（`{ type: string, nullable: true, description: 绑定系统任务；null=解绑 }`）
- 新增 import 注解块（POST /api/airdrop/projects/import，summary「批量从系统任务导入空投项目」，responses 200 含 imported/failed 属性、400）
- GET /api/airdrop/projects 注解的 items 补 `taskKey: { type: string, nullable: true }`

（i）`src/server/app.ts` 挂载行改：

```ts
  api.use(airdropRouter({ db: deps.db, tasks: deps.tasks }))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/airdrop-route.test.ts tests/airdrop-reminders.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add src/server/routes/airdrop.ts src/server/app.ts tests/airdrop-route.test.ts
git commit -m "feat: 空投追踪任务绑定校验与系统任务批量导入接口"
```

---

### Task 3: 前端类型与 endpoints

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api/endpoints.ts`
- Modify: `web/src/pages/airdrop/board.test.ts`（proj 工厂补 taskKey 字段，typecheck 要求）

**Interfaces:**
- Produces（Task 4/5 依赖）：
  - `AirdropProjectView.taskKey: string | null`；`AirdropProjectInput.taskKey?: string | null`；`AirdropProjectPatch.taskKey?: string | null`
  - `AirdropImportItem { taskKey: string; statusId: number; priority?: AirdropPriority }`
  - `AirdropImportResult { imported: number; failed: Array<{ taskKey: string; reason: string }> }`
  - `importAirdropProjects(body: { items: AirdropImportItem[] }): Promise<AirdropImportResult>`

- [ ] **Step 1: 写代码**

修改 `web/src/types.ts`（Airdrop 段内）：

```ts
/** 项目视图（含状态列名与子项数组；taskKey=绑定的系统任务，null=纯手动） */
export interface AirdropProjectView {
  id: number
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: string | null
  link: string | null
  note: string | null
  taskKey: string | null
  createdAt: string
  updatedAt: string
  statusName: string
  todos: AirdropTodoItem[]
}

/** 新建项目入参 */
export interface AirdropProjectInput {
  name: string
  statusId: number
  priority?: AirdropPriority
  deadline?: string | null
  link?: string | null
  note?: string | null
  taskKey?: string | null
}

/** 项目部分更新入参（拖拽流转传 statusId；taskKey null=解绑） */
export interface AirdropProjectPatch {
  name?: string
  statusId?: number
  priority?: AirdropPriority
  deadline?: string | null
  link?: string | null
  note?: string | null
  taskKey?: string | null
}

/** 批量导入项 */
export interface AirdropImportItem {
  taskKey: string
  statusId: number
  priority?: AirdropPriority
}

/** 批量导入结果 */
export interface AirdropImportResult {
  imported: number
  failed: Array<{ taskKey: string; reason: string }>
}
```

修改 `web/src/api/endpoints.ts`（airdrop 段末尾）：

```ts
export const importAirdropProjects = (body: { items: AirdropImportItem[] }) => post<AirdropImportResult>('/api/airdrop/projects/import', body)
```

（import type 行加 `AirdropImportItem, AirdropImportResult`）

修改 `web/src/pages/airdrop/board.test.ts` 的 proj 工厂（加字段）：

```ts
const proj = (id: number, statusId: number): AirdropProjectView => ({
  id, name: `P${id}`, statusId, priority: 'mid', deadline: null, link: null, note: null, taskKey: null,
  createdAt: 'x', updatedAt: 'x', statusName: '列', todos: [],
})
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS；若报其他 AirdropProjectView 字面量缺 taskKey，逐一补 `taskKey: null`（web/src/pages/airdrop/ 下测试与组件）

- [ ] **Step 3: 提交**

```bash
git add web/src/types.ts web/src/api/endpoints.ts web/src/pages/airdrop/board.test.ts
git commit -m "feat: 前端空投导入类型与 API"
```

---

### Task 4: hooks（useImportProjects + useTasks）

**Files:**
- Modify: `web/src/pages/airdrop/hooks.ts`
- Test: `web/src/pages/airdrop/hooks.test.tsx`（追加用例）

**Interfaces:**
- Consumes：Task 3 的 `importAirdropProjects`/`AirdropImportResult`
- Produces：`useImportProjects()`（mutation：`{ items: AirdropImportItem[] }` → 成功 message.success「已导入 N 个项目」、failed 非空追加 message.warning 列前 3 条 reason、invalidateAll；失败 errMsg）；`useTasks()`（useQuery `['tasks']`，queryFn `fetchTasks`，staleTime 60_000——Task 5 弹窗数据源）

- [ ] **Step 1: 写失败测试**

在 `web/src/pages/airdrop/hooks.test.tsx` 的 vi.mock 工厂加 `importAirdropProjects: vi.fn().mockResolvedValue({ imported: 2, failed: [] })`、`fetchTasks: vi.fn().mockResolvedValue([{ key: 't1', name: '任务一', url: 'https://a.io' }])`，末尾追加：

```tsx
describe('useImportProjects', () => {
  it('成功后提示已导入数量并失效三个查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useImportProjects(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({ items: [{ taskKey: 't1', statusId: 1 }] })
    await waitFor(() => expect(invalidate).toHaveBeenCalled())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['airdrop-statuses'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['airdrop-projects'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['airdrop-reminders'] })
  })
})

describe('useTasks', () => {
  it('查询成功返回任务列表', async () => {
    const qc = new QueryClient()
    const { result } = renderHook(() => useTasks(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.[0].name).toBe('任务一')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web -- src/pages/airdrop/hooks.test.tsx`
Expected: FAIL（`useImportProjects is not a function` / `importAirdropProjects is not a function`）

- [ ] **Step 3: 实现**

修改 `web/src/pages/airdrop/hooks.ts`（import 行加 `importAirdropProjects, fetchTasks` 与 `AirdropImportItem`）：

```ts
/** 系统任务清单（导入弹窗与编辑弹窗关联下拉的数据源） */
export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, staleTime: 60_000 })
}

/** 从系统任务批量导入为项目（成功提示数量；部分失败列前 3 条原因） */
export function useImportProjects() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: AirdropImportItem[]) => importAirdropProjects({ items }),
    onSuccess: (res) => {
      message.success(`已导入 ${res.imported} 个项目`)
      if (res.failed.length > 0) {
        message.warning(`导入失败 ${res.failed.length} 项：${res.failed.slice(0, 3).map((f) => `${f.taskKey}（${f.reason}）`).join('、')}`)
      }
      invalidateAll(qc)
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:web -- src/pages/airdrop`
Expected: PASS

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add web/src/pages/airdrop/hooks.ts web/src/pages/airdrop/hooks.test.tsx
git commit -m "feat: 空投导入与任务清单 hooks（含单测）"
```

---

### Task 5: ImportModal 与编辑弹窗关联下拉、页头按钮

**Files:**
- Create: `web/src/pages/airdrop/ImportModal.tsx`
- Modify: `web/src/pages/airdrop/ProjectFormModal.tsx`
- Modify: `web/src/pages/airdrop/index.tsx`

**Interfaces:**
- Consumes：Task 4 的 `useTasks`/`useImportProjects`；Task 6 页头按钮挂载
- Produces：`ImportModal`（默认导出，props `{ open: boolean; onClose: () => void; statuses: AirdropStatusItem[] }`）；`ProjectFormModal` 新增「关联系统任务」下拉（表单值 `taskKey: string | null`）

- [ ] **Step 1: 写组件**

创建 `web/src/pages/airdrop/ImportModal.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Checkbox, Empty, Modal, Select, Spin, Tag, Typography } from 'antd'
import { PRIORITY_LABEL } from './board'
import { useAirdropProjects, useImportProjects, useTasks } from './hooks'
import type { AirdropImportItem, AirdropPriority, AirdropStatusItem, TaskMetaView } from '../../types'

interface RowState { checked: boolean; statusId: number | undefined; priority: AirdropPriority }

/** 从系统任务批量导入弹窗：逐行勾选 + 指定状态列/优先级；已绑定任务置灰 */
export default function ImportModal({ open, onClose, statuses }: { open: boolean; onClose: () => void; statuses: AirdropStatusItem[] }) {
  const tasks = useTasks()
  const projects = useAirdropProjects()
  const importProjects = useImportProjects()
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const boundMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects.data ?? []) if (p.taskKey) map.set(p.taskKey, p.name)
    return map
  }, [projects.data])

  useEffect(() => {
    if (!open) return
    const init: Record<string, RowState> = {}
    for (const t of tasks.data ?? []) init[t.key] = { checked: false, statusId: statuses[0]?.id, priority: 'mid' }
    setRows(init)
  }, [open, tasks.data, statuses])

  const onOk = () => {
    const items: AirdropImportItem[] = []
    for (const t of tasks.data ?? []) {
      const r = rows[t.key]
      if (r?.checked && r.statusId !== undefined) items.push({ taskKey: t.key, statusId: r.statusId, priority: r.priority })
    }
    if (items.length === 0) return
    importProjects.mutate(items, { onSuccess: onClose })
  }

  return (
    <Modal open={open} title="从系统任务导入" onCancel={onClose} onOk={onOk} confirmLoading={importProjects.isPending} okText="导入" cancelText="取消" width={640}>
      {tasks.isPending ? (
        <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
      ) : (tasks.data ?? []).length === 0 ? (
        <Empty description="暂无系统任务" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.data!.map((t: TaskMetaView) => {
            const bound = boundMap.get(t.key)
            const r = rows[t.key]
            return (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: bound ? 0.45 : 1 }}>
                <Checkbox
                  checked={r?.checked ?? false}
                  disabled={Boolean(bound)}
                  onChange={(e) => setRows((prev) => ({ ...prev, [t.key]: { ...prev[t.key], checked: e.target.checked } }))}
                />
                <Typography.Text style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</Typography.Text>
                {bound ? (
                  <Tag>已导入：{bound}</Tag>
                ) : (
                  <>
                    <Select
                      size="small"
                      value={r?.statusId}
                      options={statuses.map((s) => ({ value: s.id, label: s.name }))}
                      onChange={(v) => setRows((prev) => ({ ...prev, [t.key]: { ...prev[t.key], statusId: v } }))}
                      style={{ width: 120 }}
                    />
                    <Select
                      size="small"
                      value={r?.priority}
                      options={(['high', 'mid', 'low'] as const).map((v) => ({ value: v, label: PRIORITY_LABEL[v] }))}
                      onChange={(v) => setRows((prev) => ({ ...prev, [t.key]: { ...prev[t.key], priority: v } }))}
                      style={{ width: 80 }}
                    />
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
```

修改 `web/src/pages/airdrop/ProjectFormModal.tsx`：

（a）import 加 `useTasks`（来自 ./hooks）、`TaskMetaView` 类型；`useAirdropProjects` 用于计算已绑定映射。
（b）ProjectFormValues 加 `taskKey: string | null`：

```ts
export interface ProjectFormValues {
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: Dayjs | null
  link: string | null
  note: string | null
  taskKey: string | null
}
```

（c）useEffect 的 setFieldsValue 加 `taskKey: editing?.taskKey ?? null`（依赖不变）。
（d）表单 deadline 之后（note 之前）加：

```tsx
        <Form.Item name="taskKey" label="关联系统任务" style={{ flex: 1 }}>
          <Select
            allowClear
            placeholder="不关联（纯手动追踪）"
            options={taskOptions}
          />
        </Form.Item>
```

其中 taskOptions 在组件内计算：

```ts
  const tasks = useTasks()
  const projects = useAirdropProjects()
  const taskOptions = useMemo(() => (tasks.data ?? []).map((t: TaskMetaView) => {
    const holder = (projects.data ?? []).find((p) => p.taskKey === t.key && p.id !== editing?.id)
    return { value: t.key, label: holder ? `${t.name}（已关联：${holder.name}）` : t.name, disabled: Boolean(holder) }
  }), [tasks.data, projects.data, editing?.id])
```

（e）onOk 组装加 taskKey：

```ts
    saveProject.mutate(
      { id: editing?.id ?? null, values: { name: values.name, statusId: values.statusId, priority: values.priority, deadline, link: values.link ?? null, note: values.note ?? null, taskKey: values.taskKey ?? null }, todos: cleaned },
      { onSuccess: onClose },
    )
```

（注意：原实现把 `{...values, deadline}` 直接展开传入——含 Dayjs 类型字段 deadline 被覆盖为 string、taskKey 为 string|null 合法；保持展开写法即 `{ ...values, deadline, taskKey: values.taskKey ?? null }` 亦可，两者等价，选后者改动最小）

修改 `web/src/pages/airdrop/index.tsx`（页头 Space 里「新增项目」按钮前加）：

```tsx
  const [importOpen, setImportOpen] = useState(false)
  // 页头按钮组：
  <Button icon={<DownloadOutlined />} onClick={() => setImportOpen(true)}>从系统任务导入</Button>
  // 组件末尾（StatusManageModal 之后）：
  <ImportModal open={importOpen} onClose={() => setImportOpen(false)} statuses={statuses.data} />
```

（`DownloadOutlined` 从 @ant-design/icons import；`ImportModal` import 自 './ImportModal'）

- [ ] **Step 2: 验证**

Run: `npm run typecheck`
Expected: PASS（注意 web/src/pages/profiles/index.tsx 有 2 个 HEAD 存量错误，忽略；新文件零错误）
Run: `npm run test:web`
Expected: PASS（全量 web 测试）

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/airdrop/ImportModal.tsx web/src/pages/airdrop/ProjectFormModal.tsx web/src/pages/airdrop/index.tsx
git commit -m "feat: 空投追踪系统任务导入弹窗与编辑弹窗任务关联下拉"
```

---

### Task 6: 文档同步与全量验证

**Files:**
- Modify: `docs/API-GUIDE.md`

- [ ] **Step 1: 更新用户手册**

（a）8.2 空投追踪页说明末尾补两句：

```markdown
页头「从系统任务导入」可把已登记的系统任务批量导入为项目卡片（逐行勾选并指定状态列与优先级，已导入的任务置灰）；编辑项目弹窗的「关联系统任务」下拉可为手动项目补绑定/解绑系统任务（一个任务只能绑定一个项目）。
```

（b）8.3 REST 接口总表：`POST /api/airdrop/projects` 行描述改为「新建项目（可选绑定系统任务 taskKey）」；`PATCH /api/airdrop/projects/{id}` 行描述改为「更新项目（拖拽流转/绑定解绑 taskKey）」；追加一行：

```markdown
| POST | `/api/airdrop/projects/import` | 批量从系统任务导入项目（逐项失败进 failed 清单） |
```

- [ ] **Step 2: 全量验证**

```bash
npm run typecheck
npm test
npm run test:web
```
Expected: 全部 PASS

- [ ] **Step 3: 提交**

```bash
git add docs/API-GUIDE.md
git commit -m "docs: 空投追踪任务导入功能同步 API-GUIDE"
```

---

## Self-Review 结论

- **Spec 覆盖**：task_key 列+部分唯一索引（Task 1）✓；POST/PATCH taskKey 校验与 400 文案（Task 2）✓；import 接口逐条 failed 清单（Task 2）✓；GET 视图 taskKey（Task 1）✓；deps 加 tasks 挂载（Task 2）✓；ImportModal 逐行指定/置灰（Task 5）✓；编辑弹窗关联下拉可解绑（Task 5）✓；hooks/类型/endpoints（Task 3/4）✓；文档 8.2/8.3 + swagger（Task 2/6）✓；YAGNI 边界（无运行时联动、无分组同步）✓
- **占位符扫描**：无 TBD/TODO；所有步骤含完整代码与命令
- **类型一致性**：`taskKey: string | null` 在 db 类型/Task 3 前端类型/import 接口间一致；`useImportProjects`/`importAirdropProjects`/`AirdropImportItem` 跨 Task 3/4/5 签名一致；`ImportModal` props 与 index.tsx 挂载一致

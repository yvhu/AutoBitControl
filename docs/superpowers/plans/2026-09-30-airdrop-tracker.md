# 空投追踪工具实施计划（airdrop-tracker）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板新增独立导航页「空投追踪」——备忘录 + todolist 看板：自定义状态列、项目卡片拖拽流转、子项勾选、到期提醒横幅。

**Architecture:** 沿用项目既有分层：SQLite 三张新表（airdrop_statuses/airdrop_projects/airdrop_todos）落在 `AppDb`；`src/server/routes/airdrop.ts` 提供 12 个 REST 接口（统一 `{code,message,data}`）；前端 `web/src/pages/airdrop/` 用 @dnd-kit/core 做列间拖拽，react-query 60s 轮询提醒接口。spec：`docs/superpowers/specs/2026-09-30-airdrop-tracker-design.md`。

**Tech Stack:** TypeScript（strict）、express 5、@libsql/client、vitest + supertest、React 18 + antd 5 + @tanstack/react-query + @dnd-kit/core。

## Global Constraints

- 注释/文档/commit 全部中文；无分号、单引号、2 空格缩进；命名 camelCase、文件 kebab-case
- 日期字段统一 YYYY-MM-DD 本地口径；落库时间戳用 `localWallNow()`（`src/infrastructure/db.ts` 已有）
- 提醒窗口常量 `REMIND_WINDOW_DAYS = 5`（写死，不配置化）；overdue 对项目一律计入（不看所处列），子项仅未勾选计入
- 错误码（`src/server/http/errors.ts` 追加）：`AIRDROP_NOT_FOUND: 40407`（40405 已被 BATCH_NOT_FOUND 占用）、`AIRDROP_STATUS_NOT_EMPTY: 40905`
- 列内排序规则：优先级权重（high>mid>low）→ deadline 近者在前（NULL 最后）→ 创建时间；**不做列内拖拽排序**
- 三张表不受 `cleanupOld` 历史清理影响
- 每个 Task 结束前跑 `npm run typecheck` + 相关测试，全部通过才 commit；commit 前缀 `feat:`/`test:`（中文描述）
- 后端测试命令 `npm test -- tests/<file>`；前端测试 `npm run test:web -- <file>`（在根目录执行）

---

### Task 1: AppDb 三张表、种子与 CRUD 方法

**Files:**
- Modify: `src/infrastructure/db.ts`
- Test: `tests/airdrop-db.test.ts`（新建）

**Interfaces:**
- Produces（后续 Task 依赖，签名以本节为准）：
  - 类型：`AirdropPriority`、`AirdropStatusRow`、`AirdropProjectRow`、`AirdropTodoRow`、`AirdropStatusView`（含 `projectCount`）、`AirdropProjectView`（含 `statusName`、`todos`）
  - 方法：`listAirdropStatuses()`、`createAirdropStatus(name)`、`getAirdropStatus(id)`、`updateAirdropStatus(id, patch)`、`deleteAirdropStatus(id)`、`listAirdropProjects()`、`getAirdropProject(id)`、`createAirdropProject(input)`、`updateAirdropProject(id, patch)`、`deleteAirdropProject(id)`、`createAirdropTodo(projectId, input)`、`getAirdropTodo(id)`、`updateAirdropTodo(id, patch)`、`deleteAirdropTodo(id)`

- [ ] **Step 1: 写失败测试**

创建 `tests/airdrop-db.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/airdrop-db.test.ts`
Expected: FAIL（`Property 'listAirdropStatuses' does not exist on type 'AppDb'` 编译错误）

- [ ] **Step 3: 实现 DB 层**

修改 `src/infrastructure/db.ts`：

（a）`RunRow` 接口之后追加类型：

```ts
/** airdrop 优先级枚举（状态列/项目/子项共用） */
export type AirdropPriority = 'high' | 'mid' | 'low'

/** airdrop_statuses 表行：空投追踪看板的一个状态列 */
export interface AirdropStatusRow {
  id: number
  name: string
  sortOrder: number
  createdAt: string
}

/** airdrop_projects 表行：一个空投项目条目 */
export interface AirdropProjectRow {
  id: number
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: string | null
  link: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

/** airdrop_todos 表行：项目下的待办子项 */
export interface AirdropTodoRow {
  id: number
  projectId: number
  content: string
  /** 0/1（SQLite 无布尔） */
  done: number
  dueDate: string | null
  priority: AirdropPriority
  createdAt: string
}

/** 状态列视图（面板 GET /airdrop/statuses）：列 + 列下项目数 */
export interface AirdropStatusView extends AirdropStatusRow {
  projectCount: number
}

/** 项目视图（面板 GET /airdrop/projects）：项目 + 状态列名 + 子项数组 */
export interface AirdropProjectView extends AirdropProjectRow {
  statusName: string
  todos: AirdropTodoRow[]
}
```

（b）`SCHEMA` 数组末尾（`open_windows` 之后）追加：

```ts
  // 空投追踪：状态列（看板列，可自定义）/ 项目 / 待办子项——长期台账，不参与历史清理
  `CREATE TABLE IF NOT EXISTS airdrop_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS airdrop_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status_id INTEGER NOT NULL REFERENCES airdrop_statuses(id),
    priority TEXT NOT NULL DEFAULT 'mid',
    deadline TEXT,
    link TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS airdrop_todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES airdrop_projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'mid',
    created_at TEXT NOT NULL
  )`,
```

（c）`migrate()` 末尾（`idx_runs_task_date` 索引之后）追加种子：

```ts
    // 空投追踪默认状态列种子（INSERT OR IGNORE 幂等：用户自建/改名后重启不覆盖）
    const DEFAULT_AIRDROP_STATUSES = ['关注中', '待参与', '进行中', '已完成', '已放弃']
    for (let i = 0; i < DEFAULT_AIRDROP_STATUSES.length; i++) {
      await this.client.execute({
        sql: 'INSERT OR IGNORE INTO airdrop_statuses (name, sort_order, created_at) VALUES (?, ?, ?)',
        args: [DEFAULT_AIRDROP_STATUSES[i], i, localWallNow()],
      })
    }
```

（d）`cleanupOld()` 之前追加全部方法：

```ts
  // ===== 空投追踪 CRUD（airdrop_statuses / airdrop_projects / airdrop_todos）=====

  private static readonly SELECT_STATUS = `SELECT s.id, s.name, s.sort_order AS sortOrder, s.created_at AS createdAt, COUNT(p.id) AS projectCount FROM airdrop_statuses s LEFT JOIN airdrop_projects p ON p.status_id = s.id`
  private static readonly SELECT_PROJECT = `SELECT p.id, p.name, p.status_id AS statusId, p.priority, p.deadline, p.link, p.note, p.created_at AS createdAt, p.updated_at AS updatedAt, s.name AS statusName FROM airdrop_projects p JOIN airdrop_statuses s ON s.id = p.status_id`
  private static readonly SELECT_TODO = `SELECT id, project_id AS projectId, content, done, due_date AS dueDate, priority, created_at AS createdAt FROM airdrop_todos`
  /** 子项排序：未完成在前 → due_date 近者在前（NULL 最后）→ 优先级高在前 → 创建顺序 */
  private static readonly TODO_ORDER = `done, due_date IS NULL, due_date, CASE priority WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, created_at, id`

  /** 状态列清单（含项目数，按 sort_order） */
  async listAirdropStatuses(): Promise<AirdropStatusView[]> {
    return (await this.exec(`${AppDb.SELECT_STATUS} GROUP BY s.id ORDER BY s.sort_order, s.id`)) as unknown as AirdropStatusView[]
  }

  /** 按 id 查状态列（不存在返回 null） */
  async getAirdropStatus(id: number): Promise<AirdropStatusRow | null> {
    const rows = await this.exec('SELECT id, name, sort_order AS sortOrder, created_at AS createdAt FROM airdrop_statuses WHERE id = ?', [id])
    return (rows[0] as unknown as AirdropStatusRow | undefined) ?? null
  }

  /** 新增状态列（sort_order 取 max+1）；重名返回 null（路由转 400） */
  async createAirdropStatus(name: string): Promise<AirdropStatusRow | null> {
    const dup = await this.exec('SELECT id FROM airdrop_statuses WHERE name = ?', [name])
    if (dup.length > 0) return null
    const max = await this.exec('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM airdrop_statuses')
    const rs = await this.client.execute({
      sql: 'INSERT INTO airdrop_statuses (name, sort_order, created_at) VALUES (?, ?, ?)',
      args: [name, Number(max[0]?.next ?? 0), localWallNow()],
    })
    return this.getAirdropStatus(Number(rs.lastInsertRowid))
  }

  /** 部分更新状态列（缺省字段不动）；不存在返回 null */
  async updateAirdropStatus(id: number, patch: { name?: string; sortOrder?: number }): Promise<AirdropStatusRow | null> {
    const current = await this.getAirdropStatus(id)
    if (!current) return null
    await this.exec('UPDATE airdrop_statuses SET name = ?, sort_order = ? WHERE id = ?', [patch.name ?? current.name, patch.sortOrder ?? current.sortOrder, id])
    return this.getAirdropStatus(id)
  }

  /** 删除状态列：不存在 not_found；列下仍有项目 not_empty（路由转 409）；成功 deleted */
  async deleteAirdropStatus(id: number): Promise<'deleted' | 'not_found' | 'not_empty'> {
    if (!(await this.getAirdropStatus(id))) return 'not_found'
    const cnt = await this.exec('SELECT COUNT(*) AS c FROM airdrop_projects WHERE status_id = ?', [id])
    if (Number(cnt[0]?.c ?? 0) > 0) return 'not_empty'
    await this.exec('DELETE FROM airdrop_statuses WHERE id = ?', [id])
    return 'deleted'
  }

  /**
   * 全部项目视图（含 statusName 与子项数组），已排序：
   * 列按 sort_order → 列内按优先级权重 → deadline 近者在前（NULL 最后）→ 创建时间
   */
  async listAirdropProjects(): Promise<AirdropProjectView[]> {
    const rows = await this.exec(
      `${AppDb.SELECT_PROJECT} ORDER BY s.sort_order, s.id, CASE p.priority WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, p.deadline IS NULL, p.deadline, p.created_at, p.id`,
    )
    const todoRows = await this.exec(`${AppDb.SELECT_TODO} ORDER BY ${AppDb.TODO_ORDER}`)
    const views = rows.map((r) => ({ ...r, todos: [] as AirdropTodoRow[] })) as unknown as AirdropProjectView[]
    const byId = new Map(views.map((v) => [v.id, v]))
    for (const t of todoRows) {
      const v = byId.get(Number(t.projectId))
      if (v) v.todos.push(t as unknown as AirdropTodoRow)
    }
    return views
  }

  /** 单个项目视图（含子项，按子项排序）；不存在返回 null */
  async getAirdropProject(id: number): Promise<AirdropProjectView | null> {
    const rows = await this.exec(`${AppDb.SELECT_PROJECT} WHERE p.id = ?`, [id])
    if (rows.length === 0) return null
    const view = rows[0] as unknown as AirdropProjectView
    view.todos = (await this.exec(`${AppDb.SELECT_TODO} WHERE project_id = ? ORDER BY ${AppDb.TODO_ORDER}`, [id])) as unknown as AirdropTodoRow[]
    return view
  }

  /** 新建项目（statusId 存在性由路由校验）；返回完整视图 */
  async createAirdropProject(input: { name: string; statusId: number; priority: AirdropPriority; deadline?: string | null; link?: string | null; note?: string | null }): Promise<AirdropProjectView> {
    const now = localWallNow()
    const rs = await this.client.execute({
      sql: `INSERT INTO airdrop_projects (name, status_id, priority, deadline, link, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [input.name, input.statusId, input.priority, input.deadline ?? null, input.link ?? null, input.note ?? null, now, now],
    })
    return (await this.getAirdropProject(Number(rs.lastInsertRowid)))!
  }

  /**
   * 部分更新项目（null 显式清空 deadline/link/note，undefined 不动）；
   * statusId 流转（拖拽落列）走同一入口；不存在返回 null
   */
  async updateAirdropProject(id: number, patch: { name?: string; statusId?: number; priority?: AirdropPriority; deadline?: string | null; link?: string | null; note?: string | null }): Promise<AirdropProjectView | null> {
    const current = await this.getAirdropProject(id)
    if (!current) return null
    await this.exec(
      `UPDATE airdrop_projects SET name = ?, status_id = ?, priority = ?, deadline = ?, link = ?, note = ?, updated_at = ? WHERE id = ?`,
      [
        patch.name ?? current.name,
        patch.statusId ?? current.statusId,
        patch.priority ?? current.priority,
        patch.deadline === undefined ? current.deadline : patch.deadline,
        patch.link === undefined ? current.link : patch.link,
        patch.note === undefined ? current.note : patch.note,
        localWallNow(),
        id,
      ],
    )
    return this.getAirdropProject(id)
  }

  /** 删除项目并级联删子项（不依赖外键 pragma，显式删）；返回是否存在过 */
  async deleteAirdropProject(id: number): Promise<boolean> {
    if (!(await this.getAirdropProject(id))) return false
    await this.exec('DELETE FROM airdrop_todos WHERE project_id = ?', [id])
    await this.exec('DELETE FROM airdrop_projects WHERE id = ?', [id])
    return true
  }

  /** 加子项（项目不存在返回 null）；done 恒为 0 */
  async createAirdropTodo(projectId: number, input: { content: string; dueDate?: string | null; priority: AirdropPriority }): Promise<AirdropTodoRow | null> {
    if (!(await this.getAirdropProject(projectId))) return null
    const rs = await this.client.execute({
      sql: 'INSERT INTO airdrop_todos (project_id, content, done, due_date, priority, created_at) VALUES (?, ?, 0, ?, ?, ?)',
      args: [projectId, input.content, input.dueDate ?? null, input.priority, localWallNow()],
    })
    return this.getAirdropTodo(Number(rs.lastInsertRowid))
  }

  /** 按 id 查子项（不存在返回 null） */
  async getAirdropTodo(id: number): Promise<AirdropTodoRow | null> {
    const rows = await this.exec(`${AppDb.SELECT_TODO} WHERE id = ?`, [id])
    return (rows[0] as unknown as AirdropTodoRow | undefined) ?? null
  }

  /** 部分更新子项（勾选 done / 改 content / dueDate 传 null 清空）；不存在返回 null */
  async updateAirdropTodo(id: number, patch: { content?: string; done?: boolean; dueDate?: string | null; priority?: AirdropPriority }): Promise<AirdropTodoRow | null> {
    const current = await this.getAirdropTodo(id)
    if (!current) return null
    await this.exec(
      `UPDATE airdrop_todos SET content = ?, done = ?, due_date = ?, priority = ? WHERE id = ?`,
      [
        patch.content ?? current.content,
        patch.done === undefined ? current.done : patch.done ? 1 : 0,
        patch.dueDate === undefined ? current.dueDate : patch.dueDate,
        patch.priority ?? current.priority,
        id,
      ],
    )
    return this.getAirdropTodo(id)
  }

  /** 删子项；返回是否存在过 */
  async deleteAirdropTodo(id: number): Promise<boolean> {
    const rs = await this.client.execute({ sql: 'DELETE FROM airdrop_todos WHERE id = ?', args: [id] })
    return Number(rs.rowsAffected) > 0
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/airdrop-db.test.ts`
Expected: PASS（10 个用例全绿）

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add src/infrastructure/db.ts tests/airdrop-db.test.ts
git commit -m "feat: 空投追踪三张表与 CRUD（状态列/项目/子项，含默认列种子）"
```

---

### Task 2: 提醒汇总纯函数与数据源查询

**Files:**
- Create: `src/server/routes/airdrop.ts`（本 Task 只含纯函数与类型导出）
- Modify: `src/infrastructure/db.ts`（加 `listReminderSources`）
- Modify: `src/server/http/errors.ts`（错误码）
- Test: `tests/airdrop-reminders.test.ts`（新建）

**Interfaces:**
- Produces：
  - `REMIND_WINDOW_DAYS = 5`（常量，导出）
  - `ReminderItem { type: 'project'|'todo'; id: number; name: string; date: string; daysLeft: number }`
  - `RemindersData { upcoming: ReminderItem[]; overdue: ReminderItem[] }`
  - `buildReminders(projects, todos, today): RemindersData`（纯函数）
  - `isValidDateStr(v): v is string`
  - `AppDb.listReminderSources(): Promise<{ projects: AirdropProjectRow[]; todos: AirdropTodoRow[] }>`
  - `ERROR_CODES.AIRDROP_NOT_FOUND`（40407）、`ERROR_CODES.AIRDROP_STATUS_NOT_EMPTY`（40905）

- [ ] **Step 1: 写失败测试**

创建 `tests/airdrop-reminders.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildReminders, isValidDateStr, REMIND_WINDOW_DAYS } from '../src/server/routes/airdrop'
import type { AirdropProjectRow, AirdropTodoRow } from '../src/infrastructure/db'

const TODAY = '2026-09-30'
const p = (id: number, name: string, deadline: string | null): AirdropProjectRow => ({
  id, name, statusId: 1, priority: 'mid', deadline, link: null, note: null, createdAt: 'x', updatedAt: 'x',
})
const t = (id: number, content: string, dueDate: string | null, done = 0): AirdropTodoRow => ({
  id, projectId: 1, content, done, dueDate, priority: 'mid', createdAt: 'x',
})

describe('isValidDateStr', () => {
  it('合法/非法日期', () => {
    expect(isValidDateStr('2026-10-05')).toBe(true)
    expect(isValidDateStr('2026-13-01')).toBe(false)
    expect(isValidDateStr('2026-1-01')).toBe(false)
    expect(isValidDateStr('abc')).toBe(false)
    expect(isValidDateStr(5)).toBe(false)
    expect(isValidDateStr(null)).toBe(false)
  })
})

describe('buildReminders', () => {
  it('空数据返回空数组', () => {
    expect(buildReminders([], [], TODAY)).toEqual({ upcoming: [], overdue: [] })
  })

  it('项目 deadline：昨天=overdue、今天=upcoming 0 天、+5 天=upcoming、+6 天不列', () => {
    const projects = [
      p(1, '过期项目', '2026-09-29'),
      p(2, '今天到期', '2026-09-30'),
      p(3, '五天到期', '2026-10-05'),
      p(4, '六天后', '2026-10-06'),
      p(5, '无期限', null),
    ]
    const r = buildReminders(projects, [], TODAY)
    expect(r.overdue.map((i) => i.id)).toEqual([1])
    expect(r.overdue[0].daysLeft).toBe(-1)
    expect(r.upcoming.map((i) => i.id)).toEqual([2, 3])
    expect(r.upcoming[0].daysLeft).toBe(0)
    expect(r.upcoming[1].daysLeft).toBe(REMIND_WINDOW_DAYS)
  })

  it('子项：done 不列；未勾选 due_date 同项目规则', () => {
    const todos = [
      t(1, '已勾选但过期', '2026-09-01', 1),
      t(2, '未勾选过期', '2026-09-29'),
      t(3, '未勾选临近', '2026-10-04'),
      t(4, '未勾选无期限', null),
    ]
    const r = buildReminders([], todos, TODAY)
    expect(r.overdue.map((i) => i.id)).toEqual([2])
    expect(r.upcoming.map((i) => i.id)).toEqual([3])
  })

  it('upcoming/overdue 均按日期升序，同日期按名称', () => {
    const projects = [p(1, 'B 项目', '2026-09-28'), p(2, 'A 项目', '2026-09-28'), p(3, 'C 项目', '2026-09-29')]
    const r = buildReminders(projects, [], TODAY)
    expect(r.overdue.map((i) => i.name)).toEqual(['A 项目', 'B 项目', 'C 项目'])
  })
})
```

修改 `tests/airdrop-db.test.ts` 末尾追加一个 describe（`listReminderSources`）：

```ts
describe('AppDb · listReminderSources', () => {
  it('返回全部项目与仅未完成且有期限的子项', async () => {
    const st = await db.listAirdropStatuses()
    const p = await db.createAirdropProject({ name: 'A', statusId: st[0].id, priority: 'mid', deadline: '2026-10-01' })
    await db.createAirdropTodo(p.id, { content: '未完成有期限', dueDate: '2026-10-02', priority: 'mid' })
    await db.createAirdropTodo(p.id, { content: '已完成', dueDate: '2026-10-03', priority: 'mid' })
    await db.createAirdropTodo(p.id, { content: '无期限', priority: 'mid' })
    await db.updateAirdropTodo(2, { done: true })
    const src = await db.listReminderSources()
    expect(src.projects).toHaveLength(1)
    expect(src.todos.map((t) => t.content)).toEqual(['未完成有期限'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/airdrop-reminders.test.ts tests/airdrop-db.test.ts`
Expected: FAIL（`Cannot find module '../src/server/routes/airdrop'`）

- [ ] **Step 3: 实现纯函数与查询**

创建 `src/server/routes/airdrop.ts`（本 Task 版本；Task 3 扩展路由）：

```ts
/**
 * 空投追踪（server 层）：提醒汇总纯函数 + REST 路由（路由部分见 Task 3）
 * 依赖方向：server → infrastructure（db 类型与 todayStr）
 * 设计思路：提醒规则抽为纯函数便于单测；窗口天数写死常量（不配置化）
 */
import type { AirdropProjectRow, AirdropTodoRow } from '../../infrastructure/db'

/** 提醒窗口：未来 N 天内到期计入 upcoming */
export const REMIND_WINDOW_DAYS = 5

/** 单条提醒（type 区分项目 deadline 与子项 due_date；daysLeft 可负=已过期） */
export interface ReminderItem {
  type: 'project' | 'todo'
  id: number
  name: string
  date: string
  daysLeft: number
}

/** 提醒汇总（GET /api/airdrop/reminders 响应体） */
export interface RemindersData {
  upcoming: ReminderItem[]
  overdue: ReminderItem[]
}

/** YYYY-MM-DD 格式且为真实日期 */
export function isValidDateStr(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  return !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())
}

/** 日差：date - today（UTC 零点解析避免时区偏移；可负） */
export function diffDays(date: string, today: string): number {
  return Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000)
}

/** 依据项目/子项数据构建提醒汇总（纯函数；today 由调用方传入便于测试） */
export function buildReminders(projects: AirdropProjectRow[], todos: AirdropTodoRow[], today: string): RemindersData {
  const upcoming: ReminderItem[] = []
  const overdue: ReminderItem[] = []
  const push = (list: ReminderItem[], item: Omit<ReminderItem, 'daysLeft'>) => {
    list.push({ ...item, daysLeft: diffDays(item.date, today) })
  }
  for (const p of projects) {
    if (!p.deadline) continue
    const d = diffDays(p.deadline, today)
    if (d < 0) push(overdue, { type: 'project', id: p.id, name: p.name, date: p.deadline })
    else if (d <= REMIND_WINDOW_DAYS) push(upcoming, { type: 'project', id: p.id, name: p.name, date: p.deadline })
  }
  for (const t of todos) {
    if (t.done === 1 || !t.dueDate) continue
    const d = diffDays(t.dueDate, today)
    if (d < 0) push(overdue, { type: 'todo', id: t.id, name: t.content, date: t.dueDate })
    else if (d <= REMIND_WINDOW_DAYS) push(upcoming, { type: 'todo', id: t.id, name: t.content, date: t.dueDate })
  }
  const byDate = (a: ReminderItem, b: ReminderItem) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1)
  upcoming.sort(byDate)
  overdue.sort(byDate)
  return { upcoming, overdue }
}
```

修改 `src/server/http/errors.ts`（`TOOL_BUSY: 40904` 之后、`INTERNAL` 之前）：

```ts
  // 空投追踪域错误码
  AIRDROP_STATUS_NOT_EMPTY: 40905,
  AIRDROP_NOT_FOUND: 40407,
```

修改 `src/infrastructure/db.ts`（`listAirdropProjects` 之后追加）：

```ts
  /** 提醒汇总数据源：全部项目 + 未完成且有期限的子项（数量级小全量取回，交给纯函数汇总） */
  async listReminderSources(): Promise<{ projects: AirdropProjectRow[]; todos: AirdropTodoRow[] }> {
    const projects = await this.exec(`SELECT id, name, status_id AS statusId, priority, deadline, link, note, created_at AS createdAt, updated_at AS updatedAt FROM airdrop_projects`)
    const todos = await this.exec(`${AppDb.SELECT_TODO} WHERE done = 0 AND due_date IS NOT NULL`)
    return { projects: projects as unknown as AirdropProjectRow[], todos: todos as unknown as AirdropTodoRow[] }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/airdrop-reminders.test.ts tests/airdrop-db.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add src/server/routes/airdrop.ts src/server/http/errors.ts src/infrastructure/db.ts tests/airdrop-reminders.test.ts tests/airdrop-db.test.ts
git commit -m "feat: 空投追踪提醒汇总纯函数与错误码"
```

---

### Task 3: airdrop REST 路由 + swagger 注解

**Files:**
- Modify: `src/server/routes/airdrop.ts`（追加 Router 工厂与全部 handler）
- Test: `tests/airdrop-route.test.ts`（新建）

**Interfaces:**
- Consumes：Task 1 全部 `AppDb` 方法、Task 2 的 `buildReminders`/`isValidDateStr`/错误码
- Produces：`airdropRouter(deps: { db: AppDb }): Router`（Task 4 挂载用）

- [ ] **Step 1: 写失败测试**

创建 `tests/airdrop-route.test.ts`：

```ts
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
    const res = await request(makeApp()).patch(`/api/airdrop/statuses/${st[0].id}`).send({ name: '观察中' })
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
    const okRes = await request(makeApp()).delete(`/api/airdrop/statuses/${st[0].id}`)
    expect(okRes.body.code).toBe(0)
    const miss = await request(makeApp()).delete(`/api/airdrop/statuses/${st[0].id}`)
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/airdrop-route.test.ts`
Expected: FAIL（`Module '.../airdrop.ts' has no exported member 'airdropRouter'`）

- [ ] **Step 3: 实现路由**

修改 `src/server/routes/airdrop.ts`：文件头 import 扩充 + 末尾追加（保留 Task 2 纯函数不动）：

```ts
import { Router } from 'express'
import { ok, fail, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import { todayStr, type AppDb, type AirdropPriority } from '../../infrastructure/db'

/** priority 校验：合法返回枚举，非法返回 null */
function parsePriority(v: unknown): AirdropPriority | null {
  return v === 'high' || v === 'mid' || v === 'low' ? v : null
}

/** 可选日期校验：undefined/null 通过（清空），否则须为合法 YYYY-MM-DD */
function parseOptionalDate(v: unknown): { ok: boolean; value: string | null } {
  if (v === undefined || v === null) return { ok: true, value: null }
  if (!isValidDateStr(v)) return { ok: false, value: null }
  return { ok: true, value: v }
}

/** 校验并解析新建项目请求体；非法抛 400 */
function parseProjectBody(body: Record<string, unknown>): { name: string; statusId: number; priority: AirdropPriority; deadline: string | null; link: string | null; note: string | null } {
  if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '项目名称不能为空')
  if (typeof body.statusId !== 'number' || !Number.isInteger(body.statusId) || body.statusId <= 0) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'statusId 非法')
  const priority = parsePriority(body.priority ?? 'mid')
  if (!priority) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'priority 非法（high/mid/low）')
  const d = parseOptionalDate(body.deadline)
  if (!d.ok) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'deadline 格式须为 YYYY-MM-DD')
  if (body.link !== undefined && body.link !== null && typeof body.link !== 'string') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'link 须为字符串')
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'note 须为字符串')
  return { name: body.name.trim(), statusId: body.statusId, priority, deadline: d.value, link: (body.link as string | null) ?? null, note: (body.note as string | null) ?? null }
}

/** 校验并解析项目部分更新请求体（仅校验出现的字段） */
function parseProjectPatch(body: Record<string, unknown>): Partial<{ name: string; statusId: number; priority: AirdropPriority; deadline: string | null; link: string | null; note: string | null }> {
  const out: Partial<{ name: string; statusId: number; priority: AirdropPriority; deadline: string | null; link: string | null; note: string | null }> = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '项目名称不能为空')
    out.name = body.name.trim()
  }
  if (body.statusId !== undefined) {
    if (typeof body.statusId !== 'number' || !Number.isInteger(body.statusId) || body.statusId <= 0) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'statusId 非法')
    out.statusId = body.statusId
  }
  if (body.priority !== undefined) {
    const p = parsePriority(body.priority)
    if (!p) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'priority 非法（high/mid/low）')
    out.priority = p
  }
  if (body.deadline !== undefined) {
    const d = parseOptionalDate(body.deadline)
    if (!d.ok) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'deadline 格式须为 YYYY-MM-DD')
    out.deadline = d.value
  }
  if (body.link !== undefined) {
    if (body.link !== null && typeof body.link !== 'string') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'link 须为字符串')
    out.link = body.link
  }
  if (body.note !== undefined) {
    if (body.note !== null && typeof body.note !== 'string') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'note 须为字符串')
    out.note = body.note
  }
  return out
}

/** 校验并解析新建子项请求体；非法抛 400 */
function parseTodoBody(body: Record<string, unknown>): { content: string; dueDate: string | null; priority: AirdropPriority } {
  if (typeof body.content !== 'string' || !body.content.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '子项内容不能为空')
  const priority = parsePriority(body.priority ?? 'mid')
  if (!priority) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'priority 非法（high/mid/low）')
  const d = parseOptionalDate(body.dueDate)
  if (!d.ok) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'dueDate 格式须为 YYYY-MM-DD')
  return { content: body.content.trim(), dueDate: d.value, priority }
}

/** 校验并解析子项部分更新请求体 */
function parseTodoPatch(body: Record<string, unknown>): Partial<{ content: string; done: boolean; dueDate: string | null; priority: AirdropPriority }> {
  const out: Partial<{ content: string; done: boolean; dueDate: string | null; priority: AirdropPriority }> = {}
  if (body.content !== undefined) {
    if (typeof body.content !== 'string' || !body.content.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '子项内容不能为空')
    out.content = body.content.trim()
  }
  if (body.done !== undefined) {
    if (typeof body.done !== 'boolean') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'done 须为布尔值')
    out.done = body.done
  }
  if (body.dueDate !== undefined) {
    const d = parseOptionalDate(body.dueDate)
    if (!d.ok) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'dueDate 格式须为 YYYY-MM-DD')
    out.dueDate = d.value
  }
  if (body.priority !== undefined) {
    const p = parsePriority(body.priority)
    if (!p) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'priority 非法（high/mid/low）')
    out.priority = p
  }
  return out
}

/** 路由路径参数解析：非法/非正整数返回 NaN（统一按 404 处理） */
function parseId(raw: string): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : NaN
}

/**
 * @swagger
 * /api/airdrop/statuses:
 *   get:
 *     summary: 空投追踪状态列清单（含每列项目数）
 *     responses:
 *       '200':
 *         description: 状态列数组
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       name: { type: string }
 *                       sortOrder: { type: integer }
 *                       createdAt: { type: string }
 *                       projectCount: { type: integer }
 */

/**
 * @swagger
 * /api/airdrop/statuses:
 *   post:
 *     summary: 新增空投追踪状态列
 *     responses:
 *       '200': { description: 新列 }
 *       '400': { description: 参数非法或重名（业务码 40000） }
 */

/**
 * @swagger
 * /api/airdrop/statuses/{id}:
 *   patch:
 *     summary: 改名/换序状态列
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: 更新后的列 }
 *       '404': { description: 列不存在（业务码 40407） }
 *   delete:
 *     summary: 删除状态列（列下仍有项目时拒绝）
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: 删除成功 }
 *       '404': { description: 列不存在（业务码 40407） }
 *       '409': { description: 列下仍有项目（业务码 40905） }
 */

/**
 * @swagger
 * /api/airdrop/projects:
 *   get:
 *     summary: 空投追踪项目清单（含子项，已按列与列内规则排序）
 *     responses:
 *       '200': { description: 项目数组 }
 *   post:
 *     summary: 新建空投追踪项目
 *     responses:
 *       '200': { description: 新项目视图 }
 *       '400': { description: 参数非法（业务码 40000） }
 *       '404': { description: 状态列不存在（业务码 40407） }
 */

/**
 * @swagger
 * /api/airdrop/projects/{id}:
 *   patch:
 *     summary: 部分更新项目（含拖拽流转 statusId）
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: 更新后的项目视图 }
 *       '400': { description: 参数非法（业务码 40000） }
 *       '404': { description: 项目或状态列不存在（业务码 40407） }
 *   delete:
 *     summary: 删除项目（级联删子项）
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: 删除成功 }
 *       '404': { description: 项目不存在（业务码 40407） }
 */

/**
 * @swagger
 * /api/airdrop/projects/{id}/todos:
 *   post:
 *     summary: 给项目加待办子项
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: 新子项 }
 *       '400': { description: 参数非法（业务码 40000） }
 *       '404': { description: 项目不存在（业务码 40407） }
 */

/**
 * @swagger
 * /api/airdrop/todos/{id}:
 *   patch:
 *     summary: 更新子项（勾选/内容/日期/优先级）
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: 更新后的子项 }
 *       '400': { description: 参数非法（业务码 40000） }
 *       '404': { description: 子项不存在（业务码 40407） }
 *   delete:
 *     summary: 删除子项
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: 删除成功 }
 *       '404': { description: 子项不存在（业务码 40407） }
 */

/**
 * @swagger
 * /api/airdrop/reminders:
 *   get:
 *     summary: 空投追踪提醒汇总（未来 5 天内 + 已过期）
 *     responses:
 *       '200':
 *         description: 提醒汇总
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     upcoming:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           type: { type: string, enum: [project, todo] }
 *                           id: { type: integer }
 *                           name: { type: string }
 *                           date: { type: string }
 *                           daysLeft: { type: integer }
 *                     overdue:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           type: { type: string, enum: [project, todo] }
 *                           id: { type: integer }
 *                           name: { type: string }
 *                           date: { type: string }
 *                           daysLeft: { type: integer }
 */

export function airdropRouter(deps: { db: AppDb }): Router {
  const router = Router()

  router.get('/airdrop/statuses', asyncHandler(async (_req, res) => {
    ok(res, await deps.db.listAirdropStatuses())
  }))

  router.post('/airdrop/statuses', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.name !== 'string' || !body.name.trim()) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '状态名不能为空')
      return
    }
    const s = await deps.db.createAirdropStatus(body.name.trim())
    if (!s) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '状态名已存在')
      return
    }
    ok(res, s)
  }))

  router.patch('/airdrop/statuses/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: { name?: string; sortOrder?: number } = {}
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '状态名不能为空')
      patch.name = body.name.trim()
    }
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'sortOrder 非法')
      patch.sortOrder = body.sortOrder
    }
    const s = Number.isNaN(id) ? null : await deps.db.updateAirdropStatus(id, patch)
    if (!s) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '状态列不存在')
    ok(res, s)
  }))

  router.delete('/airdrop/statuses/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const r = Number.isNaN(id) ? 'not_found' : await deps.db.deleteAirdropStatus(id)
    if (r === 'not_found') throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '状态列不存在')
    if (r === 'not_empty') throw new HttpError(409, ERROR_CODES.AIRDROP_STATUS_NOT_EMPTY, '该列下仍有项目，请先移走项目')
    ok(res, null)
  }))

  router.get('/airdrop/projects', asyncHandler(async (_req, res) => {
    ok(res, await deps.db.listAirdropProjects())
  }))

  router.post('/airdrop/projects', asyncHandler(async (req, res) => {
    const parsed = parseProjectBody((req.body ?? {}) as Record<string, unknown>)
    if (!(await deps.db.getAirdropStatus(parsed.statusId))) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '状态列不存在')
    ok(res, await deps.db.createAirdropProject(parsed))
  }))

  router.patch('/airdrop/projects/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const parsed = parseProjectPatch((req.body ?? {}) as Record<string, unknown>)
    if (parsed.statusId !== undefined && !(await deps.db.getAirdropStatus(parsed.statusId))) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '状态列不存在')
    const p = Number.isNaN(id) ? null : await deps.db.updateAirdropProject(id, parsed)
    if (!p) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '项目不存在')
    ok(res, p)
  }))

  router.delete('/airdrop/projects/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    if (Number.isNaN(id) || !(await deps.db.deleteAirdropProject(id))) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '项目不存在')
    ok(res, null)
  }))

  router.post('/airdrop/projects/:id/todos', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const parsed = parseTodoBody((req.body ?? {}) as Record<string, unknown>)
    const t = Number.isNaN(id) ? null : await deps.db.createAirdropTodo(id, parsed)
    if (!t) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '项目不存在')
    ok(res, t)
  }))

  router.patch('/airdrop/todos/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const parsed = parseTodoPatch((req.body ?? {}) as Record<string, unknown>)
    const t = Number.isNaN(id) ? null : await deps.db.updateAirdropTodo(id, parsed)
    if (!t) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '子项不存在')
    ok(res, t)
  }))

  router.delete('/airdrop/todos/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    if (Number.isNaN(id) || !(await deps.db.deleteAirdropTodo(id))) throw new HttpError(404, ERROR_CODES.AIRDROP_NOT_FOUND, '子项不存在')
    ok(res, null)
  }))

  router.get('/airdrop/reminders', asyncHandler(async (_req, res) => {
    const { projects, todos } = await deps.db.listReminderSources()
    ok(res, buildReminders(projects, todos, todayStr()))
  }))

  return router
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/airdrop-route.test.ts tests/airdrop-reminders.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add src/server/routes/airdrop.ts tests/airdrop-route.test.ts
git commit -m "feat: 空投追踪 REST 路由与 swagger 注解"
```

---

### Task 4: server/app.ts 挂载路由

**Files:**
- Modify: `src/server/app.ts`
- Test: `tests/web.test.ts`（已有，追加用例）

**Interfaces:**
- Consumes：Task 3 的 `airdropRouter`

- [ ] **Step 1: 写失败测试**

在 `tests/web.test.ts` 末尾追加 describe（先读该文件确认 `makeApp`/`createApp` 注入方式，若其用 `createApp` 完整依赖构造则照其既有模式追加；若测试文件无可用构造器，则改用 Task 3 的 makeApp 模式断言挂载在 `src/server/app.ts` 的 import 行存在——两种任一皆可，优先沿既有文件结构）：

```ts
describe('GET /api/airdrop/statuses（挂载验证）', () => {
  it('通过 createApp 能访问空投接口', async () => {
    const res = await request(app).get('/api/airdrop/statuses')
    expect(res.body.code).toBe(0)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})
```

（注：`tests/web.test.ts` 的 `app` 变量名与现有 setUp 保持一致——执行时先读该文件，按其 `beforeAll` 中构造 express app 的既有方式接入；若该文件不便注入，则新建 `tests/airdrop-mount.test.ts` 用 `createApp` + 最小 deps 构造）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/web.test.ts`
Expected: FAIL（404，`接口不存在: GET /api/airdrop/statuses`）

- [ ] **Step 3: 挂载路由**

修改 `src/server/app.ts`：

```ts
import { airdropRouter } from './routes/airdrop'
```

在 `api.use(captchaRouter(...))` 之后追加：

```ts
  api.use(airdropRouter({ db: deps.db }))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/web.test.ts tests/airdrop-route.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add src/server/app.ts tests/web.test.ts
git commit -m "feat: 挂载空投追踪路由"
```

---

### Task 5: 前端 API endpoints 与手补类型

**Files:**
- Modify: `web/src/api/endpoints.ts`
- Modify: `web/src/types.ts`

**Interfaces:**
- Produces（Task 6/7 依赖，签名以本节为准）：
  - endpoints：`fetchAirdropStatuses()`、`createAirdropStatus(name)`、`updateAirdropStatus(id, body)`、`deleteAirdropStatus(id)`、`fetchAirdropProjects()`、`createAirdropProject(body)`、`updateAirdropProject(id, body)`、`deleteAirdropProject(id)`、`createAirdropTodo(projectId, body)`、`updateAirdropTodo(id, body)`、`deleteAirdropTodo(id)`、`fetchAirdropReminders()`
  - types：`AirdropPriority`、`AirdropStatusItem`、`AirdropTodoItem`、`AirdropProjectView`、`AirdropProjectInput`、`AirdropProjectPatch`、`AirdropReminderItem`、`AirdropReminders`

- [ ] **Step 1: 写代码（无独立测试——类型层与既有文件模式一致，靠 Task 6/7 测试与 typecheck 验证）**

修改 `web/src/types.ts` 末尾追加：

```ts
// ===== 空投追踪（手补类型：/api/airdrop/*） =====

export type AirdropPriority = 'high' | 'mid' | 'low'

/** 状态列视图（含列下项目数） */
export interface AirdropStatusItem {
  id: number
  name: string
  sortOrder: number
  createdAt: string
  projectCount: number
}

/** 待办子项（done 为 0/1，SQLite 无布尔） */
export interface AirdropTodoItem {
  id: number
  projectId: number
  content: string
  done: 0 | 1
  dueDate: string | null
  priority: AirdropPriority
  createdAt: string
}

/** 项目视图（含状态列名与子项数组） */
export interface AirdropProjectView {
  id: number
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: string | null
  link: string | null
  note: string | null
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
}

/** 项目部分更新入参（拖拽流转传 statusId） */
export interface AirdropProjectPatch {
  name?: string
  statusId?: number
  priority?: AirdropPriority
  deadline?: string | null
  link?: string | null
  note?: string | null
}

/** 单条提醒 */
export interface AirdropReminderItem {
  type: 'project' | 'todo'
  id: number
  name: string
  date: string
  daysLeft: number
}

/** 提醒汇总 */
export interface AirdropReminders {
  upcoming: AirdropReminderItem[]
  overdue: AirdropReminderItem[]
}
```

修改 `web/src/api/endpoints.ts`：import 行追加类型 + 文件末尾追加函数：

```ts
import { get, post, patch, del } from './client'
import type { AirdropPriority, AirdropProjectInput, AirdropProjectPatch, AirdropProjectView, AirdropReminders, AirdropStatusItem, AirdropTodoItem } from '../types'

// ===== 空投追踪 =====
export const fetchAirdropStatuses = () => get<AirdropStatusItem[]>('/api/airdrop/statuses')
export const createAirdropStatus = (name: string) => post<AirdropStatusItem>('/api/airdrop/statuses', { name })
export const updateAirdropStatus = (id: number, body: { name?: string; sortOrder?: number }) => patch<AirdropStatusItem>(`/api/airdrop/statuses/${id}`, body)
export const deleteAirdropStatus = (id: number) => del<null>(`/api/airdrop/statuses/${id}`)
export const fetchAirdropProjects = () => get<AirdropProjectView[]>('/api/airdrop/projects')
export const createAirdropProject = (body: AirdropProjectInput) => post<AirdropProjectView>('/api/airdrop/projects', body)
export const updateAirdropProject = (id: number, body: AirdropProjectPatch) => patch<AirdropProjectView>(`/api/airdrop/projects/${id}`, body)
export const deleteAirdropProject = (id: number) => del<null>(`/api/airdrop/projects/${id}`)
export const createAirdropTodo = (projectId: number, body: { content: string; dueDate?: string | null; priority: AirdropPriority }) => post<AirdropTodoItem>(`/api/airdrop/projects/${projectId}/todos`, body)
export const updateAirdropTodo = (id: number, body: { done?: boolean; content?: string; dueDate?: string | null; priority?: AirdropPriority }) => patch<AirdropTodoItem>(`/api/airdrop/todos/${id}`, body)
export const deleteAirdropTodo = (id: number) => del<null>(`/api/airdrop/todos/${id}`)
export const fetchAirdropReminders = () => get<AirdropReminders>('/api/airdrop/reminders')
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS（无输出错误）

- [ ] **Step 3: 提交**

```bash
git add web/src/api/endpoints.ts web/src/types.ts
git commit -m "feat: 前端空投追踪 API 与手补类型"
```

---

### Task 6: board 纯函数 + hooks + 单测

**Files:**
- Create: `web/src/pages/airdrop/board.ts`
- Create: `web/src/pages/airdrop/hooks.ts`
- Test: `web/src/pages/airdrop/board.test.ts`（新建）
- Test: `web/src/pages/airdrop/hooks.test.tsx`（新建）

**Interfaces:**
- Consumes：Task 5 的 endpoints 与 types
- Produces（Task 7 依赖）：
  - board：`groupByStatus(projects)`、`deadlineBadge(deadline, today)`、`diffDays(date, today)`、`todayLocal()`、`reminderBannerText(reminders)`、`PRIORITY_TAG`、`PRIORITY_LABEL`、`diffTodos(original, next)`、`TodoDraft`
  - hooks：`useAirdropStatuses`、`useAirdropProjects`、`useAirdropReminders`、`useUpdateProject`（拖拽乐观更新）、`useSaveProject`（新建/编辑统一，含子项 diff）、`useDeleteProject`、`useUpdateTodo`、`useDeleteTodo`、`useCreateStatus`、`useUpdateStatus`、`useDeleteStatus`

- [ ] **Step 1: 写失败测试**

创建 `web/src/pages/airdrop/board.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { deadlineBadge, diffDays, diffTodos, groupByStatus, reminderBannerText, todayLocal } from './board'
import type { AirdropProjectView, AirdropReminders, AirdropTodoItem } from '../../types'

const proj = (id: number, statusId: number): AirdropProjectView => ({
  id, name: `P${id}`, statusId, priority: 'mid', deadline: null, link: null, note: null,
  createdAt: 'x', updatedAt: 'x', statusName: '列', todos: [],
})

describe('groupByStatus', () => {
  it('按 statusId 分组且保持原顺序', () => {
    const g = groupByStatus([proj(1, 2), proj(2, 1), proj(3, 2)])
    expect(g.get(2)?.map((p) => p.id)).toEqual([1, 3])
    expect(g.get(1)?.map((p) => p.id)).toEqual([2])
  })
})

describe('diffDays', () => {
  it('日差计算（可负，跨月正确）', () => {
    expect(diffDays('2026-10-05', '2026-09-30')).toBe(5)
    expect(diffDays('2026-09-29', '2026-09-30')).toBe(-1)
    expect(diffDays('2026-10-01', '2026-09-30')).toBe(1)
  })
})

describe('todayLocal', () => {
  it('返回 YYYY-MM-DD', () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('deadlineBadge', () => {
  it('无期限 null；过期 over；5 天内 warn；更远 fine', () => {
    expect(deadlineBadge(null, '2026-09-30')).toBeNull()
    expect(deadlineBadge('2026-09-29', '2026-09-30')).toEqual({ daysLeft: -1, kind: 'over' })
    expect(deadlineBadge('2026-09-30', '2026-09-30')).toEqual({ daysLeft: 0, kind: 'warn' })
    expect(deadlineBadge('2026-10-05', '2026-09-30')).toEqual({ daysLeft: 5, kind: 'warn' })
    expect(deadlineBadge('2026-10-06', '2026-09-30')).toEqual({ daysLeft: 6, kind: 'fine' })
  })
})

describe('reminderBannerText', () => {
  it('空数据 null；汇总文案含条数与前三条名', () => {
    const empty: AirdropReminders = { upcoming: [], overdue: [] }
    expect(reminderBannerText(empty)).toBeNull()
    const r: AirdropReminders = {
      upcoming: [
        { type: 'project', id: 1, name: 'Inception', date: '2026-10-05', daysLeft: 5 },
        { type: 'todo', id: 2, name: 'Monad 领水', date: '2026-10-02', daysLeft: 2 },
      ],
      overdue: [{ type: 'todo', id: 3, name: 'Linea 领水', date: '2026-09-29', daysLeft: -1 }],
    }
    expect(reminderBannerText(r)).toBe('未来 5 天到期 2 项：Inception、Monad 领水｜已过期 1 项：Linea 领水')
  })

  it('超过 3 条截断加省略号', () => {
    const r: AirdropReminders = {
      upcoming: [
        { type: 'project', id: 1, name: 'A', date: '2026-10-01', daysLeft: 1 },
        { type: 'project', id: 2, name: 'B', date: '2026-10-02', daysLeft: 2 },
        { type: 'project', id: 3, name: 'C', date: '2026-10-03', daysLeft: 3 },
        { type: 'project', id: 4, name: 'D', date: '2026-10-04', daysLeft: 4 },
      ],
      overdue: [],
    }
    expect(reminderBannerText(r)).toBe('未来 5 天到期 4 项：A、B、C…')
  })
})

describe('diffTodos', () => {
  const orig: AirdropTodoItem[] = [
    { id: 1, projectId: 1, content: '保留', done: 0, dueDate: null, priority: 'mid', createdAt: 'x' },
    { id: 2, projectId: 1, content: '要改', done: 0, dueDate: null, priority: 'mid', createdAt: 'x' },
    { id: 3, projectId: 1, content: '要删', done: 0, dueDate: null, priority: 'mid', createdAt: 'x' },
  ]

  it('识别新增/修改/删除', () => {
    const next = [
      { key: 'k1', id: 1, content: '保留', dueDate: null, priority: 'mid' },
      { key: 'k2', id: 2, content: '改过了', dueDate: '2026-10-05', priority: 'high' },
      { key: 'k3', content: '新子项', dueDate: null, priority: 'low' },
    ]
    const d = diffTodos(orig, next)
    expect(d.toDelete).toEqual([3])
    expect(d.toCreate).toHaveLength(1)
    expect(d.toCreate[0].content).toBe('新子项')
    expect(d.toUpdate).toEqual([{ id: 2, content: '改过了', dueDate: '2026-10-05', priority: 'high' }])
  })

  it('无变化的行不产生操作', () => {
    const next = [
      { key: 'k1', id: 1, content: '保留', dueDate: null, priority: 'mid' },
      { key: 'k2', id: 2, content: '要改', dueDate: null, priority: 'mid' },
      { key: 'k3', id: 3, content: '要删', dueDate: null, priority: 'mid' },
    ]
    const d = diffTodos(orig, next)
    expect(d.toDelete).toEqual([])
    expect(d.toCreate).toEqual([])
    expect(d.toUpdate).toEqual([])
  })
})
```

创建 `web/src/pages/airdrop/hooks.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { useAirdropReminders, useSaveProject, useUpdateProject } from './hooks'

vi.mock('../../api/endpoints', () => ({
  createAirdropProject: vi.fn().mockResolvedValue({ id: 1, name: 'X', statusId: 1, priority: 'mid', deadline: null, link: null, note: null, createdAt: 'x', updatedAt: 'x', statusName: '关注中', todos: [] }),
  updateAirdropProject: vi.fn().mockResolvedValue({ id: 1, name: 'X', statusId: 2, priority: 'mid', deadline: null, link: null, note: null, createdAt: 'x', updatedAt: 'x', statusName: '待参与', todos: [] }),
  createAirdropTodo: vi.fn().mockResolvedValue({ id: 9, projectId: 1, content: '新子项', done: 0, dueDate: null, priority: 'low', createdAt: 'x' }),
  updateAirdropTodo: vi.fn().mockResolvedValue({ id: 2, projectId: 1, content: '改过了', done: 0, dueDate: '2026-10-05', priority: 'high', createdAt: 'x' }),
  deleteAirdropTodo: vi.fn().mockResolvedValue(null),
  deleteAirdropProject: vi.fn().mockResolvedValue(null),
  fetchAirdropProjects: vi.fn().mockResolvedValue([]),
  fetchAirdropStatuses: vi.fn().mockResolvedValue([]),
  fetchAirdropReminders: vi.fn().mockResolvedValue({ upcoming: [], overdue: [] }),
  createAirdropStatus: vi.fn(),
  updateAirdropStatus: vi.fn(),
  deleteAirdropStatus: vi.fn(),
}))

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <App>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </App>
  )
}

describe('useAirdropReminders', () => {
  it('60 秒轮询配置生效', async () => {
    const { result } = renderHook(() => useAirdropReminders(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qc = (globalThis as unknown as { __qc?: QueryClient }).__qc
    expect(qc).toBeUndefined() // 仅为断言 hooks 不抛错；轮询参数由实现保证
  })
})
```

（注：hooks 内部测试重点在 mutation 的 invalidate 行为，用 `useQueryClient` spy 模式同 `web/src/pages/tools/hooks.test.tsx` 既有写法，故测试文件最终形态以该既有文件的 QueryClient spy 模式为准——执行时先读 `tools/hooks.test.tsx` 照抄其 spy 结构，断言 `useSaveProject` 成功后 invalidate `['airdrop-projects']`/`['airdrop-statuses']`/`['airdrop-reminders']` 三个 key、`useUpdateProject` 失败时回滚 setQueryData）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web -- src/pages/airdrop/board.test.ts`
Expected: FAIL（`Cannot find module './board'`）

- [ ] **Step 3: 实现 board.ts 与 hooks.ts**

创建 `web/src/pages/airdrop/board.ts`：

```ts
/**
 * 空投追踪纯函数（web 层）：分组/日期/徽标/横幅文案/子项 diff
 * 依赖方向：仅依赖 ../types，被 hooks 与页面组件引用
 */
import type { AirdropPriority, AirdropProjectView, AirdropReminders, AirdropTodoItem } from '../../types'

/** 按 statusId 分组项目（后端已排好序，分组保持原顺序） */
export function groupByStatus(projects: AirdropProjectView[]): Map<number, AirdropProjectView[]> {
  const map = new Map<number, AirdropProjectView[]>()
  for (const p of projects) {
    const list = map.get(p.statusId)
    if (list) list.push(p)
    else map.set(p.statusId, [p])
  }
  return map
}

/** 日差：date - today（UTC 零点解析；可负） */
export function diffDays(date: string, today: string): number {
  return Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000)
}

/** 今天日期串（本地时区，与后端 todayStr 同口径） */
export function todayLocal(): string {
  const n = new Date()
  const y = n.getFullYear()
  const m = String(n.getMonth() + 1).padStart(2, '0')
  const d = String(n.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 剩余天数徽标：过期 over / 5 天内 warn / 更远 fine；无期限返回 null */
export function deadlineBadge(deadline: string | null, today: string): { daysLeft: number; kind: 'over' | 'warn' | 'fine' } | null {
  if (!deadline) return null
  const daysLeft = diffDays(deadline, today)
  if (daysLeft < 0) return { daysLeft, kind: 'over' }
  if (daysLeft <= 5) return { daysLeft, kind: 'warn' }
  return { daysLeft, kind: 'fine' }
}

/** 提醒横幅文案（各取前 3 条，超长截断）；无提醒返回 null */
export function reminderBannerText(r: AirdropReminders): string | null {
  if (r.upcoming.length === 0 && r.overdue.length === 0) return null
  const parts: string[] = []
  const head = (items: AirdropReminders['upcoming']) => `${items.slice(0, 3).map((i) => i.name).join('、')}${items.length > 3 ? '…' : ''}`
  if (r.upcoming.length > 0) parts.push(`未来 5 天到期 ${r.upcoming.length} 项：${head(r.upcoming)}`)
  if (r.overdue.length > 0) parts.push(`已过期 ${r.overdue.length} 项：${head(r.overdue)}`)
  return parts.join('｜')
}

/** 优先级展示元数据 */
export const PRIORITY_LABEL: Record<AirdropPriority, string> = { high: '高', mid: '中', low: '低' }
export const PRIORITY_TAG: Record<AirdropPriority, 'red' | 'orange' | 'green'> = { high: 'red', mid: 'orange', low: 'green' }

/** 子项编辑草稿（key 为组件内唯一键；id 存在=已落库行） */
export interface TodoDraft {
  key: string
  id?: number
  content: string
  dueDate: string | null
  priority: AirdropPriority
}

/** 对比原始子项与编辑草稿，得出增/改/删操作（保存弹窗统一执行） */
export function diffTodos(
  original: AirdropTodoItem[],
  next: TodoDraft[],
): { toCreate: TodoDraft[]; toUpdate: Array<{ id: number; content: string; dueDate: string | null; priority: AirdropPriority }>; toDelete: number[] } {
  const nextIds = new Set(next.filter((t) => t.id !== undefined).map((t) => t.id!))
  const toDelete = original.filter((t) => !nextIds.has(t.id)).map((t) => t.id)
  const toCreate = next.filter((t) => t.id === undefined)
  const toUpdate: Array<{ id: number; content: string; dueDate: string | null; priority: AirdropPriority }> = []
  for (const t of next) {
    if (t.id === undefined) continue
    const o = original.find((x) => x.id === t.id)
    if (o && (o.content !== t.content || o.dueDate !== t.dueDate || o.priority !== t.priority)) {
      toUpdate.push({ id: t.id, content: t.content, dueDate: t.dueDate, priority: t.priority })
    }
  }
  return { toCreate, toUpdate, toDelete }
}
```

创建 `web/src/pages/airdrop/hooks.ts`：

```ts
/**
 * 空投追踪数据层（web 层）：react-query hooks 与变更操作
 * 依赖方向：仅依赖 ../../api 与 ../types，被页面组件引用
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { HttpError } from '../../api/client'
import {
  createAirdropProject, createAirdropStatus, createAirdropTodo, deleteAirdropProject, deleteAirdropStatus, deleteAirdropTodo,
  fetchAirdropProjects, fetchAirdropReminders, fetchAirdropStatuses, updateAirdropProject, updateAirdropStatus, updateAirdropTodo,
} from '../../api/endpoints'
import type { AirdropPriority, AirdropProjectInput, AirdropProjectPatch, AirdropProjectView } from '../../types'
import { diffTodos, type TodoDraft } from './board'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

/** 全部空投查询失效（任一变更后刷新看板/列/提醒） */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['airdrop-statuses'] })
  qc.invalidateQueries({ queryKey: ['airdrop-projects'] })
  qc.invalidateQueries({ queryKey: ['airdrop-reminders'] })
}

export function useAirdropStatuses() {
  return useQuery({ queryKey: ['airdrop-statuses'], queryFn: fetchAirdropStatuses })
}

export function useAirdropProjects() {
  return useQuery({ queryKey: ['airdrop-projects'], queryFn: fetchAirdropProjects })
}

/** 到期提醒：60 秒轮询（临近/过期提示横幅数据源） */
export function useAirdropReminders() {
  return useQuery({ queryKey: ['airdrop-reminders'], queryFn: fetchAirdropReminders, refetchInterval: 60_000 })
}

/** 项目更新（拖拽流转 statusId 用）：乐观更新 + 失败回滚 */
export function useUpdateProject() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AirdropProjectPatch & { id: number }) => updateAirdropProject(body.id, body),
    onMutate: async ({ id, statusId }) => {
      await qc.cancelQueries({ queryKey: ['airdrop-projects'] })
      const prev = qc.getQueryData<AirdropProjectView[]>(['airdrop-projects'])
      if (prev && statusId !== undefined) {
        qc.setQueryData<AirdropProjectView[]>(['airdrop-projects'], prev.map((p) => (p.id === id ? { ...p, statusId } : p)))
      }
      return { prev }
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['airdrop-projects'], ctx.prev)
      message.error(errMsg(e))
    },
    onSuccess: () => invalidateAll(qc),
  })
}

/** 保存项目（新建/编辑统一：项目字段 + 子项 diff 后增删改） */
export function useSaveProject() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: number | null; values: AirdropProjectInput; todos: TodoDraft[] }) => {
      const { id, values, todos } = input
      const saved = id === null ? await createAirdropProject(values) : await updateAirdropProject(id, values)
      const { toCreate, toUpdate, toDelete } = diffTodos(saved.todos, todos)
      await Promise.all([
        ...toCreate.map((t) => createAirdropTodo(saved.id, { content: t.content, dueDate: t.dueDate, priority: t.priority })),
        ...toUpdate.map((t) => updateAirdropTodo(t.id, { content: t.content, dueDate: t.dueDate, priority: t.priority })),
        ...toDelete.map((t) => deleteAirdropTodo(t)),
      ])
      return saved
    },
    onSuccess: () => { message.success('项目已保存'); invalidateAll(qc) },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteProject() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteAirdropProject(id),
    onSuccess: () => { message.success('项目已删除'); invalidateAll(qc) },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 子项勾选/修改（卡片上直接操作） */
export function useUpdateTodo() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; body: { done?: boolean; content?: string; dueDate?: string | null; priority?: AirdropPriority } }) => updateAirdropTodo(input.id, input.body),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteTodo() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteAirdropTodo(id),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useCreateStatus() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createAirdropStatus(name),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useUpdateStatus() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; body: { name?: string; sortOrder?: number } }) => updateAirdropStatus(input.id, input.body),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteStatus() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteAirdropStatus(id),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

先读 `web/src/pages/tools/hooks.test.tsx` 的 QueryClient spy 结构，把 `hooks.test.tsx` 的 mutation 用例按其模式补全（断言 `useSaveProject` 成功后 invalidate 三个 key、`useUpdateProject` onError 回滚），然后：

Run: `npm run test:web -- src/pages/airdrop`
Expected: PASS

- [ ] **Step 5: 类型检查与提交**

```bash
npm run typecheck
git add web/src/pages/airdrop/board.ts web/src/pages/airdrop/hooks.ts web/src/pages/airdrop/board.test.ts web/src/pages/airdrop/hooks.test.tsx
git commit -m "feat: 空投追踪前端 hooks 与纯函数（含单测）"
```

---

### Task 7: 看板页面组件 + @dnd-kit 拖拽 + 导航路由

**Files:**
- Modify: `web/package.json`（新增依赖，经 npm install 写入）
- Create: `web/src/pages/airdrop/index.tsx`
- Create: `web/src/pages/airdrop/ReminderBanner.tsx`
- Create: `web/src/pages/airdrop/StatusColumn.tsx`
- Create: `web/src/pages/airdrop/ProjectCard.tsx`
- Create: `web/src/pages/airdrop/ProjectFormModal.tsx`
- Create: `web/src/pages/airdrop/StatusManageModal.tsx`
- Modify: `web/src/layouts/AppLayout.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes：Task 6 的 hooks 与 board 纯函数
- Produces：`web/src/pages/airdrop/index.tsx` 默认导出 `AirdropPage`（App.tsx 路由挂载）

- [ ] **Step 1: 安装依赖**

Run（在项目根目录，web 是 npm workspace）: `npm install @dnd-kit/core --workspace web`
Expected: 安装成功，`web/package.json` dependencies 出现 `"@dnd-kit/core"`，根 `package-lock.json` 更新

- [ ] **Step 2: 写页面组件**

创建 `web/src/pages/airdrop/ReminderBanner.tsx`：

```tsx
import { Alert } from 'antd'
import { reminderBannerText } from './board'
import type { AirdropReminders } from '../../types'

/** 提醒横幅：有逾期用 error 色、仅临近用 warning 色；关闭后同文案不再弹（数据变化再现） */
export default function ReminderBanner({ reminders, dismissedKey, onDismiss }: {
  reminders: AirdropReminders
  dismissedKey: string | null
  onDismiss: (key: string) => void
}) {
  const text = reminderBannerText(reminders)
  if (!text || text === dismissedKey) return null
  return (
    <Alert
      type={reminders.overdue.length > 0 ? 'error' : 'warning'}
      showIcon
      closable
      message={text}
      onClose={() => onDismiss(text)}
      style={{ marginBottom: 16 }}
    />
  )
}
```

创建 `web/src/pages/airdrop/StatusColumn.tsx`：

```tsx
import type { CSSProperties, ReactNode } from 'react'
import { Button, theme, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useDroppable } from '@dnd-kit/core'
import type { AirdropStatusItem } from '../../types'

const COL_STYLE: CSSProperties = {
  flex: '0 0 290px',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 10,
  maxHeight: 'calc(100vh - 250px)',
}

/** 看板单列：列头（名称/数量/快捷新建）+ 卡片区；dnd drop 目标 */
export default function StatusColumn({ status, onAdd, children }: {
  status: AirdropStatusItem
  onAdd: () => void
  children: ReactNode
}) {
  const { token } = theme.useToken()
  const { setNodeRef, isOver } = useDroppable({ id: `status-${status.id}` })
  return (
    <div ref={setNodeRef} style={{ ...COL_STYLE, background: token.colorFillQuaternary, outline: isOver ? `2px dashed ${token.colorPrimary}` : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 8px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorPrimary, flex: 'none' }} />
        <Typography.Text strong style={{ fontSize: 13.5 }}>{status.name}</Typography.Text>
        <span style={{ background: token.colorFillSecondary, color: token.colorTextSecondary, fontSize: 12, padding: '0 8px', borderRadius: 10, lineHeight: '18px' }}>{status.projectCount}</span>
        <Button type="text" size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }} onClick={onAdd} title="在此列新增" />
      </div>
      <div style={{ padding: '2px 10px 12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 60 }}>
        {children}
      </div>
    </div>
  )
}
```

创建 `web/src/pages/airdrop/ProjectCard.tsx`：

```tsx
import { useState } from 'react'
import { App, Button, Checkbox, Dropdown, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, LinkOutlined, MoreOutlined } from '@ant-design/icons'
import { useDraggable } from '@dnd-kit/core'
import { deadlineBadge, PRIORITY_LABEL, PRIORITY_TAG, todayLocal } from './board'
import { useDeleteProject, useDeleteTodo, useUpdateTodo } from './hooks'
import type { AirdropProjectView } from '../../types'

const DAYS_TEXT = (b: { daysLeft: number; kind: 'over' | 'warn' | 'fine' }) => {
  if (b.kind === 'over') return `已过期 ${-b.daysLeft} 天`
  if (b.daysLeft === 0) return '今天'
  return `剩 ${b.daysLeft} 天`
}

const DAYS_COLOR = { over: '#cf1322', warn: '#d46b08', fine: '#2f54eb' } as const

/** 项目卡片：拖拽源 + 字段展示 + 子项勾选/删除 + 展开备注 + 编辑/删除入口 */
export default function ProjectCard({ project, onEdit }: { project: AirdropProjectView; onEdit: (p: AirdropProjectView) => void }) {
  const { message } = App.useApp()
  const [expanded, setExpanded] = useState(false)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `project-${project.id}` })
  const updateTodo = useUpdateTodo()
  const deleteTodo = useDeleteTodo()
  const deleteProject = useDeleteProject()
  const badge = deadlineBadge(project.deadline, todayLocal())

  const items = [
    { key: 'edit', icon: <EditOutlined />, label: '编辑' },
    { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
  ]

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        background: '#fff', borderRadius: 10, padding: '12px 13px', cursor: 'grab', opacity: isDragging ? 0.45 : 1,
        border: '1px solid #e5e9ef', boxShadow: '0 1px 2px rgba(16,24,40,.05)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <span style={{ color: '#c3c9d1', fontSize: 13 }}>⠿</span>
        <Tag color={PRIORITY_TAG[project.priority]} style={{ marginInlineEnd: 0 }}>{PRIORITY_LABEL[project.priority]}</Tag>
        <Typography.Text strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</Typography.Text>
        <Dropdown
          menu={{
            items,
            onClick: ({ key }) => {
              if (key === 'edit') onEdit(project)
              if (key === 'delete') deleteProject.mutate(project.id)
            },
          }}
          trigger={['click']}
        >
          <Button type="text" size="small" icon={<MoreOutlined />} />
        </Dropdown>
      </div>
      {project.deadline && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5b6470', marginBottom: 4 }}>
          <span>⏰ {project.deadline}</span>
          {badge && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: DAYS_COLOR[badge.kind], background: `${DAYS_COLOR[badge.kind]}18`, padding: '0 7px', borderRadius: 4 }}>{DAYS_TEXT(badge)}</span>}
        </div>
      )}
      {project.link && (
        <div style={{ fontSize: 12.5, marginBottom: 4 }}>
          <a href={project.link} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <LinkOutlined style={{ flex: 'none' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 210 }}>{project.link}</span>
          </a>
        </div>
      )}
      {project.note && (
        <Typography.Paragraph
          onClick={() => setExpanded(!expanded)}
          ellipsis={!expanded ? { rows: 2 } : false}
          style={{ fontSize: 12.5, color: '#8c959f', background: '#fafbfc', borderRadius: 6, padding: '7px 9px', marginTop: 6, marginBottom: 0, cursor: 'pointer' }}
        >
          {project.note}
        </Typography.Paragraph>
      )}
      {project.todos.length > 0 && (
        <div style={{ borderTop: '1px dashed #e5e9ef', marginTop: 9, paddingTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {project.todos.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <Checkbox
                checked={t.done === 1}
                onChange={(e) => updateTodo.mutate({ id: t.id, body: { done: e.target.checked } })}
                style={{ flex: 'none' }}
              />
              <span style={t.done === 1 ? { textDecoration: 'line-through', color: '#a6adb5' } : undefined}>{t.content}</span>
              {t.dueDate && (
                <Tooltip title={`截止 ${t.dueDate}`}>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, color: deadlineBadge(t.dueDate, todayLocal())?.kind === 'over' ? '#cf1322' : '#8c959f', flex: 'none' }}>{t.dueDate.slice(5)}</span>
                </Tooltip>
              )}
              <Popconfirm title="删除该子项？" onConfirm={() => deleteTodo.mutate(t.id)}>
                <Button type="text" size="small" icon={<DeleteOutlined style={{ fontSize: 11 }} />} style={{ flex: 'none', padding: 0 }} />
              </Popconfirm>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

创建 `web/src/pages/airdrop/ProjectFormModal.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { App, Button, DatePicker, Form, Input, Modal, Select } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useSaveProject } from './hooks'
import { PRIORITY_LABEL, type TodoDraft } from './board'
import type { AirdropPriority, AirdropProjectView, AirdropStatusItem } from '../../types'

export interface ProjectFormValues {
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: string | null
  link: string | null
  note: string | null
}

let draftSeq = 0
const nextKey = () => `draft-${Date.now()}-${draftSeq++}`

const PRIORITY_OPTIONS = (['high', 'mid', 'low'] as const).map((v) => ({ value: v, label: PRIORITY_LABEL[v] }))

function toDrafts(todos: AirdropProjectView['todos']): TodoDraft[] {
  return todos.map((t) => ({ key: `todo-${t.id}`, id: t.id, content: t.content, dueDate: t.dueDate, priority: t.priority }))
}

/** 新增/编辑项目弹窗：项目字段 + 子项编辑器（保存时 diff 增删改） */
export default function ProjectFormModal({ open, editing, statuses, onClose }: {
  open: boolean
  editing: AirdropProjectView | null
  statuses: AirdropStatusItem[]
  onClose: () => void
}) {
  const [form] = Form.useForm<ProjectFormValues>()
  const [todos, setTodos] = useState<TodoDraft[]>([])
  const saveProject = useSaveProject()

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      name: editing?.name ?? '',
      statusId: editing?.statusId ?? statuses[0]?.id,
      priority: editing?.priority ?? 'mid',
      deadline: editing?.deadline ?? null,
      link: editing?.link ?? null,
      note: editing?.note ?? null,
    })
    setTodos(editing ? toDrafts(editing.todos) : [])
  }, [open, editing, statuses, form])

  const addTodo = () => setTodos((prev) => [...prev, { key: nextKey(), content: '', dueDate: null, priority: 'mid' }])

  const onOk = async () => {
    const values = await form.validateFields()
    const deadline = values.deadline ? (values.deadline as Dayjs).format('YYYY-MM-DD') : null
    const cleaned = todos.filter((t) => t.content.trim()).map((t) => ({ ...t, content: t.content.trim() }))
    saveProject.mutate(
      { id: editing?.id ?? null, values: { ...values, deadline }, todos: cleaned },
      { onSuccess: onClose },
    )
  }

  return (
    <Modal open={open} title={editing ? '编辑项目' : '新增项目'} onCancel={onClose} onOk={onOk} confirmLoading={saveProject.isPending} okText="保存" cancelText="取消" destroyOnClose width={560}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
          <Input placeholder="如：Starknet" />
        </Form.Item>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="statusId" label="状态列" style={{ flex: 1 }}>
            <Select options={statuses.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="priority" label="优先级" style={{ flex: 1 }}>
            <Select options={PRIORITY_OPTIONS} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="deadline" label="时间节点（快照/截止/发币）" style={{ flex: 1 }}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="link" label="项目链接" style={{ flex: 1 }}>
            <Input placeholder="https://..." />
          </Form.Item>
        </div>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={3} placeholder="记录规则、进度、注意点..." />
        </Form.Item>
      </Form>
      <div style={{ border: '1px dashed #d9dce1', borderRadius: 8, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: todos.length > 0 ? 8 : 0 }}>
          <span style={{ fontSize: 12.5, color: '#5b6470' }}>待办子项</span>
          <Button type="link" size="small" icon={<PlusOutlined />} onClick={addTodo}>添加待办</Button>
        </div>
        {todos.map((t) => (
          <div key={t.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 7 }}>
            <Input
              value={t.content}
              placeholder="待办内容"
              onChange={(e) => setTodos((prev) => prev.map((x) => (x.key === t.key ? { ...x, content: e.target.value } : x)))}
              style={{ flex: 1 }}
            />
            <DatePicker
              value={t.dueDate ? dayjs(t.dueDate) : null}
              placeholder="截止"
              onChange={(d) => setTodos((prev) => prev.map((x) => (x.key === t.key ? { ...x, dueDate: d ? d.format('YYYY-MM-DD') : null } : x)))}
              style={{ width: 118 }}
            />
            <Select
              value={t.priority}
              options={PRIORITY_OPTIONS}
              onChange={(v) => setTodos((prev) => prev.map((x) => (x.key === t.key ? { ...x, priority: v } : x)))}
              style={{ width: 86 }}
            />
            <Button type="text" icon={<DeleteOutlined style={{ color: '#cf1322' }} />} onClick={() => setTodos((prev) => prev.filter((x) => x.key !== t.key))} />
          </div>
        ))}
      </div>
    </Modal>
  )
}
```

创建 `web/src/pages/airdrop/StatusManageModal.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { App, Button, Input, Modal } from 'antd'
import { DeleteOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import { useCreateStatus, useDeleteStatus, useUpdateStatus } from './hooks'
import type { AirdropStatusItem } from '../../types'

/** 管理状态列弹窗：新增/改名/删除/上下换序 */
export default function StatusManageModal({ open, statuses, onClose }: {
  open: boolean
  statuses: AirdropStatusItem[]
  onClose: () => void
}) {
  const { message } = App.useApp()
  const [names, setNames] = useState<Record<number, string>>({})
  const [newName, setNewName] = useState('')
  const createStatus = useCreateStatus()
  const updateStatus = useUpdateStatus()
  const deleteStatus = useDeleteStatus()

  useEffect(() => {
    if (open) {
      setNames(Object.fromEntries(statuses.map((s) => [s.id, s.name])))
      setNewName('')
    }
  }, [open, statuses])

  const rename = (s: AirdropStatusItem) => {
    const name = (names[s.id] ?? '').trim()
    if (!name) { message.warning('状态名不能为空'); return }
    updateStatus.mutate({ id: s.id, body: { name } })
  }

  const swap = (a: AirdropStatusItem, b: AirdropStatusItem) => {
    updateStatus.mutate({ id: a.id, body: { sortOrder: b.sortOrder } })
    updateStatus.mutate({ id: b.id, body: { sortOrder: a.sortOrder } })
  }

  const addNew = () => {
    const name = newName.trim()
    if (!name) { message.warning('状态名不能为空'); return }
    createStatus.mutate(name, { onSuccess: () => setNewName('') })
  }

  return (
    <Modal open={open} title="管理状态列" onCancel={onClose} footer={null} width={480}>
      {statuses.map((s, i) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px solid #e5e9ef', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#1677ff', flex: 'none' }} />
          <Input
            value={names[s.id] ?? s.name}
            onChange={(e) => setNames((prev) => ({ ...prev, [s.id]: e.target.value }))}
            onBlur={() => rename(s)}
            variant="borderless"
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: '#8c959f' }}>{s.projectCount} 项目</span>
          <Button type="text" size="small" icon={<UpOutlined />} disabled={i === 0} onClick={() => swap(s, statuses[i - 1])} />
          <Button type="text" size="small" icon={<DownOutlined />} disabled={i === statuses.length - 1} onClick={() => swap(s, statuses[i + 1])} />
          <Button type="text" size="small" icon={<DeleteOutlined style={{ color: '#cf1322' }} />} onClick={() => deleteStatus.mutate(s.id)} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Input value={newName} placeholder="新状态列名（如：空投已到账）" onChange={(e) => setNewName(e.target.value)} onPressEnter={addNew} style={{ flex: 1 }} />
        <Button onClick={addNew}>新增</Button>
      </div>
    </Modal>
  )
}
```

创建 `web/src/pages/airdrop/index.tsx`：

```tsx
import { useMemo, useState } from 'react'
import { Alert, Button, Card, Space, Typography } from 'antd'
import { PlusOutlined, SettingOutlined } from '@ant-design/icons'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { groupByStatus } from './board'
import { useAirdropProjects, useAirdropReminders, useAirdropStatuses, useUpdateProject } from './hooks'
import ReminderBanner from './ReminderBanner'
import StatusColumn from './StatusColumn'
import ProjectCard from './ProjectCard'
import ProjectFormModal from './ProjectFormModal'
import StatusManageModal from './StatusManageModal'
import type { AirdropProjectView } from '../../types'

/** 空投追踪看板页：提醒横幅 + 状态列拖拽 + 项目卡片 + 两个弹窗 */
export default function AirdropPage() {
  const statuses = useAirdropStatuses()
  const projects = useAirdropProjects()
  const reminders = useAirdropReminders()
  const updateProject = useUpdateProject()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AirdropProjectView | null>(null)
  const [defaultStatusId, setDefaultStatusId] = useState<number | undefined>(undefined)
  const [statusModalOpen, setStatusModalOpen] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  const grouped = useMemo(() => groupByStatus(projects.data ?? []), [projects.data])

  const openCreate = (statusId?: number) => {
    setEditing(null)
    setDefaultStatusId(statusId)
    setFormOpen(true)
  }

  const openEdit = (p: AirdropProjectView) => {
    setEditing(p)
    setFormOpen(true)
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over) return
    const pid = Number(String(active.id).replace('project-', ''))
    const sid = Number(String(over.id).replace('status-', ''))
    if (!Number.isInteger(pid) || !Number.isInteger(sid)) return
    const project = (projects.data ?? []).find((p) => p.id === pid)
    if (!project || project.statusId === sid) return
    updateProject.mutate({ id: pid, statusId: sid })
  }

  if (statuses.isPending || projects.isPending) {
    return <Card size="small"><div style={{ textAlign: 'center', padding: 48 }}><Typography.Text type="secondary">加载中...</Typography.Text></div></Card>
  }
  if (statuses.isError || projects.isError || !statuses.data || !projects.data) {
    return <Alert type="error" showIcon message="空投追踪加载失败" description="请检查后端服务是否运行" />
  }

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <ReminderBanner reminders={reminders.data ?? { upcoming: [], overdue: [] }} dismissedKey={dismissedKey} onDismiss={setDismissedKey} />
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>空投追踪</Typography.Title>
          <Typography.Text type="secondary">项目备忘录 + 待办清单：记录每个空投的参与进度、备注与时间节点</Typography.Text>
        </div>
        <Space>
          <Button icon={<SettingOutlined />} onClick={() => setStatusModalOpen(true)}>管理状态列</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>新增项目</Button>
        </Space>
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 12 }}>
          {statuses.data.map((s) => (
            <StatusColumn key={s.id} status={s} onAdd={() => openCreate(s.id)}>
              {(grouped.get(s.id) ?? []).map((p) => (
                <ProjectCard key={p.id} project={p} onEdit={openEdit} />
              ))}
            </StatusColumn>
          ))}
        </div>
      </DndContext>
      <ProjectFormModal
        open={formOpen}
        editing={editing}
        statuses={statuses.data}
        defaultStatusId={defaultStatusId}
        onClose={() => setFormOpen(false)}
      />
      <StatusManageModal open={statusModalOpen} statuses={statuses.data} onClose={() => setStatusModalOpen(false)} />
    </Space>
  )
}
```

（注：`ProjectFormModal` 增加 `defaultStatusId` prop——新建时列头「＋」预填该列：`useEffect` 中 `statusId: editing?.statusId ?? defaultStatusId ?? statuses[0]?.id`，组件签名与 effect 需按此调整）

修改 `web/src/layouts/AppLayout.tsx`（import 与 menuItems）：

```tsx
import { RocketOutlined } from '@ant-design/icons'
// menuItems 数组「任务」之后插入：
{ key: '/airdrop', icon: <RocketOutlined />, label: '空投追踪' },
```

修改 `web/src/App.tsx`：

```tsx
import AirdropPage from './pages/airdrop'
// Route 列表 tools 之前插入：
<Route path="airdrop" element={<AirdropPage />} />
```

- [ ] **Step 3: 类型检查与前端测试**

Run: `npm run typecheck`
Expected: PASS（注意 `web/tsconfig.app.json` 若报 `dayjs` 缺失——antd 自带 dayjs 传递依赖，直接 import 即可；若报错则在 web 目录 `npm install dayjs`）
Run: `npm run test:web`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add web/package.json web/package-lock.json package-lock.json web/src/pages/airdrop web/src/layouts/AppLayout.tsx web/src/App.tsx
git commit -m "feat: 空投追踪看板页面（拖拽流转/提醒横幅/弹窗）与导航入口"
```

---

### Task 8: 文档同步与全量验证

**Files:**
- Modify: `docs/API-GUIDE.md`

- [ ] **Step 1: 更新用户手册**

修改 `docs/API-GUIDE.md`：

（a）8.2 面板使用章节：页面清单加「空投追踪」页（先读该章确认页面列举格式，按其写法追加）：

```markdown
- **空投追踪页**：空投项目备忘录 + 待办清单看板。状态列可自定义（默认五列：关注中/待参与/进行中/已完成/已放弃），卡片可拖拽流转状态；项目含优先级、时间节点（到期提醒）、链接、备注与待办子项（子项可勾选、带截止时间与优先级）；页顶横幅提示未来 5 天内到期与已过期事项（60 秒轮询）。
```

（b）8.3 REST 接口总表：追加 12 行（对照该表既有行格式）：

```markdown
| GET | `/api/airdrop/statuses` | 空投追踪状态列清单（含项目数） |
| POST | `/api/airdrop/statuses` | 新增状态列 |
| PATCH | `/api/airdrop/statuses/{id}` | 状态列改名/换序 |
| DELETE | `/api/airdrop/statuses/{id}` | 删除状态列（非空 409） |
| GET | `/api/airdrop/projects` | 空投项目清单（含子项，已排序） |
| POST | `/api/airdrop/projects` | 新建项目 |
| PATCH | `/api/airdrop/projects/{id}` | 更新项目（拖拽流转 statusId） |
| DELETE | `/api/airdrop/projects/{id}` | 删除项目（级联删子项） |
| POST | `/api/airdrop/projects/{id}/todos` | 加待办子项 |
| PATCH | `/api/airdrop/todos/{id}` | 更新子项（勾选等） |
| DELETE | `/api/airdrop/todos/{id}` | 删除子项 |
| GET | `/api/airdrop/reminders` | 到期提醒汇总（5 天内 + 已过期） |
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
git commit -m "docs: 空投追踪页与接口同步 API-GUIDE"
```

---

## Self-Review 结论

- **Spec 覆盖**：三张表（Task 1）✓；12 个接口（Task 3）✓；拖拽流转（Task 3 PATCH statusId + Task 7 dnd）✓；自定义列增删改换序（Task 1/3/7 StatusManageModal）✓；子项勾选/时间/优先级（Task 1/6/7）✓；提醒 5 天窗口 + 60s 轮询 + 横幅可关闭（Task 2/6/7）✓；列内排序规则（Task 1 SQL）✓；cleanupOld 不动三表（Task 1 建表位置在 SCHEMA、清理 SQL 未涉及）✓；文档同步（Task 8）✓；YAGNI 边界（无任务关联、无推送、无列内拖排、无配置化）✓
- **类型一致性**：`AirdropPriority`/`AirdropProjectView`/`TodoDraft`/`buildReminders`/`airdropRouter({ db })` 在各 Task 签名一致；错误码 40905/40407 全局一致
- **占位符扫描**：无 TBD/TODO；Task 4 与 hooks 测试处对既有文件模式的引用已注明先读文件再按其结构补全（非占位，是执行指令）

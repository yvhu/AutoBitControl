/**
 * 空投追踪（server 层）：提醒汇总纯函数 + REST 路由
 * 依赖方向：server → infrastructure（db 类型与 todayStr）
 * 设计思路：提醒规则抽为纯函数便于单测；窗口天数写死常量（不配置化）；
 * 路由体解析函数独立成纯逻辑，参数非法统一 400（业务码 40000）
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import { todayStr, type AirdropPriority, type AirdropProjectRow, type AirdropTodoRow, type AppDb } from '../../infrastructure/db'

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

/** 路由路径参数解析：非法/非正整数返回 NaN（统一按 404 处理）；express5 下 params 可能为 string[] */
function parseId(raw: string | string[]): number {
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

/** 空投追踪 REST 路由工厂（Task 4 在 src/server/app.ts 挂载到 /api 前缀） */
export function airdropRouter(deps: { db: AppDb }): Router {
  const router = Router()

  router.get('/airdrop/statuses', asyncHandler(async (_req, res) => {
    ok(res, await deps.db.listAirdropStatuses())
  }))

  router.post('/airdrop/statuses', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '状态名不能为空')
    const s = await deps.db.createAirdropStatus(body.name.trim())
    if (!s) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '状态名已存在')
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

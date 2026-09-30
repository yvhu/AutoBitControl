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

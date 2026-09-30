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

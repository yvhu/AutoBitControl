import { describe, it, expect } from 'vitest'
import { deadlineBadge, diffDays, diffTodos, groupByStatus, reminderBannerText, todayLocal } from './board'
import type { TodoDraft } from './board'
import type { AirdropProjectView, AirdropReminders, AirdropTodoItem } from '../../types'

const proj = (id: number, statusId: number): AirdropProjectView => ({
  id, name: `P${id}`, statusId, priority: 'mid', deadline: null, link: null, note: null, taskKey: null,
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
    const next: TodoDraft[] = [
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
    const next: TodoDraft[] = [
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

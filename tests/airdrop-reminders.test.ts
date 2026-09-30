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

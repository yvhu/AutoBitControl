import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import dayjs from 'dayjs'
import { buildTemplate, sampleName, useFileAssignApply, useUpdateFileAssignSchedule, buildFileAssignSchedulePayload } from './hooks'
import type { FileAssignTemplate } from '../../types'

vi.mock('../../api/endpoints', () => ({
  applyFileAssign: vi.fn().mockResolvedValue({ renamedCount: 2, updatedRows: 2, reloadedRows: 2 }),
  updateSchedule: vi.fn().mockResolvedValue({}),
}))

const fixed = () => 0

describe('buildTemplate', () => {
  it('组件全空 → 报错', () => {
    const r = buildTemplate({ english: false, englishCount: 4, caseMode: 'lower', digits: false, digitsCount: 3, special: false, specialCount: 2, charset: '!@', position: 'replace', positionValue: '' })
    expect('error' in r).toBe(true)
  })

  it('after-position 非法 → 报错', () => {
    const r = buildTemplate({ english: true, englishCount: 2, caseMode: 'lower', digits: false, digitsCount: 3, special: false, specialCount: 2, charset: '!@', position: 'after-position', positionValue: '0' })
    expect('error' in r).toBe(true)
  })

  it('special 勾选但字符集为空 → 报错', () => {
    const r = buildTemplate({ english: false, englishCount: 4, caseMode: 'lower', digits: false, digitsCount: 3, special: true, specialCount: 2, charset: '  ', position: 'replace', positionValue: '' })
    expect(r).toEqual({ error: '特殊字符集不能为空' })
  })

  it('special 字符集含非法文件名字符 → 报错', () => {
    const r = buildTemplate({ english: false, englishCount: 4, caseMode: 'lower', digits: false, digitsCount: 3, special: true, specialCount: 2, charset: 'ab*c', position: 'replace', positionValue: '' })
    expect(r).toEqual({ error: '特殊字符集含文件名非法字符' })
  })

  it('合法表单 → 模板对象（positionValue 转数字）', () => {
    const r = buildTemplate({ english: true, englishCount: 2, caseMode: 'mixed', digits: false, digitsCount: 3, special: false, specialCount: 2, charset: '!@', position: 'after-position', positionValue: '3' })
    expect(r).toEqual({
      template: {
        english: { count: 2, caseMode: 'mixed' },
        digits: null,
        special: null,
        position: { type: 'after-position', value: 3 },
      },
    })
  })
})

describe('sampleName', () => {
  const t: FileAssignTemplate = { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }

  it('before：生成串在前，保留扩展名', () => {
    expect(sampleName('a.png', t, fixed)).toBe('aaa.png')
  })

  it('replace：替换 stem', () => {
    expect(sampleName('a.png', { ...t, position: { type: 'replace' } }, fixed)).toBe('aa.png')
  })

  it('after-position：第 N 字符后插入', () => {
    expect(sampleName('abcd.png', { ...t, position: { type: 'after-position', value: 2 } }, fixed)).toBe('abaacd.png')
  })

  it('after-text：文本后插入；未找到放末尾', () => {
    expect(sampleName('file2024x.png', { ...t, position: { type: 'after-text', value: '2024' } }, fixed)).toBe('file2024aax.png')
    expect(sampleName('abcd.png', { ...t, position: { type: 'after-text', value: 'zzz' } }, fixed)).toBe('abcdaa.png')
  })
})

describe('useFileAssignApply', () => {
  it('成功后提示并失效 settings 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useFileAssignApply(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({ sourceDir: 'D:/x', column: '文件地址', plan: [] })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] }))
  })
})

describe('buildFileAssignSchedulePayload', () => {
  const tpl: FileAssignTemplate = { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }
  const assign = { sourceDir: 'C:\\files', column: '文件地址', template: tpl }

  it('daily 模式：times 转 HH:mm 排序，fileAssign 固化，taskKeys 恒为空', () => {
    const p = buildFileAssignSchedulePayload({ mode: 'daily', times: [dayjs('15:00', 'HH:mm'), dayjs('09:00', 'HH:mm')] }, assign)
    expect(p).toEqual({
      name: '文件随机分配（定时）',
      mode: 'daily',
      config: { times: ['09:00', '15:00'], fileAssign: assign },
      taskKeys: [],
    })
  })

  it('interval 模式：带 everyHours，无 times', () => {
    const p = buildFileAssignSchedulePayload({ mode: 'interval', everyHours: 6 }, assign)
    expect(p.config).toEqual({ everyHours: 6, fileAssign: assign })
    expect(p.taskKeys).toEqual([])
  })

  it('weekly 模式：带 weekdays', () => {
    const p = buildFileAssignSchedulePayload({ mode: 'weekly', weekdays: [1, 5], times: [dayjs('09:00', 'HH:mm')] }, assign)
    expect(p.config).toEqual({ times: ['09:00'], weekdays: [1, 5], fileAssign: assign })
  })
})

describe('useUpdateFileAssignSchedule', () => {
  it('成功后失效 schedules 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateFileAssignSchedule(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({ id: 1, enabled: false })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedules'] }))
  })
})


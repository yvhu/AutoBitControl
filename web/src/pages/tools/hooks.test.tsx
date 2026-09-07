import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { buildTemplate, sampleName, useFileAssignApply } from './hooks'
import type { FileAssignTemplate } from '../../types'

vi.mock('../../api/endpoints', () => ({
  applyFileAssign: vi.fn().mockResolvedValue({ renamedCount: 2, updatedRows: 2, reloadedRows: 2 }),
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

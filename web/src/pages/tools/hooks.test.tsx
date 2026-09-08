import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { buildTemplate, sampleName, useFileAssignApply, summarizeNodes, useClashStatus, useClashOptimize } from './hooks'
import type { FileAssignTemplate } from '../../types'

vi.mock('../../api/endpoints', () => ({
  applyFileAssign: vi.fn().mockResolvedValue({ renamedCount: 2, updatedRows: 2, reloadedRows: 2 }),
  fetchClashStatus: vi.fn().mockResolvedValue({
    detected: true, kernel: 'mihomo', mixedPort: 7890, apiBase: 'http://127.0.0.1:9090',
    capability: { listProxies: true, delay: true, switchNode: true, providers: false, switchProfile: false },
    group: 'GLOBAL', currentNode: 'HK-01', groups: [{ name: 'GLOBAL', now: 'HK-01' }], subscriptions: [],
    auto: { pace: 'normal', lastCheckAt: null, allDown: false, deferredSwitches: 0 }, anyRunning: false,
  }),
  testClash: vi.fn().mockResolvedValue({ group: 'GLOBAL', currentNode: 'HK-01', currentUsable: true, nodes: [] }),
  optimizeClash: vi.fn().mockResolvedValue({ chosen: 'HK-02', switched: true, nodes: [] }),
  setClashGroup: vi.fn().mockResolvedValue({ group: 'GLOBAL' }),
  updateClashSubscription: vi.fn().mockResolvedValue(null),
  fetchClashProfiles: vi.fn().mockResolvedValue({ files: ['a.yaml'] }),
  switchClashProfile: vi.fn().mockResolvedValue({ file: 'a.yaml' }),
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

describe('summarizeNodes', () => {
  it('统计可用/不可用并取最优节点', () => {
    const nodes = [
      { name: 'B', urls: [], score: 50, usable: true },
      { name: 'A', urls: [], score: 100, usable: true },
      { name: 'D', urls: [], score: 999, usable: false },
    ]
    expect(summarizeNodes(nodes)).toEqual({ usableCount: 2, downCount: 1, best: nodes[0] })
  })

  it('全部不可用 → best 为 null', () => {
    expect(summarizeNodes([{ name: 'D', urls: [], score: 999, usable: false }])).toEqual({ usableCount: 0, downCount: 1, best: null })
  })
})

describe('useClashStatus', () => {
  it('返回探测状态', async () => {
    const qc = new QueryClient()
    const { result } = renderHook(() => useClashStatus(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    await waitFor(() => expect(result.current.data?.detected).toBe(true))
  })
})

describe('useClashOptimize', () => {
  it('成功后失效 clash-status 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useClashOptimize(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['clash-status'] }))
  })
})

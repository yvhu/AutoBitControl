import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { datasourceText, formatBalance, useTestBitbrowser } from './hooks'

vi.mock('../../api/endpoints', () => ({ testBitbrowser: vi.fn().mockResolvedValue({ ok: true }) }))

describe('formatBalance', () => {
  it('已配置 → N 点（¥X）', () => {
    expect(formatBalance({ configured: true, points: 12345, yuan: 12.345 })).toBe('12,345 点（¥12.345）')
  })

  it('未配置 → 未配置 Key', () => {
    expect(formatBalance({ configured: false, points: 0, yuan: 0 })).toBe('未配置 Key')
  })
})

describe('datasourceText', () => {
  it('可用 → N 行（列: a, b, c）', () => {
    expect(datasourceText({ available: true, rows: 3, columns: ['a', 'b', 'c'] })).toBe('3 行（列: a, b, c）')
  })

  it('不可用 → 未配置', () => {
    expect(datasourceText({ available: false, rows: 0, columns: [] })).toBe('未配置')
  })
})

describe('useTestBitbrowser', () => {
  it('成功后失效顶栏 bitbrowser-status 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useTestBitbrowser(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bitbrowser-status'] }))
  })
})

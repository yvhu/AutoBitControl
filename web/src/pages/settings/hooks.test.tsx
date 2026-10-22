import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { datasourceText, usePoolStatus, useTestBitbrowser } from './hooks'
import { fetchPoolStatus } from '../../api/endpoints'

vi.mock('../../api/endpoints', () => ({
  testBitbrowser: vi.fn().mockResolvedValue({ ok: true }),
  fetchPoolStatus: vi.fn(),
}))

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

describe('usePoolStatus', () => {
  it('每 5 秒轮询一次池状态', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchPoolStatus).mockResolvedValue({ enabled: false, status: null })
      const qc = new QueryClient()
      renderHook(() => usePoolStatus(), {
        wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(fetchPoolStatus).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(fetchPoolStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

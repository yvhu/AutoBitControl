import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useGuardedMutation } from './useGuardedMutation'

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useGuardedMutation', () => {
  it('pending 期间忽略重复 run', async () => {
    const client = new QueryClient()
    let resolve: (v: unknown) => void = () => {}
    const mutationFn = vi.fn(() => new Promise<unknown>((r) => { resolve = r }))
    const { result } = renderHook(() => useGuardedMutation({ mutationFn }), { wrapper: wrapper(client) })
    act(() => { result.current.run(1); result.current.run(2) })
    await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1))
    await act(async () => { resolve(null) })
  })

  it('完成后 cooldownMs 内忽略重复，冷却后恢复', async () => {
    const client = new QueryClient()
    const mutationFn = vi.fn().mockResolvedValue(null)
    const { result } = renderHook(() => useGuardedMutation({ mutationFn }, { cooldownMs: 50 }), { wrapper: wrapper(client) })
    await act(async () => { result.current.run(1) })
    await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1))
    act(() => { result.current.run(2) })
    expect(mutationFn).toHaveBeenCalledTimes(1) // 冷却内
    await new Promise((r) => setTimeout(r, 60))
    await act(async () => { result.current.run(3) })
    expect(mutationFn).toHaveBeenCalledTimes(2)
  })

  it('getKey 区分变量：不同键互不影响，同一键仍去重', async () => {
    const client = new QueryClient()
    const mutationFn = vi.fn().mockResolvedValue(null)
    const { result } = renderHook(
      () => useGuardedMutation({ mutationFn }, { getKey: (v: number) => v }),
      { wrapper: wrapper(client) },
    )
    act(() => { result.current.run(1); result.current.run(2); result.current.run(1) })
    await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(2)) // 键 1、2 各一次，重复的键 1 被忽略
  })
})

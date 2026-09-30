/**
 * 空投追踪 hooks 单测（web 层）
 * 依赖方向：mock ../../api/endpoints，断言变更编排（invalidate/乐观回滚/子项 diff）
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { useAirdropReminders, useSaveProject, useUpdateProject } from './hooks'
import { createAirdropProject, createAirdropTodo, deleteAirdropTodo, fetchAirdropReminders, updateAirdropProject, updateAirdropTodo } from '../../api/endpoints'
import type { AirdropProjectView, AirdropReminders } from '../../types'

vi.mock('../../api/endpoints', () => ({
  createAirdropProject: vi.fn(),
  updateAirdropProject: vi.fn(),
  createAirdropTodo: vi.fn(),
  updateAirdropTodo: vi.fn(),
  deleteAirdropTodo: vi.fn(),
  deleteAirdropProject: vi.fn(),
  fetchAirdropProjects: vi.fn().mockResolvedValue([]),
  fetchAirdropStatuses: vi.fn().mockResolvedValue([]),
  fetchAirdropReminders: vi.fn().mockResolvedValue({ upcoming: [], overdue: [] }),
  createAirdropStatus: vi.fn(),
  updateAirdropStatus: vi.fn(),
  deleteAirdropStatus: vi.fn(),
}))

const savedView: AirdropProjectView = {
  id: 1, name: 'X', statusId: 1, priority: 'mid', deadline: null, link: null, note: null,
  createdAt: 'x', updatedAt: 'x', statusName: '关注中', todos: [],
}

const makeMessage = () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })

describe('useAirdropReminders', () => {
  it('查询成功返回提醒汇总数据', async () => {
    const reminders: AirdropReminders = {
      upcoming: [{ type: 'project', id: 1, name: 'Inception', date: '2026-10-05', daysLeft: 5 }],
      overdue: [],
    }
    vi.mocked(fetchAirdropReminders).mockResolvedValue(reminders)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useAirdropReminders(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(reminders)
  })
})

describe('useSaveProject', () => {
  it('新建成功后提示并失效看板/列/提醒三查询', async () => {
    vi.mocked(createAirdropProject).mockResolvedValue(savedView)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const message = makeMessage()
    vi.spyOn(App, 'useApp').mockReturnValue({ message } as never)
    const { result } = renderHook(() => useSaveProject(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({ id: null, values: { name: 'X', statusId: 1 }, todos: [] })
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('项目已保存'))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['airdrop-projects'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['airdrop-statuses'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['airdrop-reminders'] })
  })

  it('编辑保存按 diff 执行子项增改删', async () => {
    vi.mocked(updateAirdropProject).mockResolvedValue({
      ...savedView,
      todos: [
        { id: 2, projectId: 1, content: '要改', done: 0, dueDate: null, priority: 'mid', createdAt: 'x' },
        { id: 3, projectId: 1, content: '要删', done: 0, dueDate: null, priority: 'mid', createdAt: 'x' },
      ],
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const message = makeMessage()
    vi.spyOn(App, 'useApp').mockReturnValue({ message } as never)
    const { result } = renderHook(() => useSaveProject(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({
      id: 1,
      values: { name: 'X', statusId: 1 },
      todos: [
        { key: 'k2', id: 2, content: '改过了', dueDate: '2026-10-05', priority: 'high' },
        { key: 'k3', content: '新子项', dueDate: null, priority: 'low' },
      ],
    })
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('项目已保存'))
    expect(createAirdropTodo).toHaveBeenCalledWith(1, { content: '新子项', dueDate: null, priority: 'low' })
    expect(updateAirdropTodo).toHaveBeenCalledWith(2, { content: '改过了', dueDate: '2026-10-05', priority: 'high' })
    expect(deleteAirdropTodo).toHaveBeenCalledWith(3)
  })
})

describe('useUpdateProject', () => {
  it('拖拽乐观更新缓存，失败回滚并报错', async () => {
    let rejectFn!: (reason: unknown) => void
    vi.mocked(updateAirdropProject).mockImplementationOnce(
      () => new Promise<AirdropProjectView>((_resolve, reject) => { rejectFn = reject }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const base: AirdropProjectView = {
      id: 1, name: 'P1', statusId: 1, priority: 'mid', deadline: null, link: null, note: null,
      createdAt: 'x', updatedAt: 'x', statusName: '列', todos: [],
    }
    qc.setQueryData(['airdrop-projects'], [base, { ...base, id: 2, name: 'P2' }])
    const message = makeMessage()
    vi.spyOn(App, 'useApp').mockReturnValue({ message } as never)
    const { result } = renderHook(() => useUpdateProject(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({ id: 1, statusId: 2 })
    await waitFor(() => {
      const data = qc.getQueryData<AirdropProjectView[]>(['airdrop-projects'])
      expect(data?.find((p) => p.id === 1)?.statusId).toBe(2)
    })
    rejectFn(new Error('网络错误'))
    await waitFor(() => {
      const data = qc.getQueryData<AirdropProjectView[]>(['airdrop-projects'])
      expect(data?.find((p) => p.id === 1)?.statusId).toBe(1)
    })
    expect(message.error).toHaveBeenCalledWith('操作失败，请重试')
  })
})

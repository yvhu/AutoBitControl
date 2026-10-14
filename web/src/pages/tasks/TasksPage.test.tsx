/**
 * TasksPage 状态 Tab 单测：默认选中「已启用」、Tab 带数量、切换后展示对应分组
 * 依赖方向：mock ../../api/endpoints；用 antd App + QueryClientProvider 包裹
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import TasksPage from './index'
import { fetchTasks } from '../../api/endpoints'
import type { TaskMetaView } from '../../types'

vi.mock('../../api/endpoints', () => ({
  fetchTasks: vi.fn(),
  setTaskEnabled: vi.fn(),
  triggerTask: vi.fn(),
  fetchProfiles: vi.fn(),
}))

const tasks = [
  { key: 'a', name: '启用任务', enabled: true, group: { key: 'g1', name: '组一' } },
  { key: 'b', name: '停用任务', enabled: false, group: { key: 'g2', name: '组二' } },
] as unknown as TaskMetaView[]

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <App>
      <QueryClientProvider client={qc}>
        <TasksPage />
      </QueryClientProvider>
    </App>,
  )
}

describe('TasksPage 状态 Tab', () => {
  it('默认选中已启用并带数量；切换到已停用展示对应分组', async () => {
    vi.mocked(fetchTasks).mockResolvedValue(tasks)
    renderPage()

    const enabledTab = await screen.findByRole('tab', { name: /已启用 1/ })
    expect(enabledTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /已停用 1/ })).toBeInTheDocument()

    // 默认 Tab 展示启用桶的分组；停用桶的分组尚未挂载
    expect(await screen.findByText('组一')).toBeInTheDocument()
    expect(screen.queryByText('组二')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /已停用/ }))
    expect(await screen.findByText('组二')).toBeInTheDocument()
  })
})

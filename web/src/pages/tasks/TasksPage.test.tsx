/**
 * TasksPage 状态 Tab 单测：默认选中「已启用」、Tab 带数量、切换后展示对应分组
 * 依赖方向：mock ../../api/endpoints；用 antd App + QueryClientProvider 包裹
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import TasksPage from './index'
import { fetchTasks, triggerTask } from '../../api/endpoints'
import type { TaskMetaView } from '../../types'

vi.mock('../../api/endpoints', () => ({
  fetchTasks: vi.fn(),
  setTaskEnabled: vi.fn(),
  triggerTask: vi.fn(),
  fetchProfiles: vi.fn(),
}))

// antd 弹层在 jsdom 下渲染较重，全量并行跑时默认 5s 超时不够，本文件单独放宽
vi.setConfig({ testTimeout: 20000 })

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

  it('任务卡同时展示「任务页」与「发现来源」链接', async () => {
    vi.mocked(fetchTasks).mockResolvedValue([
      { key: 'dac', name: 'DAC 签到', enabled: true, url: 'https://site/', sourceUrl: ['https://a/', 'https://b/'] },
    ] as unknown as TaskMetaView[])
    renderPage()

    expect(await screen.findByRole('link', { name: /任务页/ })).toHaveAttribute('href', 'https://site/')
    const sources = await screen.findAllByRole('link', { name: /发现来源/ })
    expect(sources).toHaveLength(2)
    expect(sources[0]).toHaveAttribute('href', 'https://a/')
    expect(sources[1]).toHaveAttribute('href', 'https://b/')
  })

  it('点「立即触发」需经二次确认才调用触发接口', async () => {
    vi.mocked(fetchTasks).mockResolvedValue([
      { key: 'a', name: '启用任务', enabled: true },
    ] as unknown as TaskMetaView[])
    renderPage()
    const btn = await screen.findByRole('button', { name: /立\s?即\s?触\s?发/ }, { timeout: 15000 })
    fireEvent.click(btn)
    // 确认弹窗出现前不调用接口
    expect(vi.mocked(triggerTask)).not.toHaveBeenCalled()
    await screen.findByText('将对全部启用窗口开窗执行，确认？', undefined, { timeout: 15000 })
    // antd 会在两个中文字之间自动插空格，用 \s? 兼容
    const ok = await screen.findByRole('button', { name: /^触\s?发$/ }, { timeout: 15000 })
    fireEvent.click(ok)
    await waitFor(() => expect(vi.mocked(triggerTask)).toHaveBeenCalledWith('a'))
  })
})

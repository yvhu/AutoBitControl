/**
 * PoolStatusCard 单测：窗口池启用时展示状态指标，未启用时提示开启方式
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PoolStatusCard from './PoolStatusCard'
import { fetchPoolStatus } from '../../api/endpoints'
import type { PoolStatusData } from '../../types'

vi.mock('../../api/endpoints', () => ({ fetchPoolStatus: vi.fn() }))

function renderCard(data: PoolStatusData) {
  vi.mocked(fetchPoolStatus).mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PoolStatusCard />
    </QueryClientProvider>,
  )
}

describe('PoolStatusCard 窗口池状态卡片', () => {
  it('启用时展示内存/健康/容量/队列指标', async () => {
    renderCard({
      enabled: true,
      status: {
        memoryState: 'warning',
        globalHealthState: 'paused',
        freeMb: 3200,
        perWindowMb: 1024,
        effectivePool: 2,
        maxOpenWindows: 4,
        actualOpen: 3,
        poolSize: 2,
        busy: 1,
        idle: 1,
        opening: 1,
        queueWindows: 2,
        pendingTasks: 6,
        updatedAt: '2026-10-22 09:00:00.000',
      },
    })
    expect(await screen.findByText('窗口池状态')).toBeInTheDocument()
    expect(await screen.findByText('偏高')).toBeInTheDocument()
    expect(screen.getByText('暂停')).toBeInTheDocument()
    expect(screen.getByText('3200 MB')).toBeInTheDocument()
    expect(screen.getByText('1024 MB')).toBeInTheDocument()
    expect(screen.getByText('2 / 4')).toBeInTheDocument()
    expect(screen.getByText('3 / 2')).toBeInTheDocument()
    expect(screen.getByText('1 / 1 / 1')).toBeInTheDocument()
    expect(screen.getByText('2 / 6')).toBeInTheDocument()
    expect(screen.getByText('2026-10-22 09:00:00.000')).toBeInTheDocument()
  })

  it('状态快照缺失时提示稍后刷新', async () => {
    renderCard({ enabled: true, status: null })
    expect(await screen.findByText('窗口池状态不可用')).toBeInTheDocument()
    expect(screen.getByText(/稍后刷新/)).toBeInTheDocument()
  })
})

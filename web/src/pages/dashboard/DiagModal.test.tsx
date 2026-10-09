/**
 * DiagModal 单测（web 层）：注入 fake 诊断包，断言错误/步骤/文本渲染，未打开时不请求
 * 依赖方向：mock ../../api/endpoints，用 QueryClientProvider 包裹
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import DiagModal from './DiagModal'
import { fetchDiagnostics } from '../../api/endpoints'
import type { DiagBundle } from '../../types'

vi.mock('../../api/endpoints', () => ({ fetchDiagnostics: vi.fn() }))

const fakeDiag: DiagBundle = {
  taskKey: 'faucet',
  profileName: '窗口1',
  status: 'failed',
  error: '提交后未出现成功文案',
  url: 'https://faucet.example/claim',
  capturedAt: '2026-10-09T10:00:00.000Z',
  steps: [
    { name: '打开站点', startMs: 1000, ms: 1200, ok: true },
    { name: '点击领取', startMs: 2200, ms: 800, ok: false, detail: '超时' },
  ],
  visibleText: '账户余额 0 ETH',
  dialogText: '请先连接钱包',
}

function renderModal(props: Partial<ComponentProps<typeof DiagModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DiagModal runId={7} open onClose={() => {}} {...props} />
    </QueryClientProvider>,
  )
}

describe('DiagModal', () => {
  it('打开时拉取诊断并渲染错误与步骤时间线', async () => {
    vi.mocked(fetchDiagnostics).mockResolvedValue(fakeDiag)
    renderModal()
    await waitFor(() => expect(screen.getByText('提交后未出现成功文案')).toBeInTheDocument())
    expect(fetchDiagnostics).toHaveBeenCalledWith(7)
    expect(screen.getByText(/打开站点/)).toBeInTheDocument()
    expect(screen.getByText(/点击领取/)).toBeInTheDocument()
    expect(screen.getByText('账户余额 0 ETH')).toBeInTheDocument()
    expect(screen.getByText('请先连接钱包')).toBeInTheDocument()
  })

  it('传入截图时显示查看截图入口', async () => {
    vi.mocked(fetchDiagnostics).mockResolvedValue(fakeDiag)
    renderModal({ screenshot: '2026-10-09/x.png' })
    await waitFor(() => expect(screen.getByText(/查看截图/)).toBeInTheDocument())
  })

  it('未打开时不请求诊断', () => {
    vi.mocked(fetchDiagnostics).mockClear()
    renderModal({ open: false })
    expect(fetchDiagnostics).not.toHaveBeenCalled()
  })
})

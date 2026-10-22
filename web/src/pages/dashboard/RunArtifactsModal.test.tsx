/**
 * RunArtifactsModal 单测（web 层）：断言按需拉取、标签映射、空态与未打开不请求
 * 依赖方向：mock ../../api/endpoints，用 QueryClientProvider 包裹
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import RunArtifactsModal, { artifactLabel } from './RunArtifactsModal'
import { fetchRunArtifacts } from '../../api/endpoints'
import type { RunArtifactsData } from '../../types'

vi.mock('../../api/endpoints', () => ({ fetchRunArtifacts: vi.fn() }))

function renderModal(props: Partial<ComponentProps<typeof RunArtifactsModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RunArtifactsModal runId={7} open onClose={() => {}} {...props} />
    </QueryClientProvider>,
  )
}

const data: RunArtifactsData = {
  runId: 7,
  files: [
    { name: 'quiz-answer.png', path: '/s/quiz-answer.png', size: 1, mtimeMs: 1 },
    { name: 'claim-success.png', path: '/s/claim-success.png', size: 1, mtimeMs: 2 },
    { name: '2026-10-21-success.png', path: '/s/2026-10-21-success.png', size: 1, mtimeMs: 3 },
  ],
}

describe('artifactLabel', () => {
  it('固定名/框架名映射为中文，未知名保留原名', () => {
    expect(artifactLabel('quiz-answer.png')).toBe('答题')
    expect(artifactLabel('claim-success.png')).toBe('领取成功')
    expect(artifactLabel('2026-10-21-success.png')).toBe('完成')
    expect(artifactLabel('2026-10-21-attempt2.png')).toBe('第 2 次失败')
    expect(artifactLabel('foo.png')).toBe('foo')
  })
})

describe('RunArtifactsModal', () => {
  it('打开时拉取并展示全部截图与数量', async () => {
    vi.mocked(fetchRunArtifacts).mockResolvedValue(data)
    renderModal()
    await waitFor(() => expect(screen.getByText('截图（3 张）')).toBeInTheDocument())
    expect(fetchRunArtifacts).toHaveBeenCalledWith(7)
    expect(screen.getByAltText('答题')).toBeInTheDocument()
    expect(screen.getByAltText('领取成功')).toBeInTheDocument()
    expect(screen.getByAltText('完成')).toBeInTheDocument()
  })

  it('无截图时显示空态', async () => {
    vi.mocked(fetchRunArtifacts).mockResolvedValue({ runId: 7, files: [] })
    renderModal()
    await waitFor(() => expect(screen.getByText('暂无截图')).toBeInTheDocument())
  })

  it('未打开时不请求', () => {
    vi.mocked(fetchRunArtifacts).mockClear()
    renderModal({ open: false })
    expect(fetchRunArtifacts).not.toHaveBeenCalled()
  })
})

/**
 * RerunFailedModal 单测：默认勾选、已成功可强勾、停用/在途不可选、确认提交 runIds、
 * 重新打开使用新预览（含加载中/失败态）、新鲜数据剔除不可选勾选
 * 依赖方向：mock ../../api/endpoints，用 QueryClientProvider + App 包裹
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { useState } from 'react'
import type { ReactNode } from 'react'
import RerunFailedModal from './RerunFailedModal'
import { fetchRerunCandidates, rerunBatch } from '../../api/endpoints'
import type { RerunCandidatesData } from '../../types'

vi.mock('../../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints')>()
  return { ...actual, fetchRerunCandidates: vi.fn(), rerunBatch: vi.fn() }
})

// antd Table 在 jsdom 下渲染较重，全量并行跑时默认 5s 超时不够，本文件单独放宽
vi.setConfig({ testTimeout: 20000 })

const data: RerunCandidatesData = {
  batchId: 2,
  taskKey: 't1',
  candidates: [
    { runId: 1, profileId: 1, profileName: '窗口1', bitbrowserId: 'bb-1', status: 'failed', error: 'boom', finishedAt: null, latestStatus: 'success', latestFinishedAt: '2026-10-17 11:00:00.000', alreadySuccess: true, inFlight: false, selectable: true, defaultSelected: false, blockedReason: null },
    { runId: 2, profileId: 2, profileName: '窗口2', bitbrowserId: 'bb-2', status: 'captcha_failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: true, defaultSelected: true, blockedReason: null },
    { runId: 3, profileId: 3, profileName: '窗口3', bitbrowserId: 'bb-3', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: false, defaultSelected: false, blockedReason: 'profile-disabled' },
    { runId: 4, profileId: 4, profileName: '窗口4', bitbrowserId: 'bb-4', status: 'failed', error: null, finishedAt: null, latestStatus: 'running', latestFinishedAt: null, alreadySuccess: false, inFlight: true, selectable: false, defaultSelected: false, blockedReason: 'in-flight' },
  ],
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}><App>{children}</App></QueryClientProvider>
}

const firstPreview: RerunCandidatesData = {
  batchId: 2,
  taskKey: 't1',
  candidates: [
    { runId: 11, profileId: 1, profileName: '窗口A', bitbrowserId: 'bb-a', status: 'failed', error: null, finishedAt: null, latestStatus: 'success', latestFinishedAt: null, alreadySuccess: true, inFlight: false, selectable: true, defaultSelected: false, blockedReason: null },
    { runId: 12, profileId: 2, profileName: '窗口B', bitbrowserId: 'bb-b', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: true, defaultSelected: true, blockedReason: null },
  ],
}

const secondPreview: RerunCandidatesData = {
  batchId: 2,
  taskKey: 't1',
  candidates: [
    { runId: 11, profileId: 1, profileName: '窗口A', bitbrowserId: 'bb-a', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: true, defaultSelected: true, blockedReason: null },
    { runId: 12, profileId: 2, profileName: '窗口B', bitbrowserId: 'bb-b', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: false, defaultSelected: false, blockedReason: 'circuit-breaker' },
  ],
}

const pruneFirstPreview: RerunCandidatesData = {
  batchId: 2,
  taskKey: 't1',
  candidates: [
    { runId: 21, profileId: 1, profileName: '窗口A', bitbrowserId: 'bb-a', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: true, defaultSelected: false, blockedReason: null },
    { runId: 22, profileId: 2, profileName: '窗口B', bitbrowserId: 'bb-b', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: true, defaultSelected: true, blockedReason: null },
  ],
}

const pruneSecondPreview: RerunCandidatesData = {
  batchId: 2,
  taskKey: 't1',
  candidates: [
    { runId: 21, profileId: 1, profileName: '窗口A', bitbrowserId: 'bb-a', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: false, defaultSelected: false, blockedReason: 'circuit-breaker' },
    { runId: 22, profileId: 2, profileName: '窗口B', bitbrowserId: 'bb-b', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: true, defaultSelected: true, blockedReason: null },
  ],
}

function OpenCloseHarness() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)}>{open ? '关闭预览' : '打开预览'}</button>
      <RerunFailedModal batchId={2} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

function renderHarness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function HarnessWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}><App>{children}</App></QueryClientProvider>
  }
  return { qc, ...render(<OpenCloseHarness />, { wrapper: HarnessWrapper }) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 关闭后等待 5ms 再打开，避免同一毫秒内 dataUpdatedAt 与 openedAt 相等被误判为新鲜数据 */
async function closeThenReopen() {
  fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '打开预览' })).toBeInTheDocument())
  await new Promise((resolve) => setTimeout(resolve, 5))
  fireEvent.click(screen.getByRole('button', { name: '打开预览' }))
}

describe('RerunFailedModal', () => {
  beforeEach(() => {
    vi.mocked(fetchRerunCandidates).mockReset()
    vi.mocked(rerunBatch).mockReset()
  })

  it('默认勾选非成功窗口，已成功可手动勾选，停用/在途不可选，确认提交选中 runIds', async () => {
    vi.mocked(fetchRerunCandidates).mockResolvedValue(data)
    vi.mocked(rerunBatch).mockResolvedValue({ batchId: 9, queued: 2 })
    render(<RerunFailedModal batchId={2} open onClose={() => {}} />, { wrapper })
    await screen.findByText('后续已成功')
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 1 个/ })).toBeEnabled())
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[1]).not.toBeChecked()
    expect(boxes[2]).toBeChecked()
    expect(boxes[3]).toBeDisabled()
    expect(boxes[4]).not.toBeChecked()
    expect(boxes[4]).toBeDisabled()
    expect(screen.getByText('执行中，暂不可重跑')).toBeInTheDocument()
    expect(screen.queryByText('在途·将排队')).toBeNull()
    fireEvent.click(boxes[1])
    expect(screen.getByRole('button', { name: /重跑选中 2 个/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重跑选中 2 个/ }))
    await waitFor(() => expect(rerunBatch).toHaveBeenCalledWith(2, [1, 2]))
  })

  it('重新打开时等待新响应，加载中禁止提交，新预览就绪后再校验勾选与提交', async () => {
    const second = deferred<RerunCandidatesData>()
    vi.mocked(fetchRerunCandidates)
      .mockResolvedValueOnce(firstPreview)
      .mockReturnValueOnce(second.promise)
    vi.mocked(rerunBatch).mockResolvedValue({ batchId: 9, queued: 1 })
    renderHarness()

    await screen.findByText('窗口A')
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 1 个/ })).toBeEnabled())
    const firstBoxes = screen.getAllByRole('checkbox')
    expect(firstBoxes[1]).not.toBeChecked()
    expect(firstBoxes[2]).toBeChecked()

    await closeThenReopen()

    // 第二次响应仍在途：只显示加载态，不能复用缓存勾选提交
    await waitFor(() => expect(fetchRerunCandidates).toHaveBeenCalledTimes(2))
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(document.querySelector('.ant-spin-spinning')).not.toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 0 个/ })).toBeDisabled())

    await act(async () => {
      second.resolve(secondPreview)
      await second.promise
    })

    await screen.findByText('窗口熔断中，请先重置')
    await waitFor(() => {
      const reopenedBoxes = screen.getAllByRole('checkbox')
      expect(reopenedBoxes[1]).toBeChecked()
      expect(reopenedBoxes[2]).not.toBeChecked()
      expect(reopenedBoxes[2]).toBeDisabled()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 1 个/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /重跑选中 1 个/ }))
    await waitFor(() => expect(rerunBatch).toHaveBeenCalledWith(2, [11]))
  })

  it('重新打开时新预览请求失败：显示错误且不允许提交缓存勾选', async () => {
    vi.mocked(fetchRerunCandidates)
      .mockResolvedValueOnce(firstPreview)
      .mockRejectedValueOnce(new Error('network down'))
    vi.mocked(rerunBatch).mockResolvedValue({ batchId: 9, queued: 1 })
    renderHarness()

    await screen.findByText('窗口A')
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 1 个/ })).toBeEnabled())

    await closeThenReopen()

    await screen.findByText('预览加载失败')
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 0 个/ })).toBeDisabled())
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(rerunBatch).not.toHaveBeenCalled()
  })

  it('新鲜数据把已手动勾选的行变为不可选时，剔除勾选并从提交载荷中排除', async () => {
    vi.mocked(fetchRerunCandidates)
      .mockResolvedValueOnce(pruneFirstPreview)
      .mockResolvedValueOnce(pruneSecondPreview)
    vi.mocked(rerunBatch).mockResolvedValue({ batchId: 9, queued: 1 })
    const { qc } = renderHarness()

    await screen.findByText('窗口A')
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 1 个/ })).toBeEnabled())
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[1]).not.toBeChecked()
    expect(boxes[2]).toBeChecked()
    fireEvent.click(boxes[1])
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 2 个/ })).toBeInTheDocument())

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['rerunCandidates', 2] })
    })

    await screen.findByText('窗口熔断中，请先重置')
    await waitFor(() => {
      const refreshedBoxes = screen.getAllByRole('checkbox')
      expect(refreshedBoxes[1]).toBeDisabled()
      expect(refreshedBoxes[1]).not.toBeChecked()
      expect(refreshedBoxes[2]).toBeChecked()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 1 个/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /重跑选中 1 个/ }))
    await waitFor(() => expect(rerunBatch).toHaveBeenCalledWith(2, [22]))
  })
})

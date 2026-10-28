/**
 * SingleBatchRow 组件测试：默认仅展示最新轮次、历史轮次可展开且不可操作、行级动作路由
 * 依赖方向：mock ./hooks，用 App + QueryClientProvider 包裹（与 RerunFailedModal.test.tsx 同模式）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import type { ReactNode } from 'react'
import { SingleBatchRow } from './index'
import type { BatchItem, RunRow } from '../../types'
import { useBatchDetail, useRerunBatch, useTriggerTask, useStopRun } from './hooks'

vi.mock('./hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks')>()
  return {
    ...actual,
    useBatchDetail: vi.fn(),
    useRerunBatch: vi.fn(),
    useTriggerTask: vi.fn(),
    useStopRun: vi.fn(),
  }
})

// antd Table 在 jsdom 下渲染较重，全量并行跑时默认 5s 超时不够，本文件单独放宽
vi.setConfig({ testTimeout: 20000 })

const rerunMutate = vi.fn()
const triggerMutate = vi.fn()
const stopMutate = vi.fn()

const taskKey = 'task-1'
const taskInfo = { [taskKey]: { name: '任务一', groupName: null } }

function makeBatch(over: Partial<BatchItem> = {}): BatchItem {
  return {
    id: 2,
    kind: 'single',
    taskKey,
    source: 'trigger-single',
    createdAt: '2026-10-28 08:00:00.000',
    lastActivityAt: '2026-10-28 08:00:00.000',
    lastFinishedAt: '2026-10-28 08:05:00.000',
    stats: { total: 2, success: 0, failed: 1, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 },
    ...over,
  } as BatchItem
}

function makeRun(over: Partial<RunRow>): RunRow {
  return {
    id: 0,
    profileId: 1,
    taskKey,
    date: '2026-10-28',
    slot: 0,
    status: 'failed',
    attempts: 1,
    error: null,
    screenshot: null,
    startedAt: '2026-10-28 08:00:00.000',
    finishedAt: '2026-10-28 08:01:00.000',
    batchId: 2,
    failureKind: 'task',
    profileName: '窗口1',
    bitbrowserId: 'bb-1',
    durationSec: 60,
    inFlight: false,
    isLatest: true,
    notBeforeMs: null,
    ...over,
  } as RunRow
}

const historyRun = makeRun({ id: 101, slot: 0, isLatest: false, error: '旧轮次错误' })
const latestRun = makeRun({ id: 102, slot: 1, isLatest: true, error: '最新轮次错误' })

/** 同一窗口两轮记录：101 为历史轮次，102 为最新轮次 */
const twoRuns = [historyRun, latestRun]

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}><App>{children}</App></QueryClientProvider>
}

beforeEach(() => {
  rerunMutate.mockReset()
  triggerMutate.mockReset()
  stopMutate.mockReset()
  vi.mocked(useRerunBatch).mockReturnValue({ mutate: rerunMutate, isPending: false } as never)
  vi.mocked(useTriggerTask).mockReturnValue({ mutate: triggerMutate, isPending: false } as never)
  vi.mocked(useStopRun).mockReturnValue({ mutate: stopMutate, isPending: false } as never)
})

describe('SingleBatchRow 历史轮次', () => {
  it('默认只展示最新轮次，展开后历史轮次带标记且不可操作，最新轮次重跑写回原批次', () => {
    const batch = makeBatch()
    vi.mocked(useBatchDetail).mockReturnValue({ data: { batch, runs: twoRuns }, isPending: false } as never)

    render(<SingleBatchRow batch={batch} taskInfo={taskInfo} />, { wrapper })

    // 默认仅最新轮次
    expect(screen.getByText('最新轮次错误')).toBeInTheDocument()
    expect(screen.queryByText('旧轮次错误')).toBeNull()
    const historyButton = screen.getByRole('button', { name: '显示历史轮次 1' })
    expect(historyButton).toBeInTheDocument()

    // 展开后历史轮次可见，带「历史轮次 · slot 0」标记，且无操作按钮
    fireEvent.click(historyButton)
    const historyText = screen.getByText('旧轮次错误')
    expect(screen.getByText('历史轮次 · slot 0')).toBeInTheDocument()
    const historyRow = historyText.closest('tr')
    expect(historyRow).not.toBeNull()
    for (const name of ['重跑', '执行', '停止']) {
      expect(within(historyRow as HTMLElement).queryByRole('button', { name })).toBeNull()
    }

    // 最新轮次重跑 → 写回原批次的单窗口 runIds
    const latestRow = screen.getByText('最新轮次错误').closest('tr')
    expect(latestRow).not.toBeNull()
    fireEvent.click(within(latestRow as HTMLElement).getByRole('button', { name: '重跑' }))
    expect(rerunMutate).toHaveBeenCalledWith({ batchId: 2, runIds: [102] })
  })

  it('未分批运行的执行走单窗口触发', () => {
    const batch = makeBatch({ id: 3, stats: { total: 1, success: 1, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 } })
    const run = makeRun({ id: 201, batchId: null, status: 'success', isLatest: true, error: '单窗口成功' })
    vi.mocked(useBatchDetail).mockReturnValue({ data: { batch, runs: [run] }, isPending: false } as never)

    render(<SingleBatchRow batch={batch} taskInfo={taskInfo} />, { wrapper })

    fireEvent.click(screen.getByRole('button', { name: '执行' }))
    expect(triggerMutate).toHaveBeenCalledWith({ key: taskKey, bitbrowserId: 'bb-1' })
    expect(rerunMutate).not.toHaveBeenCalled()
  })
})

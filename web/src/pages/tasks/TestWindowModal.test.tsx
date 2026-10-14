/**
 * TestWindowModal 单测：启用窗口过滤、关键词过滤、全选/反选、已选计数、表头列名、提交 payload
 * 依赖方向：mock ../../api/endpoints；antd App + QueryClientProvider 包裹
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import TestWindowModal, { enabledProfiles, filterByKeyword, selectAllIds, invertIds, byName } from './TestWindowModal'
import { fetchProfiles } from '../../api/endpoints'
import type { ProfileRow } from '../../types'

vi.mock('../../api/endpoints', () => ({ fetchProfiles: vi.fn() }))

// antd Table 在 jsdom 下渲染较重，全量并行跑时默认 5s 超时不够，本文件单独放宽
vi.setConfig({ testTimeout: 20000 })

const mk = (id: number, name: string, bitbrowserId: string, enabled: number, open = false): ProfileRow =>
  ({ id, name, bitbrowserId, enabled, open }) as unknown as ProfileRow

describe('纯函数', () => {
  const rows = [mk(1, '窗口1', 'bb-1', 1), mk(2, '窗口2', 'bb-2', 0), mk(3, '张三', 'bb-3', 1)]

  it('enabledProfiles 只保留启用窗口', () => {
    expect(enabledProfiles(rows).map((p) => p.id)).toEqual([1, 3])
  })

  it('filterByKeyword 按名称/ID 过滤；空白关键词不过滤', () => {
    expect(filterByKeyword(rows, '张三').map((p) => p.id)).toEqual([3])
    expect(filterByKeyword(rows, 'bb-3').map((p) => p.id)).toEqual([3])
    expect(filterByKeyword(rows, '   ').length).toBe(3)
  })

  it('selectAllIds 并集去重（保留原已选在前）', () => {
    const filtered = [mk(1, '窗口1', 'bb-1', 1), mk(2, '窗口2', 'bb-2', 1)]
    expect(selectAllIds(filtered, ['bb-9'])).toEqual(['bb-9', 'bb-1', 'bb-2'])
  })

  it('invertIds 过滤集内取反，过滤集外的已选保留', () => {
    const filtered = [mk(1, '窗口1', 'bb-1', 1), mk(2, '窗口2', 'bb-2', 1), mk(3, '窗口3', 'bb-3', 1)]
    expect(invertIds(filtered, ['bb-1', 'bb-9'])).toEqual(['bb-9', 'bb-2', 'bb-3'])
  })

  it('byName 按名称排序（中文拼音）', () => {
    const rows = [mk(1, '窗口3', 'bb-3', 1), mk(2, '窗口1', 'bb-1', 1), mk(3, '窗口2', 'bb-2', 1)]
    expect([...rows].sort(byName).map((p) => p.name)).toEqual(['窗口1', '窗口2', '窗口3'])
  })

  it('byName 数字名称按大小（自然排序）', () => {
    const rows = [mk(1, '100', 'b1', 1), mk(2, '2', 'b2', 1), mk(3, '-1', 'b3', 1)]
    expect([...rows].sort(byName).map((p) => p.name)).toEqual(['-1', '2', '100'])
  })
})

function renderModal(onSubmit = vi.fn(), onCancel = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <App>
      <QueryClientProvider client={qc}>
        <TestWindowModal open taskName="测试任务" submitting={false} onCancel={onCancel} onSubmit={onSubmit} />
      </QueryClientProvider>
    </App>,
  )
  return { onSubmit, onCancel }
}

describe('TestWindowModal', () => {
  beforeEach(() => {
    vi.mocked(fetchProfiles).mockResolvedValue([
      mk(1, '窗口1', 'bb-1', 1),
      mk(2, '窗口2', 'bb-2', 0),
      mk(3, '窗口3', 'bb-3', 1),
    ])
  })

  it('只列出启用窗口', async () => {
    renderModal()
    expect(await screen.findByText(/窗口1/)).toBeInTheDocument()
    expect(screen.getByText(/窗口3/)).toBeInTheDocument()
    expect(screen.queryByText(/窗口2/)).not.toBeInTheDocument()
  })

  it('表格展示列名', async () => {
    renderModal()
    await screen.findByText(/窗口1/)
    const headers = screen.getAllByRole('columnheader').map((el) => el.textContent)
    expect(headers).toEqual(expect.arrayContaining(['窗口名称', '比特窗口ID', '备注', '打开状态']))
  })

  it('未选中时提交按钮禁用；选中后提交调用 onSubmit(profileIds)', async () => {
    const { onSubmit } = renderModal()
    await screen.findByText(/窗口1/)
    const ok = screen.getByRole('button', { name: '提交执行' })
    expect(ok).toBeDisabled()
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    await waitFor(() => expect(ok).not.toBeDisabled())
    fireEvent.click(ok)
    expect(onSubmit).toHaveBeenCalledWith(['bb-1'])
  })

  it('全选选中全部启用窗口并显示已选计数，提交带全部', async () => {
    const { onSubmit } = renderModal()
    await screen.findByText(/窗口1/)
    fireEvent.click(screen.getByRole('button', { name: /全\s?选/ }))
    await waitFor(() => expect(screen.getByText(/已选 2 个窗口/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '提交执行' }))
    expect(onSubmit).toHaveBeenCalledWith(['bb-1', 'bb-3'])
  })

  it('反选在过滤集内取反', async () => {
    renderModal()
    await screen.findByText(/窗口1/)
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: /反\s?选/ }))
    await waitFor(() => expect(screen.getByText(/已选 1 个窗口/)).toBeInTheDocument())
  })
})

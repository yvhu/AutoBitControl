/**
 * StatsBar 批次状态分段条单测：按占比渲染分段、仅展示非零状态、total=0 无分段
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import StatsBar from './StatsBar'
import type { BatchItem } from '../../types'

function stats(over: Partial<BatchItem['stats']>): BatchItem['stats'] {
  return { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0, ...over }
}

/** 取分段条容器（唯一带 border-radius: 5px 的 div） */
function barOf(container: HTMLElement): HTMLElement {
  return container.querySelector('div[style*="border-radius: 5px"]') as HTMLElement
}

describe('StatsBar 批次状态分段条', () => {
  it('按占比渲染分段并展示非零状态图例', () => {
    const { container } = render(
      <StatsBar stats={stats({ total: 50, success: 30, failed: 2, captchaFailed: 1, skipped: 1, running: 2, retryWait: 1, pending: 13 })} />,
    )
    expect(screen.getByText('成功 30')).toBeInTheDocument()
    expect(screen.getByText('待执行 13')).toBeInTheDocument()
    const bar = barOf(container)
    expect(bar.children.length).toBe(7) // 7 个非零状态
    expect((bar.children[0] as HTMLElement).style.width).toBe('60%') // 30/50
  })

  it('total=0：无分段', () => {
    const { container } = render(<StatsBar stats={stats({})} />)
    expect(barOf(container).children.length).toBe(0)
  })

  it('零值状态不显示', () => {
    render(<StatsBar stats={stats({ total: 10, success: 10 })} />)
    expect(screen.getByText('成功 10')).toBeInTheDocument()
    expect(screen.queryByText(/失败/)).not.toBeInTheDocument()
  })
})

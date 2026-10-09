import { describe, it, expect, vi } from 'vitest'
import { clickPoint } from '../src/automation/dom'

describe('dom clickPoint', () => {
  it('用 patchright 原生 mouse.click 在坐标派发可信点击', async () => {
    const click = vi.fn(async () => {})
    const page = { mouse: { click } } as never
    await clickPoint(page, 12, 34)
    expect(click).toHaveBeenCalledWith(12, 34)
  })
})

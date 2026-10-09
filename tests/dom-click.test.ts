import { describe, it, expect, vi } from 'vitest'
import { clickPoint } from '../src/automation/dom'

describe('dom clickPoint', () => {
  it('经 CDP Input.dispatchMouseEvent 在坐标派发按下/抬起', async () => {
    const send = vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params }))
    const detach = vi.fn(async () => {})
    const page = { context: () => ({ newCDPSession: async () => ({ send, detach }) }), waitForTimeout: vi.fn(async () => {}) } as never
    await clickPoint(page, 12, 34)
    const pressed = send.mock.calls.find((c) => c[1].type === 'mousePressed')
    expect(pressed?.[1]).toMatchObject({ x: 12, y: 34 })
    expect(send.mock.calls.some((c) => c[1].type === 'mouseReleased')).toBe(true)
    expect(detach).toHaveBeenCalled()
  })
})

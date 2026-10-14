import { describe, it, expect } from 'vitest'
import { CancelRegistry } from '../src/engine/cancel-registry'

describe('CancelRegistry', () => {
  it('request / isCancelled / clear 基本语义（按窗口+任务隔离）', () => {
    const reg = new CancelRegistry()
    expect(reg.isCancelled(1, 'a')).toBe(false)
    reg.request(1, 'a')
    expect(reg.isCancelled(1, 'a')).toBe(true)
    expect(reg.isCancelled(2, 'a')).toBe(false)
    expect(reg.isCancelled(1, 'b')).toBe(false)
    reg.clear(1, 'a')
    expect(reg.isCancelled(1, 'a')).toBe(false)
  })
})

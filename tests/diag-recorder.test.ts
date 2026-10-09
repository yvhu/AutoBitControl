import { describe, it, expect, vi } from 'vitest'
import { StepRecorder } from '../src/automation/diag'

describe('StepRecorder', () => {
  it('成功步骤记录 name/耗时/ok=true，并返回结果', async () => {
    const r = new StepRecorder()
    const out = await r.run('step-a', async () => 42)
    expect(out).toBe(42)
    const [s] = r.steps()
    expect(s.name).toBe('step-a')
    expect(s.ok).toBe(true)
    expect(s.ms).toBeGreaterThanOrEqual(0)
  })

  it('失败步骤记录 ok=false 并继续抛出', async () => {
    const r = new StepRecorder()
    await expect(r.run('boom', async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(r.steps()[0].ok).toBe(false)
  })

  it('提供 logger 时输出步骤日志', async () => {
    const log = { info: vi.fn(), warn: vi.fn() } as never
    const r = new StepRecorder()
    await r.run('s', async () => {}, log)
    expect((log as never as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalled()
  })
})

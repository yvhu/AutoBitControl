import { describe, it, expect, vi, afterEach } from 'vitest'
import { SiteTask, type TaskMeta } from '../src/tasks/base'
import type { TaskContext } from '../src/engine/task-context'

class T extends SiteTask {
  meta: TaskMeta = { key: 't', name: 'T', url: 'https://a.test/' }
  acted = false
  async action(): Promise<void> { this.acted = true }
}

/** 构造注入假 page/log 的 ctx（goto 行为由调用方给定） */
function makeCtx(goto: ReturnType<typeof vi.fn>) {
  const log = { warn: vi.fn() }
  const ctx = {
    page: { goto, context: () => ({ pages: () => [] }) },
    log,
    wallet: { ensureLoggedIn: vi.fn(async () => ({ skipped: false })) },
  } as never as TaskContext
  return { ctx, log }
}

describe('SiteTask 模板', () => {
  afterEach(() => vi.useRealTimers())

  it('默认 run：goto 后调用 action', async () => {
    const goto = vi.fn(async () => {})
    const { ctx } = makeCtx(goto)
    const t = new T()
    await t.run(ctx)
    expect(goto).toHaveBeenCalledTimes(1)
    expect(t.acted).toBe(true)
  })

  it('默认 run：goto 失败两次后第三次成功（重试共 3 次）', async () => {
    vi.useFakeTimers()
    const goto = vi.fn()
      .mockRejectedValueOnce(new Error('net-1'))
      .mockRejectedValueOnce(new Error('net-2'))
      .mockResolvedValueOnce(undefined)
    const { ctx, log } = makeCtx(goto)
    const t = new T()
    const p = t.run(ctx)
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBeUndefined()
    expect(goto).toHaveBeenCalledTimes(3)
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(t.acted).toBe(true)
  })

  it('默认 run：goto 持续失败 → 重试 3 次后抛出最后一次错误', async () => {
    vi.useFakeTimers()
    const goto = vi.fn()
      .mockRejectedValueOnce(new Error('net-1'))
      .mockRejectedValueOnce(new Error('net-2'))
      .mockRejectedValueOnce(new Error('net-3'))
    const { ctx, log } = makeCtx(goto)
    const t = new T()
    const p = t.run(ctx)
    const assertion = expect(p).rejects.toThrow('net-3')
    await vi.runAllTimersAsync()
    await assertion
    expect(goto).toHaveBeenCalledTimes(3)
    expect(log.warn).toHaveBeenCalledTimes(3)
    expect(t.acted).toBe(false)
  })
})

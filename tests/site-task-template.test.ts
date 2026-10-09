import { describe, it, expect, vi } from 'vitest'
import { SiteTask, type TaskMeta } from '../src/tasks/base'
import type { TaskContext } from '../src/engine/task-context'

class T extends SiteTask {
  meta: TaskMeta = { key: 't', name: 'T', url: 'https://a.test/' }
  acted = false
  async action(): Promise<void> { this.acted = true }
}

describe('SiteTask 模板', () => {
  it('默认 run：goto 后调用 action', async () => {
    const goto = vi.fn(async () => {})
    const ctx = {
      page: { goto, context: () => ({ pages: () => [] }) },
      closeOtherTabs: vi.fn(async () => {}),
      wallet: { ensureLoggedIn: vi.fn(async () => ({ skipped: false })) },
    } as never as TaskContext
    const t = new T()
    await t.run(ctx)
    expect(goto).toHaveBeenCalled()
    expect(t.acted).toBe(true)
  })
})

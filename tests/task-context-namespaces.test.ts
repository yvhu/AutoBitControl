import { describe, it, expect } from 'vitest'
import { TaskContext, type SiteTask, type TaskMeta } from '../src/tasks/base'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake', name: '假', url: '' }
  async run() {}
}

function makeCtx(): TaskContext {
  return new TaskContext({
    page: {
      context: () => ({}),
      getByText: () => ({ first() { return this }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} }),
      locator: () => ({ first() { return this }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} }),
      waitForTimeout: async () => {},
      reload: async () => {},
      url: () => '',
    } as never,
    task: new FakeTask(),
    human: { click: async () => {} } as never,
    profile: { id: 1, bitbrowserId: 'bb', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('TaskContext 命名空间门面', () => {
  it('ctx.wallet 暴露 ready/login/sign/confirmTx/ensureLoggedIn', () => {
    const ctx = makeCtx()
    expect(typeof ctx.wallet.ready).toBe('function')
    expect(typeof ctx.wallet.login).toBe('function')
    expect(typeof ctx.wallet.sign).toBe('function')
    expect(typeof ctx.wallet.confirmTx).toBe('function')
    expect(typeof ctx.wallet.ensureLoggedIn).toBe('function')
  })

  it('ctx.step 返回结果并记录', async () => {
    const ctx = makeCtx()
    const out = await ctx.step('s', async () => 7)
    expect(out).toBe(7)
    expect(ctx.steps().map((x) => x.name)).toContain('s')
  })
})

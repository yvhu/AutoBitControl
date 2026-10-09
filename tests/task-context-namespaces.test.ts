import { describe, it, expect, vi } from 'vitest'
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

describe('ctx.captcha 命名空间', () => {
  it('暴露 turnstile/visible/autoClick', () => {
    const ctx = makeCtx()
    expect(typeof ctx.captcha.turnstile).toBe('function')
    expect(typeof ctx.captcha.visible).toBe('function')
    expect(typeof ctx.captcha.autoClick).toBe('function')
  })

  it('门面方法委托到扁平方法并转发返回结果', async () => {
    const ctx = makeCtx()
    const clickTurnstileBox = vi.fn().mockResolvedValue(true)
    const turnstileVisible = vi.fn().mockResolvedValue(false)
    const autoClickTurnstile = vi.fn().mockResolvedValue(true)
    ctx.clickTurnstileBox = clickTurnstileBox
    ctx.turnstileVisible = turnstileVisible
    ctx.autoClickTurnstile = autoClickTurnstile

    await expect(ctx.captcha.turnstile()).resolves.toBe(true)
    await expect(ctx.captcha.visible()).resolves.toBe(false)
    await expect(ctx.captcha.autoClick()).resolves.toBe(true)

    expect(clickTurnstileBox).toHaveBeenCalledTimes(1)
    expect(turnstileVisible).toHaveBeenCalledTimes(1)
    expect(autoClickTurnstile).toHaveBeenCalledTimes(1)
  })

  it('重复访问返回同一缓存实例', () => {
    const ctx = makeCtx()
    expect(ctx.captcha).toBe(ctx.captcha)
  })
})

describe('TaskContext.safeScreenshot', () => {
  it('截图失败只告警不抛错，返回空串', async () => {
    const ctx = makeCtx()
    ctx.screenshot = vi.fn().mockRejectedValue(new Error('CDP 超时'))
    await expect(ctx.safeScreenshot('x')).resolves.toBe('')
  })

  it('截图成功返回路径', async () => {
    const ctx = makeCtx()
    ctx.screenshot = vi.fn().mockResolvedValue('/tmp/x.png')
    await expect(ctx.safeScreenshot('x')).resolves.toBe('/tmp/x.png')
  })
})

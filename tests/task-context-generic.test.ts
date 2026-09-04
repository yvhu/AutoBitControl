import { describe, it, expect, vi } from 'vitest'
import { TaskContext } from '../src/engine/task-context'
import type { SiteTask, TaskMeta } from '../src/tasks/base'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake', name: '假任务', url: '' }
  async run(_ctx: TaskContext) {}
}

/** 假页面：textDelays 按文案配置出现时机（<0 永不出现）；reload 计数；locator 可控可见性 */
function makeFakePage(textDelays: Record<string, number>, opts: { count?: number; visible?: boolean } = {}) {
  let reloads = 0
  const start = Date.now()
  return {
    __reloads: () => reloads,
    getByText: (text: string) => ({
      first: () => ({
        waitFor: ({ timeout }: { timeout: number }) => new Promise<void>((resolve, reject) => {
          const delay = textDelays[text]
          if (delay === undefined || delay < 0) setTimeout(() => reject(new Error(`等待文案超时: ${text}`)), timeout)
          else setTimeout(resolve, delay)
        }),
      }),
      count: async () => {
        const delay = textDelays[text]
        return delay !== undefined && delay >= 0 && Date.now() - start >= delay ? 1 : 0
      },
    }),
    locator: () => ({
      first: () => ({
        count: async () => opts.count ?? 0,
        isVisible: async () => opts.visible ?? true,
      }),
    }),
    waitForTimeout: vi.fn(async () => {}),
    reload: vi.fn(async () => { reloads++ }),
  }
}

function makeCtx(page: ReturnType<typeof makeFakePage>): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new FakeTask(),
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('TaskContext 通用页面工具', () => {
  it('raceTexts：任一文案出现返回其键', async () => {
    const ctx = makeCtx(makeFakePage({ '量子箱': 100 }))
    expect(await ctx.raceTexts([['a', '量子箱'], ['b', '永不出现']], 1000)).toBe('a')
  })

  it('raceTexts：全部不出现 → null', async () => {
    const ctx = makeCtx(makeFakePage({}))
    expect(await ctx.raceTexts([['a', 'x']], 200)).toBeNull()
  })

  it('visible：count 0 / isVisible false / 异常均按不可见', async () => {
    expect(await makeCtx(makeFakePage({}, { count: 0 })).visible('s')).toBe(false)
    expect(await makeCtx(makeFakePage({}, { count: 1, visible: false })).visible('s')).toBe(false)
    expect(await makeCtx(makeFakePage({}, { count: 1, visible: true })).visible('s')).toBe(true)
  })

  it('waitGoneOrHidden：元素不存在立即返回', async () => {
    const ctx = makeCtx(makeFakePage({}, { count: 0 }))
    const start = Date.now()
    await ctx.waitGoneOrHidden('s', 2000)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('waitGoneOrHidden：一直可见则等满超时', async () => {
    const ctx = makeCtx(makeFakePage({}, { count: 1, visible: true }))
    const start = Date.now()
    await ctx.waitGoneOrHidden('s', 300)
    expect(Date.now() - start).toBeGreaterThanOrEqual(300)
  })

  it('waitForTextWithReloads：被动期出现 → true 且不刷新', async () => {
    const page = makeFakePage({ '目录栏': 100 })
    const ctx = makeCtx(page)
    expect(await ctx.waitForTextWithReloads('目录栏', { passiveMs: 1000, rounds: 2, roundWaitMs: 500 })).toBe(true)
    expect(page.reload).not.toHaveBeenCalled()
  })

  it('waitForTextWithReloads：全部超时 → false 且按轮数刷新', async () => {
    const page = makeFakePage({})
    const ctx = makeCtx(page)
    expect(await ctx.waitForTextWithReloads('目录栏', { passiveMs: 100, rounds: 2, roundWaitMs: 200 })).toBe(false)
    expect(page.reload).toHaveBeenCalledTimes(2)
  })

  it('detectPageState：已登录文案先出现 → loggedIn', async () => {
    const ctx = makeCtx(makeFakePage({ '目录栏': 80, '进入': 160 }))
    expect(await ctx.detectPageState({ loggedInText: '目录栏', landingText: '进入', waitMs: 1000 })).toBe('loggedIn')
  })

  it('detectPageState：未登录文案先出现 → landing', async () => {
    const ctx = makeCtx(makeFakePage({ '目录栏': 160, '进入': 80 }))
    expect(await ctx.detectPageState({ loggedInText: '目录栏', landingText: '进入', waitMs: 1000 })).toBe('landing')
  })

  it('detectPageState：都不出现则刷新重试后抛错（含两个文案）', async () => {
    const page = makeFakePage({})
    const ctx = makeCtx(page)
    await expect(ctx.detectPageState({ loggedInText: '目录栏', landingText: '进入', waitMs: 100, rounds: 2, roundWaitMs: 100 }))
      .rejects.toThrow('目录栏 或 进入')
    expect(page.reload).toHaveBeenCalledTimes(2)
  })
})

/** 可脚本化假页面：texts 为当前出现文案集合；reload 执行 onReload 改写集合（模拟刷新恢复） */
function makeRecoverPage(initTexts: string[], onReload: () => string[]) {
  let texts = [...initTexts]
  let reloads = 0
  return {
    __reloads: () => reloads,
    getByText: (text: string) => ({
      first: () => ({
        waitFor: async () => {
          throw new Error(`等待文案超时: ${text}`)
        },
      }),
      count: async () => (texts.includes(text) ? 1 : 0),
    }),
    waitForTimeout: vi.fn(async () => {}),
    reload: async () => {
      reloads++
      texts = onReload()
    },
  }
}

function makeRecoverCtx(page: ReturnType<typeof makeRecoverPage>): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new FakeTask(),
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('TaskContext 刷新恢复工具', () => {
  it('recoverErrorText：命中返回文案，未命中返回空串', async () => {
    const ctx = makeRecoverCtx(makeRecoverPage(['Network Error'], () => ['x']))
    expect(await ctx.recoverErrorText(['Network Error', 'Turnstile 超时'])).toBe('Network Error')
    expect(await ctx.recoverErrorText(['别的错误'])).toBe('')
  })

  it('waitForTextRecover：目标文案已出现 → true 且不刷新', async () => {
    const page = makeRecoverPage(['Hello,'], () => ['x'])
    const ctx = makeRecoverCtx(page)
    expect(await ctx.waitForTextRecover('Hello,', { budgetMs: 300, recoverTexts: ['Network Error'] })).toBe(true)
    expect(page.__reloads()).toBe(0)
  })

  it('waitForTextRecover：错误文案出现 → 刷新后目标出现 → true', async () => {
    const page = makeRecoverPage(['Network Error'], () => ['Hello,'])
    const ctx = makeRecoverCtx(page)
    expect(await ctx.waitForTextRecover('Hello,', { budgetMs: 1000, recoverTexts: ['Network Error'] })).toBe(true)
    expect(page.__reloads()).toBeGreaterThan(0)
  })

  it('waitForTextRecover：预算耗尽仍未出现 → false', async () => {
    const page = makeRecoverPage(['x'], () => ['x'])
    const ctx = makeRecoverCtx(page)
    expect(await ctx.waitForTextRecover('Hello,', { budgetMs: 200, recoverTexts: ['Network Error'] })).toBe(false)
  })

  it('waitForTextRecover：refreshEveryMs 周期刷新直至目标出现 → true', async () => {
    let n = 0
    const page = makeRecoverPage(['loading'], () => (++n >= 3 ? ['Hello,'] : ['loading']))
    const ctx = makeRecoverCtx(page)
    expect(await ctx.waitForTextRecover('Hello,', { budgetMs: 3000, refreshEveryMs: 50 })).toBe(true)
    expect(page.__reloads()).toBeGreaterThanOrEqual(3)
  })
})

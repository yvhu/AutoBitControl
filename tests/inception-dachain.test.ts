import { describe, it, expect } from 'vitest'
import { InceptionDachainTask } from '../src/tasks/inception-dachain'
import { TaskContext } from '../src/tasks/base'

/** 按文案配置出现时机：delayMs < 0 表示永不出现（waitFor 超时拒绝） */
function makeFakePage(textDelays: Record<string, number>, opts: { count?: number; visible?: boolean; bodyText?: string } = {}) {
  const counts: Record<string, number> = {}
  return {
    getByText: (text: string) => ({
      first: () => ({
        waitFor: ({ timeout }: { timeout: number }) => new Promise<void>((resolve, reject) => {
          const delay = textDelays[text]
          if (delay === undefined || delay < 0) {
            setTimeout(() => reject(new Error(`等待文案超时: ${text}`)), timeout)
          } else {
            setTimeout(resolve, delay)
          }
        }),
      }),
    }),
    locator: (sel: string) => ({
      first: () => ({
        count: async () => counts[sel] ?? opts.count ?? 0,
        isVisible: async () => opts.visible ?? true,
      }),
    }),
    waitForTimeout: async (ms: number) => { await new Promise(r => setTimeout(r, ms)) },
    evaluate: async (fn: () => unknown) => fn(),
    __bodyText: opts.bodyText ?? '',
  }
}

// ctx.js 会把任务闭包经 page.evaluate 执行；假页面用 new Function 注入 fake document 执行原函数体
function makeCtx(page: ReturnType<typeof makeFakePage>): TaskContext {
  const wrapped = {
    ...page,
    evaluate: async (fn: () => unknown) => {
      const body = (page as unknown as { __bodyText: string }).__bodyText
      const exec = new Function('document', `return (${fn.toString()})()`)
      return exec({ body: { innerText: body } })
    },
  }
  return new TaskContext({
    page: wrapped as never,
    task: new InceptionDachainTask(),
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

// 私有辅助方法经类型断言直接测试（纯竞速/等待逻辑，与页面无关）；
// 通用竞速/可见性/消失等待已下沉 ctx（见 task-context-generic.test.ts），此处仅测任务级组合
type TaskHelpers = {
  raceAfterOpenFree(ctx: TaskContext, timeoutMs: number): Promise<'limit' | 'modal' | 'insufficient' | null>
  raceReveal(ctx: TaskContext, timeoutMs: number): Promise<'revealed' | 'insufficient' | 'limit' | null>
  dailyOpens(ctx: TaskContext): Promise<{ opened: number; total: number } | null>
}
const helpers = new InceptionDachainTask() as unknown as TaskHelpers

describe('InceptionDachainTask 竞速与等待逻辑', () => {
  it('raceAfterOpenFree：命中每日上限提示 → limit（任务成功）', async () => {
    const ctx = makeCtx(makeFakePage({ 'Daily limit reached': 100 }))
    expect(await helpers.raceAfterOpenFree(ctx, 1000)).toBe('limit')
  })

  it('raceAfterOpenFree：弹窗出现 → modal', async () => {
    const ctx = makeCtx(makeFakePage({ 'What is inside?': 100 }))
    expect(await helpers.raceAfterOpenFree(ctx, 1000)).toBe('modal')
  })

  it('raceAfterOpenFree：余额不足 → insufficient（快速失败不空耗）', async () => {
    const ctx = makeCtx(makeFakePage({ 'Insufficient QE': 100 }))
    expect(await helpers.raceAfterOpenFree(ctx, 1000)).toBe('insufficient')
  })

  it('raceAfterOpenFree：全部不出现 → null（重点一次 Open Free）', async () => {
    const ctx = makeCtx(makeFakePage({}))
    expect(await helpers.raceAfterOpenFree(ctx, 200)).toBeNull()
  })

  it('raceReveal：任一结果文案出现 → revealed', async () => {
    const ctx1 = makeCtx(makeFakePage({ 'You Won': 100 }))
    expect(await helpers.raceReveal(ctx1, 1000)).toBe('revealed')
    const ctx2 = makeCtx(makeFakePage({ 'Better luck next time': 100 }))
    expect(await helpers.raceReveal(ctx2, 1000)).toBe('revealed')
  })

  it('raceReveal：余额不足 → insufficient', async () => {
    const ctx = makeCtx(makeFakePage({ 'Insufficient QE': 100 }))
    expect(await helpers.raceReveal(ctx, 1000)).toBe('insufficient')
  })

  it('raceReveal：弹窗内出现每日上限提示 → limit（达上限窗口弹窗无开箱结果场景）', async () => {
    const ctx = makeCtx(makeFakePage({ 'Daily limit reached': 100 }))
    expect(await helpers.raceReveal(ctx, 1000)).toBe('limit')
  })

  it('raceReveal：90s 内无结果 → null（触发补点一次或失败）', async () => {
    const ctx = makeCtx(makeFakePage({}))
    expect(await helpers.raceReveal(ctx, 200)).toBeNull()
  })

  it('dailyOpens：解析页面 DAILY OPENS 计数器', async () => {
    const ctx = makeCtx(makeFakePage({}, { bodyText: 'DAILY | OPENS | 5/5 | QE WON TODAY | 700/3,000' }))
    expect(await helpers.dailyOpens(ctx)).toEqual({ opened: 5, total: 5 })
  })

  it('dailyOpens：计数器未渲染/改版 → null（走文案竞速兜底）', async () => {
    const ctx = makeCtx(makeFakePage({}, { bodyText: 'SYS://DASHBOARD.MAIN | 21,804 | QE' }))
    expect(await helpers.dailyOpens(ctx)).toBeNull()
  })
})

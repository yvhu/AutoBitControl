/**
 * InceptionDachainTask 竞速与等待逻辑单测（注入假页面，不连真浏览器）
 * 改写后任务经 ../api 的 race/runJs/elementState 调用，故假页面按「文案是否出现」提供 count，
 * 并支持 runJs 的 evaluate（注入假 document 执行原函数体）与竞速轮询用的 waitForTimeout。
 */
import { describe, it, expect, vi } from 'vitest'
import { InceptionDachainTask } from '../src/tasks/inception-dachain'
import { TaskContext } from '../src/tasks/base'

/** 按文案配置是否出现；locator 恒存在且可见（供 isVisible 判定补点） */
function makeFakePage(textPresent: Record<string, boolean>, opts: { visible?: boolean; bodyText?: string } = {}) {
  const clicks: string[] = []
  return {
    getByText: (text: string) => ({
      count: async () => (textPresent[text] ? 1 : 0),
    }),
    locator: (sel: string) => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => opts.visible ?? true,
        click: async () => { clicks.push(sel) },
      }),
    }),
    waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, ms)) },
    // runJs 会把任务闭包经 page.evaluate 执行；用 new Function 注入假 document 执行原函数体
    evaluate: async (fn: () => unknown) => {
      const exec = new Function('document', `return (${fn.toString()})()`)
      return exec({ body: { innerText: opts.bodyText ?? '' } })
    },
    clicks,
  }
}

function makeCtx(page: ReturnType<typeof makeFakePage>): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new InceptionDachainTask(),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

// 私有辅助方法经类型断言直接测试（纯竞速/等待逻辑，与页面无关）
type TaskHelpers = {
  raceAfterOpenFree(ctx: TaskContext, timeoutMs: number): Promise<'limit' | 'modal' | 'insufficient' | null>
  raceReveal(ctx: TaskContext, timeoutMs: number): Promise<'revealed' | 'insufficient' | 'limit' | null>
  dailyOpens(ctx: TaskContext): Promise<{ opened: number; total: number } | null>
  revealInModal(ctx: TaskContext): Promise<'revealed' | 'insufficient' | 'limit' | null>
}
const helpers = new InceptionDachainTask() as unknown as TaskHelpers

describe('InceptionDachainTask 竞速与等待逻辑', () => {
  it('raceAfterOpenFree：命中每日上限提示 → limit（任务成功）', async () => {
    const ctx = makeCtx(makeFakePage({ 'Daily limit reached': true }))
    expect(await helpers.raceAfterOpenFree(ctx, 1000)).toBe('limit')
  })

  it('raceAfterOpenFree：弹窗出现 → modal', async () => {
    const ctx = makeCtx(makeFakePage({ 'What is inside?': true }))
    expect(await helpers.raceAfterOpenFree(ctx, 1000)).toBe('modal')
  })

  it('raceAfterOpenFree：余额不足 → insufficient（快速失败不空耗）', async () => {
    const ctx = makeCtx(makeFakePage({ 'Insufficient QE': true }))
    expect(await helpers.raceAfterOpenFree(ctx, 1000)).toBe('insufficient')
  })

  it('raceAfterOpenFree：全部不出现 → null（重点一次 Open Free）', async () => {
    const ctx = makeCtx(makeFakePage({}))
    expect(await helpers.raceAfterOpenFree(ctx, 200)).toBeNull()
  })

  it('raceReveal：任一结果文案出现 → revealed', async () => {
    const ctx1 = makeCtx(makeFakePage({ 'You Won': true }))
    expect(await helpers.raceReveal(ctx1, 1000)).toBe('revealed')
    const ctx2 = makeCtx(makeFakePage({ 'Better luck next time': true }))
    expect(await helpers.raceReveal(ctx2, 1000)).toBe('revealed')
  })

  it('raceReveal：余额不足 → insufficient', async () => {
    const ctx = makeCtx(makeFakePage({ 'Insufficient QE': true }))
    expect(await helpers.raceReveal(ctx, 1000)).toBe('insufficient')
  })

  it('raceReveal：弹窗内出现每日上限提示 → limit（达上限窗口弹窗无开箱结果场景）', async () => {
    const ctx = makeCtx(makeFakePage({ 'Daily limit reached': true }))
    expect(await helpers.raceReveal(ctx, 1000)).toBe('limit')
  })

  it('raceReveal：预算内无结果 → null（触发补点一次或失败）', async () => {
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

  it('revealInModal：45s 无结果补点 Open for 一次，随后用剩余预算等结果（超时返回 null）', async () => {
    vi.useFakeTimers()
    try {
      const page = makeFakePage({})
      const ctx = makeCtx(page)
      const p = helpers.revealInModal(ctx)
      // 首轮竞速 45s 后无结果 → 补点 Open for（首点 + 补点共 2 次）
      await vi.advanceTimersByTimeAsync(46_000)
      expect(page.clicks.filter((s) => s.includes('Open for')).length).toBe(2)
      // 第二轮用剩余预算（约 120s - 46s）继续等，仍无结果 → 返回 null
      await vi.advanceTimersByTimeAsync(80_000)
      expect(await p).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

import { describe, it, expect, vi } from 'vitest'
import { recoverProbe } from '../src/automation/dom'

function makePage(opts: { appearAfterMs?: number; errorText?: string; startMs?: number }) {
  const start = Date.now()
  let reloads = 0
  const map: Record<string, number> = {}
  if (opts.appearAfterMs !== undefined) map['目标'] = opts.appearAfterMs
  if (opts.errorText) map[opts.errorText] = 0
  return {
    get reloads() { return reloads },
    locator: () => ({ first() { return this }, count: async () => 0, isVisible: async () => false }),
    getByText: (t: string) => ({
      first() { return this },
      count: async () => {
        const at = map[t]
        if (at === undefined) return 0
        return Date.now() - start >= at ? 1 : 0
      },
      isVisible: async () => true,
      waitFor: async () => {},
    }),
    waitForTimeout: vi.fn(async () => {}),
    reload: vi.fn(async () => { reloads++ }),
    url: () => 'https://x.test/',
  }
}

const log = { info: vi.fn(), warn: vi.fn() } as never

describe('dom recoverProbe', () => {
  it('目标探针出现 → true，不刷新', async () => {
    const page = makePage({ appearAfterMs: 0 }) as never
    expect(await recoverProbe(page, { text: '目标' }, log, { budgetMs: 2000 })).toBe(true)
    expect((page as never as { reload: ReturnType<typeof vi.fn> }).reload).not.toHaveBeenCalled()
  })

  it('预算内不出现 → false（无错误文案时不刷新）', async () => {
    const page = makePage({}) as never
    expect(await recoverProbe(page, { text: '目标' }, log, { budgetMs: 300 })).toBe(false)
    expect((page as never as { reload: ReturnType<typeof vi.fn> }).reload).not.toHaveBeenCalled()
  })

  it('长时间无探针且不刷新 → 触发心跳日志', async () => {
    const beatLog = { info: vi.fn(), warn: vi.fn() }
    const page = makePage({}) as never
    expect(await recoverProbe(page, { text: '目标' }, beatLog as never, { budgetMs: 200, heartbeatMs: 1 })).toBe(false)
    expect(beatLog.info).toHaveBeenCalled()
  })

  it('出现可恢复错误文案 → 触发刷新', async () => {
    const page = makePage({ errorText: 'Network Error' }) as never
    await recoverProbe(page, { text: '目标' }, log, { budgetMs: 400, recoverTexts: ['Network Error'] })
    expect((page as never as { reload: ReturnType<typeof vi.fn> }).reload).toHaveBeenCalled()
  })

  it('配置 refreshEveryMs → 无错误也周期刷新', async () => {
    const page = makePage({}) as never
    await recoverProbe(page, { text: '目标' }, log, { budgetMs: 600, refreshEveryMs: 100 })
    expect((page as never as { reload: ReturnType<typeof vi.fn> }).reload).toHaveBeenCalled()
  })

  it('文案存在但首个元素不可见（双 DOM/动画态）→ 按存在判定命中 true，不刷新', async () => {
    const reload = vi.fn(async () => {})
    const page = {
      getByText: (t: string) => ({
        first() { return this },
        count: async () => (t === 'Daily Check-in' ? 1 : 0),
        isVisible: async () => false,
      }),
      locator: () => ({ first() { return this }, count: async () => 0, isVisible: async () => false }),
      waitForTimeout: vi.fn(async () => {}),
      reload,
      url: () => 'https://x.test/',
    } as never
    expect(await recoverProbe(page, { text: 'Daily Check-in' }, log, { budgetMs: 300 })).toBe(true)
    expect(reload).not.toHaveBeenCalled()
  })
})

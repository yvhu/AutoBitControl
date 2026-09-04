import { describe, it, expect, vi } from 'vitest'
import { PortalRhunaTask } from '../src/tasks/portal-rhuna'
import { TaskContext } from '../src/tasks/base'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 假页面状态：bodyText 可被 reload 回调改写（模拟刷新恢复）；时间缩放加速测试 */
interface PageState {
  bodyText: string
  reloads: number
  onReload: () => string
}

function makeCtx(state: PageState): TaskContext {
  const page = {
    getByText: (text: string) => ({
      count: async () => (state.bodyText.includes(text) ? 1 : 0),
    }),
    reload: async () => {
      state.reloads++
      state.bodyText = state.onReload()
    },
    waitForTimeout: async (ms: number) => {
      await sleep(Math.min(ms, 10))
    },
  }
  return new TaskContext({
    page: page as never,
    task: new PortalRhunaTask(),
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

// 私有辅助方法经类型断言直接测试（刷新恢复逻辑，与真实页面无关）
type TaskHelpers = {
  waitForTextRecover(ctx: TaskContext, text: string, budgetMs: number, refreshEveryMs?: number): Promise<boolean>
  hasRecoverError(ctx: TaskContext): Promise<boolean>
  clickTurnstileCheckbox(ctx: TaskContext): Promise<boolean>
}
const helpers = new PortalRhunaTask() as unknown as TaskHelpers

describe('PortalRhunaTask 刷新恢复逻辑', () => {
  it('文案已出现：直接 true，不触发刷新', async () => {
    const state: PageState = { bodyText: 'Hello, 0xabc!', reloads: 0, onReload: () => 'x' }
    expect(await helpers.waitForTextRecover(makeCtx(state), 'Hello,', 500)).toBe(true)
    expect(state.reloads).toBe(0)
  })

  it('Network Error 出现：刷新恢复后文案出现 → true', async () => {
    const state: PageState = { bodyText: 'Network Error', reloads: 0, onReload: () => 'Hello, 0xabc!' }
    expect(await helpers.waitForTextRecover(makeCtx(state), 'Hello,', 1000)).toBe(true)
    expect(state.reloads).toBeGreaterThan(0)
  })

  it('预算耗尽仍未出现 → false', async () => {
    const state: PageState = { bodyText: 'x', reloads: 0, onReload: () => 'x' }
    expect(await helpers.waitForTextRecover(makeCtx(state), 'Hello,', 200)).toBe(false)
  })

  it('周期刷新：无错误文案也按 refreshEveryMs 刷新，直至文案出现 → true', async () => {
    let n = 0
    const state: PageState = { bodyText: 'loading', reloads: 0, onReload: () => (++n >= 3 ? 'Hello, 0xabc!' : 'loading') }
    expect(await helpers.waitForTextRecover(makeCtx(state), 'Hello,', 3000, 50)).toBe(true)
    expect(state.reloads).toBeGreaterThanOrEqual(3)
  })

  it('hasRecoverError：Network Error / Turnstile 超时命中，正常文案不命中', async () => {
    const s1: PageState = { bodyText: 'Network Error', reloads: 0, onReload: () => 'x' }
    expect(await helpers.hasRecoverError(makeCtx(s1))).toBe(true)
    const s2: PageState = { bodyText: 'Turnstile token request timed out', reloads: 0, onReload: () => 'x' }
    expect(await helpers.hasRecoverError(makeCtx(s2))).toBe(true)
    const s3: PageState = { bodyText: 'Quest completed successfully!', reloads: 0, onReload: () => 'x' }
    expect(await helpers.hasRecoverError(makeCtx(s3))).toBe(false)
  })
})

describe('PortalRhunaTask 验证方框点击重试', () => {
  const BOX = { x: 933, y: 510, width: 60, height: 50 }

  /** 可脚本化假 ctx：boundingBox 依次取 boxes（重试时重新取盒），clickAt 可配置抛错序列 */
  function makeTurnstileCtx(
    boxes: Array<{ x: number; y: number; width: number; height: number } | null>,
    clickAt: ReturnType<typeof vi.fn>,
    log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } = { info: vi.fn(), warn: vi.fn() },
  ): TaskContext {
    let i = 0
    const page = {
      locator: () => ({
        first: () => ({
          boundingBox: async () => boxes[Math.min(i++, boxes.length - 1)],
        }),
      }),
      waitForTimeout: async (ms: number) => {
        await sleep(Math.min(ms, 10))
      },
    }
    return new TaskContext({
      page: page as never,
      task: new PortalRhunaTask(),
      human: { clickAt } as never,
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: log as never,
      artifactsDir: '',
      walletPasswords: {},
    })
  }

  const transientErr = () => new Error('cdpSession.send: Protocol error (Input.dispatchMouseEvent): Invalid parameters')

  it('点击被浏览器拒绝（Protocol error）后重新取盒重试成功', async () => {
    const clickAt = vi.fn().mockRejectedValueOnce(transientErr()).mockResolvedValueOnce(undefined)
    const warn = vi.fn()
    const ctx = makeTurnstileCtx([BOX, BOX], clickAt, { info: vi.fn(), warn })
    expect(await helpers.clickTurnstileCheckbox(ctx)).toBe(true)
    expect(clickAt).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({ attempt: 1 })
    expect(warn.mock.calls[0][0].err).toContain('Protocol error')
  })

  it('连续三次被浏览器拒绝后向上抛错', async () => {
    const clickAt = vi.fn().mockRejectedValue(transientErr())
    const ctx = makeTurnstileCtx([BOX, BOX, BOX], clickAt)
    await expect(helpers.clickTurnstileCheckbox(ctx)).rejects.toThrow('Protocol error')
    expect(clickAt).toHaveBeenCalledTimes(3)
  })

  it('非瞬时错误不重试直接抛', async () => {
    const clickAt = vi.fn().mockRejectedValue(new Error('点击失败: 找不到元素 iframe'))
    const ctx = makeTurnstileCtx([BOX], clickAt)
    await expect(helpers.clickTurnstileCheckbox(ctx)).rejects.toThrow('找不到元素')
    expect(clickAt).toHaveBeenCalledTimes(1)
  })

  it('方框不存在返回 false 且不点击', async () => {
    const clickAt = vi.fn()
    const ctx = makeTurnstileCtx([null], clickAt)
    expect(await helpers.clickTurnstileCheckbox(ctx)).toBe(false)
    expect(clickAt).not.toHaveBeenCalled()
  })
})

describe('PortalRhunaTask 验证方框可见性', () => {
  type TurnstileHelpers = {
    turnstileVisible(ctx: TaskContext): Promise<boolean>
  }
  const helpers = new PortalRhunaTask() as unknown as TurnstileHelpers

  function makeVisibleCtx(counts: number[]): TaskContext {
    let i = 0
    const page = {
      locator: () => ({
        first: () => ({
          count: async () => counts[Math.min(i++, counts.length - 1)],
        }),
      }),
    }
    return new TaskContext({
      page: page as never,
      task: new PortalRhunaTask(),
      human: {} as never,
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: '',
      walletPasswords: {},
    })
  }

  it('任一选择器命中即判定方框可见', async () => {
    expect(await helpers.turnstileVisible(makeVisibleCtx([1, 0]))).toBe(true)
  })

  it('两个选择器都未命中判定不可见', async () => {
    expect(await helpers.turnstileVisible(makeVisibleCtx([0, 0]))).toBe(false)
  })
})

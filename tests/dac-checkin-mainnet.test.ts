/**
 * DacCheckinMainnetTask 单测（注入假页面，不连真浏览器）
 * 覆盖：登录编排（打开主网页 → 0x 判已登录 / Connect wallet / 无钱包列表 / 多轮重试 / 授权弹窗自动确认）
 *       签到（点 Check in → Checked in today 成功；已签到幂等；都不出现则报错）
 * 领 chip 由独立任务 dac-play-mainnet 负责，其单测见 dac-play-mainnet.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { DacCheckinMainnetTask } from '../src/tasks/dac-checkin-mainnet'
import { TaskContext } from '../src/tasks/base'
import { WalletActions } from '../src/automation'

const URL = 'https://interstellar.dachain.io/'
const CHECKIN_TEXT = 'Check in'
const CHECKED_TEXT = 'Checked in today'

/** 假页面：记录 goto 的目标；context().pages() 供 openPage(closeOtherTabs) 使用 */
function makeFakePage() {
  const gotos: string[] = []
  return {
    gotos,
    context: () => ({ pages: () => [] }),
    goto: async (u: string) => { gotos.push(u) },
    url: () => URL,
  }
}

/** 假页面（签到态）：按选择器文案返回可见性；记录点击；screenshot 供截图调用 */
function makeCheckinPage(opts: { checkinVisible: boolean; checkedVisible: boolean }) {
  const clicks: string[] = []
  const isVisible = async (sel: string): Promise<boolean> => {
    if (sel.includes(CHECKED_TEXT)) return opts.checkedVisible
    if (sel.includes(CHECKIN_TEXT)) return opts.checkinVisible
    return false
  }
  return {
    clicks,
    locator: (sel: string) => ({
      first: () => ({
        count: async () => ((await isVisible(sel)) ? 1 : 0),
        isVisible: () => isVisible(sel),
        click: async () => { clicks.push(sel) },
      }),
    }),
    waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, ms)) },
    screenshot: async () => '/tmp/x.png',
  }
}

function makeCtx(page: unknown): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new DacCheckinMainnetTask(),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('DacCheckinMainnetTask 登录编排', () => {
  it('meta：key/名称/分类/钱包正确', () => {
    const t = new DacCheckinMainnetTask()
    expect(t.meta.key).toBe('dac-checkin-mainnet')
    expect(t.meta.name).toBe('DAC 签到（主网）')
    expect(t.meta.category).toBe('checkin')
    expect(t.meta.wallet).toBe('metamask')
    expect(t.meta.enabled).toBe(false)
  })

  it('run：打开主网页并以 0x 判登录态、点 Connect wallet、无钱包列表、多轮重试', async () => {
    const page = makeFakePage()
    const ctx = makeCtx(page)
    let captured: Record<string, unknown> | undefined
    const spy = vi.spyOn(WalletActions.prototype, 'ensureConnected').mockImplementation(async (opts) => {
      captured = opts as Record<string, unknown>
      throw new Error('__connect__')
    })
    try {
      await expect(new DacCheckinMainnetTask().run(ctx)).rejects.toThrow('__connect__')
    } finally {
      spy.mockRestore()
    }
    expect(page.gotos).toContain(URL)
    expect(captured?.connected).toEqual({ text: '0x' })
    expect(captured?.disconnected).toBe('Connect wallet')
    expect(captured?.connect).toBe('button:has-text("Connect wallet")')
    expect(captured?.walletOption).toBeUndefined() // 真机无站内钱包列表
    expect(captured?.attempts).toBe(3) // 登录可能需多次尝试
    expect(captured?.autoConfirmTransaction).toBe(true) // 0 撸站点：授权确认弹窗自动确认
  })
})

describe('DacCheckinMainnetTask 签到', () => {
  const helpers = new DacCheckinMainnetTask() as unknown as { checkin(ctx: TaskContext): Promise<void> }

  it('签到按钮出现 → 点击 → 出现 Checked in today → 成功', async () => {
    const page = makeCheckinPage({ checkinVisible: true, checkedVisible: true })
    await expect(helpers.checkin(makeCtx(page))).resolves.toBeUndefined()
    expect(page.clicks.some((s) => s.includes('Check in'))).toBe(true)
  })

  it('无签到按钮但已 Checked in today → 幂等成功，不点击', async () => {
    const page = makeCheckinPage({ checkinVisible: false, checkedVisible: true })
    await expect(helpers.checkin(makeCtx(page))).resolves.toBeUndefined()
    expect(page.clicks).toHaveLength(0)
  })

  it('签到按钮与已签到态都不出现 → 等满预算抛错', async () => {
    vi.useFakeTimers()
    try {
      const page = makeCheckinPage({ checkinVisible: false, checkedVisible: false })
      const assertion = expect(helpers.checkin(makeCtx(page))).rejects.toThrow('未出现签到按钮')
      await vi.advanceTimersByTimeAsync(31_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

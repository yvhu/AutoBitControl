/**
 * PortalRhunaTask 单测：验证方框点击容错逻辑
 * 背景：真机批量运行中 31~40% 首跑失败，根因是 claimLoop 内点击 Turnstile 方框时
 * CDP 派发被浏览器拒绝（iframe 持续重渲染，Protocol error）——3 次重试耗尽后
 * 瞬时错误直穿到任务层把整个 run 打挂（600s 退避 + 重跑全流程）。
 * 修复：瞬时错误在任务层当可恢复处理（进入冷却期后重点），不打断领取流程。
 * 改写后任务经 ../api 的 clickTurnstile 调用，故 mock 该出口控制成功/失败/拒绝。
 */
import { describe, it, expect, vi } from 'vitest'
import { PortalRhunaTask } from '../src/tasks/portal-rhuna'
import { TaskContext } from '../src/tasks/base'
import { clickTurnstile, click, waitFor, race, evaluate, takeScreenshot } from '../src/api'

vi.mock('../src/api', () => ({
  openPage: vi.fn(),
  connectWallet: vi.fn(),
  click: vi.fn(),
  waitFor: vi.fn(),
  race: vi.fn(),
  evaluate: vi.fn(),
  takeScreenshot: vi.fn(),
  clickTurnstile: vi.fn(),
  hasText: vi.fn(),
  getElementState: vi.fn(),
}))

/** 真机实测的错误原文（turnstile.ts 重试耗尽后上抛） */
const CDP_REJECTED_ERR = 'cdpSession.send: Protocol error (Input.dispatchMouseEvent): Invalid parameters'

function makeCtx(page: unknown = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = new TaskContext({
    page: page as never,
    task: new PortalRhunaTask(),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: {},
  })
  return { ctx, log }
}

/** 假页面：只回答 isVisible 需要的 count/isVisible */
function makePage(dialogVisible: boolean) {
  return {
    locator: vi.fn(() => ({
      first: () => ({
        count: async () => (dialogVisible ? 1 : 0),
        isVisible: async () => dialogVisible,
      }),
    })),
  }
}

// 私有辅助方法经类型断言直接测试（纯容错分支逻辑，与页面无关）
type PortalHelpers = {
  tryClickTurnstile(ctx: TaskContext): Promise<'clicked' | 'absent' | 'rejected'>
  closeDialog(ctx: TaskContext): Promise<void>
  checkin(ctx: TaskContext): Promise<void>
}
const helpers = new PortalRhunaTask() as unknown as PortalHelpers

describe('PortalRhunaTask 验证方框点击容错', () => {
  it('点击成功 → clicked', async () => {
    const { ctx } = makeCtx()
    vi.mocked(clickTurnstile).mockResolvedValueOnce(true)
    expect(await helpers.tryClickTurnstile(ctx)).toBe('clicked')
  })

  it('方框未出现 → absent（无点击、无报错）', async () => {
    const { ctx } = makeCtx()
    vi.mocked(clickTurnstile).mockResolvedValueOnce(false)
    expect(await helpers.tryClickTurnstile(ctx)).toBe('absent')
  })

  it('瞬时 CDP 拒绝（重试耗尽）→ rejected 不抛错，记警告日志', async () => {
    const { ctx, log } = makeCtx()
    vi.mocked(clickTurnstile).mockRejectedValueOnce(new Error(CDP_REJECTED_ERR))
    expect(await helpers.tryClickTurnstile(ctx)).toBe('rejected')
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatchObject({ step: 'turnstile', window: '窗口1' })
    expect((log.warn.mock.calls[0][0] as { err: string }).err).toContain('Protocol error')
  })

  it('非瞬时错误 → 直接上抛（不吞错）', async () => {
    const { ctx } = makeCtx()
    vi.mocked(clickTurnstile).mockRejectedValueOnce(new Error('点击失败: 找不到元素 iframe'))
    await expect(helpers.tryClickTurnstile(ctx)).rejects.toThrow('找不到元素')
  })
})

describe('PortalRhunaTask 失败收尾关闭弹窗', () => {
  it('本轮未出 Claim → 先关弹窗，下一轮才点卡片', async () => {
    const { ctx } = makeCtx(makePage(true))
    vi.mocked(click).mockClear()
    vi.mocked(click).mockResolvedValue(undefined)
    vi.mocked(waitFor).mockResolvedValue(true)
    vi.mocked(evaluate).mockResolvedValue('')
    vi.mocked(takeScreenshot).mockResolvedValue('')
    vi.mocked(race).mockResolvedValueOnce(null).mockResolvedValueOnce('success')

    await helpers.checkin(ctx)

    const targets = vi.mocked(click).mock.calls.map((call) => call[1])
    expect(targets[0]).toContain('Daily Check-in')
    expect(targets[1]).toBe('[role="dialog"] button[aria-label="Close quest"]')
    expect(targets[2]).toContain('Daily Check-in')
  })

  it('弹窗已不存在 → 不收尾点击，避免空等', async () => {
    const { ctx } = makeCtx(makePage(false))
    vi.mocked(click).mockClear()

    await helpers.closeDialog(ctx)

    expect(click).not.toHaveBeenCalled()
  })
})

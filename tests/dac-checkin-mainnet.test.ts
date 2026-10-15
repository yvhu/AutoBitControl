/**
 * DacCheckinMainnetTask 登录编排单测（注入假页面 + 拦截 ensureConnected，不连真浏览器）
 * 验证：打开主网页 → 以 0x 判已登录、点 Connect wallet、不依赖站内钱包列表（walletOption 为空）、多轮重试
 */
import { describe, it, expect, vi } from 'vitest'
import { DacCheckinMainnetTask } from '../src/tasks/dac-checkin-mainnet'
import { TaskContext } from '../src/tasks/base'
import { WalletActions } from '../src/automation'

const URL = 'https://interstellar.dachain.io/'

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

function makeCtx(page: ReturnType<typeof makeFakePage>): TaskContext {
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

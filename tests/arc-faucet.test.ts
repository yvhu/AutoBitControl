/**
 * Arc 领水任务（faucet-arc）单测与集成测试：
 * - 单测：网络/币种默认值助手与确保函数、竞速等待的纯逻辑分支（注入假 page/human，不连真浏览器）
 * - 集成：真实 chromium + 本地 fixture，验证 run() 全链路（无验证码 / v2 挑战两模式）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import {
  currentNetwork,
  isUsdcChecked,
  ensureNetwork,
  ensureUsdc,
  ensureSubmitEnabled,
  waitForOutcome,
  ArcFaucetTask,
  SUCCESS_TEXT,
  CAPTCHA_V2_TEXT,
  NETWORK_DISPLAY_SELECTOR,
  NETWORK_BUTTON_SELECTOR,
  NETWORK_OPTION_SELECTOR,
  CURRENCY_RADIO_SELECTOR,
  CURRENCY_CARD_SELECTOR,
  SUBMIT_SELECTOR,
} from '../src/tasks/arc-faucet'
import { TaskContext } from '../src/tasks/base'
import { Humanizer } from '../src/automation/humanize'

/** 每个选择器的假元素（count 恒 1 的通用形态；需要可变行为的测试直接改 state 或替换字段） */
interface FakeElem {
  count: () => Promise<number>
  textContent: () => Promise<string | null>
  isChecked: () => Promise<boolean>
  isEnabled: () => Promise<boolean>
  fill: ReturnType<typeof vi.fn>
}

/** 可变状态：测试中改值即可驱动助手函数分支 */
interface FakeState {
  network: string
  usdcChecked: boolean
  submitEnabled: boolean
  optionCount: number
  texts: Record<string, boolean>
  /** Network 显示值元素数量（缺省 1；0 模拟元素缺失） */
  displayCount?: number
  /** USDC radio 元素数量（缺省 1；0 模拟元素缺失） */
  usdcRadioCount?: number
}

/** 构造注入假依赖的 TaskContext：locator 按选择器路由到假元素，未注册选择器 count=0 */
function makeCtx(state: FakeState) {
  const clicks = vi.fn().mockResolvedValue(undefined)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const blank: FakeElem = {
    count: async () => 0,
    textContent: async () => null,
    isChecked: async () => false,
    isEnabled: async () => false,
    fill: vi.fn(),
  }
  const elems: Record<string, FakeElem> = {
    [NETWORK_DISPLAY_SELECTOR]: {
      count: async () => state.displayCount ?? 1,
      textContent: async () => state.network,
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: vi.fn(),
    },
    [CURRENCY_RADIO_SELECTOR]: {
      count: async () => state.usdcRadioCount ?? 1,
      textContent: async () => null,
      isChecked: async () => state.usdcChecked,
      isEnabled: async () => true,
      fill: vi.fn(),
    },
    [NETWORK_OPTION_SELECTOR]: {
      count: async () => state.optionCount,
      textContent: async () => 'Arc Testnet',
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: vi.fn(),
    },
    [SUBMIT_SELECTOR]: {
      count: async () => 1,
      textContent: async () => 'Send 20 USDC',
      isChecked: async () => false,
      isEnabled: async () => state.submitEnabled,
      fill: vi.fn(),
    },
  }
  const page = {
    locator: (sel: string) => ({
      first: () => elems[sel] ?? blank,
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getByText: (t: string) => ({ count: async () => (state.texts[t] ? 1 : 0) }),
  }
  const ctx = new TaskContext({
    page: page as never,
    task: { meta: { key: 'faucet-arc', name: 'Arc 领水', url: 'https://faucet.circle.com/' } },
    human: { click: clicks } as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: {},
    accountRow: { metamask钱包地址: '0xabc' },
  })
  return { ctx, clicks, log }
}

const baseState = (): FakeState => ({ network: 'Arc Testnet', usdcChecked: true, submitEnabled: true, optionCount: 1, texts: {} })

describe('currentNetwork 当前网络读取', () => {
  it('返回下拉显示值', async () => {
    const { ctx } = makeCtx({ ...baseState(), network: 'Ethereum Sepolia' })
    expect(await currentNetwork(ctx)).toBe('Ethereum Sepolia')
  })

  it('元素缺失 → 空串', async () => {
    const { ctx } = makeCtx({ ...baseState(), displayCount: 0 })
    expect(await currentNetwork(ctx)).toBe('')
  })

  it('显示值为空串 → 空串', async () => {
    const { ctx } = makeCtx({ ...baseState(), network: '' })
    expect(await currentNetwork(ctx)).toBe('')
  })
})

describe('isUsdcChecked 币种选中读取', () => {
  it('radio 已选中 → true', async () => {
    const { ctx } = makeCtx({ ...baseState(), usdcChecked: true })
    expect(await isUsdcChecked(ctx)).toBe(true)
  })

  it('radio 未选中 → false', async () => {
    const { ctx } = makeCtx({ ...baseState(), usdcChecked: false })
    expect(await isUsdcChecked(ctx)).toBe(false)
  })

  it('radio 元素缺失 → false', async () => {
    const { ctx } = makeCtx({ ...baseState(), usdcRadioCount: 0 })
    expect(await isUsdcChecked(ctx)).toBe(false)
  })
})

describe('ensureNetwork 网络确保', () => {
  it('已是 Arc Testnet → 不点击任何元素', async () => {
    const { ctx, clicks } = makeCtx(baseState())
    await ensureNetwork(ctx)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('非默认网络 → 点触发按钮与目标选项各一次，二次校验通过', async () => {
    const state = { ...baseState(), network: 'Ethereum Sepolia' }
    const { ctx, clicks } = makeCtx(state)
    // 模拟点选后页面更新显示值（默认假点击不改变页面，此测试覆写为「点击生效」）
    clicks.mockImplementation((sel: string) => {
      if (sel === NETWORK_OPTION_SELECTOR) state.network = 'Arc Testnet'
    })
    await ensureNetwork(ctx)
    expect(clicks).toHaveBeenNthCalledWith(1, NETWORK_BUTTON_SELECTOR)
    expect(clicks).toHaveBeenNthCalledWith(2, NETWORK_OPTION_SELECTOR)
    expect(clicks).toHaveBeenCalledTimes(2)
  })

  it('下拉无目标选项 → 抛错', async () => {
    const { ctx } = makeCtx({ ...baseState(), network: 'Ethereum Sepolia', optionCount: 0 })
    await expect(ensureNetwork(ctx)).rejects.toThrow('Network 下拉未找到选项')
  })

  it('点选后显示值仍非 Arc Testnet → 抛错（带当前值提示）', async () => {
    const state = { ...baseState(), network: 'Ethereum Sepolia' }
    const { ctx } = makeCtx(state)
    const promise = ensureNetwork(ctx)
    await expect(promise).rejects.toThrow('Network 选择失败')
  })
})

describe('ensureUsdc 币种确保', () => {
  it('已选中 USDC → 不点击', async () => {
    const { ctx, clicks } = makeCtx(baseState())
    await ensureUsdc(ctx)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('未选中 → 点 USDC 卡片一次', async () => {
    const state = { ...baseState(), usdcChecked: false }
    const { ctx, clicks } = makeCtx(state)
    // 模拟点卡片后 radio 选中（默认假点击不改变页面，此测试覆写为「点击生效」）
    clicks.mockImplementation((sel: string) => {
      if (sel === CURRENCY_CARD_SELECTOR) state.usdcChecked = true
    })
    await ensureUsdc(ctx)
    expect(clicks).toHaveBeenCalledWith(CURRENCY_CARD_SELECTOR)
    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('点卡片后仍未选中 → 抛错', async () => {
    const state = { ...baseState(), usdcChecked: false }
    const { ctx } = makeCtx(state)
    await expect(ensureUsdc(ctx)).rejects.toThrow('USDC 币种选择失败')
  })
})

describe('ensureSubmitEnabled 提交按钮可用等待', () => {
  it('按钮已可用 → 立即返回', async () => {
    const { ctx } = makeCtx({ ...baseState(), submitEnabled: true })
    await ensureSubmitEnabled(ctx, 200)
  })

  it('按钮持续禁用 → 超时抛错', async () => {
    const { ctx } = makeCtx({ ...baseState(), submitEnabled: false })
    await expect(ensureSubmitEnabled(ctx, 200)).rejects.toThrow('未变为可用')
  })
})

describe('waitForOutcome 竞速等待', () => {
  it('成功文案先出现 → success', async () => {
    const state = { ...baseState(), texts: { [SUCCESS_TEXT]: true } }
    const { ctx } = makeCtx(state)
    expect(await waitForOutcome(ctx, 300)).toBe('success')
  })

  it('v2 挑战文案先出现 → captcha', async () => {
    const state = { ...baseState(), texts: { [CAPTCHA_V2_TEXT]: true } }
    const { ctx } = makeCtx(state)
    expect(await waitForOutcome(ctx, 300)).toBe('captcha')
  })

  it('两文案都出现 → success 优先', async () => {
    const state = { ...baseState(), texts: { [SUCCESS_TEXT]: true, [CAPTCHA_V2_TEXT]: true } }
    const { ctx } = makeCtx(state)
    expect(await waitForOutcome(ctx, 300)).toBe('success')
  })

  it('都未出现 → null（超时）', async () => {
    const { ctx } = makeCtx(baseState())
    expect(await waitForOutcome(ctx, 300)).toBeNull()
  })
})

describe('ArcFaucetTask 元信息', () => {
  it('meta 契约正确', () => {
    const t = new ArcFaucetTask()
    expect(t.meta.key).toBe('faucet-arc')
    expect(t.meta.name).toBe('Arc 领水')
    expect(t.meta.url).toBe('https://faucet.circle.com/')
    expect(t.meta.sourceUrl).toBe('https://faucet.circle.com/')
    expect(t.meta.category).toBe('faucet')
    expect(t.meta.enabled).toBe(true)
    expect(t.meta.wallet).toBeUndefined()
    expect(t.meta.timeoutSec).toBe(240)
    expect(t.meta.retry).toEqual({ max: 2, backoffSec: 120 })
    expect(t.meta.captcha).toEqual({ auto: true })
    expect(t.meta.concurrency).toBe(3)
  })
})

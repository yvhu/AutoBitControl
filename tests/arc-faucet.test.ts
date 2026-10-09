/**
 * Arc 领水任务（faucet-arc）单测与集成测试：
 * - 单测：网络/币种默认值助手与确保函数、地址重填自愈（注入假 page/human，不连真浏览器）
 * - 集成：真实 chromium + 本地 fixture，验证 run() 全链路（plain 一次提交成功）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import type { Page } from 'patchright'
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
  ArcFaucetTask,
  SUCCESS_TEXT,
  NETWORK_DISPLAY_SELECTOR,
  NETWORK_BUTTON_SELECTOR,
  NETWORK_OPTION_SELECTOR,
  CURRENCY_RADIO_SELECTOR,
  CURRENCY_CARD_SELECTOR,
  SUBMIT_SELECTOR,
  ADDRESS_SELECTOR,
} from '../src/tasks/arc-faucet'
import { TaskContext } from '../src/tasks/base'

/** 每个选择器的假元素（count 恒 1 的通用形态；需要可变行为的测试直接改 state 或替换字段） */
interface FakeElem {
  count: () => Promise<number>
  textContent: () => Promise<string | null>
  isChecked: () => Promise<boolean>
  isEnabled: () => Promise<boolean>
  fill: ReturnType<typeof vi.fn>
  /** patchright 直调点击（任务经 page.locator(sel).first().click()） */
  click: ReturnType<typeof vi.fn>
  /** 等待元素可见（仅地址输入框实现；action 等它） */
  waitFor?: ReturnType<typeof vi.fn>
  /** 输入框当前值（仅地址输入框实现；缺省无此能力） */
  inputValue?: () => Promise<string>
}

/** 可变状态：测试中改值即可驱动助手函数分支 */
interface FakeState {
  network: string
  usdcChecked: boolean
  submitEnabled: boolean
  optionCount: number
  texts: Record<string, boolean>
  /** 地址输入框当前值（自愈循环重填判定读它） */
  addressValue: string
  /** Network 显示值元素数量（缺省 1；0 模拟元素缺失） */
  displayCount?: number
  /** USDC radio 元素数量（缺省 1；0 模拟元素缺失） */
  usdcRadioCount?: number
  /** 提交按钮 isEnabled 读取钩子（证明 ensureSubmitEnabled 被调） */
  onSubmitEnabledCheck?: () => void
}

/** 构造注入假依赖的 TaskContext：locator 按选择器路由到假元素，未注册选择器 count=0 */
function makeCtx(state: FakeState) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const noopClick = () => vi.fn().mockResolvedValue(undefined)
  const blank: FakeElem = {
    count: async () => 0,
    textContent: async () => null,
    isChecked: async () => false,
    isEnabled: async () => false,
    fill: vi.fn(),
    click: noopClick(),
  }
  /** 地址输入框 fill mock（暴露给测试覆写行为：模拟 React 未就绪首填不生效等） */
  const addressFill = vi.fn().mockImplementation(async (v: string) => {
    state.addressValue = v
  })
  const elems: Record<string, FakeElem> = {
    [ADDRESS_SELECTOR]: {
      count: async () => 1,
      textContent: async () => null,
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: addressFill,
      click: noopClick(),
      waitFor: vi.fn().mockResolvedValue(undefined),
      inputValue: async () => state.addressValue,
    },
    [NETWORK_DISPLAY_SELECTOR]: {
      count: async () => state.displayCount ?? 1,
      textContent: async () => state.network,
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: vi.fn(),
      click: noopClick(),
    },
    [CURRENCY_RADIO_SELECTOR]: {
      count: async () => state.usdcRadioCount ?? 1,
      textContent: async () => null,
      isChecked: async () => state.usdcChecked,
      isEnabled: async () => true,
      fill: vi.fn(),
      click: noopClick(),
    },
    [NETWORK_OPTION_SELECTOR]: {
      count: async () => state.optionCount,
      textContent: async () => 'Arc Testnet',
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: vi.fn(),
      click: noopClick(),
    },
    [NETWORK_BUTTON_SELECTOR]: {
      count: async () => 1,
      textContent: async () => null,
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: vi.fn(),
      click: noopClick(),
    },
    [CURRENCY_CARD_SELECTOR]: {
      count: async () => 1,
      textContent: async () => null,
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: vi.fn(),
      click: noopClick(),
    },
    [SUBMIT_SELECTOR]: {
      count: async () => 1,
      textContent: async () => 'Send 20 USDC',
      isChecked: async () => false,
      isEnabled: async () => {
        state.onSubmitEnabledCheck?.()
        return state.submitEnabled
      },
      fill: vi.fn(),
      click: noopClick(),
    },
  }
  const page = {
    locator: (sel: string) => ({
      first: () => elems[sel] ?? blank,
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getByText: (t: string) => ({ count: async () => (state.texts[t] ? 1 : 0) }),
    // 默认 run 用 context().pages() 清理残留标签页（空数组即无残留），goto 打开 meta.url
    context: () => ({ pages: () => [] }),
    goto: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = new TaskContext({
    page: page as never,
    task: { meta: { key: 'faucet-arc', name: 'Arc 领水', url: 'https://faucet.circle.com/' } },
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: {},
    accountRow: { metamask钱包地址: '0xabc' },
  })
  return { ctx, elems, log, addressFill, page }
}

const baseState = (): FakeState => ({ network: 'Arc Testnet', usdcChecked: true, submitEnabled: true, optionCount: 1, texts: {}, addressValue: '0xabc' })

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
    const { ctx, elems } = makeCtx(baseState())
    await ensureNetwork(ctx)
    expect(elems[NETWORK_BUTTON_SELECTOR].click).not.toHaveBeenCalled()
    expect(elems[NETWORK_OPTION_SELECTOR].click).not.toHaveBeenCalled()
  })

  it('非默认网络 → 点触发按钮与目标选项各一次，二次校验通过', async () => {
    const state = { ...baseState(), network: 'Ethereum Sepolia' }
    const { ctx, elems } = makeCtx(state)
    // 模拟点选后页面更新显示值（默认假点击不改变页面，此测试覆写为「点击生效」）
    elems[NETWORK_OPTION_SELECTOR].click.mockImplementation(async () => { state.network = 'Arc Testnet' })
    await ensureNetwork(ctx)
    expect(elems[NETWORK_BUTTON_SELECTOR].click).toHaveBeenCalledTimes(1)
    expect(elems[NETWORK_OPTION_SELECTOR].click).toHaveBeenCalledTimes(1)
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
    const { ctx, elems } = makeCtx(baseState())
    await ensureUsdc(ctx)
    expect(elems[CURRENCY_CARD_SELECTOR].click).not.toHaveBeenCalled()
  })

  it('未选中 → 点 USDC 卡片一次', async () => {
    const state = { ...baseState(), usdcChecked: false }
    const { ctx, elems } = makeCtx(state)
    // 模拟点卡片后 radio 选中（默认假点击不改变页面，此测试覆写为「点击生效」）
    elems[CURRENCY_CARD_SELECTOR].click.mockImplementation(async () => { state.usdcChecked = true })
    await ensureUsdc(ctx)
    expect(elems[CURRENCY_CARD_SELECTOR].click).toHaveBeenCalledTimes(1)
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
    expect(t.meta.timeoutSec).toBe(420)
    expect(t.meta.retry).toEqual({ max: 2, backoffSec: 120 })
    expect(t.meta.concurrency).toBe(3)
  })
})

describe('ArcFaucetTask run 地址重填自愈', () => {
  it('首跑提交按钮未启用且输入框为空 → 重填后按钮启用 → 成功（fill ≥ 2 次）', async () => {
    const state = { ...baseState(), submitEnabled: false, addressValue: '', texts: { [SUCCESS_TEXT]: true } }
    const { ctx, elems, addressFill } = makeCtx(state)
    // 首次 fill 模拟站点 React 未就绪：input 事件无人监听 → 值不保留、按钮不启用；之后 fill 正常生效
    let fills = 0
    addressFill.mockImplementation(async (v: string) => {
      fills++
      if (fills === 1) return
      state.addressValue = v
      state.submitEnabled = true
    })
    // 默认 run 开页走 page.context()/page.goto（makeCtx 已给假实现）；截图与站点自愈逻辑无关，仅需存根
    ctx.screenshot = vi.fn().mockResolvedValue('/tmp/arc.png')
    // 假时钟：ensureSubmitEnabled 每轮 15s 预算瞬间走完（真实时钟会让首轮超时等足 15s）
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 600
      return now
    })
    try {
      await new ArcFaucetTask().run(ctx)
    } finally {
      nowSpy.mockRestore()
    }
    expect(fills).toBeGreaterThanOrEqual(2)
    expect(addressFill).toHaveBeenCalledTimes(2)
    expect(elems[SUBMIT_SELECTOR].click).toHaveBeenCalled()
    expect(ctx.screenshot).toHaveBeenCalledWith('arc-faucet-success')
  })
})

describe('ArcFaucetTask run 地址快速自愈', () => {
  it('fill 后输入框值被清空 → ensureSubmitEnabled 轮询检测到空框立即重填 → 按钮启用 → 成功（fill 共 2 次）', async () => {
    const state = { ...baseState(), submitEnabled: false, addressValue: '', texts: { [SUCCESS_TEXT]: true } }
    const { ctx, elems, addressFill, page } = makeCtx(state)
    // 首次 fill 模拟 React hydration 重渲染清空：值不保留；轮询自愈重填第二次才生效并启用按钮
    let fills = 0
    addressFill.mockImplementation(async (v: string) => {
      fills++
      if (fills === 1) return
      state.addressValue = v
      state.submitEnabled = true
    })
    // 提交按钮 isEnabled 读取计数：ensureSubmitEnabled 内部轮询读取它
    let submitEnabledChecks = 0
    state.onSubmitEnabledCheck = () => { submitEnabledChecks++ }
    ctx.screenshot = vi.fn().mockResolvedValue('/tmp/arc.png')
    await new ArcFaucetTask().run(ctx)
    expect(fills).toBe(2)
    expect(addressFill).toHaveBeenCalledTimes(2)
    // 自愈已并入按钮轮询：以 500ms 间隔检测（fake waitForTimeout 即时 resolve，不耗真实时间）
    expect(page.waitForTimeout).toHaveBeenCalledWith(500)
    expect(submitEnabledChecks).toBeGreaterThanOrEqual(1)
    expect(elems[SUBMIT_SELECTOR].click).toHaveBeenCalled()
    expect(ctx.screenshot).toHaveBeenCalledWith('arc-faucet-success')
  })

  it('ensureSubmitEnabled 轮询期间地址框被清空 2 次均重填，最终按钮可用成功（fill ≥ 3 次）', async () => {
    const state = { ...baseState(), submitEnabled: false, addressValue: '', texts: { [SUCCESS_TEXT]: true } }
    const { ctx, elems, addressFill } = makeCtx(state)
    let fills = 0
    addressFill.mockImplementation(async (v: string) => {
      fills++
      state.addressValue = v
    })
    // hydration 反复清空：前两次按钮检查时把地址框清空（模拟重渲染晚于重填），第三次检查按钮启用
    let enabledChecks = 0
    state.onSubmitEnabledCheck = () => {
      enabledChecks++
      if (enabledChecks <= 2) state.addressValue = ''
      else state.submitEnabled = true
    }
    ctx.screenshot = vi.fn().mockResolvedValue('/tmp/arc.png')
    await new ArcFaucetTask().run(ctx)
    // 首填 + 轮询中 2 次重填（每次清空都被发现并重填，直到按钮可用）
    expect(fills).toBeGreaterThanOrEqual(3)
    expect(elems[SUBMIT_SELECTOR].click).toHaveBeenCalled()
    expect(ctx.screenshot).toHaveBeenCalledWith('arc-faucet-success')
  })
})

describe('ArcFaucetTask run 提交后无成功文案', () => {
  it('成功文案始终不出现 → 抛「未出现成功文案」超时', async () => {
    // texts 为空 = getByText(SUCCESS_TEXT).count() 恒 0，submitAndWait 跑到竞速预算耗尽返回 false
    const { ctx } = makeCtx({ ...baseState(), texts: {} })
    // SUBMIT_RACE_MS 不可注入：沿用本文件假时钟套路，让 30s 竞速预算瞬间走完（真实时钟会让用例等足 30s）
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 600
      return now
    })
    try {
      await expect(new ArcFaucetTask().run(ctx)).rejects.toThrow('未出现成功文案')
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('Arc 领水任务集成（真实浏览器 + 本地 fixture）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'arc-faucet.html'), 'utf-8'))
    })
    await new Promise<void>((r) => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  /** 构造真实浏览器页面的 TaskContext */
  function makeBrowserCtx(page: Page, task: ArcFaucetTask) {
    return new TaskContext({
      page,
      task,
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: join(tmpdir(), 'arc-faucet-test-artifacts'),
      walletPasswords: {},
      accountRow: { metamask钱包地址: '0x835e' },
    })
  }

  it('plain 模式：一次提交成功、地址保留、仅主 frame', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const task = new ArcFaucetTask()
      task.meta.url = baseUrl + '/?mode=plain'
      const ctx = makeBrowserCtx(page, task)
      await task.run(ctx)
      expect(await page.locator('input[name="address"]').inputValue()).toBe('0x835e')
      expect(await page.getByText('on its way').count()).toBe(1)
      // 无挑战：页面只含主 frame
      expect(page.frames().length).toBe(1)
    } finally {
      await browser.close()
    }
  }, 90000)
})

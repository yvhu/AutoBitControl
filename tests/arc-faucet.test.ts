/**
 * Arc 领水任务（faucet-arc）单测与集成测试：
 * - 单测：网络/币种默认值助手与确保函数、竞速等待的纯逻辑分支（注入假 page/human，不连真浏览器）
 * - 集成：真实 chromium + 本地 fixture，验证 run() 全链路（无验证码 / v2 挑战两模式）
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
  waitForOutcome,
  detectV2Challenge,
  V3_SITEKEY,
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
  /** v2 挑战是否已渲染（detectV2Challenge 经 ctx.js → page.evaluate 假实现读取；缺省 false） */
  v2Challenge?: boolean
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
    // ctx.js 的 evaluate 假实现：不执行函数体，直接返回 state.v2Challenge 控制检测结果
    evaluate: () => Promise.resolve(state.v2Challenge ?? false),
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

const baseState = (): FakeState => ({ network: 'Arc Testnet', usdcChecked: true, submitEnabled: true, optionCount: 1, texts: {}, v2Challenge: false })

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

describe('detectV2Challenge 挑战检测', () => {
  it('无挑战 → false', async () => {
    const { ctx } = makeCtx({ ...baseState(), v2Challenge: false })
    expect(await detectV2Challenge(ctx)).toBe(false)
  })

  it('存在 v2 anchor（k≠v3 sitekey）→ true', async () => {
    const { ctx } = makeCtx({ ...baseState(), v2Challenge: true })
    expect(await detectV2Challenge(ctx)).toBe(true)
  })

  it('常驻 v3 sitekey 契约', () => {
    expect(V3_SITEKEY).toBe('6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2')
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
    expect(t.meta.captcha).toEqual({ auto: true })
    expect(t.meta.concurrency).toBe(3)
  })
})

describe('Arc 领水任务集成（真实浏览器 + 本地 fixture）', () => {
  let server: Server
  let baseUrl: string

  /** anchor iframe fixture：一键通过模式（?onepass=1）点复选框即变绿；挑战模式等 bframe 验证完成发来 grid-solved 才变绿；两种模式都回传 anchor-solved 给父页 */
  const ANCHOR_HTML = `<!doctype html><html><body><div id="recaptcha-anchor" role="checkbox" aria-checked="false" style="width:28px;height:28px"></div><script>
const anchor = document.getElementById('recaptcha-anchor')
const onepass = new URLSearchParams(location.search).get('onepass') === '1'
const solved = function () { anchor.setAttribute('aria-checked', 'true'); window.parent.postMessage('anchor-solved', '*') }
anchor.addEventListener('click', function () { if (onepass) solved() })
window.addEventListener('message', function (e) { if (e.data === 'grid-solved') solved() })
</script></body></html>`

  /** bframe fixture：九宫格挑战页（提示语「停车计时器」→ /m/015qbp；9 格可点、点格加 selected class；验证按钮通知 anchor 完成） */
  const BFRAME_HTML = `<!doctype html><html><body>
<div class="rc-imageselect-desc-wrapper"><strong>停车计时器</strong></div>
<div id="rc-imageselect-target"><table>
<tr><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td></tr>
<tr><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td></tr>
<tr><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td></tr>
</table></div>
<button id="recaptcha-verify-button">验证</button>
<script>
document.querySelectorAll('#rc-imageselect-target table td').forEach(function (td) { td.addEventListener('click', function () { td.classList.add('selected') }) })
document.getElementById('recaptcha-verify-button').addEventListener('click', function () {
  const anchorFrame = window.parent.document.querySelector('iframe[src*="anchor"]')
  if (anchorFrame) anchorFrame.contentWindow.postMessage('grid-solved', '*')
})
</script></body></html>`

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (path === '/recaptcha/enterprise/anchor') {
        res.end(ANCHOR_HTML)
        return
      }
      if (path === '/recaptcha/enterprise/bframe') {
        res.end(BFRAME_HTML)
        return
      }
      res.end(readFileSync(join(__dirname, 'fixtures', 'arc-faucet.html'), 'utf-8'))
    })
    await new Promise<void>((r) => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  /** 构造真实浏览器页面的 TaskContext；假打码服务记录调用（九宫格路线：solveGrid；autoSolve 仅保留接口兼容） */
  function makeBrowserCtx(page: Page, task: ArcFaucetTask, captcha: { solveGrid?: ReturnType<typeof vi.fn>; autoSolve?: ReturnType<typeof vi.fn> } = {}) {
    return new TaskContext({
      page,
      task,
      human: new Humanizer(page),
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: join(tmpdir(), 'arc-faucet-test-artifacts'),
      walletPasswords: {},
      accountRow: { metamask钱包地址: '0x835e' },
      captcha: {
        autoSolve: captcha.autoSolve ?? vi.fn(),
        solveGrid: captcha.solveGrid ?? vi.fn().mockResolvedValue({ type: 'multi', objects: [] }),
      } as never,
    })
  }

  it('plain 模式：无验证码，一次提交成功且不触发九宫格', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const task = new ArcFaucetTask()
      task.meta.url = baseUrl + '/?mode=plain'
      const solveGrid = vi.fn()
      const ctx = makeBrowserCtx(page, task, { solveGrid })
      await task.run(ctx)
      expect(await page.locator('input[name="address"]').inputValue()).toBe('0x835e')
      expect(await page.getByText('on its way').count()).toBe(1)
      expect(solveGrid).not.toHaveBeenCalled()
    } finally {
      await browser.close()
    }
  }, 90000)

  it('v2 模式：首次提交触发挑战 → 一键通过（未出图）→ 再提交成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const task = new ArcFaucetTask()
      task.meta.url = baseUrl + '/?mode=v2'
      const solveGrid = vi.fn()
      const ctx = makeBrowserCtx(page, task, { solveGrid })
      await task.run(ctx)
      expect(solveGrid).not.toHaveBeenCalled()
      expect(await detectV2Challenge(ctx)).toBe(true)
      expect(await page.getByText('on its way').count()).toBe(1)
    } finally {
      await browser.close()
    }
  }, 90000)

  it('challenge 模式：v2 挑战 → 九宫格求解（假分类）→ 按钮恢复 → 再提交成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const task = new ArcFaucetTask()
      task.meta.url = baseUrl + '/?mode=challenge'
      const solveGrid = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
      const ctx = makeBrowserCtx(page, task, { solveGrid })
      await task.run(ctx)
      expect(solveGrid).toHaveBeenCalledTimes(1)
      expect(solveGrid.mock.calls[0][1]).toBe('/m/015qbp')
      expect(await detectV2Challenge(ctx)).toBe(true)
      expect(await page.getByText('on its way').count()).toBe(1)
    } finally {
      await browser.close()
    }
  }, 90000)
})

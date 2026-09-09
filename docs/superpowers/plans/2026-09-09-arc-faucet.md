# Arc 领水任务实施计划（faucet-arc）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 faucet 任务 `faucet-arc`，在 https://faucet.circle.com/ 为每个窗口的 MetaMask 钱包地址领取 20 testnet USDC（Arc Testnet），reCAPTCHA v2 挑战走 yescaptcha 自动打码。

**Architecture:** 一个任务文件 `src/tasks/arc-faucet.ts`（模块级常量/辅助函数导出供单测 + `ArcFaucetTask` 类），仿 `shelby-faucet.ts` 模式；run 流程为 UI 驱动 + 成功文案判定（`is on its way to your wallet and should appear shortly`），v2 挑战出现才打码。测试仿 `tests/shelby-faucet.test.ts`：注入假 page/human 的纯逻辑单测 + 真实 chromium + 本地 fixture 集成测试。

**Tech Stack:** TypeScript（严格模式）、patchright、vitest、Node 内置 http 服务器。

**规格来源:** `docs/superpowers/specs/2026-09-09-arc-faucet-design.md`

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、camelCase 命名、kebab-case 文件名；文件头中文注释块说明模块职责
- 日志消息用中文，格式 `logger.info({count}, '消息')`；commit 风格 conventional + 中文描述（`feat:`/`docs:`）
- 测试命令：`npx vitest run tests/arc-faucet.test.ts`（单文件）；`npm test`（全量）；`npm run typecheck`（tsc --noEmit 严格模式，必须通过）
- 任务 meta：key `faucet-arc`、name `Arc 领水`、url/sourceUrl `https://faucet.circle.com/`、category `faucet`、lastUpdated `2026-09-09`、enabled `true`、**不配 wallet**、timeoutSec `240`、retry `{ max: 2, backoffSec: 120 }`、captcha `{ auto: true }`、concurrency `3`
- 限频文案不做判定（用户隔天执行一次，撞限频按失败处理）
- 真机验证用窗口 `57acfefad5f94c449afe35397f97e45f`（窗口 100）：`BITBROWSER_PROFILE_ID=57acfefad5f94c449afe35397f97e45f TASK_KEY=faucet-arc npm run task:run`
- 真机经验验证后追加 `docs/TASK-DEVELOPMENT-LESSONS.md`（与代码同批提交）

---

## Task 1: 任务文件骨架 + 默认值/确保助手函数（TDD）

**Files:**
- Create: `tests/arc-faucet.test.ts`（单测脚手架 + 助手函数测试）
- Create: `src/tasks/arc-faucet.ts`（常量 + 5 个导出助手函数，本任务不含任务类）

**Interfaces:**
- Produces（后续任务依赖）:
  - 导出常量：`ADDRESS_SELECTOR = 'input[name="address"]'`、`NETWORK_BUTTON_SELECTOR = 'button[name="network"]'`、`NETWORK_DISPLAY_SELECTOR = 'button[name="network"] .field-display-value'`、`TARGET_NETWORK = 'Arc Testnet'`、`NETWORK_OPTION_SELECTOR = '[role="listbox"] [role="option"]:has-text("Arc Testnet")'`、`CURRENCY_RADIO_SELECTOR = 'input[name="currency"][value="USDC"]'`、`CURRENCY_CARD_SELECTOR = '[data-testid="select-card-USDC"]'`、`SUBMIT_SELECTOR = 'form button[type="submit"]'`、`SUCCESS_TEXT = 'is on its way to your wallet and should appear shortly'`、`CAPTCHA_V2_TEXT = 'verify that you are not a bot'`、`SUBMIT_ENABLED_TIMEOUT_MS = 15000`、`SUBMIT_RACE_MS = 30000`
  - `currentNetwork(ctx: TaskContext): Promise<string>`（元素缺失返回 `''`）
  - `isUsdcChecked(ctx: TaskContext): Promise<boolean>`（元素缺失/异常返回 `false`）
  - `ensureNetwork(ctx: TaskContext): Promise<void>`（已是 Arc Testnet 不点击；否则点按钮+选项并二次校验）
  - `ensureUsdc(ctx: TaskContext): Promise<void>`（已选中不点击；否则点卡片并二次校验）
  - `ensureSubmitEnabled(ctx: TaskContext, timeoutMs = SUBMIT_ENABLED_TIMEOUT_MS): Promise<void>`（轮询 isEnabled，超时抛错）

- [ ] **Step 1: 写失败的测试**

创建 `tests/arc-faucet.test.ts`（本任务先只含助手函数测试；文件头中文注释块）：

```ts
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
      count: async () => 1,
      textContent: async () => state.network,
      isChecked: async () => false,
      isEnabled: async () => true,
      fill: vi.fn(),
    },
    [CURRENCY_RADIO_SELECTOR]: {
      count: async () => 1,
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

const baseState = (): FakeState => ({ network: 'Arc Testnet', usdcChecked: true, submitEnabled: true, optionCount: 1 })

describe('currentNetwork 当前网络读取', () => {
  it('返回下拉显示值', async () => {
    const { ctx } = makeCtx({ ...baseState(), network: 'Ethereum Sepolia' })
    expect(await currentNetwork(ctx)).toBe('Ethereum Sepolia')
  })

  it('元素缺失 → 空串', async () => {
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
})

describe('ensureNetwork 网络确保', () => {
  it('已是 Arc Testnet → 不点击任何元素', async () => {
    const { ctx, clicks } = makeCtx(baseState())
    await ensureNetwork(ctx)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('非默认网络 → 点触发按钮与目标选项各一次，二次校验通过', async () => {
    const { ctx, clicks } = makeCtx({ ...baseState(), network: 'Ethereum Sepolia' })
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
    state.network = 'Ethereum Sepolia'
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
    const { ctx, clicks } = makeCtx({ ...baseState(), usdcChecked: false })
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
```

注意：`ensureNetwork` 的「点选后仍非 Arc Testnet」测试通过闭包变量 `state` 在调用期间不改变而模拟（helper 点选后二次读取仍是旧值）。`waitForTimeout` 假实现立即 resolve，`ensureSubmitEnabled` 的超时测试传入 200ms 小预算避免真实等待。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: FAIL（`Failed to resolve import "../src/tasks/arc-faucet"`）

- [ ] **Step 3: 实现任务文件骨架**

创建 `src/tasks/arc-faucet.ts`：

```ts
/**
 * Arc 领水任务（faucet-arc）：Circle 测试网水龙头 https://faucet.circle.com/ 领取 20 testnet USDC
 * 页面核实（2026-09-09 SSR 抓取，选择器已提取；交互细节真机验证后回填）：
 *   表单：input[name="address"]（placeholder Wallet address）+ form button[type="submit"]（文案 Send 20 USDC，地址校验前 disabled）
 *   Network 下拉：button[name="network"]（.field-display-value 显示当前值，默认 Arc Testnet）；
 *     选项 [role="listbox"] [role="option"] 共 38 项（downshift 生成的 item id 带随机数字后缀，按文本匹配）
 *   币种：三张 radio 卡片（USDC/EURC/CIRBTC），input[name="currency"][value="USDC"] 默认 checked；
 *     卡片 [data-testid="select-card-USDC"]（三卡片 id 重复非法，禁用 id 选择器）
 *   验证码：reCAPTCHA v3 无形（页面常驻 api.js，浏览器自行生成 token，不主动打码）
 *     + v2 回退挑战（提交被拒后动态注入 iframe，站点文案 "Please verify that you are not a bot and submit again."）
 *   成功：headline "Tokens sent" + "20 testnet USDC is on its way to your wallet and should appear shortly."
 *   限频：每资产×网络 1-2 小时限领一次（不做判定：用户隔天执行一次，撞限频按失败处理）
 * 流程：开页 → 填 metamask 地址（数据源列，不连钱包）→ 校验网络/币种默认值 → 点 Send → 竞速成功文案/v2 提示
 *   → v2 出现才 yescaptcha 打码（避免误打常驻 v3 白花点数）→ 再点 Send → 成功截图
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// —— 站点元素与文案（2026-09-09 SSR 核实）——
/** 地址输入框 */
export const ADDRESS_SELECTOR = 'input[name="address"]'
/** Network 下拉触发按钮 */
export const NETWORK_BUTTON_SELECTOR = 'button[name="network"]'
/** Network 下拉当前显示值容器 */
export const NETWORK_DISPLAY_SELECTOR = 'button[name="network"] .field-display-value'
/** Network 目标网络名 */
export const TARGET_NETWORK = 'Arc Testnet'
/** Network 下拉目标选项（按文本匹配；downshift 选项 id 带随机后缀不可硬编码） */
export const NETWORK_OPTION_SELECTOR = '[role="listbox"] [role="option"]:has-text("Arc Testnet")'
/** USDC 币种 radio */
export const CURRENCY_RADIO_SELECTOR = 'input[name="currency"][value="USDC"]'
/** USDC 币种卡片（未选中时点击选中） */
export const CURRENCY_CARD_SELECTOR = '[data-testid="select-card-USDC"]'
/** 提交按钮 */
export const SUBMIT_SELECTOR = 'form button[type="submit"]'
/** 领取成功文案（任务单判定文案） */
export const SUCCESS_TEXT = 'is on its way to your wallet and should appear shortly'
/** v2 挑战提示文案（提交被拒后出现；出现才触发打码） */
export const CAPTCHA_V2_TEXT = 'verify that you are not a bot'
/** 提交按钮 enabled 轮询上限（毫秒） */
export const SUBMIT_ENABLED_TIMEOUT_MS = 15000
/** 单次提交后的竞速等待（毫秒） */
export const SUBMIT_RACE_MS = 30000

/** 读取 Network 下拉当前显示值（元素缺失/读取失败返回空串） */
export async function currentNetwork(ctx: TaskContext): Promise<string> {
  const loc = ctx.page.locator(NETWORK_DISPLAY_SELECTOR).first()
  if ((await loc.count()) === 0) return ''
  return ((await loc.textContent().catch(() => '')) ?? '').trim()
}

/** USDC radio 是否已选中（元素缺失/读取失败按未选中处理） */
export async function isUsdcChecked(ctx: TaskContext): Promise<boolean> {
  const loc = ctx.page.locator(CURRENCY_RADIO_SELECTOR).first()
  if ((await loc.count()) === 0) return false
  return (await loc.isChecked().catch(() => false)) === true
}

/** 确保 Network = Arc Testnet：已是则不动；否则打开下拉点选目标选项并二次校验 */
export async function ensureNetwork(ctx: TaskContext): Promise<void> {
  if ((await currentNetwork(ctx)) === TARGET_NETWORK) return
  await ctx.human.click(NETWORK_BUTTON_SELECTOR)
  const opt = ctx.page.locator(NETWORK_OPTION_SELECTOR).first()
  if ((await opt.count()) === 0) throw new Error(`Network 下拉未找到选项: ${TARGET_NETWORK}`)
  await ctx.human.click(NETWORK_OPTION_SELECTOR)
  const now = await currentNetwork(ctx)
  if (now !== TARGET_NETWORK) throw new Error(`Network 选择失败: 当前显示 ${now || '(空)'}，期望 ${TARGET_NETWORK}`)
}

/** 确保币种 = USDC：已选中则不动；否则点卡片并二次校验 */
export async function ensureUsdc(ctx: TaskContext): Promise<void> {
  if (await isUsdcChecked(ctx)) return
  await ctx.human.click(CURRENCY_CARD_SELECTOR)
  if (!(await isUsdcChecked(ctx))) throw new Error('USDC 币种选择失败: radio 仍未选中')
}

/** 等提交按钮变为可用（地址校验通过后解除 disabled）；超时抛错 */
export async function ensureSubmitEnabled(ctx: TaskContext, timeoutMs = SUBMIT_ENABLED_TIMEOUT_MS): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const btn = ctx.page.locator(SUBMIT_SELECTOR).first()
    if ((await btn.count()) > 0 && (await btn.isEnabled().catch(() => false))) return
    await ctx.page.waitForTimeout(500)
  }
  throw new Error(`提交按钮 ${timeoutMs}ms 内未变为可用（地址校验未通过？）`)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: PASS（11 个单测全绿）

- [ ] **Step 5: 提交**

```bash
git add src/tasks/arc-faucet.ts tests/arc-faucet.test.ts
git commit -m "feat: Arc 领水任务骨架与网络/币种/提交按钮确保助手（TDD）"
```

---

## Task 2: 竞速等待 + 任务类与主流程（TDD）

**Files:**
- Modify: `tests/arc-faucet.test.ts`（追加竞速与 meta 测试，扩展 import）
- Modify: `src/tasks/arc-faucet.ts`（追加 waitForOutcome/submitAndWait/runArcFaucet + ArcFaucetTask 类）

**Interfaces:**
- Consumes: Task 1 的全部常量与助手函数
- Produces:
  - `waitForOutcome(ctx: TaskContext, timeoutMs: number): Promise<'success' | 'captcha' | null>`（轮询 textPresent：成功文案优先）
  - `export class ArcFaucetTask extends SiteTask`，meta 与 Global Constraints 一致；`run(ctx)` 委托模块级 `runArcFaucet`

- [ ] **Step 1: 写失败的测试**

修改 `tests/arc-faucet.test.ts`：

1. 顶部 import 追加（把 Task 1 的 import 块替换为）：

```ts
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
```

2. `makeCtx` 增加 texts 支持：把 `page` 的构造替换为（page 增加 getByText；`texts` 通过闭包 state 读取）：

```ts
  const page = {
    locator: (sel: string) => ({
      first: () => elems[sel] ?? blank,
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getByText: (t: string) => ({ count: async () => (state.texts[t] ? 1 : 0) }),
  }
```

3. `FakeState` 增加字段 `texts: Record<string, boolean>`；`baseState()` 返回加 `texts: {}`。
4. 在文件末尾（`ensureSubmitEnabled` describe 之后）追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: FAIL（`waitForOutcome`/`ArcFaucetTask` 未导出；已通过的单测不受影响）

- [ ] **Step 3: 实现竞速等待与任务类**

在 `src/tasks/arc-faucet.ts` 的 `ensureSubmitEnabled` 之后追加：

```ts
/** 竞速等待：成功文案 / v2 挑战文案谁先出现（都未出现返回 null；textPresent 即时判断轮询） */
export async function waitForOutcome(ctx: TaskContext, timeoutMs: number): Promise<'success' | 'captcha' | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await ctx.textPresent(SUCCESS_TEXT)) return 'success'
    if (await ctx.textPresent(CAPTCHA_V2_TEXT)) return 'captcha'
    await ctx.page.waitForTimeout(1000)
  }
  return null
}

/** 点提交并竞速等待结果 */
async function submitAndWait(ctx: TaskContext): Promise<'success' | 'captcha' | null> {
  await ctx.human.click(SUBMIT_SELECTOR)
  return waitForOutcome(ctx, SUBMIT_RACE_MS)
}

/** Arc 领水主流程（模块级函数：任务类委托它，集成测试可直接覆盖） */
async function runArcFaucet(ctx: TaskContext): Promise<void> {
  // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
  await ctx.closeOtherTabs()
  await ctx.goto()
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  // 钱包地址按窗口从数据源读取（严格模式：缺行/缺列/空值即任务失败——数据没备齐不该硬跑）
  const address = await ctx.account('metamask钱包地址')
  await ctx.page.locator(ADDRESS_SELECTOR).first().fill(address)
  await ensureNetwork(ctx)
  await ensureUsdc(ctx)
  await ensureSubmitEnabled(ctx)
  // 提交：v3 常驻不打码（浏览器自行生成 token）；被拒后站点动态注入 v2 挑战
  let outcome = await submitAndWait(ctx)
  if (outcome === 'captcha') {
    ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '检测到 v2 挑战，yescaptcha 打码')
    await ctx.solveCaptcha()
    await ensureSubmitEnabled(ctx)
    outcome = await submitAndWait(ctx)
    if (outcome === 'captcha') throw new Error('打码后再次提交仍触发 v2 挑战（token 未生效）')
  }
  if (outcome !== 'success') throw new Error(`提交后 ${SUBMIT_RACE_MS}ms 内未出现成功文案（v2 挑战也未出现）`)
  // 成功截图留档；截图失败只告警，不判任务失败（真机偶发等字体加载超时）
  try {
    await ctx.screenshot('arc-faucet-success')
  } catch (e) {
    ctx.log.warn({ step: 'faucet', window: ctx.profile.name, err: (e as Error).message }, '成功截图失败（不影响任务结果）')
  }
}

/** Arc 领水任务（Circle 测试网水龙头：Arc Testnet 领取 20 testnet USDC） */
export class ArcFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-arc',
    name: 'Arc 领水',
    url: 'https://faucet.circle.com/',
    sourceUrl: 'https://faucet.circle.com/',
    note: '页面核实（2026-09-09 SSR）：表单 input[name="address"] + form button[type="submit"]（文案 Send 20 USDC，地址校验前 disabled）；Network 下拉 button[name="network"] 默认 Arc Testnet（非默认才改，选项按文本匹配）；币种 input[name="currency"][value="USDC"] 默认选中（非默认才点 [data-testid="select-card-USDC"]）；验证码 reCAPTCHA v3 无形（常驻 api.js 不主动打码）+ v2 回退挑战（提交被拒后动态注入，出现 v2 文案才 yescaptcha 打码再提交）；成功文案 "is on its way to your wallet and should appear shortly"；限频每资产×网络 1-2 小时一次（不做判定，用户隔天执行）；不连钱包，地址取自数据源「metamask钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-09',
    enabled: true,
    // 不连钱包：只填地址，不配置 wallet
    timeoutSec: 240,
    // 短退避：领水任务重试成本低，撞限频/网络抖动重试两次收敛
    retry: { max: 2, backoffSec: 120 },
    captcha: { auto: true },
    // 公共水龙头保守并发：多窗口各自 IP，3 路并行避免触发平台风控
    concurrency: 3,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runArcFaucet(ctx)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: PASS（19 个单测全绿）

- [ ] **Step 5: 提交**

```bash
git add src/tasks/arc-faucet.ts tests/arc-faucet.test.ts
git commit -m "feat: Arc 领水任务主流程（竞速等待 + v2 打码分支 + 任务类）"
```

---

## Task 3: 集成测试（真实 chromium + 本地 fixture）

**Files:**
- Create: `tests/fixtures/arc-faucet.html`
- Modify: `tests/arc-faucet.test.ts`（追加集成测试 describe）

**Interfaces:**
- Consumes: `ArcFaucetTask`（`meta.url` 可覆写指向本地 fixture）、`TaskContext` 依赖注入（`accountRow`、`captcha` 假服务、`Humanizer(page)`）
- Produces: 无新接口

- [ ] **Step 1: 写失败的测试（只加测试，fixture 留待 Step 3）**

在 `tests/arc-faucet.test.ts` 顶部 import 追加（原 import 块第 3 行 `import { chromium } from 'patchright'` 之后）：

```ts
import type { Page } from 'patchright'
```

在 `tests/arc-faucet.test.ts` 末尾追加集成测试 describe：

```ts
describe('Arc 领水任务集成（真实浏览器 + 本地 fixture）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'arc-faucet.html'), 'utf-8'))
    })
    await new Promise<void>((r) => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  /** 构造真实浏览器页面的 TaskContext；autoSolve 假服务记录调用（验证码不真打） */
  function makeBrowserCtx(page: Page, task: ArcFaucetTask, autoSolve: ReturnType<typeof vi.fn>) {
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
      captcha: { autoSolve: autoSolve } as never,
    })
  }

  it('plain 模式：无验证码，一次提交成功且不打码', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const task = new ArcFaucetTask()
      task.meta.url = baseUrl + '/?mode=plain'
      const autoSolve = vi.fn().mockResolvedValue('solved')
      const ctx = makeBrowserCtx(page, task, autoSolve)
      await task.run(ctx)
      expect(await page.locator('input[name="address"]').inputValue()).toBe('0x835e')
      expect(await page.getByText('on its way').count()).toBe(1)
      expect(autoSolve).not.toHaveBeenCalled()
    } finally {
      await browser.close()
    }
  }, 90000)

  it('v2 模式：首次提交触发挑战 → 打码一次 → 再提交成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const task = new ArcFaucetTask()
      task.meta.url = baseUrl + '/?mode=v2'
      const autoSolve = vi.fn().mockResolvedValue('solved')
      const ctx = makeBrowserCtx(page, task, autoSolve)
      await task.run(ctx)
      expect(autoSolve).toHaveBeenCalledTimes(1)
      expect(await page.getByText('on its way').count()).toBe(1)
    } finally {
      await browser.close()
    }
  }, 90000)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: FAIL（集成测试 beforeAll 读 fixture 文件不存在抛错：ENOENT tests/fixtures/arc-faucet.html）

- [ ] **Step 3: 创建 fixture（实现）**

创建 `tests/fixtures/arc-faucet.html`：

```html
<!doctype html>
<html>
<body>
  <button name="network" type="button">
    <div class="field-display-value">Arc Testnet</div>
  </button>
  <div role="listbox">
    <span role="option">Arc Testnet</span>
    <span role="option">Ethereum Sepolia</span>
  </div>
  <input type="radio" name="currency" value="USDC" checked />
  <input type="radio" name="currency" value="EURC" />
  <div data-testid="select-card-USDC"></div>
  <input name="address" type="text" placeholder="Wallet address" />
  <button type="submit" disabled>Send 20 USDC</button>
  <script>
    // mode=plain：提交即成功；mode=v2：首次提交出现 v2 挑战文案，再次提交成功
    const mode = new URLSearchParams(location.search).get('mode') ?? 'plain'
    const addr = document.querySelector('input[name="address"]')
    const btn = document.querySelector('button[type="submit"]')
    addr.addEventListener('input', () => { btn.disabled = addr.value.trim() === '' })
    let submits = 0
    btn.addEventListener('click', () => {
      submits++
      const box = document.createElement('div')
      if (mode === 'v2' && submits === 1) {
        box.textContent = 'We detect unusual traffic from your request. Please verify that you are not a bot and submit again.'
      } else {
        box.textContent = '20 testnet USDC is on its way to your wallet and should appear shortly.'
      }
      document.body.appendChild(box)
    })
  </script>
</body>
</html>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: PASS（21 个测试全绿；集成测试需下载/使用本地 chromium，单文件时长约 30-60s）

- [ ] **Step 5: 提交**

```bash
git add tests/arc-faucet.test.ts tests/fixtures/arc-faucet.html
git commit -m "test: Arc 领水集成测试（成功/v2 挑战两模式 + 本地 fixture）"
```

---

## Task 4: 任务注册与全量验证

**Files:**
- Modify: `src/tasks/index.ts`（登记 ArcFaucetTask）

**Interfaces:**
- Consumes: `ArcFaucetTask`
- Produces: 任务注册表自动获得 API/面板能力（key `faucet-arc`）

- [ ] **Step 1: 登记任务**

修改 `src/tasks/index.ts`：

```ts
import { ArcFaucetTask } from './arc-faucet'

// 全部任务实例（每个任务一个单例，跨 API/队列共享状态）
const ALL: SiteTask[] = [new ExampleCheckinTask(), new FaucetExampleTask(), new MintExampleTask(), new InceptionDachainTask(), new PortalRhunaTask(), new ShelbyFaucetTask(), new ShelbyExplorerTask(), new ArcFaucetTask()]
```

（在现有 import 列表末尾追加 ArcFaucetTask import；ALL 数组末尾追加 `new ArcFaucetTask()`）

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0，无输出（tsc 严格模式）

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: PASS（全部测试通过，含新增 arc-faucet 21 个）

- [ ] **Step 4: 提交**

```bash
git add src/tasks/index.ts
git commit -m "feat: 注册 Arc 领水任务（faucet-arc）"
```

---

## Task 5: 真机验证与经验文档

**Files:**
- Modify: `docs/TASK-DEVELOPMENT-LESSONS.md`（追加真机经验）

**Interfaces:**
- Consumes: 已注册任务 `faucet-arc`、本机比特浏览器（API http://127.0.0.1:54345，已运行）
- Produces: 真机核实结论（用于后续限频判定等增强决策）

- [ ] **Step 1: 真机单窗口验证**

Run（PowerShell，工作目录为项目根）:

```powershell
$env:BITBROWSER_PROFILE_ID="57acfefad5f94c449afe35397f97e45f"
$env:TASK_KEY="faucet-arc"
npm run task:run
```

Expected: 脚本日志显示任务运行结果（success）。观察点：
1. 日志确认「Network 下拉默认 Arc Testnet」「USDC 默认选中」未触发误改（无选择日志即默认值路径）
2. 地址 fill 后提交按钮变为可用（无「未变为可用」报错即通过）
3. 是否触发 v2 挑战（日志「检测到 v2 挑战，yescaptcha 打码」）
4. 成功截图落盘 `data/screenshots/<日期>/<窗口>/faucet-arc/arc-faucet-success.png`，检查页面成功文案
5. 若窗口 100 已在 1-2 小时内领过（撞限频）：任务可能因「未出现成功文案」失败——换未领过的窗口重跑验证，或等冷却后重跑

若脚本报「任务未注册: faucet-arc」：确认 Task 4 已完成且脚本进程无旧代码缓存（tsx 每次现编译，重启即生效）。

- [ ] **Step 2: 追加真机经验到 LESSONS**

在 `docs/TASK-DEVELOPMENT-LESSONS.md` 追加条目（按其现有章节结构，如「Arc 领水（faucet-arc）」小节），内容以真机实际为准，至少包含：v2 挑战触发情况（触发与否/时机）、成功文案出现时机、限频实际文案与冷却时间（若撞到）、Network 下拉交互是否有坑（如列表 DOM 常驻/aria-expanded 变化）、按钮 enabled 条件。

- [ ] **Step 3: 提交**

```bash
git add docs/TASK-DEVELOPMENT-LESSONS.md
git commit -m "docs: 追加 Arc 领水真机验证经验"
```

---

## Self-Review 记录

1. **Spec coverage**：spec 五节改动清单全部覆盖——任务文件（Task 1/2）、index 登记（Task 4）、单测+集成（Task 1/2/3）、真机验证+文档（Task 5）；限频判定明确不做（Global Constraints）；EURC/CIRBTC 不支持（范围外）。
2. **Placeholder scan**：无 TBD/TODO；每步含完整代码与命令。
3. **Type consistency**：`waitForOutcome` 返回 `'success' | 'captcha' | null` 在 Task 2 定义、测试与 Task 3 使用一致；常量名在测试（Task 1 import）与实现（Task 1 导出）一致。

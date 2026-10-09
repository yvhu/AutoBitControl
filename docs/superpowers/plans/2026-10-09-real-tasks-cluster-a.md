# 真实任务重写（簇 A：无钱包领水任务）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 3 个无钱包地址类任务（`faucet-arc` / `shelby-faucet` / `auralaunch-faucet`）重写为新范式：`SiteTask`（默认 `run` + `action`）、DOM 直调 `ctx.page`（patchright）、`ctx.safeScreenshot`、`ctx.captcha.*`，并消除 `arc` 对 `automation/captcha/frame-find` 的越层直引。

**Architecture:** 不改站点业务逻辑（选择器、判定、自愈循环原样保留），只替换「调用层」：旧扁平 DSL（`ctx.goto`/`closeOtherTabs`/`assertVisible`/`human.click`/`screenshot`/`waitCaptchaPassed`/`textPresent`）→ 新门面（默认 run + `ctx.page` + `ctx.safeScreenshot` + `ctx.captcha.*`）。旧扁平方法仍存在（Plan 4 才删），故本计划为**渐进式**，可独立测试、可回滚。

**Tech Stack:** TypeScript（严格）、patchright 1.62.1、vitest 3.2（fake page / 真实 chromium + fixture）。

## Global Constraints

- 依赖方向：`tasks → engine → automation/integrations → infrastructure`；**`tasks` 层禁止直接 import `automation`**（经 `./base` / `ctx` 取得能力）。
- 任务里 DOM 操作直调 `ctx.page`（patchright）；截图用 `ctx.safeScreenshot`；验证码用 `ctx.captcha.*`；数据源用 `ctx.account`。
- 代码风格：无分号、单引号、2 空格缩进；文件头/注释中文；命名 camelCase，文件 kebab-case。
- 站点业务逻辑（选择器、`judge*` 判定、自愈/补点循环）**行为等价**，不得改动判定阈值与真机实测参数。
- 提交风格：conventional + 中文，单行。
- 验证命令：`npx vitest run <file>`、`npm run typecheck`、`npm test`。
- 运行环境：Windows PowerShell 5.1；分支 `feat/task-thin-facade`。
- 真机验证（AGENTS 规范）：每任务改完由用户在真实窗口 `task:run` 验证；并发≤4；卡住 3 分钟暂停。

---

### Task 1: `ctx.captcha.hasChallenge` 门面补充

**Files:**
- Modify: `src/engine/task-context.ts`（`get captcha()` 增加 `hasChallenge`）
- Test: `tests/task-context-namespaces.test.ts`

**Interfaces:**
- Produces: `ctx.captcha.hasChallenge(siteKeyExclude?: string): Promise<boolean>` —— 页面存在 reCAPTCHA 锚点或挑战 frame（排除常驻 sitekey）即 true。
- 供 Task 2（arc）替代对 `../automation/captcha/frame-find` 的直接 import。

- [ ] **Step 1: 写失败测试**（`tests/task-context-namespaces.test.ts` 的 captcha describe 内追加）

```ts
  it('captcha.hasChallenge 委托 frame 查找（无 frame → false）', async () => {
    const ctx = makeCtx()
    ;(ctx.page as unknown as { frames: () => unknown[] }).frames = () => []
    await expect(ctx.captcha.hasChallenge('6LcV3')).resolves.toBe(false)
  })
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/task-context-namespaces.test.ts`
Expected: FAIL（`hasChallenge` 不存在）

- [ ] **Step 3: 最小实现**

`src/engine/task-context.ts` 顶部 captcha import 追加 `findAnchorFrame`/`findChallengeFrame`：

```ts
import { findAnchorFrame, findChallengeFrame } from '../automation/captcha/frame-find'
```

`get captcha()` 返回对象追加：

```ts
      /** 页面是否存在 reCAPTCHA 锚点/挑战 frame（排除常驻 v3 sitekey） */
      hasChallenge: async (siteKeyExclude?: string): Promise<boolean> => {
        return findAnchorFrame(this.page, siteKeyExclude) !== null || findChallengeFrame(this.page, siteKeyExclude) !== null
      },
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/task-context-namespaces.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/task-context.ts tests/task-context-namespaces.test.ts
git commit -m "feat: ctx.captcha.hasChallenge（reCAPTCHA frame 检测，供任务去越层直引）"
```

---

### Task 2: `arc-faucet` 重写

**Files:**
- Modify: `src/tasks/arc-faucet.ts`
- Modify: `tests/arc-faucet.test.ts`

**Interfaces:**
- Consumes: `SiteTask`（默认 `run`）、`ctx.page`、`ctx.account`、`ctx.captcha.hasChallenge`、`ctx.captcha.waitPlugin`、`ctx.safeScreenshot`
- Produces: `ArcFaucetTask extends SiteTask`（`action`），模块级助手/常量保持导出（测试仍用）

- [ ] **Step 1: 重写 `src/tasks/arc-faucet.ts`（完整替换；逻辑等价，仅换调用层）**

```ts
/**
 * Arc 领水任务（faucet-arc）：Circle 测试网水龙头 https://faucet.circle.com/ 领取 20 testnet USDC
 * 流程（真机核实）：填地址 → 校验网络/币种 → 点 Send → 竞速成功文案/v2 挑战
 *   → v2 走浏览器插件自动解题（ctx.captcha.waitPlugin）→ 再点 Send → 成功截图
 * 依赖方向：仅依赖 ./base（经 ctx 用能力），不再直接 import automation
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'

// —— 站点元素与文案（2026-09-09 SSR 核实）——
export const ADDRESS_SELECTOR = 'input[name="address"]'
export const NETWORK_BUTTON_SELECTOR = 'button[name="network"]'
export const NETWORK_DISPLAY_SELECTOR = 'button[name="network"] .field-display-value'
export const TARGET_NETWORK = 'Arc Testnet'
export const NETWORK_OPTION_SELECTOR = '[role="listbox"] [role="option"]:has-text("Arc Testnet")'
export const CURRENCY_RADIO_SELECTOR = 'input[name="currency"][value="USDC"]'
export const CURRENCY_CARD_SELECTOR = '[data-testid="select-card-USDC"]'
export const SUBMIT_SELECTOR = 'form button[type="submit"]'
export const SUCCESS_TEXT = 'is on its way to your wallet and should appear shortly'
export const CAPTCHA_V2_TEXT = 'verify that you are not a bot'
export const SUBMIT_ENABLED_TIMEOUT_MS = 15000
export const SUBMIT_RACE_MS = 30000
export const V3_SITEKEY = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'

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
  await ctx.page.locator(NETWORK_BUTTON_SELECTOR).first().click()
  const opt = ctx.page.locator(NETWORK_OPTION_SELECTOR).first()
  if ((await opt.count()) === 0) throw new Error(`Network 下拉未找到选项: ${TARGET_NETWORK}`)
  await ctx.page.locator(NETWORK_OPTION_SELECTOR).first().click()
  const now = await currentNetwork(ctx)
  if (now !== TARGET_NETWORK) throw new Error(`Network 选择失败: 当前显示 ${now || '(空)'}，期望 ${TARGET_NETWORK}`)
}

/** 确保币种 = USDC：已选中则不动；否则点卡片并二次校验 */
export async function ensureUsdc(ctx: TaskContext): Promise<void> {
  if (await isUsdcChecked(ctx)) return
  await ctx.page.locator(CURRENCY_CARD_SELECTOR).first().click()
  if (!(await isUsdcChecked(ctx))) throw new Error('USDC 币种选择失败: radio 仍未选中')
}

/** 等提交按钮变为可用（地址校验通过后解除 disabled）；onPoll 用于 hydration 清空自愈 */
export async function ensureSubmitEnabled(ctx: TaskContext, timeoutMs = SUBMIT_ENABLED_TIMEOUT_MS, onPoll?: () => Promise<void>): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const btn = ctx.page.locator(SUBMIT_SELECTOR).first()
    if ((await btn.count()) > 0 && (await btn.isEnabled().catch(() => false))) return
    if (onPoll) await onPoll().catch(() => {})
    await ctx.page.waitForTimeout(500)
  }
  throw new Error(`提交按钮 ${timeoutMs}ms 内未变为可用（地址校验未通过？）`)
}

/** 竞速等待：成功文案 / v2 挑战文案谁先出现；每 2s 补一次 DOM 挑战检测 */
export async function waitForOutcome(ctx: TaskContext, timeoutMs: number, allowChallenge = true): Promise<'success' | 'captcha' | null> {
  const end = Date.now() + timeoutMs
  let lastCheck = 0
  while (Date.now() < end) {
    if (await ctx.page.getByText(SUCCESS_TEXT, { exact: false }).count() > 0) return 'success'
    if (allowChallenge) {
      if (await ctx.page.getByText(CAPTCHA_V2_TEXT, { exact: false }).count() > 0) return 'captcha'
      if (Date.now() - lastCheck >= 2000 && (await ctx.captcha.hasChallenge(V3_SITEKEY))) return 'captcha'
      lastCheck = Date.now()
    }
    await ctx.page.waitForTimeout(1000)
  }
  return null
}

/** 点提交并竞速等待结果 */
async function submitAndWait(ctx: TaskContext, allowChallenge = true): Promise<'success' | 'captcha' | null> {
  await ctx.page.locator(SUBMIT_SELECTOR).first().click()
  return waitForOutcome(ctx, SUBMIT_RACE_MS, allowChallenge)
}

/** Arc 领水任务（Circle 测试网水龙头：Arc Testnet 领取 20 testnet USDC） */
export class ArcFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-arc',
    name: 'Arc 领水',
    group: { key: 'arc', name: 'Arc' },
    url: 'https://faucet.circle.com/',
    sourceUrl: 'https://faucet.circle.com/',
    note: '真机核实（2026-09-09）：站点为 reCAPTCHA Enterprise（页面常驻 v3 sitekey 6LcNs_0p，浏览器自行生成 token）；提交被拒后动态注入 v2 挑战——人机验证走浏览器插件自动解题（ctx.captcha.waitPlugin，插件=yescaptcha 人机助手；任务侧只等 aria-checked 变绿）；不连钱包，地址取自数据源「metamask钱包地址」列；限频每资产×网络 1-2 小时（不做判定）',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: true,
    timeoutSec: 420,
    retry: { max: 2, backoffSec: 120 },
    concurrency: 3,
  }

  async action(ctx: TaskContext): Promise<void> {
    await ctx.page.locator(ADDRESS_SELECTOR).first().waitFor({ state: 'visible', timeout: 20000 })
    const address = await ctx.account('metamask钱包地址')
    const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
    await addressInput.fill(address)
    await ensureNetwork(ctx)
    await ensureUsdc(ctx)
    // 提交按钮等待 + hydration 清空自愈合并（React hydration 可晚于 6s 清空地址框）
    await ensureSubmitEnabled(ctx, SUBMIT_ENABLED_TIMEOUT_MS, async () => {
      if (((await addressInput.inputValue().catch(() => '')) ?? '') === '') {
        await addressInput.fill(address)
      }
    })
    let outcome = await submitAndWait(ctx)
    if (outcome === 'captcha') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '检测到 v2 挑战，等待浏览器插件自动解题')
      const solved = await ctx.captcha.waitPlugin({ siteKeyExclude: V3_SITEKEY })
      if (solved === 'none') throw new Error('未检测到验证码锚点 frame')
      if (solved === 'timeout') throw new Error('等待验证码插件解题超时（检查插件 ClientKey/余额）')
      await ensureSubmitEnabled(ctx)
      outcome = await submitAndWait(ctx, false)
    }
    if (outcome !== 'success') throw new Error(`提交后 ${SUBMIT_RACE_MS}ms 内未出现成功文案（v2 挑战也未出现）`)
    await ctx.safeScreenshot('arc-faucet-success')
  }
}
```

同时删除原文件中的 `import { findAnchorFrame, findChallengeFrame } from '../automation/captcha/frame-find'` 与旧 `detectV2Challenge` 导出（逻辑并入 `waitForOutcome` 的 `hasChallenge` 调用）。

- [ ] **Step 2: 适配 `tests/arc-faucet.test.ts`**

1. 删除 `import { Humanizer } ...`（不再需要；若集成测试 `makeBrowserCtx` 用到，改为 `human: {} as never`）与 `detectV2Challenge` 导入。
2. `makeCtx` 的假 `page` 增加默认 `run` 所需字段（默认 run 用 `page.context().pages()` 与 `page.goto`）：

```ts
  const page = {
    // ...既有 locator/getByText/waitForTimeout/frames...
    context: () => ({ pages: () => [{}] }),   // pages() 返回非空；run 内 p!==ctx.page 才关，假 page 无 close 会 catch
    goto: vi.fn().mockResolvedValue(undefined),
    // ...
  }
```

并把 `page.locator(sel).first()` 的元素补上 `click: vi.fn().mockResolvedValue(undefined)`（供货运作点击；arc 现在用 `page.locator().click()`）。

3. 删除 `makeCtx` 里的 `human: { click: clicks }`，改为 `human: {} as never`；把原本断言 `clicks` 的地方改为对**提交按钮元素 click** 的断言，例如：

```ts
  const submitClick = elems[SUBMIT_SELECTOR].click
  expect(submitClick).toHaveBeenCalled()
```

4. `stubRunCapabilities`（若存在）与 run 测试里对 `ctx.closeOtherTabs`/`ctx.goto`/`ctx.assertVisible` 的 stub 改为：默认 run 用 `page.context`/`page.goto`（已在 makeCtx 提供）；action 用 `page.locator(ADDRESS_SELECTOR).waitFor`（给地址元素加 `waitFor: vi.fn().mockResolvedValue(undefined)`）。
5. 集成测试 `makeBrowserCtx` 的 `human: new Humanizer(page)` 改为 `human: {} as never`（任务不再用 human）。
6. v2/challenge 集成测试仍依赖 `ctx.captcha.hasChallenge`（经真实 `page.frames()` 读 fixture 注入的 iframe）——无需改断言。

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/arc-faucet.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/arc-faucet.ts tests/arc-faucet.test.ts
git commit -m "refactor: arc-faucet 改用 SiteTask/patchright 直调 + ctx.captcha（去越层直引）"
```

- [ ] **Step 5: 真机验证（用户执行）**

`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=faucet-arc npm run task:run`，覆盖 plain 提交与 v2 挑战各一个窗口。

---

### Task 3: `shelby-faucet` 重写

**Files:**
- Modify: `src/tasks/shelby-faucet.ts`
- Modify: `tests/shelby-faucet.test.ts`

**Interfaces:**
- Consumes: `SiteTask`（覆盖 `run`，两页流程）、`ctx.page`、`ctx.account`、`ctx.safeScreenshot`
- Produces: `judgeFundResponse`、`runClaimLoop` 仍导出（测试用）

- [ ] **Step 1: 重写 `src/tasks/shelby-faucet.ts`（完整替换；逻辑等价）**

```ts
/**
 * Shelby 文档站领水任务（合并版）：一次开窗领取 APT 与 ShelbyUSD 各最多 5 次
 * 两页流程：APT 页 → 填地址 → 循环领取 → USD 页 → 填地址 → 循环领取
 * 成功判定走 /fund 接口响应；达上限（UsageLimitExhausted）视为成功幂等收敛
 * 依赖方向：仅依赖 ./base；不连钱包
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import type { Response } from 'patchright'

const ADDRESS_SELECTOR = 'input[name="address"]'
const FUND_BUTTON_SELECTOR = 'button:has-text("Fund")'
const FUND_URL_PART = 'faucet.shelbynet.shelby.xyz/fund'
const MAX_CLAIMS_PER_RUN = 5
const FUND_WAIT_MS = 10000
const RECLICK_MAX = 1
const CLAIM_GAP_MIN_MS = 1000
const CLAIM_GAP_MAX_MS = 2000

export interface FundResponse {
  txn_hashes?: string[]
  message?: string
  error_code?: string
  rejection_reasons?: Array<{ reason?: string; code?: string }>
}

export type FundVerdict = 'success' | 'limit' | 'rejected'

/** 判定 /fund 响应体：txn_hashes 非空即成功；含 UsageLimitExhausted 即达上限；其余一律拒绝 */
export function judgeFundResponse(body: FundResponse | null): FundVerdict {
  if (body && Array.isArray(body.txn_hashes) && body.txn_hashes.length > 0) return 'success'
  const reasons = body?.rejection_reasons ?? []
  if (reasons.some((r) => r.code === 'UsageLimitExhausted')) return 'limit'
  return 'rejected'
}

/** 注册并等待一次 /fund POST 响应（注册即吞错；超时返回 null） */
function waitFundResponse(ctx: TaskContext): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.url().includes(FUND_URL_PART) && r.request().method() === 'POST', { timeout: FUND_WAIT_MS })
    .catch(() => null)
}

/**
 * 领取循环：最多 maxClaims 次「点 Fund → 等 /fund POST 响应 → 判定」
 * @returns 实际成功领取次数（达上限提前退出时小于 maxClaims）
 */
export async function runClaimLoop(ctx: TaskContext, address: string, maxClaims: number): Promise<{ claimed: number }> {
  let claimed = 0
  for (let i = 0; i < maxClaims; i++) {
    const input = ctx.page.locator(ADDRESS_SELECTOR).first()
    const current = await input.inputValue().catch(() => '')
    if (current === '') await input.fill(address)
    let res: Response | null = null
    for (let attempt = 0; attempt <= RECLICK_MAX; attempt++) {
      const respPromise = waitFundResponse(ctx)
      await ctx.page.locator(FUND_BUTTON_SELECTOR).first().click()
      res = await respPromise
      if (res) break
      ctx.log.warn({ step: 'fund', window: ctx.profile.name, claim: i + 1, attempt: attempt + 1 }, '等待 /fund 响应超时，拟人补点重试')
    }
    if (!res) throw new Error(`第 ${i + 1} 次领取失败（等待 /fund 响应超时）`)
    const body = (await res.json().catch(() => null)) as FundResponse | null
    const verdict = judgeFundResponse(body)
    if (verdict === 'success') {
      claimed++
      ctx.log.info({ step: 'fund', window: ctx.profile.name, claim: i + 1 }, '领取成功')
      await ctx.page.waitForTimeout(CLAIM_GAP_MIN_MS + Math.floor(Math.random() * (CLAIM_GAP_MAX_MS - CLAIM_GAP_MIN_MS)))
      continue
    }
    if (verdict === 'limit') {
      ctx.log.info({ step: 'fund', window: ctx.profile.name, claim: i + 1 }, '已达当日领取上限，提前结束（视为成功）')
      break
    }
    throw new Error(`第 ${i + 1} 次领取被拒绝: ${JSON.stringify(body ?? {})}`.slice(0, 500))
  }
  return { claimed }
}

/** Shelby 领水任务（合并版：APT + ShelbyUSD 各最多 5 次，一次开窗） */
export class ShelbyFaucetTask extends SiteTask {
  usdUrl = 'https://docs.shelby.xyz/apis/faucet/shelbyusd'

  meta: TaskMeta = {
    key: 'shelby-faucet',
    name: 'Shelby 领水',
    group: { key: 'shelby', name: 'Shelby' },
    url: 'https://docs.shelby.xyz/apis/faucet/aptos',
    sourceUrl: ['https://docs.shelby.xyz/apis/faucet/aptos', 'https://docs.shelby.xyz/apis/faucet/shelbyusd'],
    note: '真机核实（2026-09-07）：两文档页表单一致（input[name="address"] + Fund 按钮）；接口 POST faucet.shelbynet.shelby.xyz/fund（USD 带 ?asset=shelbyusd）；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 UsageLimitExhausted 视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空；成功 toast 插入会致下一轮点击偶发落空——响应超时自动补点一次；截图偶发等字体超时已非致命化；地址 fill 直填；网络选择器保持默认 Shelbynet；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: true,
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 120 },
    concurrency: 6,
  }

  /** 两页流程，覆盖默认 run */
  async run(ctx: TaskContext): Promise<void> {
    const address = await this.claimOnPage(ctx, this.meta.url)
    ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'apt', claimed: address.apt }, 'APT 领水完成')
    const usd = await this.claimOnPage(ctx, this.usdUrl, address.addr)
    ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'shelbyusd', claimed: usd.apt }, 'ShelbyUSD 领水完成')
    await ctx.safeScreenshot('shelby-faucet-success')
  }

  /** 打开一页 → 等地址框 → 取/用地址 → 循环领取 */
  private async claimOnPage(ctx: TaskContext, url: string, knownAddress?: string): Promise<{ addr: string; apt: number }> {
    await ctx.page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' })
    await ctx.page.locator(ADDRESS_SELECTOR).first().waitFor({ state: 'visible', timeout: 20000 })
    const addr = knownAddress ?? (await ctx.account('petra钱包地址'))
    await ctx.page.locator(ADDRESS_SELECTOR).first().fill(addr)
    const { claimed } = await runClaimLoop(ctx, addr, MAX_CLAIMS_PER_RUN)
    return { addr, apt: claimed }
  }
}
```

- [ ] **Step 2: 适配 `tests/shelby-faucet.test.ts`**

1. `makeCtx` 中删除 `human: { click: vi.fn() }`（改 `human: {} as never`），假 `page.locator` 改为按选择器路由并支持 click 记录：
   - `ADDRESS_SELECTOR` → `{ first: () => inputEl }`（inputEl 含 `inputValue`/`fill`）。
   - `FUND_BUTTON_SELECTOR` → `{ first: () => ({ click: vi.fn(async () => { clicks.push(FUND_BUTTON_SELECTOR) }) }) }`。
   暴露 `clicks` 给测试。
2. 所有 `ctx.human.click` 断言改为 `clicks` 数组断言（次数/存在性）。
3. 「点击失败不产生孤儿 unhandledRejection」用例：把 `human: { click: reject }` 改为假 `FUND_BUTTON_SELECTOR` 元素的 `click: () => Promise.reject(new Error('点击失败: 找不到元素 button:has-text("Fund")'))`。
4. `runClaimLoop` 不涉及默认 run，测试无需 `goto`。
5. `ShelbyFaucetTask` meta 断言中 `url` 等不变；`t.usdUrl` 仍存在。
6. 集成测试 `human: new Humanizer(page)` 改为 `human: {} as never`；`task.run(ctx)` 走覆盖的 run（用真实 `page.goto`）——fixture 已由 `task.meta.url = baseUrl + '/aptos'` 重定向，保持。

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/shelby-faucet.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/shelby-faucet.ts tests/shelby-faucet.test.ts
git commit -m "refactor: shelby-faucet 改用 SiteTask/patchright 直调 + ctx.safeScreenshot"
```

- [ ] **Step 5: 真机验证（用户执行）**

`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=shelby-faucet npm run task:run`。

---

### Task 4: `auralaunch-faucet` 重写

**Files:**
- Modify: `src/tasks/auralaunch-faucet.ts`
- Modify: `tests/auralaunch-faucet.test.ts`

**Interfaces:**
- Consumes: `SiteTask`（默认 `run` + `action`）、`ctx.page`、`ctx.account`、`ctx.safeScreenshot`
- Produces: 模块级助手（`unwrapTrpcEnvelope`/`judgeFaucetResponse`/`waitFaucetResponse`/`waitUiOutcome`/`waitInputReady`）与常量仍导出（测试用）

- [ ] **Step 1: 重写 `src/tasks/auralaunch-faucet.ts`（完整替换；逻辑等价）**

```ts
/**
 * AuraLaunch 领水任务（auralaunch-faucet）：Caldera LiteForge 测试网水龙头
 * 地址取自数据源「metamask钱包地址」直填（不连钱包）；领取走 tRPC，限频=已领取=成功幂等
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import type { Response } from 'patchright'

export const ADDRESS_SELECTOR = 'input[placeholder="Recipient\'s Wallet Address"]'
export const REQUEST_BTN_SELECTOR = '.flex.justify-center.items-center.gap-2:has-text("Request")'
export const LIMIT_KEYWORDS = ['sorry, something went wrong', 'try again later', 'already claimed', 'rate limit', 'cooldown', '24 hours']
export const SUCCESS_TEXT = 'Successfully requested funds to your wallet'
export const FAUCET_RESPONSE_WAIT_MS = 15000
export const UI_OUTCOME_WAIT_MS = 30000
export const INPUT_READY_WAIT_MS = 45000
export const INPUT_READY_RELOAD_WAIT_MS = 30000
export const RECLICK_MAX = 1
export const RECLICK_WAIT_MS = 5000

export function unwrapTrpcEnvelope(body: unknown): { success?: boolean; message?: string } | null {
  const items = Array.isArray(body) ? body : [body]
  for (const item of items) {
    const it = item as { result?: { data?: unknown }; error?: { json?: unknown } } | null
    if (!it) continue
    const resultData = it.result?.data as { json?: unknown } | null
    const json = resultData?.json ?? null
    if (json && typeof json === 'object' && typeof (json as { success?: unknown }).success === 'boolean') {
      const c = json as { success: boolean; message?: unknown }
      return { success: c.success, message: typeof c.message === 'string' ? c.message : '' }
    }
  }
  return null
}

export async function judgeFaucetResponse(res: Response): Promise<'success' | 'limit' | 'rejected'> {
  const body = await res.json().catch(() => null)
  const raw = JSON.stringify(body ?? {})
  const envelope = unwrapTrpcEnvelope(body)
  if (envelope && typeof envelope.success === 'boolean') return envelope.success ? 'success' : 'rejected'
  if (res.status() === 429) return 'limit'
  if (/TOO_MANY_REQUESTS|24 hours|rate limit|cooldown/i.test(raw)) return 'limit'
  if (res.status() >= 200 && res.status() < 300) return 'success'
  return 'rejected'
}

export function waitFaucetResponse(ctx: TaskContext, address: string): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.request().method() === 'POST' && (r.request().postData() ?? '').includes(address), { timeout: FAUCET_RESPONSE_WAIT_MS })
    .catch(() => null)
}

export async function waitUiOutcome(ctx: TaskContext, timeoutMs = UI_OUTCOME_WAIT_MS): Promise<'success' | 'limit' | 'none'> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await ctx.page.getByText(SUCCESS_TEXT, { exact: false }).count() > 0) return 'success'
    for (const kw of LIMIT_KEYWORDS) {
      if (await ctx.page.getByText(kw, { exact: false }).count() > 0) return 'limit'
    }
    await ctx.page.waitForTimeout(1000)
  }
  return 'none'
}

export async function waitInputReady(ctx: TaskContext, timeoutMs = INPUT_READY_WAIT_MS): Promise<'ready' | 'disabled' | 'missing'> {
  const poll = async (ms: number): Promise<'ready' | 'disabled' | null> => {
    const end = Date.now() + ms
    let existed = false
    while (Date.now() < end) {
      const loc = ctx.page.locator(ADDRESS_SELECTOR).first()
      if ((await loc.count()) > 0) {
        existed = true
        if (await loc.isEnabled().catch(() => false)) return 'ready'
      }
      await ctx.page.waitForTimeout(1000)
    }
    return existed ? 'disabled' : null
  }
  const first = await poll(timeoutMs)
  if (first) return first
  await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  return (await poll(INPUT_READY_RELOAD_WAIT_MS)) ?? 'missing'
}

/** AuraLaunch 领水任务（Caldera LiteForge 测试网水龙头） */
export class AuralaunchFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'auralaunch-faucet',
    name: 'AuraLaunch 领水',
    group: { key: 'auralaunch', name: 'AuraLaunch' },
    url: 'https://liteforge.hub.caldera.xyz/',
    sourceUrl: 'https://liteforge.hub.caldera.xyz/',
    note: '真机核实（2026-10-08）：Caldera LiteForge 水龙头（Bridge/Faucet 同页 SPA）；地址框 input[placeholder="Recipient\'s Wallet Address"]；不连钱包，地址取自数据源「metamask钱包地址」列；领水走 tRPC faucet.requestFaucetFunds——成功 200+success:true、失败 200+success:false（不能只看状态码）、限频 429+TOO_MANY_REQUESTS（24h 一次，视为已领取=成功幂等）；站点有 Turnstile（实测无需人工点击），token 未就绪时点击无请求——补点一次自愈；落地页渲染可超 20s、已领后地址框可能短暂禁用——等就绪+刷新兜底',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: true,
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 120 },
    concurrency: 3,
  }

  async action(ctx: TaskContext): Promise<void> {
    const ready = await waitInputReady(ctx)
    if (ready === 'missing') throw new Error('地址输入框未出现（页面未渲染或站点改版）')
    if (ready === 'disabled') {
      // 逐一匹配全部限频关键词（与旧 recoverErrorText(LIMIT_KEYWORDS) 等价）
      let limitText = ''
      for (const kw of LIMIT_KEYWORDS) {
        if (await ctx.page.getByText(kw, { exact: false }).count() > 0) { limitText = kw; break }
      }
      if (limitText !== '') {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name, limitText }, '地址框禁用且出现限频提示，视为已领取 = 成功（重跑幂等）')
        await ctx.safeScreenshot('auralaunch-faucet-limit')
        return
      }
      const bodyText = await ctx.page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '')
      throw new Error(`地址输入框持续禁用且无限频提示（页面文本: ${bodyText.slice(0, 300)}）`)
    }
    const address = await ctx.account('metamask钱包地址')
    const addressInput = ctx.page.locator(ADDRESS_SELECTOR).first()
    await addressInput.fill(address)
    if (((await addressInput.inputValue().catch(() => '')) ?? '') !== address) {
      await addressInput.fill(address)
    }
    let resp: Response | null = null
    for (let attempt = 0; attempt <= RECLICK_MAX && !resp; attempt++) {
      const respPromise = waitFaucetResponse(ctx, address)
      await ctx.page.locator(REQUEST_BTN_SELECTOR).first().click()
      resp = await respPromise
      if (!resp && attempt < RECLICK_MAX) {
        ctx.log.warn({ step: 'faucet', window: ctx.profile.name, attempt: attempt + 1 }, '点击 Request 后未捕获领水请求（Turnstile 未就绪？），等待后补点')
        await ctx.page.waitForTimeout(RECLICK_WAIT_MS)
      }
    }
    if (resp) {
      const verdict = await judgeFaucetResponse(resp)
      if (verdict === 'success') {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '领水成功（tRPC success:true）')
        await ctx.safeScreenshot('auralaunch-faucet-success')
        return
      }
      if (verdict === 'limit') {
        ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '已达当日领取上限（24h 限频），视为已领取 = 成功（重跑幂等）')
        await ctx.safeScreenshot('auralaunch-faucet-limit')
        return
      }
      const envelope = unwrapTrpcEnvelope(await resp.json().catch(() => null))
      throw new Error(`领水请求被拒绝: ${envelope?.message ?? '未知原因（无信封）'}`.slice(0, 400))
    }
    const outcome = await waitUiOutcome(ctx)
    if (outcome === 'success') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '领水成功（页面成功文案）')
      await ctx.safeScreenshot('auralaunch-faucet-success')
      return
    }
    if (outcome === 'limit') {
      ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '页面出现限频提示，视为已领取 = 成功（重跑幂等）')
      await ctx.safeScreenshot('auralaunch-faucet-limit')
      return
    }
    const bodyText = await ctx.page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '')
    throw new Error(`点击 Request 后未出现成功/限频信号（页面文本: ${bodyText.slice(0, 300)}）`)
  }
}
```

> 说明：`ctx.captcha`/Turnstile 本任务不显式调用（观察需求未变）；`ctx.recover` 未强套（`waitInputReady` 的 enabled 语义与之不同），保持原自愈循环。

- [ ] **Step 2: 适配 `tests/auralaunch-faucet.test.ts`**

1. 删除 `human: { click: clicks }` → `human: {} as never`；假 `page.locator(sel).first()` 对**非地址选择器**补 `click: vi.fn(async () => clicks.push(sel))`。
2. `stubRunCapabilities(ctx)`：默认 run 用 `ctx.page.context().pages()` 与 `ctx.page.goto`，改为在假 page 上提供 `context: () => ({ pages: () => [{}] })`、`goto: vi.fn().mockResolvedValue(undefined)`；`ctx.screenshot` 仍 stub（`safeScreenshot` 内部调用它，断言 `ctx.screenshot).toHaveBeenCalledWith('auralaunch-faucet-success'/'auralaunch-faucet-limit')` 保持不变）。
3. 断言 `clicks` 的地方改为记录自 `page.locator().click` 的数组。
4. `waitInputReady`/`waitUiOutcome`/`judgeFaucetResponse`/`unwrapTrpcEnvelope`/`waitFaucetResponse` 单测不变（助 signature 不变）。
5. 主流程测试里 `new AuralaunchFaucetTask().run(ctx)` 仍调用 run（默认 run → action）。

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/auralaunch-faucet.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/auralaunch-faucet.ts tests/auralaunch-faucet.test.ts
git commit -m "refactor: auralaunch-faucet 改用 SiteTask/patchright 直调 + ctx.safeScreenshot"
```

- [ ] **Step 5: 真机验证（用户执行）**

`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=auralaunch-faucet npm run task:run`。

---

### Task 5: 全量回归与真机验证清单

**Files:** 无（验证）

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS（旧扁平方法仍在，其余任务未动，行为不变）

- [ ] **Step 2: 聚焦簇 A**

Run: `npx vitest run tests/arc-faucet.test.ts tests/shelby-faucet.test.ts tests/auralaunch-faucet.test.ts tests/task-context-namespaces.test.ts`
Expected: PASS

- [ ] **Step 3: 真机验证清单（用户执行）**

- `faucet-arc`：plain 窗口 + 已领/受限窗口各一
- `shelby-faucet`：APT/USD 两页各领
- `auralaunch-faucet`：正常领 + 已领（限频）各一
失败即按 AGENTS 规范停下带日志/截图求助。

---

## Self-Review

- **Spec coverage**：簇 A 三任务全部改为 `SiteTask` + `ctx.page` 直调 + `ctx.safeScreenshot` + `ctx.captcha.*`；`arc` 越层直引 `frame-find` 由 Task 1 的 `ctx.captcha.hasChallenge` 消除。其余簇 B/C、清理、文档、诊断面板在后续计划。
- **Placeholder scan**：无 TBD；三份任务文件为完整替换代码；测试为精确编辑说明（改哪些 stub/断言）。
- **Type consistency**：`ctx.captcha.hasChallenge(siteKeyExclude?)` 在 Task 1 定义、Task 2 消费；`ctx.safeScreenshot` 承接 `ctx.screenshot` 断言；`runClaimLoop`/`judgeFundResponse` 签名不变；`waitInputReady` 等签名不变。
- **风险**：测试的假 page 需支持默认 run 的 `context().pages()`/`goto` 与 `locator().click()`；实现者按 Step 2 逐条调整。真机行为必须由用户验证（Task 5）。

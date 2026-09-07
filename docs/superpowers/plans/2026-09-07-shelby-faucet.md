# Shelby 领水任务实施计划（shelby-apt-faucet / shelby-usd-faucet）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增两个 faucet 任务，按窗口从 accounts.xlsx「petra钱包地址」列取地址，在 Shelby 文档页各循环领取 APT / ShelbyUSD 最多 5 次（达当日上限提前退出视为成功）。

**Architecture:** 一个任务文件 `src/tasks/shelby-faucet.ts` 内放两个 SiteTask 子类（差异仅 meta），共用模块级函数 `judgeFundResponse`（响应体判定）与 `runClaimLoop`（领取循环）；成功/上限判定走领水接口响应体（`txn_hashes` 非空 / `UsageLimitExhausted`），不依赖页面文案。单测用注入假 page/human 的纯逻辑测试 + 真实 chromium + 本地 fixture + `page.route` 拦截的集成测试。

**Tech Stack:** TypeScript 严格模式、vitest、patchright（真实浏览器集成测试）、node:http 本地 fixture 服务。

**规格来源:** `docs/superpowers/specs/2026-09-07-shelby-faucet-design.md`

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、camelCase 命名、文件 kebab-case；文件头中文注释块说明模块职责
- 所有注释/文档/commit message 用中文；commit 风格 conventional（`feat:`/`test:` + 中文描述）
- 任务文件只经 `TaskContext` 使用引擎能力，不得直接 import `automation/`、`infrastructure/`、`integrations/`
- 限额约定（写死进代码注释）：`MAX_CLAIMS_PER_RUN = 5`（每币种 5 次 / 每窗口 IP 合计 10 次/天）
- 真机核实事实（2026-09-07）：输入框 `input[name="address"]`、按钮 `button:has-text("Fund")`、接口 `POST https://faucet.shelbynet.shelby.xyz/fund`（ShelbyUSD 带 `?asset=shelbyusd`）、成功 200 `{"txn_hashes":["..."]}`、上限 429 `{"error_code":"Rejected","rejection_reasons":[{"code":"UsageLimitExhausted"}]}`、全程无验证码
- 完成标准：`npm run typecheck` 与 `npm test` 全部通过
- 测试命令：`npx vitest run tests/shelby-faucet.test.ts`（单文件）；`npm test`（全量）

---

### Task 1: 任务文件 + 判定/循环纯逻辑 + 登记

**Files:**
- Create: `src/tasks/shelby-faucet.ts`
- Create: `tests/shelby-faucet.test.ts`
- Modify: `src/tasks/index.ts`

**Interfaces:**
- Consumes: `SiteTask`、`TaskContext`、`TaskMeta`（来自 `src/tasks/base.ts`）；`TaskContext` 构造参数（page/task/human/profile/cfg/logger/artifactsDir/walletPasswords，见 `src/engine/task-context.ts` 的 `TaskContextDeps`）
- Produces（后续任务依赖）:
  - `export interface FundResponse { txn_hashes?: string[]; message?: string; error_code?: string; rejection_reasons?: Array<{ reason?: string; code?: string }> }`
  - `export type FundVerdict = 'success' | 'limit' | 'rejected'`
  - `export function judgeFundResponse(body: FundResponse | null): FundVerdict`
  - `export async function runClaimLoop(ctx: TaskContext, address: string, maxClaims: number): Promise<{ claimed: number }>`
  - `export class ShelbyAptFaucetTask extends SiteTask`（meta.key `shelby-apt-faucet`）
  - `export class ShelbyUsdFaucetTask extends SiteTask`（meta.key `shelby-usd-faucet`）

- [ ] **Step 1: 写失败的单测（判定函数 + 领取循环）**

创建 `tests/shelby-faucet.test.ts`：

```ts
/**
 * Shelby 领水任务单测：判定函数与领取循环的纯逻辑分支（注入假 page/human，不连真浏览器）
 */
import { describe, it, expect, vi } from 'vitest'
import { judgeFundResponse, runClaimLoop, type FundResponse } from '../src/tasks/shelby-faucet'
import { TaskContext } from '../src/tasks/base'

/** 构造注入假依赖的 TaskContext（page/human 按需 mock，logger 用 vi.fn 可断言） */
function makeCtx(responses: FundResponse[] = []) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const queue = [...responses]
  const page = {
    locator: () => ({
      first: () => ({ inputValue: vi.fn().mockResolvedValue('0x1'), fill: vi.fn().mockResolvedValue(undefined) }),
    }),
    waitForResponse: vi.fn(() => Promise.resolve({ json: () => Promise.resolve(queue.shift() ?? null) })),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = new TaskContext({
    page: page as never,
    task: { meta: { key: 'shelby-apt-faucet', name: 'Shelby APT 领水', url: '' } },
    human: { click: vi.fn().mockResolvedValue(undefined) } as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: {},
  })
  return { ctx, log }
}

describe('judgeFundResponse 判定', () => {
  it('txn_hashes 非空 → success', () => {
    expect(judgeFundResponse({ txn_hashes: ['0xabc'] })).toBe('success')
  })

  it('UsageLimitExhausted → limit', () => {
    expect(
      judgeFundResponse({
        message: 'Request rejected by 1 checkers',
        error_code: 'Rejected',
        rejection_reasons: [{ reason: 'You have reached the maximum allowed number of requests per day: 10', code: 'UsageLimitExhausted' }],
        txn_hashes: [],
      }),
    ).toBe('limit')
  })

  it('其它拒绝原因 → rejected', () => {
    expect(judgeFundResponse({ error_code: 'Rejected', rejection_reasons: [{ code: 'SomeOtherReason' }], txn_hashes: [] })).toBe('rejected')
  })

  it('响应体为空 → rejected', () => {
    expect(judgeFundResponse(null)).toBe('rejected')
  })
})

describe('runClaimLoop 领取循环', () => {
  it('全部成功 → 领满 maxClaims 次，不抛错', async () => {
    const { ctx } = makeCtx(Array(5).fill({ txn_hashes: ['0xabc'] }))
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(5)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(5)
  })

  it('中途达上限 → 提前退出不抛错，claimed 为已成功次数', async () => {
    const { ctx, log } = makeCtx([
      { txn_hashes: ['0x1'] },
      { txn_hashes: ['0x2'] },
      { error_code: 'Rejected', rejection_reasons: [{ code: 'UsageLimitExhausted' }], txn_hashes: [] },
    ])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(2)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('上限'))).toBe(true)
  })

  it('首轮即达上限（0 次成功）→ 收敛为成功不抛错', async () => {
    const { ctx } = makeCtx([{ error_code: 'Rejected', rejection_reasons: [{ code: 'UsageLimitExhausted' }], txn_hashes: [] }])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(0)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(1)
  })

  it('其它拒绝 → 抛错（进失败重试）', async () => {
    const { ctx } = makeCtx([{ error_code: 'Rejected', rejection_reasons: [{ code: 'SomethingElse' }], txn_hashes: [] }])
    await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('被拒绝')
  })

  it('等待响应超时 → 抛错', async () => {
    const { ctx } = makeCtx([])
    ;(ctx.page.waitForResponse as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'))
    await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('等待 /fund 响应超时')
  })

  it('输入框为空时先回填地址再点击', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    let fillCount = 0
    const page = {
      locator: () => ({
        first: () => ({ inputValue: vi.fn().mockResolvedValue(''), fill: vi.fn().mockImplementation(() => { fillCount++ }) }),
      }),
      waitForResponse: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ txn_hashes: ['0x1'] }) })),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const ctx = new TaskContext({
      page: page as never,
      task: { meta: { key: 'shelby-apt-faucet', name: 'Shelby APT 领水', url: '' } },
      human: { click: vi.fn().mockResolvedValue(undefined) } as never,
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: log as never,
      artifactsDir: '',
      walletPasswords: {},
    })
    await runClaimLoop(ctx, '0x123', 1)
    expect(fillCount).toBe(1)
  })
})
```

- [ ] **Step 2: 运行单测确认失败**

Run: `npx vitest run tests/shelby-faucet.test.ts`
Expected: FAIL（`Failed to resolve import "../src/tasks/shelby-faucet"`）

- [ ] **Step 3: 实现任务文件**

创建 `src/tasks/shelby-faucet.ts`：

```ts
/**
 * Shelby 文档站领水任务（APT 与 ShelbyUSD，两个任务类共用一个领取循环）
 * 真机核实（2026-09-07，窗口 1/3）：
 *   文档页表单：input[name="address"]（placeholder Address）+ Fund 按钮；网络选择器默认 Shelbynet（不动）
 *   领水接口：POST https://faucet.shelbynet.shelby.xyz/fund（ShelbyUSD 带 ?asset=shelbyusd，由页面自身调用）
 *   成功：HTTP 200 txn_hashes 非空，页面出现 "Funding successful! View in explorer"
 *   达上限：HTTP 429 error_code=Rejected + rejection_reasons 含 UsageLimitExhausted
 *   （每币种 5 次/每窗口 IP 合计 10 次/天）
 *   全程无验证码；成功判定走接口响应（页面成功 toast 会累积，无法区分新旧）
 * 流程：打开页面 → 等表单就绪 → 数据源取「petra钱包地址」→ 清空并拟人键入
 *   → 循环最多 MAX_CLAIMS_PER_RUN 次「点 Fund → 等 /fund POST 响应 → 判定」，
 *   达上限提前退出视为成功（服务端计数天然幂等，重跑补领至上限即收敛）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// —— 站点元素（真机核实）——
/** 地址输入框（两个页面一致） */
const ADDRESS_SELECTOR = 'input[name="address"]'
/** 领取按钮（两个页面一致） */
const FUND_BUTTON_SELECTOR = 'button:has-text("Fund")'
/** 领水接口 URL 片段（限定 host：防御网络选择器残留 Local 的异常） */
const FUND_URL_PART = 'faucet.shelbynet.shelby.xyz/fund'
/** 每币种每日最多领取次数（与服务端限额约定一致：合计 10 次/天由两个任务各 5 次用满） */
const MAX_CLAIMS_PER_RUN = 5
/** 单次领取等待接口响应超时（毫秒） */
const FUND_WAIT_MS = 30000
/** 两次领取之间的拟人停顿（毫秒区间） */
const CLAIM_GAP_MIN_MS = 3000
const CLAIM_GAP_MAX_MS = 8000

/** /fund 响应体（成功与拒绝两种形态，真机核实） */
export interface FundResponse {
  txn_hashes?: string[]
  message?: string
  error_code?: string
  rejection_reasons?: Array<{ reason?: string; code?: string }>
}

/** 领取结果判定：success 成功 / limit 达当日上限 / rejected 其它拒绝 */
export type FundVerdict = 'success' | 'limit' | 'rejected'

/** 判定 /fund 响应体：txn_hashes 非空即成功；含 UsageLimitExhausted 即达上限；其余一律拒绝 */
export function judgeFundResponse(body: FundResponse | null): FundVerdict {
  if (body && Array.isArray(body.txn_hashes) && body.txn_hashes.length > 0) return 'success'
  const reasons = body?.rejection_reasons ?? []
  if (reasons.some((r) => r.code === 'UsageLimitExhausted')) return 'limit'
  return 'rejected'
}

/**
 * 领取循环：最多 maxClaims 次「点 Fund → 等 /fund POST 响应 → 判定」
 * - 成功计数并拟人停顿后继续；达上限提前退出（视为成功，重跑幂等）；其它拒绝抛错进失败重试
 * - 每轮点击前防御性校验输入框仍含地址（成功领取后页面可能清空表单），为空则回填
 * - 先注册 waitForResponse 再点击，避免响应早于等待注册；谓词限定 POST 方法与接口 host
 * @returns 实际成功领取次数（达上限提前退出时小于 maxClaims）
 */
export async function runClaimLoop(ctx: TaskContext, address: string, maxClaims: number): Promise<{ claimed: number }> {
  let claimed = 0
  for (let i = 0; i < maxClaims; i++) {
    const input = ctx.page.locator(ADDRESS_SELECTOR).first()
    const current = await input.inputValue().catch(() => '')
    if (current === '') await input.fill(address)
    const respPromise = ctx.page.waitForResponse((r) => r.url().includes(FUND_URL_PART) && r.request().method() === 'POST', {
      timeout: FUND_WAIT_MS,
    })
    await ctx.human.click(FUND_BUTTON_SELECTOR)
    let body: FundResponse | null = null
    try {
      const res = await respPromise
      body = (await res.json().catch(() => null)) as FundResponse | null
    } catch (e) {
      throw new Error(`第 ${i + 1} 次领取失败（等待 /fund 响应超时）: ${(e as Error).message}`)
    }
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

/** 领水任务公共流程（两个任务类共用）：不连钱包，地址取自数据源「petra钱包地址」列 */
async function runShelbyFaucet(ctx: TaskContext): Promise<void> {
  // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
  await ctx.closeOtherTabs()
  await ctx.goto()
  // 等表单就绪（输入框可见）
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  // 钱包地址按窗口从数据源读取（严格模式：缺行/缺列/空值即任务失败——数据没备齐不该硬跑）
  const address = await ctx.account('petra钱包地址')
  // 先清空防重试会话残留，再拟人逐键输入
  await ctx.page.locator(ADDRESS_SELECTOR).first().fill('')
  await ctx.typeInto(ADDRESS_SELECTOR, address)
  // 循环领取：最多 MAX_CLAIMS_PER_RUN 次，达上限提前退出（视为成功）
  const { claimed } = await runClaimLoop(ctx, address, MAX_CLAIMS_PER_RUN)
  ctx.log.info({ step: 'fund', window: ctx.profile.name, claimed }, '领水完成')
  // 成功截图留档（自动存档到 data/screenshots/<日期>/<窗口>/<任务>/）
  await ctx.screenshot('shelby-faucet-success')
}

/** APT 领水任务 */
export class ShelbyAptFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'shelby-apt-faucet',
    name: 'Shelby APT 领水',
    url: 'https://docs.shelby.xyz/apis/faucet/aptos',
    sourceUrl: 'https://docs.shelby.xyz/apis/faucet/aptos',
    note: '真机核实（2026-09-07）：文档页表单 input[name="address"] + Fund 按钮；接口 POST faucet.shelbynet.shelby.xyz/fund；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 error_code=Rejected + UsageLimitExhausted 即达上限，视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空（页面显示 Funding successful!，toast 累积不做判定）；网络选择器保持默认 Shelbynet（等待接口限定 host 兜底防御残留 Local）；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-07',
    enabled: true,
    // 不连钱包：只填地址，不配置 wallet
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 600 },
    captcha: { auto: true },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runShelbyFaucet(ctx)
  }
}

/** ShelbyUSD 领水任务 */
export class ShelbyUsdFaucetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'shelby-usd-faucet',
    name: 'Shelby ShelbyUSD 领水',
    url: 'https://docs.shelby.xyz/apis/faucet/shelbyusd',
    sourceUrl: 'https://docs.shelby.xyz/apis/faucet/shelbyusd',
    note: '真机核实（2026-09-07）：与 APT 领水同表单结构；接口 POST faucet.shelbynet.shelby.xyz/fund?asset=shelbyusd；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 UsageLimitExhausted 视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空；网络选择器保持默认 Shelbynet；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-07',
    enabled: true,
    timeoutSec: 300,
    retry: { max: 2, backoffSec: 600 },
    captcha: { auto: true },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runShelbyFaucet(ctx)
  }
}
```

- [ ] **Step 4: 运行单测确认通过**

Run: `npx vitest run tests/shelby-faucet.test.ts`
Expected: PASS（7 个用例全过）

- [ ] **Step 5: 登记任务**

修改 `src/tasks/index.ts`——在 import 区加一行、ALL 数组加两个实例：

```ts
import { InceptionDachainTask } from './inception-dachain'
import { PortalRhunaTask } from './portal-rhuna'
import { ShelbyAptFaucetTask, ShelbyUsdFaucetTask } from './shelby-faucet'

// 全部任务实例（每个任务一个单例，跨 API/队列共享状态）
const ALL: SiteTask[] = [new ExampleCheckinTask(), new FaucetExampleTask(), new MintExampleTask(), new InceptionDachainTask(), new PortalRhunaTask(), new ShelbyAptFaucetTask(), new ShelbyUsdFaucetTask()]
```

- [ ] **Step 6: 复跑单测 + 提交**

Run: `npx vitest run tests/shelby-faucet.test.ts`（Expected: PASS）
Commit:

```powershell
git add src/tasks/shelby-faucet.ts src/tasks/index.ts tests/shelby-faucet.test.ts
git commit -m "feat: 新增 Shelby 领水任务（APT/ShelbyUSD，循环领取与上限收敛）"
```

---

### Task 2: 集成测试（真实浏览器 + fixture + 路由拦截）

**Files:**
- Create: `tests/fixtures/shelby-faucet.html`
- Modify: `tests/shelby-faucet.test.ts`（追加集成测试 describe）

**Interfaces:**
- Consumes: Task 1 的 `ShelbyAptFaucetTask`、`TaskContext`（`accountRow` 依赖注入）、`Humanizer`（来自 `src/automation/humanize.ts`，测试层允许 import）
- Produces: 无新接口（验证任务 run() 全链路）

- [ ] **Step 1: 创建 fixture 页面**

创建 `tests/fixtures/shelby-faucet.html`（仿 `tests/fixtures/checkin.html`，点击 Fund 时向领水接口发 POST，由测试路由拦截）：

```html
<!doctype html>
<html>
<body>
  <input name="address" type="text" placeholder="Address" />
  <button>Fund</button>
  <script>
    document.querySelector('button').addEventListener('click', () => {
      fetch('https://faucet.shelbynet.shelby.xyz/fund', { method: 'POST' })
    })
  </script>
</body>
</html>
```

- [ ] **Step 2: 追加集成测试**

在 `tests/shelby-faucet.test.ts` 顶部 import 区改为：

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { judgeFundResponse, runClaimLoop, ShelbyAptFaucetTask, type FundResponse } from '../src/tasks/shelby-faucet'
import { TaskContext } from '../src/tasks/base'
import { Humanizer } from '../src/automation/humanize'
```

在文件末尾追加集成测试 describe：

```ts
describe('Shelby 领水任务集成（真实浏览器 + 本地 fixture + 路由拦截）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'shelby-faucet.html'), 'utf-8'))
    })
    await new Promise<void>((r) => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('run() 完整流程：填地址 → 循环领取 → 达上限提前退出视为成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      // 拦截领水接口：前 2 次成功、第 3 次达上限（验证提前退出收敛）
      let calls = 0
      await page.route('**/faucet.shelbynet.shelby.xyz/fund*', (route) => {
        calls++
        if (calls <= 2) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ txn_hashes: ['0xabc'] }) })
        }
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Request rejected by 1 checkers',
            error_code: 'Rejected',
            rejection_reasons: [{ reason: 'You have reached the maximum allowed number of requests per day: 10', code: 'UsageLimitExhausted' }],
            txn_hashes: [],
          }),
        })
      })
      const task = new ShelbyAptFaucetTask()
      task.meta.url = baseUrl
      const ctx = new TaskContext({
        page,
        task,
        human: new Humanizer(page),
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-faucet-test-artifacts'),
        walletPasswords: {},
        accountRow: { petra钱包地址: '0x835e' },
      })
      await task.run(ctx)
      expect(calls).toBe(3)
      expect(await page.locator('input[name="address"]').inputValue()).toBe('0x835e')
    } finally {
      await browser.close()
    }
  })
})
```

- [ ] **Step 3: 运行集成测试确认通过**

Run: `npx vitest run tests/shelby-faucet.test.ts`
Expected: PASS（8 个用例全过；集成用例约 10-20s，含拟人键入延迟）

- [ ] **Step 4: 提交**

```powershell
git add tests/shelby-faucet.test.ts tests/fixtures/shelby-faucet.html
git commit -m "test: Shelby 领水任务集成测试（真实浏览器 + 路由拦截）"
```

---

### Task 3: 全量验证与真机试跑

**Files:** 无代码改动（发现问题则修复后重新提交）

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无输出错误（`tsc --noEmit` 通过）

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过（含既有 30+ 测试文件，30s 超时内）

- [ ] **Step 3: 面板冒烟（不消耗额度）**

Run: `npm run dev` 后访问 Vite 面板「任务」页
Expected: 出现「Shelby APT 领水」与「Shelby ShelbyUSD 领水」两个卡片（category faucet 徽章、来源页、备注可见），默认开关为开

- [ ] **Step 4: 真机单窗口试跑（需用户确认，消耗该窗口当日额度）**

注意：此步骤会消耗指定窗口当日 10 次额度的一部分，执行前必须征得用户同意。窗口 4 的比特 ID 为 `e8d594dbd90d4f95a86f7d072a27c180`（accounts.xlsx 第 5 行）。

```powershell
$env:BITBROWSER_PROFILE_ID="e8d594dbd90d4f95a86f7d072a27c180"; $env:TASK_KEY="shelby-apt-faucet"; npm run task:run
$env:BITBROWSER_PROFILE_ID="e8d594dbd90d4f95a86f7d072a27c180"; $env:TASK_KEY="shelby-usd-faucet"; npm run task:run
```

Expected: 两个任务均 success；日志显示 5 次「领取成功」；`data/screenshots/<日期>/<窗口>/<任务key>/shelby-faucet-success.png` 截图出现 `Funding successful!`；面板看板两条运行记录

- [ ] **Step 5: 复跑收敛验证（可选，已消耗额度时）**

Run: 再次执行 Step 4 中任一命令
Expected: success；日志显示「已达当日领取上限，提前结束（视为成功）」且 0 次成功（验证幂等收敛路径）

- [ ] **Step 6: 上线收尾**

提示用户：面板「定时任务」建每日计划（建议 APT 任务在前、ShelbyUSD 在后，各每天一次，时区 Asia/Shanghai）。本步骤无代码改动，无需提交；若 Step 1-2 发现问题并修复，按 conventional 中文描述提交修复 commit。

---

## 自查记录（写计划后执行）

- **规格覆盖**：任务文件与登记（改动清单 1/2）→ Task 1；单测（改动清单 3）→ Task 1+2；真机验证计划 → Task 3 Step 4-5；typecheck/npm test → Task 3 Step 1-2。规格中「面板出现任务卡片」→ Task 3 Step 3。全部覆盖，无缺口。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；无「类似 Task N」引用。
- **类型一致性**：`FundResponse`/`FundVerdict`/`judgeFundResponse`/`runClaimLoop(ctx, address, maxClaims): Promise<{claimed: number}>` 在 Task 1 定义、Task 1/2 测试中一致使用；`MAX_CLAIMS_PER_RUN=5` 与集成测试期望 `calls === 3`（2 成功 + 1 上限提前退出）一致。

# Shelby 领水任务合并与提速实施计划（shelby-faucet rev2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 shelby-apt-faucet / shelby-usd-faucet 合并为单任务 `shelby-faucet`（一次开窗领两页各 5 次），落地补点重试、fill 直填、截图非致命化、短退避四项优化，并把任务级与全局并发上限提到 6。

**Architecture:** 重写 `src/tasks/shelby-faucet.ts`：单个 `ShelbyFaucetTask`（meta.key `shelby-faucet`）+ 模块级 `judgeFundResponse` / `runClaimLoop`（含响应超时补点）；地址用 `fill()` 直填替代 `typeInto`；成功截图 try/catch 非致命。测试：纯逻辑单测（补点路径、幂等收敛、孤儿 promise 回归）+ 真实浏览器集成测试（fixture 按路径决定 asset，路由拦截计数）。

**Tech Stack:** TypeScript 严格模式、vitest、patchright、node:http fixture、@libsql/client 不涉及。

**规格来源:** `docs/superpowers/specs/2026-09-07-shelby-faucet-rev2-design.md`

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、camelCase、文件 kebab-case；文件头中文注释块；注释/commit 用中文；commit conventional（feat:/test:/fix: + 中文）
- 任务文件只 import './base'，经 TaskContext 使用引擎能力
- 常量（写死进代码注释）：`MAX_CLAIMS_PER_RUN = 5`、`FUND_WAIT_MS = 10000`、`RECLICK_MAX = 1`、`CLAIM_GAP_MIN_MS = 1000`、`CLAIM_GAP_MAX_MS = 2000`
- meta 契约：key `shelby-faucet`、name `Shelby 领水`、concurrency 6、retry `{ max: 2, backoffSec: 120 }`、timeoutSec 300、不配 wallet、category `faucet`；类属性 `usdUrl = 'https://docs.shelby.xyz/apis/faucet/shelbyusd'`
- `config/config.json`：`execution.maxConcurrentWindows` 4 → 6
- 旧 key `shelby-apt-faucet` / `shelby-usd-faucet` 及其任务类彻底删除（index.ts 不再登记）
- 真机核实事实：选择器 `input[name="address"]` / `button:has-text("Fund")`；接口 `POST https://faucet.shelbynet.shelby.xyz/fund`（USD 加 `?asset=shelbyusd`）；成功 200 `{"txn_hashes":["..."]}`；上限 429 `error_code=Rejected` + `rejection_reasons[].code=UsageLimitExhausted`；无验证码
- 完成标准：`npm run typecheck` 与 `npm test` 全绿

---

### Task 1: 合并任务重写 + 单测 + 登记 + 并发配置

**Files:**
- Modify: `src/tasks/shelby-faucet.ts`（整体重写）
- Modify: `src/tasks/index.ts`
- Modify: `config/config.json`
- Modify: `tests/shelby-faucet.test.ts`（整体重写：单测部分）

**Interfaces:**
- Consumes: `SiteTask`/`TaskContext`/`TaskMeta`（`src/tasks/base.ts`）、`TaskContextDeps` 构造参数
- Produces（Task 2 依赖）:
  - `export interface FundResponse { txn_hashes?: string[]; message?: string; error_code?: string; rejection_reasons?: Array<{ reason?: string; code?: string }> }`
  - `export type FundVerdict = 'success' | 'limit' | 'rejected'`
  - `export function judgeFundResponse(body: FundResponse | null): FundVerdict`
  - `export async function runClaimLoop(ctx: TaskContext, address: string, maxClaims: number): Promise<{ claimed: number }>`（含超时补点）
  - `export class ShelbyFaucetTask extends SiteTask`（meta.key `shelby-faucet`；公开字段 `usdUrl: string` 默认 `'https://docs.shelby.xyz/apis/faucet/shelbyusd'`，集成测试可覆盖）

- [ ] **Step 1: 重写测试文件（先红）**

用以下完整内容覆盖 `tests/shelby-faucet.test.ts`：

```ts
/**
 * Shelby 领水任务（合并版）单测与集成测试：
 * - 单测：judgeFundResponse 判定与 runClaimLoop 循环的纯逻辑分支（注入假 page/human，不连真浏览器）
 * - 集成：真实 chromium + 本地 fixture + page.route 拦截，验证 run() 跨两页全链路
 */
import { describe, it, expect, vi } from 'vitest'
import { judgeFundResponse, runClaimLoop, ShelbyFaucetTask, type FundResponse } from '../src/tasks/shelby-faucet'
import { TaskContext } from '../src/tasks/base'

/** 假响应：仅含判定所需字段 */
function resp(body: FundResponse | null): { json: () => Promise<FundResponse | null> } {
  return { json: () => Promise.resolve(body) }
}

const SUCCESS_BODY = { txn_hashes: ['0xabc'] }
const LIMIT_BODY = {
  message: 'Request rejected by 1 checkers',
  error_code: 'Rejected',
  rejection_reasons: [{ reason: 'You have reached the maximum allowed number of requests per day: 10', code: 'UsageLimitExhausted' }],
  txn_hashes: [],
}
const REJECT_BODY = { error_code: 'Rejected', rejection_reasons: [{ code: 'SomethingElse' }], txn_hashes: [] }

/** 构造注入假依赖的 TaskContext：waitForResponse 依次返回队列中的值（null 表示超时） */
function makeCtx(responses: Array<{ json: () => Promise<unknown> } | null>, opts: { inputValue?: string } = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const queue = [...responses]
  const page = {
    locator: () => ({
      first: () => ({
        inputValue: vi.fn().mockResolvedValue(opts.inputValue ?? '0x1'),
        fill: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    waitForResponse: vi.fn(() => Promise.resolve(queue.shift() ?? null)),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = new TaskContext({
    page: page as never,
    task: { meta: { key: 'shelby-faucet', name: 'Shelby 领水', url: '' } },
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
    expect(judgeFundResponse(SUCCESS_BODY)).toBe('success')
  })

  it('UsageLimitExhausted → limit', () => {
    expect(judgeFundResponse(LIMIT_BODY)).toBe('limit')
  })

  it('其它拒绝原因 → rejected', () => {
    expect(judgeFundResponse(REJECT_BODY)).toBe('rejected')
  })

  it('响应体为空 → rejected', () => {
    expect(judgeFundResponse(null)).toBe('rejected')
  })
})

describe('runClaimLoop 领取循环', () => {
  it('全部成功 → 领满 maxClaims 次，不补点', async () => {
    const { ctx } = makeCtx(Array(5).fill(resp(SUCCESS_BODY)))
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(5)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(5)
    expect(ctx.human.click).toHaveBeenCalledTimes(5)
  })

  it('响应超时 → 补点一次后成功', async () => {
    const { ctx } = makeCtx([null, resp(SUCCESS_BODY)])
    const { claimed } = await runClaimLoop(ctx, '0x1', 1)
    expect(claimed).toBe(1)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(2)
    expect(ctx.human.click).toHaveBeenCalledTimes(2)
  })

  it('补点后仍超时 → 抛错（进失败重试）', async () => {
    const { ctx } = makeCtx([null, null])
    await expect(runClaimLoop(ctx, '0x1', 1)).rejects.toThrow('等待 /fund 响应超时')
    expect(ctx.human.click).toHaveBeenCalledTimes(2)
  })

  it('中途达上限 → 提前退出不抛错，claimed 为已成功次数', async () => {
    const { ctx, log } = makeCtx([resp(SUCCESS_BODY), resp(SUCCESS_BODY), resp(LIMIT_BODY)])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(2)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('上限'))).toBe(true)
  })

  it('首轮即达上限（0 次成功）→ 收敛为成功不抛错', async () => {
    const { ctx } = makeCtx([resp(LIMIT_BODY)])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(0)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(1)
  })

  it('其它拒绝 → 抛错', async () => {
    const { ctx } = makeCtx([resp(REJECT_BODY)])
    await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('被拒绝')
  })

  it('输入框为空 → 先回填地址再点击', async () => {
    const { ctx } = makeCtx([resp(SUCCESS_BODY)], { inputValue: '' })
    await runClaimLoop(ctx, '0x123', 1)
    const fillCalls = (ctx.page.locator('x').first().fill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fillCalls).toContain('0x123')
  })
})

describe('点击失败不产生孤儿 unhandledRejection', () => {
  it('human.click 抛错 → 立即上抛且无未处理拒绝', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    // 注意：waitForResponse 必须是普通函数返回裸 promise（vi.fn 会因 tinyspy 隐式挂 .then 而遮蔽 unhandledRejection）
    const page = {
      locator: () => ({
        first: () => ({ inputValue: vi.fn().mockResolvedValue('0x1'), fill: vi.fn().mockResolvedValue(undefined) }),
      }),
      waitForResponse: () => new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 10000ms exceeded')), 50)),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const ctx = new TaskContext({
      page: page as never,
      task: { meta: { key: 'shelby-faucet', name: 'Shelby 领水', url: '' } },
      human: { click: vi.fn().mockRejectedValue(new Error('点击失败: 找不到元素 button:has-text("Fund")')) } as never,
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: log as never,
      artifactsDir: '',
      walletPasswords: {},
    })
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('点击失败')
      await new Promise((r) => setTimeout(r, 200))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('ShelbyFaucetTask 元信息', () => {
  it('合并任务 meta 契约正确', () => {
    const t = new ShelbyFaucetTask()
    expect(t.meta.key).toBe('shelby-faucet')
    expect(t.meta.name).toBe('Shelby 领水')
    expect(t.meta.concurrency).toBe(6)
    expect(t.meta.retry?.backoffSec).toBe(120)
    expect(t.usdUrl).toBe('https://docs.shelby.xyz/apis/faucet/shelbyusd')
    expect(t.meta.category).toBe('faucet')
    expect(t.meta.enabled).toBe(true)
  })
})
```

- [ ] **Step 2: 运行单测确认失败（RED）**

Run: `npx vitest run tests/shelby-faucet.test.ts`
Expected: FAIL（`Failed to resolve import "ShelbyFaucetTask" from ...`——旧文件无此导出；集成测试 describe 尚未加回，文件可先只含单测）

- [ ] **Step 3: 重写任务文件**

用以下完整内容覆盖 `src/tasks/shelby-faucet.ts`：

```ts
/**
 * Shelby 文档站领水任务（合并版）：一次开窗领取 APT 与 ShelbyUSD 各最多 5 次
 * 真机核实（2026-09-07，窗口 1/3/4 与批量批次）：
 *   文档页表单：input[name="address"]（placeholder Address）+ Fund 按钮；网络选择器默认 Shelbynet（不动）
 *   领水接口：POST https://faucet.shelbynet.shelby.xyz/fund（ShelbyUSD 带 ?asset=shelbyusd，由页面自身调用）
 *   成功：HTTP 200 txn_hashes 非空，页面出现 "Funding successful! View in explorer"
 *   达上限：HTTP 429 error_code=Rejected + rejection_reasons 含 UsageLimitExhausted
 *   （每币种 5 次/每窗口 IP 合计 10 次/天）
 *   全程无验证码；成功判定走接口响应（页面成功 toast 会累积，无法区分新旧）
 * 实测坑（批量批次）：成功 toast 插入后布局位移，下一轮点击可能落空（请求未发出）——
 *   等响应超时后拟人补点一次自我纠正（残余风险：极慢响应下补点会多领一次，
 *   但达上限提前退出使任务自校正，最多造成两币种额度微偏）；任务自身截图
 *   偶发等字体加载超时，截图失败只告警不判任务失败
 * 流程：打开 APT 页 → 填地址 → 领 5 次 → 打开 USD 页 → 填地址 → 领 5 次，
 *   达上限提前退出视为成功（服务端计数天然幂等，重跑补领至上限即收敛）
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'

// —— 站点元素与接口（真机核实）——
/** 地址输入框（两个页面一致） */
const ADDRESS_SELECTOR = 'input[name="address"]'
/** 领取按钮（两个页面一致） */
const FUND_BUTTON_SELECTOR = 'button:has-text("Fund")'
/** 领水接口 URL 片段（限定 host：防御网络选择器残留 Local 的异常） */
const FUND_URL_PART = 'faucet.shelbynet.shelby.xyz/fund'
/** 每币种每日最多领取次数（与服务端限额约定一致：合计 10 次/天由两页各 5 次用满） */
const MAX_CLAIMS_PER_RUN = 5
/** 单次领取等待接口响应超时（毫秒，真机响应 1-3s；超时触发补点） */
const FUND_WAIT_MS = 10000
/** 响应超时后的补点次数上限（点击落空自我纠正，批量实测校准） */
const RECLICK_MAX = 1
/** 两次领取之间的拟人停顿（毫秒区间） */
const CLAIM_GAP_MIN_MS = 1000
const CLAIM_GAP_MAX_MS = 2000

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
 * 注册并等待一次 /fund POST 响应：注册即吞错（防孤儿 promise 触发进程级 unhandledRejection），
 * 超时返回 null；谓词限定 POST 方法与接口 host
 */
function waitFundResponse(ctx: TaskContext): Promise<Response | null> {
  return ctx.page
    .waitForResponse((r) => r.url().includes(FUND_URL_PART) && r.request().method() === 'POST', { timeout: FUND_WAIT_MS })
    .catch(() => null)
}

/**
 * 领取循环：最多 maxClaims 次「点 Fund → 等 /fund POST 响应 → 判定」
 * - 成功计数并拟人停顿后继续；达上限提前退出（视为成功，重跑幂等）；其它拒绝抛错进失败重试
 * - 响应超时（点击落空——成功 toast 插入后布局位移，真机实测）：拟人补点最多 RECLICK_MAX 次
 * - 每轮点击前防御性校验输入框仍含地址（页面可能清空表单），为空则回填
 * - 先注册 waitForResponse 再点击，避免响应早于等待注册
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
      await ctx.human.click(FUND_BUTTON_SELECTOR)
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

/** 领水任务公共流程：每页填地址 + 循环领取；不连钱包，地址取自数据源「petra钱包地址」列 */
async function runShelbyFaucet(ctx: TaskContext, usdUrl: string): Promise<void> {
  // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
  await ctx.closeOtherTabs()
  await ctx.goto()
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  // 钱包地址按窗口从数据源读取（严格模式：缺行/缺列/空值即任务失败——数据没备齐不该硬跑）
  const address = await ctx.account('petra钱包地址')
  // APT 页：fill 直填（等价粘贴，免逐键打字）
  await ctx.page.locator(ADDRESS_SELECTOR).first().fill(address)
  const apt = await runClaimLoop(ctx, address, MAX_CLAIMS_PER_RUN)
  ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'apt', claimed: apt.claimed }, 'APT 领水完成')
  // ShelbyUSD 页
  await ctx.goto(usdUrl)
  await ctx.assertVisible(ADDRESS_SELECTOR, 20000)
  await ctx.page.locator(ADDRESS_SELECTOR).first().fill(address)
  const usd = await runClaimLoop(ctx, address, MAX_CLAIMS_PER_RUN)
  ctx.log.info({ step: 'fund', window: ctx.profile.name, asset: 'shelbyusd', claimed: usd.claimed }, 'ShelbyUSD 领水完成')
  // 成功截图留档；截图偶发等字体加载超时（真机实测）——失败只告警，不判任务失败
  try {
    await ctx.screenshot('shelby-faucet-success')
  } catch (e) {
    ctx.log.warn({ step: 'fund', window: ctx.profile.name, err: (e as Error).message }, '成功截图失败（不影响任务结果）')
  }
}

/** Shelby 领水任务（合并版：APT + ShelbyUSD 各最多 5 次，一次开窗） */
export class ShelbyFaucetTask extends SiteTask {
  /** ShelbyUSD 文档页地址（独立于 meta.url，供集成测试覆盖为本地 fixture） */
  usdUrl = 'https://docs.shelby.xyz/apis/faucet/shelbyusd'

  meta: TaskMeta = {
    key: 'shelby-faucet',
    name: 'Shelby 领水',
    url: 'https://docs.shelby.xyz/apis/faucet/aptos',
    sourceUrl: ['https://docs.shelby.xyz/apis/faucet/aptos', 'https://docs.shelby.xyz/apis/faucet/shelbyusd'],
    note: '真机核实（2026-09-07）：两文档页表单一致（input[name="address"] + Fund 按钮）；接口 POST faucet.shelbynet.shelby.xyz/fund（USD 带 ?asset=shelbyusd）；限额每币种 5 次/每窗口 IP 合计 10 次/天（429 UsageLimitExhausted 视为成功提前退出，重跑幂等）；成功响应 txn_hashes 非空；成功 toast 插入会致下一轮点击偶发落空——响应超时自动补点一次；任务截图偶发等字体超时已非致命化；地址 fill 直填（等价粘贴）；网络选择器保持默认 Shelbynet；全程无验证码；不连钱包，地址取自数据源「petra钱包地址」列',
    category: 'faucet',
    lastUpdated: '2026-09-07',
    enabled: true,
    // 不连钱包：只填地址，不配置 wallet
    timeoutSec: 300,
    // 短退避：服务端计数幂等，重跑补领至上限即收敛
    retry: { max: 2, backoffSec: 120 },
    captcha: { auto: true },
    concurrency: 6,
  }

  async run(ctx: TaskContext): Promise<void> {
    await runShelbyFaucet(ctx, this.usdUrl)
  }
}
```

- [ ] **Step 4: 运行单测确认通过（GREEN）**

Run: `npx vitest run tests/shelby-faucet.test.ts`
Expected: PASS（13 个单测用例全过）

- [ ] **Step 5: 登记与并发配置**

修改 `src/tasks/index.ts`——import 区把两旧类换成新类、ALL 数组同步：

```ts
import { ShelbyFaucetTask } from './shelby-faucet'

// 全部任务实例（每个任务一个单例，跨 API/队列共享状态）
const ALL: SiteTask[] = [new ExampleCheckinTask(), new FaucetExampleTask(), new MintExampleTask(), new InceptionDachainTask(), new PortalRhunaTask(), new ShelbyFaucetTask()]
```

修改 `config/config.json`：`"maxConcurrentWindows": 4` → `"maxConcurrentWindows": 6`（其余不动）。

- [ ] **Step 6: 复跑单测 + 提交**

Run: `npx vitest run tests/shelby-faucet.test.ts`（Expected: PASS）；`npm run typecheck`（Expected: clean）
Commit:

```powershell
git add src/tasks/shelby-faucet.ts src/tasks/index.ts config/config.json tests/shelby-faucet.test.ts
git commit -m "feat: Shelby 领水任务合并提速（单任务两页领取、超时补点、fill 直填、并发 6）"
```

---

### Task 2: 集成测试更新（双页 fixture + 路由拦截）

**Files:**
- Modify: `tests/fixtures/shelby-faucet.html`
- Modify: `tests/shelby-faucet.test.ts`（追加集成测试 describe）

**Interfaces:**
- Consumes: Task 1 的 `ShelbyFaucetTask`（含 `usdUrl` 字段）、`TaskContext`（`accountRow` 注入）、`Humanizer`
- Produces: 无新接口

- [ ] **Step 1: 更新 fixture（按页面路径决定请求 asset）**

覆盖 `tests/fixtures/shelby-faucet.html`：

```html
<!doctype html>
<html>
<body>
  <input name="address" type="text" placeholder="Address" />
  <button>Fund</button>
  <script>
    document.querySelector('button').addEventListener('click', () => {
      const asset = location.pathname.includes('usd') ? '?asset=shelbyusd' : ''
      fetch('https://faucet.shelbynet.shelby.xyz/fund' + asset, { method: 'POST' })
    })
  </script>
</body>
</html>
```

- [ ] **Step 2: 追加集成测试 describe**

在 `tests/shelby-faucet.test.ts` 顶部 import 区改为：

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { judgeFundResponse, runClaimLoop, ShelbyFaucetTask, type FundResponse } from '../src/tasks/shelby-faucet'
import { TaskContext } from '../src/tasks/base'
import { Humanizer } from '../src/automation/humanize'
```

在文件末尾追加：

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

  it('run() 完整流程：APT 5 次 + USD 2 次成功后达上限提前退出收敛', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const calls: string[] = []
      let usdCount = 0
      await page.route('**/faucet.shelbynet.shelby.xyz/fund*', (route) => {
        const url = route.request().url()
        calls.push(url)
        if (url.includes('asset=shelbyusd')) {
          usdCount++
          if (usdCount <= 2) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ txn_hashes: ['0xusd'] }) })
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
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ txn_hashes: ['0xapt'] }) })
      })
      const task = new ShelbyFaucetTask()
      task.meta.url = baseUrl + '/aptos'
      task.usdUrl = baseUrl + '/usd'
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
      expect(calls.length).toBe(8)
      expect(calls.filter((u) => u.includes('asset=shelbyusd')).length).toBe(3)
      expect(await page.locator('input[name="address"]').inputValue()).toBe('0x835e')
    } finally {
      await browser.close()
    }
  }, 90000)
})
```

- [ ] **Step 3: 运行集成测试确认通过**

Run: `npx vitest run tests/shelby-faucet.test.ts`
Expected: PASS（14 个用例全过；集成用例约 30-60s，已显式 90s 超时）

- [ ] **Step 4: 提交**

```powershell
git add tests/shelby-faucet.test.ts tests/fixtures/shelby-faucet.html
git commit -m "test: Shelby 领水合并任务集成测试（双页路由拦截）"
```

---

### Task 3: 全量验证与真机试跑

**Files:** 无代码改动（发现问题则修复后重新提交）

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无输出错误

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过（既有 367 - 原集成 1 + 新集成 1 = 367 用例量级；含已知 task-context-scenarios 负载时序 flake，复跑确认）

- [ ] **Step 3: 注册冒烟（不消耗额度）**

Run: `npx tsx -e "import { loadTasks } from './src/tasks/index'; const k = [...loadTasks().keys()]; console.log(k.join(', ')); console.log('旧key已移除:', !k.includes('shelby-apt-faucet') && !k.includes('shelby-usd-faucet'), '| 新key:', k.includes('shelby-faucet'))"`
Expected: 任务列表含 `shelby-faucet`、不含两个旧 key

- [ ] **Step 4: 真机单窗口试跑（需用户确认，消耗窗口 5 当日 10/10 额度）**

窗口 5 比特 ID：`52b8efce7f1846d285cdf24f1137e367`（accounts.xlsx 第 6 行，当日未消耗）

```powershell
$env:BITBROWSER_PROFILE_ID="52b8efce7f1846d285cdf24f1137e367"; $env:TASK_KEY="shelby-faucet"; npm run task:run
```

Expected: success；日志依次「APT 领水完成 claimed 5」+「ShelbyUSD 领水完成 claimed 5」；单 run 完成两页

- [ ] **Step 5: 复跑收敛验证（同一窗口）**

Run: 再次执行 Step 4 命令
Expected: success；两页均「已达当日领取上限，提前结束（视为成功）」claimed 0（幂等收敛）

- [ ] **Step 6: 上线收尾**

提示用户：面板「定时任务」中引用旧 key 的计划改为 `shelby-faucet`；`npm run dev` 重启生效。无代码改动不提交；若 Step 1-2 发现问题并修复，按 conventional 中文描述提交。

---

## 自查记录（写计划后执行）

- **规格覆盖**：改动清单 1（任务重写）→ Task 1；清单 2（index.ts）→ Task 1 Step 5；清单 3（config.json 6）→ Task 1 Step 5；清单 4（单测+集成+fixture）→ Task 1/2；清单 5（运维提示+真机验证）→ Task 3。无缺口。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`waitFundResponse`（模块私有）、`runClaimLoop(ctx, address, maxClaims)`、`ShelbyFaucetTask.usdUrl` 在 Task 1 定义、Task 1/2 测试中一致使用；`RECLICK_MAX = 1` 与单测「补点后仍超时」期望 click 2 次一致；集成测试期望 calls 8（APT 5 + USD 2 成功 + 1 上限）与 USD 上限逻辑一致。

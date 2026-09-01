# WalletSession（窗口会话级钱包扩展检测）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在窗口会话内惰性检测「当前浏览器实例的钱包扩展是否加载成功」，按钱包类型缓存结果，扩展缺失时快速失败并交由任务重试重启窗口。

**Architecture:** 新增 `WalletSession`（automation 层，内存态、每窗口会话一个实例）提供 `ensureReady(type, adapter)`；WalletAdapter 契约增加 `extensionId/probePath/providerFlag` 供探测；window-runner 会话创建后注入 TaskContext；任务登录前经 `ctx.ensureWalletReady()` 调用。检测 = 页面主世界 provider 轮询（含钱包标识验证）+ CDP `Target.createTarget` 扩展页探测（顺带唤醒 MV3 后台）。

**Tech Stack:** TypeScript、patchright（CDP）、vitest。仓库规范：单测用中文用例名、fake page mock 直接字面量构造、`as never` 收窄类型。

## Global Constraints

- 依赖方向：tasks → engine → automation/integrations → infrastructure（`src/automation/wallet/*` 只能依赖 patchright 类型与 `./types`）
- 不持久化 WalletSession 状态（内存态、窗口会话级）；不改任何数据库表
- 现有时间参数沿用实测值：provider 轮询 10×6s（默认，测试可注入更短间隔）
- 提交风格：单行 `fix:/feat:/docs:/chore:` 前缀 + 简短描述；每任务一个 commit
- 测试命令：`npx vitest run <file>`；类型检查：`npm run typecheck`
- 运行环境：Windows PowerShell 5.1

---

### Task 1: WalletAdapter 探测契约（extensionId / probePath / providerFlag）

**Files:**
- Modify: `src/automation/wallet/types.ts:36-41`（WalletAdapter 接口）
- Modify: `src/automation/wallet/metamask.ts:19-22`（类字段区）
- Modify: `src/automation/wallet/petra.ts:9-12`（类字段区）
- Test: `tests/wallet.test.ts`（追加断言用例）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `WalletAdapter.extensionId: string`、`WalletAdapter.probePath: string`、`WalletAdapter.providerFlag: string`（后续任务 2/3 使用）

- [ ] **Step 1: 写失败测试**

`tests/wallet.test.ts` 末尾追加：

```ts
describe('WalletAdapter 探测契约', () => {
  it('内建适配器声明 extensionId / probePath / providerFlag（WalletSession 探测用）', () => {
    const mm = new MetaMaskAdapter()
    expect(mm.extensionId).toBe('nkbihfbeogaeaoehlefnkodbefgpgknn')
    expect(mm.probePath).toBe('home.html')
    expect(mm.providerFlag).toBe('isMetaMask')
    const pt = new PetraAdapter()
    expect(pt.extensionId.length).toBeGreaterThan(0)
    expect(pt.probePath).toBe('index.html')
    expect(pt.providerFlag).toBe('isPetra')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/wallet.test.ts`
Expected: FAIL（类型错误：extensionId 等属性不存在）

- [ ] **Step 3: 最小实现**

`src/automation/wallet/types.ts` 的 WalletAdapter 接口追加三个字段：

```ts
export interface WalletAdapter {
  key: string
  extensionUrlPatterns: string[]
  /** 扩展 ID：CDP 探测扩展页用（MetaMask = nkbihfbeogaeaoehlefnkodbefgpgknn，真机弹窗 URL 实证） */
  extensionId: string
  /** 扩展页探测路径（MetaMask home.html / Petra index.html） */
  probePath: string
  /** 页面 provider 标识字段：区分其它钱包注入的 window.ethereum（isMetaMask / isPetra） */
  providerFlag: string
  unlock?(popup: PopupPage, password: string): Promise<void>
  ensureConnected(popup: PopupPage): Promise<void>
}
```

`src/automation/wallet/metamask.ts` 类字段区（key 之后）追加：

```ts
  extensionId = 'nkbihfbeogaeaoehlefnkodbefgpgknn'
  probePath = 'home.html'
  providerFlag = 'isMetaMask'
```

`src/automation/wallet/petra.ts` 类字段区（key 之后）追加：

```ts
  extensionId = 'ejjladinnckdgjemekebdpeokbikhfci'
  probePath = 'index.html'
  providerFlag = 'isPetra'
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/wallet.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/wallet/types.ts src/automation/wallet/metamask.ts src/automation/wallet/petra.ts tests/wallet.test.ts
git commit -m "feat: wallet adapter probe contract (extensionId/probePath/providerFlag)"
```

---

### Task 2: WalletSession 探测 + 缓存

**Files:**
- Create: `src/automation/wallet/session.ts`
- Test: `tests/wallet-session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WalletAdapter.extensionId/probePath/providerFlag`
- Produces: `WalletSession` 类（构造 `(page: Page, opts?: { pollIntervalMs?: number })`）、`ensureReady(type: string, adapter: WalletAdapter): Promise<WalletReadyState>`、`WalletReadyState = 'ready' | 'missing'`（后续任务 3/4 使用）

- [ ] **Step 1: 写失败测试**

`tests/wallet-session.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { WalletSession } from '../src/automation/wallet/session'
import type { WalletAdapter } from '../src/automation/wallet/types'

/** 假 Page：evaluate 实现「按 flag 读 provider 标记」；context().newCDPSession 模拟 CDP 探测 */
function makeFakePage(opts: { providerOk?: boolean; cdpOk?: boolean; evaluateDelay?: number } = {}) {
  let evaluateCalls = 0
  const page = {
    __evaluateCalls: () => evaluateCalls,
    evaluate: vi.fn(async (fn: (flag: string) => boolean, flag: string) => {
      evaluateCalls++
      const delay = opts.evaluateDelay ?? 0
      if (delay > 0) {
        // 注入慢场景：前 delay 次返回 false，之后按 providerOk
        if (evaluateCalls <= delay) return false
      }
      return opts.providerOk !== false && flag === 'isMetaMask'
    }),
    waitForTimeout: vi.fn(async () => {}),
    context: () => ({
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async (method: string) => {
          if (method === 'Target.createTarget') {
            if (opts.cdpOk === false) throw new Error('no extension')
            return { targetId: 't-1' }
          }
          return {}
        }),
        detach: vi.fn(async () => {}),
      })),
    }),
  }
  return page
}

const adapter: WalletAdapter = {
  key: 'metamask',
  extensionUrlPatterns: [],
  extensionId: 'nkbihfbeogaeaoehlefnkodbefgpgknn',
  probePath: 'home.html',
  providerFlag: 'isMetaMask',
  ensureConnected: async () => {},
}

describe('WalletSession', () => {
  it('provider 已注入（isMetaMask=true）→ ready，且 CDP 探测作预热（不改变判定）', async () => {
    const page = makeFakePage({ providerOk: true, cdpOk: false })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    expect(await s.ensureReady('metamask', adapter)).toBe('ready')
  })

  it('provider 缺失且 CDP 探测失败 → missing', async () => {
    const page = makeFakePage({ providerOk: false, cdpOk: false })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    expect(await s.ensureReady('metamask', adapter)).toBe('missing')
  })

  it('provider 缺失但 CDP 探测成功（注入慢）→ 追加轮询后 ready', async () => {
    const page = makeFakePage({ providerOk: true, cdpOk: true, evaluateDelay: 2 })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    expect(await s.ensureReady('metamask', adapter)).toBe('ready')
  })

  it('同类型第二次调用命中缓存（不再探测）', async () => {
    const page = makeFakePage({ providerOk: true })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    await s.ensureReady('metamask', adapter)
    const before = page.__evaluateCalls()
    await s.ensureReady('metamask', adapter)
    expect(page.__evaluateCalls()).toBe(before)
  })

  it('不同类型独立探测互不影响（petra 缺失不影响 metamask ready）', async () => {
    const page = makeFakePage({ providerOk: true, cdpOk: false })
    const s = new WalletSession(page as never, { pollIntervalMs: 5 })
    const petra = { ...adapter, key: 'petra', providerFlag: 'isPetra' }
    expect(await s.ensureReady('metamask', adapter)).toBe('ready')
    expect(await s.ensureReady('petra', petra)).toBe('missing')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/wallet-session.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/automation/wallet/session.ts`：

```ts
/**
 * 钱包扩展会话检测（automation 层）：每窗口会话一个实例（window-runner 创建后注入）
 * 检测「当前浏览器实例的钱包扩展是否加载成功」——页面主世界 provider 轮询
 * （含钱包类型标识验证）+ CDP 扩展页探测（Target.createTarget，顺带唤醒 MV3 后台）；
 * 结果按钱包类型缓存，同会话复用（扩展状态不会中途改变；新会话必须重建实例）
 * 依赖方向：仅依赖 patchright 类型与 ./types，被 engine 层依赖
 */
import type { Page } from 'patchright'
import type { WalletAdapter } from './types'

/** 扩展加载检测结果：ready 已加载可响应 / missing 未加载（窗口重启才可能恢复） */
export type WalletReadyState = 'ready' | 'missing'

/** provider 轮询预算（注入实测 0-30s 随机，10×6s 兜底） */
const PROVIDER_POLL_ROUNDS = 10
const PROVIDER_POLL_INTERVAL_MS = 6000
/** provider 缺失但 CDP 探测成功（扩展已加载、注入慢）时的追加轮询 */
const PROVIDER_EXTRA_ROUNDS = 5

export class WalletSession {
  private states = new Map<string, WalletReadyState>()
  private readonly pollIntervalMs: number

  constructor(private page: Page, opts: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? PROVIDER_POLL_INTERVAL_MS
  }

  /** 首次调用时探测并缓存；后续同类型直接返回缓存 */
  async ensureReady(type: string, adapter: WalletAdapter): Promise<WalletReadyState> {
    const cached = this.states.get(type)
    if (cached) return cached
    const state = await this.probe(adapter)
    this.states.set(type, state)
    return state
  }

  /** provider 轮询：主世界读 window.ethereum 并验证钱包标识（4 参形式，与 TaskContext.js 一致） */
  private async providerPresent(adapter: WalletAdapter, rounds: number): Promise<boolean> {
    for (let i = 0; i < rounds; i++) {
      const ok = await this.page.evaluate((flag: string) => {
        const eth = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum
        return typeof eth !== 'undefined' && eth[flag] === true
      }, adapter.providerFlag, {}, false).catch(() => false)
      if (ok) return true
      await this.page.waitForTimeout(this.pollIntervalMs)
    }
    return false
  }

  /**
   * CDP 扩展页探测：Target.createTarget 打开扩展页（能创建即扩展已加载），
   * 打开动作同时唤醒 MV3 后台 service worker；结束后关闭目标与 CDP 会话（best-effort）
   */
  private async probeExtensionPage(adapter: WalletAdapter): Promise<boolean> {
    let session: { send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>; detach?(): Promise<void> } | null = null
    try {
      session = (await this.page.context().newCDPSession(this.page)) as never
      const res = await session.send('Target.createTarget', { url: `chrome-extension://${adapter.extensionId}/${adapter.probePath}` })
      const targetId = res?.targetId
      if (typeof targetId === 'string') {
        await session.send('Target.closeTarget', { targetId }).catch(() => {})
      }
      return true
    } catch {
      return false
    } finally {
      await session?.detach?.().catch(() => {})
    }
  }

  private async probe(adapter: WalletAdapter): Promise<WalletReadyState> {
    if (await this.providerPresent(adapter, PROVIDER_POLL_ROUNDS)) {
      // 已注入：CDP 探测仅作预热（失败不影响判定）
      await this.probeExtensionPage(adapter)
      return 'ready'
    }
    // provider 缺失：CDP 探测区分「扩展未加载」与「注入慢」；注入慢再追加轮询
    if (!(await this.probeExtensionPage(adapter))) return 'missing'
    return (await this.providerPresent(adapter, PROVIDER_EXTRA_ROUNDS)) ? 'ready' : 'missing'
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/wallet-session.test.ts`；`npm run typecheck`
Expected: 5/5 PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/wallet/session.ts tests/wallet-session.test.ts
git commit -m "feat: WalletSession per-window wallet extension load detection with type cache"
```

---

### Task 3: TaskContext.ensureWalletReady

**Files:**
- Modify: `src/engine/task-context.ts`（deps 增加 `walletSession?`；新增方法）
- Test: `tests/login-by-wallet.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `WalletSession/ensureReady/WalletReadyState`
- Produces: `TaskContextDeps.walletSession?: WalletSession`、`TaskContext.ensureWalletReady(): Promise<void>`（任务 5 使用）

- [ ] **Step 1: 写失败测试**

`tests/login-by-wallet.test.ts` 的 `makeCtx` 增加可选参数并在文件末尾追加 describe：

```ts
function makeCtx(walletPasswords: Record<string, string>, walletSession?: never): TaskContext {
  const reg = new WalletRegistry()
  reg.register(new MetaMaskAdapter())
  const task = new WalletTask()
  return new TaskContext({
    page: { context: () => ({}) } as never,
    task,
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: {} as never,
    artifactsDir: '',
    walletPasswords,
    wallets: reg,
    walletSession,
  })
}

describe('ensureWalletReady 扩展就绪检查', () => {
  it('会话报告 missing → 抛「扩展未加载」提示重启窗口', async () => {
    const session = { ensureReady: vi.fn().mockResolvedValue('missing') }
    const ctx = makeCtx({}, session as never)
    await expect(ctx.ensureWalletReady()).rejects.toThrow('钱包扩展未加载')
  })

  it('会话报告 ready → 正常通过', async () => {
    const session = { ensureReady: vi.fn().mockResolvedValue('ready') }
    const ctx = makeCtx({}, session as never)
    await expect(ctx.ensureWalletReady()).resolves.toBeUndefined()
  })

  it('未注入会话（脚本/旧装配兼容）→ 跳过检查不抛错', async () => {
    const ctx = makeCtx({})
    await expect(ctx.ensureWalletReady()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/login-by-wallet.test.ts`
Expected: FAIL（`ensureWalletReady` 不存在）

- [ ] **Step 3: 最小实现**

`src/engine/task-context.ts`：

1. 顶部 import 增加：`import type { WalletRegistry, PopupPage, WalletSession } from '../automation/wallet/types'` 改为两个 import（session 独立文件）：

```ts
import type { WalletRegistry, PopupPage } from '../automation/wallet/types'
import type { WalletSession } from '../automation/wallet/session'
```

2. TaskContextDeps 增加字段（accountRow 之后）：

```ts
  /** 窗口会话级钱包扩展检测（window-runner 每轮会话创建注入；未注入时 ensureWalletReady 跳过） */
  walletSession?: WalletSession
```

3. 类内新增方法（loginByWallet 之前）：

```ts
  /**
   * 钱包扩展就绪检查（会话级缓存）：任务登录流程前调用，扩展未加载时快速失败
   * （重试会重启浏览器窗口，扩展随之重载——真机实测重启即恢复）
   * 无 wallet 配置 / 未注入会话时跳过（脚本与测试兼容）
   * @throws 钱包注册表未注入 / 该类型钱包扩展未加载
   */
  async ensureWalletReady(): Promise<void> {
    const walletKey = this.deps.task.meta.wallet
    if (!walletKey) return
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const session = this.deps.walletSession
    if (!session) return
    const adapter = this.deps.wallets.get(walletKey)
    const state = await session.ensureReady(walletKey, adapter)
    if (state === 'missing') {
      throw new Error(`窗口 ${walletKey} 钱包扩展未加载（重试将重启浏览器窗口）`)
    }
  }
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/login-by-wallet.test.ts tests/wallet-session.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/task-context.ts tests/login-by-wallet.test.ts
git commit -m "feat: TaskContext.ensureWalletReady with session-level fast-fail"
```

---

### Task 4: window-runner 注入 WalletSession

**Files:**
- Modify: `src/engine/window-runner.ts`（runWindowTasks 创建 session；runTask 透传；TaskContext 构造）
- Test: `tests/windowRunner.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `WalletSession`、Task 3 的 `TaskContextDeps.walletSession`
- Produces: 每轮窗口会话一个 WalletSession 实例，注入该轮全部任务（任务 5 依赖）

- [ ] **Step 1: 写失败测试**

`tests/windowRunner.test.ts` 追加：

```ts
import { WalletSession } from '../src/automation/wallet/session'

class WalletProbeTask implements SiteTask {
  meta = { key: 'wallet-probe', name: 'WP', url: 'https://x.io', wallet: 'metamask' }
  run = vi.fn(async (ctx: TaskContext) => { await ctx.ensureWalletReady() })
}
```

需要先在文件头部 import `TaskContext`（当前只 import 了 SiteTask）：

```ts
import type { SiteTask } from '../src/tasks/base'
import { TaskContext } from '../src/tasks/base'
```

describe 内追加用例：

```ts
  it('WalletSession 注入任务：扩展缺失时任务快速失败（错误提示重启窗口）', async () => {
    const db = makeDb()
    // fake 页面：provider 缺失（evaluate 恒 false）、CDP 探测失败（newCDPSession reject）、
    // waitForTimeout 立即返回——完整探测路径在 mock 下瞬时完成
    const page = {
      ...okPage,
      evaluate: vi.fn().mockResolvedValue(false),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      context: () => ({ newCDPSession: vi.fn().mockRejectedValue(new Error('no extension')) }),
    }
    const task = new WalletProbeTask()
    const runner = makeRunner({
      db,
      tasks: new Map([['wallet-probe', task]]),
      driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }),
    })
    await runner.runWindowTasks(makeProfile(), ['wallet-probe'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map(c => c[4])).toEqual(['running', 'retry_wait'])
    expect(String(calls[1][5].error)).toContain('钱包扩展未加载')
    expect(task.run).toHaveBeenCalledTimes(1)
  })
```

注意：`wallet-probe` 任务需要 registry——window-runner 测试里 `wallets: null as never`，`ensureWalletReady` 先取 `deps.wallets`…… `walletSession` 已注入时会先 `get(walletKey)`——`wallets` 为 null 会抛「钱包注册表未注入」而不是走探测。因此 makeRunner 需能注入 registry：

`makeRunner` 的 over 增加 `wallets?: WalletRegistry`，装配处改为 `wallets: over.wallets ?? (null as never)`。用例传 `new WalletRegistry().register(new MetaMaskAdapter())`。相应 import `WalletRegistry`、`MetaMaskAdapter`。

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/windowRunner.test.ts`
Expected: FAIL（WalletSession 未注入 → ensureWalletReady 直接跳过 → statuses 为 success 而非 retry_wait）

- [ ] **Step 3: 最小实现**

`src/engine/window-runner.ts`：

1. import 增加：`import { WalletSession } from '../automation/wallet/session'`

2. `runWindowTasks` 中 CDP 连接成功、IP 探活通过之后（`const page = connected.page` 之后）创建：

```ts
      const page = connected.page
      // 窗口会话级钱包扩展检测：每轮会话一个实例（内存态，会话结束即丢弃；
      // 扩展状态随浏览器实例重置，新会话必须重建）
      const walletSession = new WalletSession(page)
```

3. `runTask` 签名增加参数 `walletSession: WalletSession`，TaskContext 构造处增加 `walletSession,`；调用点改为 `await this.runTask(profile, key, page, date, walletSession)`

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/windowRunner.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/window-runner.ts tests/windowRunner.test.ts
git commit -m "feat: window-runner creates WalletSession per window session and injects into tasks"
```

---

### Task 5: inception-dachain 接入（移除旧 ethereum 轮询）

**Files:**
- Modify: `src/tasks/inception-dachain.ts`（loginByMetaMask 开头替换检查；删除 ETH_POLL_* 常量）

**Interfaces:**
- Consumes: Task 3 的 `TaskContext.ensureWalletReady`
- Produces: 无新接口

- [ ] **Step 1: 写失败测试**

现有测试不覆盖登录流程内部（只测竞速辅助方法），本任务靠现有测试保持绿 + typecheck 验证常量删除无残留：

Run: `npx vitest run tests/inception-dachain.test.ts`
Expected: PASS（现状基线，删除后必须仍 PASS）

- [ ] **Step 2: 最小实现**

`src/tasks/inception-dachain.ts`：

1. 删除常量：

```ts
const ETH_POLL_ROUNDS = 10 // window.ethereum 注入轮询次数（并发实测 0-30s 随机）
const ETH_POLL_INTERVAL_MS = 6000 // 轮询间隔（总预算 60s）
```

2. `loginByMetaMask` 方法体替换开头（原 ethReady 块整段删除）：

```ts
  private async loginByMetaMask(ctx: TaskContext): Promise<boolean> {
    // 会话级钱包扩展就绪检查：provider 轮询（isMetaMask 验证）+ CDP 扩展页探测（预热），
    // 结果按类型缓存；扩展未加载时快速失败（重试将重启浏览器窗口，扩展随之重载）
    await ctx.ensureWalletReady()

    // Enter Inception → 登录方式选择弹窗（Get Started）→ 点 WALLET
    await ctx.clickCheckin('button:has-text("Enter Inception")', { assert: 'text=Get Started', assertTimeoutMs: GET_STARTED_WAIT_MS })
    await ctx.human.click('button:has-text("WALLET")')

    // AppKit 弹窗视图归一化：初始视图不固定（钱包列表 / 上次钱包 QR 页 / 列表收起），
    // 依次尝试 直接命中 → header-back 回退 → all-wallets 展开 → tab-browser 切换
    await ctx.assertVisible('[data-testid="w3m-modal-card"]', APP_KIT_MODAL_WAIT_MS)
    const entryFound = await this.normalizeAppKit(ctx)
    if (!entryFound) throw new Error('AppKit 弹窗未出现 MetaMask 入口（弹窗视图异常，归一化未命中）')

    await ctx.human.click(METAMASK_ENTRY)

    // 钱包弹窗 → 解锁 → 确认连接；已授权过站点的窗口可能不再弹弹窗（静默连接），
    // 弹窗未出现不立即判失败，交给后面的左侧目录判定；
    // 8s 内未出现则补点一次入口（AppKit 动画未稳定时首次点击可能不注册）
    try {
      await ctx.loginByWallet({ reclick: { selector: METAMASK_ENTRY, afterMs: 8000 } })
      return false
    } catch (e) {
      if ((e as Error).message.includes('钱包弹窗未出现')) return true
      throw e
    }
  }
```

（原方法中「扩展注入判定：弹窗归一化耗时已并行覆盖大部分轮询窗口…」注释段一并删除）

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/inception-dachain.test.ts tests/login-by-wallet.test.ts tests/wallet-session.test.ts tests/windowRunner.test.ts`；`npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/inception-dachain.ts
git commit -m "feat: inception-dachain uses session-level ensureWalletReady (remove per-task ethereum poll)"
```

---

### Task 6: 全量回归 + 收尾

**Files:**
- Modify: 无（若设计文档需要补实施记录，更新 `docs/superpowers/specs/2026-09-01-wallet-session-design.md` 状态行）

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS（250+ 新增用例全绿）

- [ ] **Step 2: 更新设计文档状态**

`docs/superpowers/specs/2026-09-01-wallet-session-design.md` 顶部 `状态：设计已确认（尚未实施代码）` 改为 `状态：已实施（2026-09-01，见 commit 记录）；真机验证待用户窗口运行确认`

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-09-01-wallet-session-design.md
git commit -m "docs: mark wallet-session design as implemented"
```

- [ ] **Step 4: 真机验证指引（用户执行，不属本计划任务）**

由用户在其真实环境重启服务后观察：历史「扩展未加载」类窗口（如 63/96/97）应快速失败并带明确错误「钱包扩展未加载」；正常窗口登录流程不受影响（provider 就绪时探测耗时 ~1-2s）。

---

## Self-Review

- **Spec coverage**：三态缓存（Task 2 缓存测试）、三级检测（Task 2 的 provider 轮询 + CDP 探测 + 已有补点保留在任务内）、多钱包分桶（Task 2 独立探测测试 + Task 1 契约）、生命周期（Task 4 每会话创建 + 内存态）、集成点（Task 3/4/5）、失败语义（Task 3 抛错文案、Task 4 注入测试）、边界（未注入跳过、复用窗口重建=新会话自然重检）——均已覆盖。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency**：`WalletReadyState` 定义于 Task 2 并在 Task 3 使用；`ensureReady(type, adapter)` 签名跨任务一致；`walletSession?` deps 字段 Task 3 定义、Task 4 赋值；`extensionId/probePath/providerFlag` Task 1 定义、Task 2 使用。

# 任务通用化封装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 inception-dachain 沉淀的站点无关模式下沉为全局能力（TaskContext 通用页面工具 + AppKit 钱包登录封装），任务瘦身为站点特有部分，行为保持等价。

**Architecture:** TaskContext（src/engine/task-context.ts）新增 `raceTexts/visible/waitGoneOrHidden/waitForTextWithReloads/detectPageState` 五个通用方法；新增 `src/engine/appkit.ts` 的 `openAppKitWallet` 函数并由 TaskContext 方法委托暴露；inception-dachain.ts 删除已下沉的私有实现改为调用。纯后端任务层改动，前端/DB/调度不动。

**Tech Stack:** TypeScript、patchright、vitest（fake page 字面量 mock + `as never`）。

## Global Constraints

- 依赖方向：tasks → engine → automation/integrations → infrastructure；appkit.ts 与 task-context.ts 互引时 appkit 只用 `import type`（运行时无环）
- 等价变换：时间/次数参数值一律不改（仅搬移位置）；已验证的行为语义（竞速、归一化、补点、静默连接容忍）保持不变
- 默认参数与现任务常量一致：modalWaitMs 45000 / normalizeRounds 5 / roundSleepMs 3000 / reclickAfterMs 8000；detectPageState rounds 10 / roundWaitMs 15000 / reloadTimeoutMs 45000；waitForTextWithReloads rounds 默认 0 / roundWaitMs 默认 30000
- 提交风格：单行 `feat:/fix:/docs:/chore:` 前缀
- 测试命令：`npx vitest run <file>`、`npm run typecheck`、`npm test`
- 运行环境：Windows PowerShell 5.1；工作目录 `D:\StudySpace\AutoBitControl`，直接提交 `develop` 分支

---

### Task 1: TaskContext 通用页面工具

**Files:**
- Modify: `src/engine/task-context.ts`（类内新增五个方法）
- Test: `tests/task-context-generic.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `waitForText/textPresent/page.reload/page.locator`
- Produces: `TaskContext.raceTexts<K extends string>(entries: Array<[K, string]>, timeoutMs): Promise<K | null>`、`visible(selector): Promise<boolean>`、`waitGoneOrHidden(selector, timeoutMs): Promise<void>`、`waitForTextWithReloads(text, opts): Promise<boolean>`、`detectPageState(opts): Promise<'loggedIn' | 'landing'>`（Task 2/3 消费）

- [ ] **Step 1: 写失败测试**

`tests/task-context-generic.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { TaskContext } from '../src/engine/task-context'
import type { SiteTask, TaskMeta } from '../src/tasks/base'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake', name: '假任务', url: '' }
  async run(_ctx: TaskContext) {}
}

/** 假页面：textDelays 按文案配置出现时机（<0 永不出现）；reload 计数；locator 可控可见性 */
function makeFakePage(textDelays: Record<string, number>, opts: { count?: number; visible?: boolean } = {}) {
  let reloads = 0
  return {
    __reloads: () => reloads,
    getByText: (text: string) => ({
      first: () => ({
        waitFor: ({ timeout }: { timeout: number }) => new Promise<void>((resolve, reject) => {
          const delay = textDelays[text]
          if (delay === undefined || delay < 0) setTimeout(() => reject(new Error(`等待文案超时: ${text}`)), timeout)
          else setTimeout(resolve, delay)
        }),
      }),
    }),
    locator: () => ({
      first: () => ({
        count: async () => opts.count ?? 0,
        isVisible: async () => opts.visible ?? true,
      }),
    }),
    waitForTimeout: vi.fn(async () => {}),
    reload: vi.fn(async () => { reloads++ }),
  }
}

function makeCtx(page: ReturnType<typeof makeFakePage>): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new FakeTask(),
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('TaskContext 通用页面工具', () => {
  it('raceTexts：任一文案出现返回其键', async () => {
    const ctx = makeCtx(makeFakePage({ '量子箱': 100 }))
    expect(await ctx.raceTexts([['a', '量子箱'], ['b', '永不出现']], 1000)).toBe('a')
  })

  it('raceTexts：全部不出现 → null', async () => {
    const ctx = makeCtx(makeFakePage({}))
    expect(await ctx.raceTexts([['a', 'x']], 200)).toBeNull()
  })

  it('visible：count 0 / isVisible false / 异常均按不可见', async () => {
    expect(await makeCtx(makeFakePage({}, { count: 0 })).visible('s')).toBe(false)
    expect(await makeCtx(makeFakePage({}, { count: 1, visible: false })).visible('s')).toBe(false)
    expect(await makeCtx(makeFakePage({}, { count: 1, visible: true })).visible('s')).toBe(true)
  })

  it('waitGoneOrHidden：元素不存在立即返回', async () => {
    const ctx = makeCtx(makeFakePage({}, { count: 0 }))
    const start = Date.now()
    await ctx.waitGoneOrHidden('s', 2000)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('waitGoneOrHidden：一直可见则等满超时', async () => {
    const ctx = makeCtx(makeFakePage({}, { count: 1, visible: true }))
    const start = Date.now()
    await ctx.waitGoneOrHidden('s', 300)
    expect(Date.now() - start).toBeGreaterThanOrEqual(300)
  })

  it('waitForTextWithReloads：被动期出现 → true 且不刷新', async () => {
    const page = makeFakePage({ '目录栏': 100 })
    const ctx = makeCtx(page)
    expect(await ctx.waitForTextWithReloads('目录栏', { passiveMs: 1000, rounds: 2, roundWaitMs: 500 })).toBe(true)
    expect(page.reload).not.toHaveBeenCalled()
  })

  it('waitForTextWithReloads：全部超时 → false 且按轮数刷新', async () => {
    const page = makeFakePage({})
    const ctx = makeCtx(page)
    expect(await ctx.waitForTextWithReloads('目录栏', { passiveMs: 100, rounds: 2, roundWaitMs: 200 })).toBe(false)
    expect(page.reload).toHaveBeenCalledTimes(2)
  })

  it('detectPageState：已登录文案先出现 → loggedIn', async () => {
    const ctx = makeCtx(makeFakePage({ '目录栏': 80, '进入': 160 }))
    expect(await ctx.detectPageState({ loggedInText: '目录栏', landingText: '进入', waitMs: 1000 })).toBe('loggedIn')
  })

  it('detectPageState：未登录文案先出现 → landing', async () => {
    const ctx = makeCtx(makeFakePage({ '目录栏': 160, '进入': 80 }))
    expect(await ctx.detectPageState({ loggedInText: '目录栏', landingText: '进入', waitMs: 1000 })).toBe('landing')
  })

  it('detectPageState：都不出现则刷新重试后抛错（含两个文案）', async () => {
    const page = makeFakePage({})
    const ctx = makeCtx(page)
    await expect(ctx.detectPageState({ loggedInText: '目录栏', landingText: '进入', waitMs: 100, rounds: 2, roundWaitMs: 100 }))
      .rejects.toThrow('目录栏 或 进入')
    expect(page.reload).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/task-context-generic.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 最小实现**

`src/engine/task-context.ts` 类内（`waitForGone` 方法之后、`closeModal` 之前）新增：

```ts
  /** 多文案竞速：任一出现返回其键，都等不到返回 null（通用竞速等待） */
  async raceTexts<K extends string>(entries: Array<[K, string]>, timeoutMs: number): Promise<K | null> {
    const r = await Promise.race(entries.map(([k, text]) => this.waitForText(text, timeoutMs).then(() => k).catch(() => null)))
    return r ?? null
  }

  /** 元素是否可见（任何异常按不可见处理） */
  async visible(selector: string): Promise<boolean> {
    try {
      const loc = this.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }

  /** 等元素消失或隐藏（元素从未出现视为已消失；最多 timeoutMs） */
  async waitGoneOrHidden(selector: string, timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try {
        const loc = this.page.locator(selector).first()
        if ((await loc.count()) === 0) return
        if (!(await loc.isVisible().catch(() => false))) return
      } catch {
        return
      }
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * 等文案出现 + 刷新兜底：先被动等 passiveMs，再最多 rounds 轮刷新（每轮等 roundWaitMs）
   * @returns 出现 true / 全部超时 false
   */
  async waitForTextWithReloads(
    text: string,
    opts: { passiveMs: number; rounds?: number; roundWaitMs?: number; reloadTimeoutMs?: number },
  ): Promise<boolean> {
    const waitFor = async (ms: number): Promise<boolean> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await this.textPresent(text)) return true
        await this.page.waitForTimeout(5000)
      }
      return false
    }
    if (await waitFor(opts.passiveMs)) return true
    for (let round = 0; round < (opts.rounds ?? 0); round++) {
      await this.page.reload({ timeout: opts.reloadTimeoutMs ?? 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
      if (await waitFor(opts.roundWaitMs ?? 30000)) return true
    }
    return false
  }

  /**
   * 登录状态竞速判定：已登录文案 / 未登录文案谁先出现；都不出现则刷新重试
   * （已登录窗口误入登录分支时，仪表盘永远不出现未登录文案——假报网络异常的根因修复）
   * @throws 多轮刷新后两者均未出现
   */
  async detectPageState(opts: {
    loggedInText: string
    landingText: string
    waitMs: number
    rounds?: number
    roundWaitMs?: number
    reloadTimeoutMs?: number
  }): Promise<'loggedIn' | 'landing'> {
    const race = async (ms: number): Promise<'loggedIn' | 'landing' | null> =>
      this.raceTexts([['loggedIn', opts.loggedInText], ['landing', opts.landingText]], ms)
    let state = await race(opts.waitMs)
    for (let i = 0; i < (opts.rounds ?? 10) && !state; i++) {
      await this.page.reload({ timeout: opts.reloadTimeoutMs ?? 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
      state = await race(opts.roundWaitMs ?? 15000)
    }
    if (!state) throw new Error(`多次刷新后仍未出现 ${opts.loggedInText} 或 ${opts.landingText}（网络异常）`)
    return state
  }
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/task-context-generic.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/task-context.ts tests/task-context-generic.test.ts
git commit -m "feat: TaskContext generic page helpers (raceTexts/visible/waitGoneOrHidden/waitForTextWithReloads/detectPageState)"
```

---

### Task 2: AppKit 登录封装

**Files:**
- Create: `src/engine/appkit.ts`
- Modify: `src/engine/task-context.ts`（import + 委托方法）
- Test: `tests/appkit.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ctx.visible / ctx.assertVisible / ctx.human.click / ctx.page.waitForTimeout / ctx.loginByWallet`
- Produces: `AppKitLoginOptions` 接口与 `openAppKitWallet(ctx, opts): Promise<boolean>`（popupFailed）；`TaskContext.openAppKitWallet(opts)` 委托方法（Task 3 消费）

- [ ] **Step 1: 写失败测试**

`tests/appkit.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { openAppKitWallet, type AppKitLoginOptions } from '../src/engine/appkit'

const OPTS: AppKitLoginOptions = {
  walletKey: 'metamask',
  openSelector: 'button:has-text("WALLET")',
  entryTestId: 'wallet-selector-io.metamask',
}

/** 假 ctx：visible 按可见集合判定；归一化点击记录在 human.click */
function makeCtx(over: Partial<Record<'visible', (sel: string) => boolean>> = {}) {
  const visibleSel = new Set<string>()
  const visible = over.visible ?? ((sel: string) => visibleSel.has(sel))
  const click = vi.fn(async (sel: string) => {
    // 模拟归一化点击的效果：点 header-back → 入口出现
    if (sel === '[data-testid="header-back"]') visibleSel.add(`[data-testid="${OPTS.entryTestId}"]`)
    if (sel === '[data-testid="all-wallets"]') visibleSel.add(`[data-testid="${OPTS.entryTestId}"]`)
    if (sel === '[data-testid="tab-browser"]') visibleSel.add(`[data-testid="${OPTS.entryTestId}"]`)
  })
  const ctx = {
    human: { click },
    assertVisible: vi.fn().mockResolvedValue(undefined),
    visible: vi.fn(async (sel: string) => visible(sel)),
    page: { waitForTimeout: vi.fn().mockResolvedValue(undefined) },
    loginByWallet: vi.fn().mockResolvedValue(undefined),
  }
  return { ctx: ctx as never, click, visibleSel, setVisible: (sel: string, v: boolean) => (v ? visibleSel.add(sel) : visibleSel.delete(sel)) }
}

describe('openAppKitWallet 登录封装', () => {
  it('入口直接可见 → 点击入口 + 弹窗连接，返回 false', async () => {
    const { ctx, click, setVisible } = makeCtx()
    setVisible(`[data-testid="${OPTS.entryTestId}"]`, true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
    expect(click).toHaveBeenCalledWith(OPTS.openSelector)
    expect(click).toHaveBeenCalledWith(`[data-testid="${OPTS.entryTestId}"]`)
    expect((ctx as never as { loginByWallet: ReturnType<typeof vi.fn> }).loginByWallet).toHaveBeenCalledWith({ reclick: { selector: `[data-testid="${OPTS.entryTestId}"]`, afterMs: 8000 } })
  })

  it('QR 视图（header-back）→ 回退后命中入口', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible('[data-testid="header-back"]', true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
  })

  it('列表收起（all-wallets）→ 展开后命中入口', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible('[data-testid="all-wallets"]', true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
  })

  it('tab-browser 切换 → 命中入口', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible('[data-testid="tab-browser"]', true)
    expect(await openAppKitWallet(ctx, OPTS)).toBe(false)
  })

  it('归一化轮数耗尽仍未命中 → 抛错', async () => {
    const { ctx } = makeCtx()
    await expect(openAppKitWallet(ctx, OPTS)).rejects.toThrow('AppKit 弹窗未出现 metamask 钱包入口')
  })

  it('钱包弹窗未出现 → 返回 true（静默连接容忍）；其它错误继续抛出', async () => {
    const { ctx, setVisible } = makeCtx()
    setVisible(`[data-testid="${OPTS.entryTestId}"]`, true)
    const loginByWallet = ctx as never as { loginByWallet: ReturnType<typeof vi.fn> }
    loginByWallet.mockRejectedValueOnce(new Error('钱包弹窗未出现'))
    expect(await openAppKitWallet(ctx, OPTS)).toBe(true)
    loginByWallet.mockRejectedValueOnce(new Error('其它错误'))
    await expect(openAppKitWallet(ctx, OPTS)).rejects.toThrow('其它错误')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/appkit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/engine/appkit.ts`：

```ts
/**
 * AppKit 钱包登录流程封装（engine 层）：站点页面内 AppKit（Reown）弹窗的打开、
 * 视图归一化与钱包入口点击。真机实测沉淀：AppKit 弹窗初始视图不固定
 * （钱包列表 / 上次钱包 QR 页 / 列表收起），直接等入口会误判失败。
 * 依赖方向：仅 import type TaskContext（运行时无环），被 task-context 委托调用
 */
import type { TaskContext } from './task-context'

export interface AppKitLoginOptions {
  /** 钱包类型（与 WalletAdapter.key 对应，弹窗连接时取适配器） */
  walletKey: string
  /** 站点页面上「打开 AppKit 弹窗」的按钮（如 button:has-text("WALLET")） */
  openSelector: string
  /** 钱包入口 data-testid（如 wallet-selector-io.metamask） */
  entryTestId: string
  /** 弹窗容器 testid（默认 w3m-modal-card） */
  modalTestId?: string
  /** 弹窗出现等待（默认 45000，高负载渲染慢放宽） */
  modalWaitMs?: number
  /** 视图归一化轮数（默认 5） */
  normalizeRounds?: number
  /** 每轮归一化后停顿（默认 3000） */
  roundSleepMs?: number
  /** 弹窗未出现时补点入口的间隔（默认 8000） */
  reclickAfterMs?: number
}

/**
 * 打开站点 AppKit 弹窗 → 视图归一化 → 点钱包入口 → 钱包弹窗解锁/连接
 * @returns popupFailed：钱包弹窗未出现（静默连接容忍，调用方结合登录态判定）
 * @throws 弹窗未出现 / 归一化轮数耗尽未找到入口 / 钱包连接其它错误
 */
export async function openAppKitWallet(ctx: TaskContext, opts: AppKitLoginOptions): Promise<boolean> {
  await ctx.human.click(opts.openSelector)
  await ctx.assertVisible(`[data-testid="${opts.modalTestId ?? 'w3m-modal-card'}"]`, opts.modalWaitMs ?? 45000)
  const entry = `[data-testid="${opts.entryTestId}"]`
  let found = false
  for (let i = 0; i < (opts.normalizeRounds ?? 5) && !found; i++) {
    if (await ctx.visible(entry)) {
      found = true
      break
    }
    if (await ctx.visible('[data-testid="header-back"]')) {
      await ctx.human.click('[data-testid="header-back"]')
    } else if (await ctx.visible('[data-testid="all-wallets"]')) {
      await ctx.human.click('[data-testid="all-wallets"]')
    } else if (await ctx.visible('[data-testid="tab-browser"]')) {
      await ctx.human.click('[data-testid="tab-browser"]')
    }
    await ctx.page.waitForTimeout(opts.roundSleepMs ?? 3000)
  }
  if (!found) throw new Error(`AppKit 弹窗未出现 ${opts.walletKey} 钱包入口（弹窗视图异常，归一化未命中）`)
  await ctx.human.click(entry)
  try {
    await ctx.loginByWallet({ reclick: { selector: entry, afterMs: opts.reclickAfterMs ?? 8000 } })
    return false
  } catch (e) {
    if ((e as Error).message.includes('钱包弹窗未出现')) return true
    throw e
  }
}
```

`src/engine/task-context.ts`：

1. import 区追加：`import { openAppKitWallet as runAppKitLogin, type AppKitLoginOptions } from './appkit'`
2. 类内（ensureWalletReady 之后）新增委托方法：

```ts
  /**
   * AppKit 钱包登录（站点页内 AppKit 弹窗打开 + 视图归一化 + 入口点击 + 钱包弹窗连接）
   * 真机实测：AppKit 初始视图不固定，此封装集中处理归一化与补点
   * @returns popupFailed：钱包弹窗未出现（静默连接容忍，调用方结合登录态判定）
   */
  async openAppKitWallet(opts: AppKitLoginOptions): Promise<boolean> {
    return runAppKitLogin(this, opts)
  }
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/appkit.test.ts tests/task-context-generic.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/appkit.ts src/engine/task-context.ts tests/appkit.test.ts
git commit -m "feat: AppKit wallet login wrapper (modal normalization + entry click + reclick)"
```

---

### Task 3: inception-dachain 瘦身（等价变换）

**Files:**
- Modify: `src/tasks/inception-dachain.ts`
- Modify: `tests/inception-dachain.test.ts`（移除已下沉用例，保留任务级竞速组合与计数器用例）

**Interfaces:**
- Consumes: Task 1 的 `ctx.detectPageState/waitForTextWithReloads/raceTexts/waitGoneOrHidden/visible`、Task 2 的 `ctx.openAppKitWallet`
- Produces: 任务内保留 `raceAfterOpenFree/raceReveal/dailyOpens/finishAtLimit/openCrates` 私有方法（后续任务可参考的站点特有样板）

- [ ] **Step 1: 基线**

Run: `npx vitest run tests/inception-dachain.test.ts`
Expected: 现有用例 PASS（重构前基线）

- [ ] **Step 2: 任务重构**

`src/tasks/inception-dachain.ts` 按以下改动：

1. 删除私有方法：`raceTexts`、`raceLoginState`、`visible`、`waitGoneOrHidden`、`detectState`、`waitForSidebar`、`normalizeAppKit`（全部由 ctx 方法替代）
2. 删除常量：`STATE_WAIT_MS`、`STATE_RELOAD_ROUNDS`、`STATE_RELOAD_WAIT_MS`、`SIDEBAR_PASSIVE_MS`、`SIDEBAR_RELOAD_ROUNDS`、`SIDEBAR_RELOAD_WAIT_MS`、`APP_KIT_MODAL_WAIT_MS`、`APP_KIT_NORMALIZE_ROUNDS`、`APP_KIT_ROUND_SLEEP_MS`（参数并入 ctx 调用或采用封装默认值）；保留 `RELOAD_TIMEOUT_MS`、`GET_STARTED_WAIT_MS`、`CRATE_*`、`OPEN_FREE_*`、`REVEAL_*`、`MODAL_GONE_MS` 及站点文案常量
3. `run()` 中：
   - `const state = await this.detectState(ctx)` →
     `const state = await ctx.detectPageState({ loggedInText: SIDEBAR_TEXT, landingText: ENTER_TEXT, waitMs: 20000, rounds: 10, roundWaitMs: 15000, reloadTimeoutMs: RELOAD_TIMEOUT_MS })`
   - `if (!(await this.waitForSidebar(ctx)))` →
     `if (!(await ctx.waitForTextWithReloads(SIDEBAR_TEXT, { passiveMs: 45000, rounds: 2, roundWaitMs: 30000, reloadTimeoutMs: RELOAD_TIMEOUT_MS })))`
   - 其余结构不变（含 popupFailed 分支与错误文案）
4. `loginByMetaMask` 改为：

```ts
  private async loginByMetaMask(ctx: TaskContext): Promise<boolean> {
    // 会话级钱包扩展就绪检查：provider 轮询（isMetaMask 验证）+ CDP 扩展页探测（预热），
    // 结果按类型缓存；扩展未加载时快速失败（重试将重启浏览器窗口，扩展随之重载）
    await ctx.ensureWalletReady()

    // Enter Inception → 登录方式选择弹窗（Get Started）——站点特有入口
    await ctx.clickCheckin('button:has-text("Enter Inception")', { assert: 'text=Get Started', assertTimeoutMs: GET_STARTED_WAIT_MS })

    // AppKit 弹窗打开 + 视图归一化 + MetaMask 入口点击 + 钱包弹窗连接（通用封装）；
    // 已授权过站点的窗口可能不再弹弹窗（静默连接）——弹窗未出现不立即判失败
    return ctx.openAppKitWallet({ walletKey: 'metamask', openSelector: 'button:has-text("WALLET")', entryTestId: METAMASK_ENTRY })
  }
```

5. `raceAfterOpenFree` / `raceReveal` 改用 `ctx.raceTexts`（组合不变）
6. `openCrates` 中 `this.visible` → `ctx.visible`、`this.waitGoneOrHidden` → `ctx.waitGoneOrHidden`、`this.finishAtLimit` 不变

- [ ] **Step 3: 测试适配**

`tests/inception-dachain.test.ts`：

1. `TaskHelpers` 类型与取用调整：移除 `raceLoginState/visible/waitGoneOrHidden`（已下沉）；
   保留 `raceAfterOpenFree/raceReveal/dailyOpens`
2. 删除用例：`raceLoginState` 3 个、`waitGoneOrHidden` 3 个、`visible` 1 个（由 task-context-generic 覆盖）
3. 保留用例：`raceAfterOpenFree` 4 个、`raceReveal` 4 个、`dailyOpens` 2 个（fake ctx 无需变化——任务级竞速改走 ctx.raceTexts 后仍经 fake page 的 getByText 生效）

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/inception-dachain.test.ts tests/task-context-generic.test.ts tests/appkit.test.ts`；`npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tasks/inception-dachain.ts tests/inception-dachain.test.ts
git commit -m "refactor: inception-dachain uses generic ctx helpers + AppKit wrapper (behavior-preserving)"
```

---

### Task 4: 全量回归与收尾

**Files:**
- 无（仅验证）

- [ ] **Step 1: 后端全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS

- [ ] **Step 2: 提交（无文档变更则跳过）**

无文档变更则跳过。

- [ ] **Step 3: 真机验证指引（用户执行）**

由用户真实窗口复跑 inception-dachain（3-5 个窗口）确认登录/开箱行为与重构前一致；
重点观察：已登录跳过、AppKit 归一化、弹窗解锁连接、开箱上限判定。

---

## Self-Review

- **Spec coverage**：TaskContext 五方法（Task 1）、appkit 封装与 popupFailed 语义（Task 2）、任务瘦身与等价变换（Task 3）、测试策略与真机验证（Task 3/4）——全部覆盖；范围外项无对应任务（符合）。
- **Placeholder scan**：无 TBD/TODO；代码步骤均含完整代码。
- **Type consistency**：`AppKitLoginOptions` 在 Task 2 定义、Task 2/3 消费一致；`openAppKitWallet(ctx, opts): Promise<boolean>` 与 TaskContext 委托方法签名一致；`detectPageState` 返回 `'loggedIn' | 'landing'` 与 Task 3 run() 分支一致；Task 1 的五个方法名在 Task 3 调用处一致。

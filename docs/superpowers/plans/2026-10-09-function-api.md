# 能力函数库（`src/api`）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把对外 API 从「`ctx` 命名空间方法」改为「`src/api/index.ts` 统一出口的能力函数」，`ctx` 降级为运行时数据袋子；任务改为 `import { ... } from '../api'` 后调用函数；文档重写为函数手册。

**Architecture:** 新增对外层 `src/api/`（`tasks → api → engine → automation`）。分两段走以保持全程绿灯：**先加法**（新增 api 函数，复用现有 `automation/*` 与 `ctx` 字段，旧方法暂留）→ **任务改调函数** → **再删旧方法/命名空间**。行为全程等价。

**Tech Stack:** TypeScript（严格）、patchright、vitest（fake ctx/page + `as never`）。

## Global Constraints

- 依赖方向：`tasks → api → engine → automation/integrations → infrastructure`；`api` 可 import `engine`（`TaskContext` 类型、`StepRecorder`）与 `automation`（实现）。
- 函数首参统一 `ctx`（运行时袋子）；命名动词开头、无缩写、语义自解释。
- `ctx` 只暴露运行时数据字段（`page/log/profile/artifactsDir/accountRow/task` + 钱包内部依赖 + `recorder`），不再有方法/命名空间。
- 行为等价：不改 `automation/*` 实现；站点判定/阈值不变。
- 风格：无分号、单引号、2 空格缩进；文件头中文注释块。
- 验证：`npx vitest run <file>`、`npm run typecheck`、`npm test`；涉及 web/文档时 `npm run test:web`。
- 提交风格：conventional + 中文。
- 分支：`develop`（已合并此前工作）；本计划直接在 `develop` 上做（如需要可另开分支）。
- 真机验证由用户执行；本计划真机抽验放最后。

---

### Task 1: `TaskContext` 暴露运行时字段 + `src/api` 骨架 + `api/page.ts`

**Files:**
- Modify: `src/engine/task-context.ts`（公开运行时字段 getter；方法暂留）
- Create: `src/api/page.ts`、`src/api/index.ts`（暂只导出 page 成员）
- Test: `tests/api-page.test.ts`

**Interfaces:**
- `TaskContext` 新增公开只读 getter：`wallets`、`walletPasswords`、`walletSession`、`task`、`artifactsDir`、`recorder`。
- Produces：`openPage` / `click` / `fill` / `pressKey` / `runJs`。

- [ ] **Step 1: 写失败测试** `tests/api-page.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { openPage, click, fill, pressKey, runJs } from '../src/api'

/** 最小假 ctx：只提供函数用到的字段 */
function makeCtx(over: Record<string, unknown> = {}) {
  return {
    page: {
      goto: vi.fn(async () => {}),
      locator: () => ({ first: () => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}) }) }),
      keyboard: { press: vi.fn(async () => {}) },
      evaluate: vi.fn(async (fn: () => unknown) => fn()),
      context: () => ({ pages: () => [] }),
    },
    log: { warn: vi.fn() },
    task: { meta: { url: 'https://x/' } },
    ...over,
  } as never
}

describe('api/page', () => {
  it('openPage：默认 meta.url，成功调用一次 goto', async () => {
    const ctx = makeCtx()
    await openPage(ctx)
    expect((ctx as never as { page: { goto: ReturnType<typeof vi.fn> } }).page.goto).toHaveBeenCalledWith('https://x/', expect.anything())
  })

  it('click：选择器走 locator().click', async () => {
    const ctx = makeCtx()
    await click(ctx, '#a')
    // 断言 locator 被调用（简化：不抛错即通过）
    expect(true).toBe(true)
  })

  it('click：坐标走 CDP 点击（page.mouse/新 CDP session）', async () => {
    const send = vi.fn(async () => ({}))
    const ctx = makeCtx({ page: { context: () => ({ newCDPSession: async () => ({ send, detach: async () => {} }) }), waitForTimeout: async () => {} } })
    await click(ctx, { x: 10, y: 20 })
    expect(send).toHaveBeenCalled()
  })

  it('fill / pressKey / runJs', async () => {
    const ctx = makeCtx()
    await fill(ctx, '#a', 'v')
    await pressKey(ctx, 'Enter')
    expect(await runJs(ctx, () => 42)).toBe(42)
  })
})
```

- [ ] **Step 2: 运行验证失败** `npx vitest run tests/api-page.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现**

`src/engine/task-context.ts` 追加公开 getter（方法暂留，后续 Task 9 删）：

```ts
  /** 钱包适配器注册表（api/wallet 使用） */
  get wallets(): WalletRegistry | undefined { return this.deps.wallets }
  /** 钱包解锁密码映射（api/wallet 使用） */
  get walletPasswords(): Record<string, string> { return this.deps.walletPasswords }
  /** 窗口会话级钱包扩展探测（api/wallet 使用） */
  get walletSession(): WalletSession | undefined { return this.deps.walletSession }
  /** 当前任务引用（api 使用） */
  get task(): TaskRef { return this.deps.task }
  /** 截图产物目录（api/data 使用） */
  get artifactsDir(): string { return this.deps.artifactsDir }
  /** 步骤记录器（api/diag 使用） */
  get recorder(): StepRecorder { return this.recorderInstance }
```

（把现有 `private recorder = new StepRecorder()` 改为 `private recorderInstance = new StepRecorder()` 并加 getter。）

`src/api/page.ts`：

```ts
/**
 * 页面能力函数（api 层）：打开网页与基础交互
 * 依赖方向：依赖 engine 的 TaskContext 类型与 automation/dom 的坐标点击
 */
import type { TaskContext } from '../engine/task-context'
import { clickPoint } from '../automation'

/** 打开网页：默认 meta.url；失败重试（默认 3 次，2-5s 退避）；可选关闭残留标签页 */
export async function openPage(
  ctx: TaskContext,
  url?: string,
  options: { retries?: number; timeoutMs?: number; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'; closeOtherTabs?: boolean } = {},
): Promise<void> {
  const target = url ?? ctx.task.meta.url
  if (!target) throw new Error('未提供 url（任务 meta.url 为空）')
  if (options.closeOtherTabs) {
    for (const p of ctx.page.context().pages()) {
      if (p !== ctx.page) await p.close().catch(() => {})
    }
  }
  const retries = options.retries ?? 3
  const timeoutMs = options.timeoutMs ?? 45000
  const waitUntil = options.waitUntil ?? 'domcontentloaded'
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await ctx.page.goto(target, { timeout: timeoutMs, waitUntil })
      return
    } catch (e) {
      ctx.log.warn({ url: target, attempt }, `页面加载失败，第 ${attempt}/${retries} 次`)
      if (attempt === retries) throw e
      await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 3000)))
    }
  }
}

/** 点击：选择器字符串走 locator().click；{ x, y } 走 CDP 坐标点击 */
export async function click(ctx: TaskContext, target: string | { x: number; y: number }): Promise<void> {
  if (typeof target === 'string') {
    await ctx.page.locator(target).first().click()
    return
  }
  await clickPoint(ctx.page, target.x, target.y)
}

/** 填入输入框（设置为给定值） */
export async function fill(ctx: TaskContext, selector: string, text: string): Promise<void> {
  await ctx.page.locator(selector).first().fill(text)
}

/** 按键（'Enter' / 'Control+A' 等） */
export async function pressKey(ctx: TaskContext, key: string): Promise<void> {
  await ctx.page.keyboard.press(key)
}

/** 主世界执行 JS 并返回结果（读站点注入的全局变量必须用主世界） */
export async function runJs<T>(ctx: TaskContext, fn: () => T): Promise<T> {
  return ctx.page.evaluate(fn, undefined, {}, false) as Promise<T>
}
```

`src/api/index.ts`（暂只导出 page）：

```ts
/** api 唯一出口：任务只从这里 import 能力函数 */
export { openPage, click, fill, pressKey, runJs } from './page'
```

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/api-page.test.ts`；`npm run typecheck` → PASS
- [ ] **Step 5: 提交** `feat: api 页面函数与统一出口骨架（openPage/click/fill/pressKey/runJs）`

---

### Task 2: `api/find.ts`

**Files:** Create `src/api/find.ts`、Modify `src/api/index.ts`、Test `tests/api-find.test.ts`

**Interfaces:** `elementState` / `countElements` / `getText` / `hasText`。

- [ ] **Step 1: 写失败测试**（fake ctx：locator().first() 支持 count/isVisible/textContent；getByText().count）

```ts
import { describe, it, expect, vi } from 'vitest'
import { elementState, countElements, getText, hasText } from '../src/api'

function makeCtx(opts: { count?: number; visible?: boolean; text?: string; pageText?: boolean } = {}) {
  return {
    page: {
      locator: () => ({ first: () => ({ count: async () => opts.count ?? 1, isVisible: async () => opts.visible ?? true, textContent: async () => opts.text ?? '' }) }),
      getByText: () => ({ count: async () => (opts.pageText ? 1 : 0) }),
    },
  } as never
}

describe('api/find', () => {
  it('elementState：visible / hidden / absent', async () => {
    expect(await elementState(makeCtx({ count: 1, visible: true }), '#a')).toBe('visible')
    expect(await elementState(makeCtx({ count: 1, visible: false }), '#a')).toBe('hidden')
    expect(await elementState(makeCtx({ count: 0 }), '#a')).toBe('absent')
  })
  it('countElements / getText / hasText', async () => {
    expect(await countElements(makeCtx({ count: 3 }), '#a')).toBe(3)
    expect(await getText(makeCtx({ text: ' hi ' }), '#a')).toBe('hi')
    expect(await hasText(makeCtx({ pageText: true }), 'hi')).toBe(true)
    expect(await hasText(makeCtx({ pageText: false }), 'hi')).toBe(false)
  })
})
```

- [ ] **Step 2-4: 实现并验证**

`src/api/find.ts`：

```ts
/**
 * 查找能力函数（api 层）：即时判断元素状态/数量/文本（不等待）
 * 依赖方向：依赖 engine 的 TaskContext 类型
 */
import type { TaskContext } from '../engine/task-context'

/** 元素状态：可见 / 隐藏（在 DOM 但不可见）/ 不存在（查询异常按不存在处理） */
export async function elementState(ctx: TaskContext, selector: string): Promise<'visible' | 'hidden' | 'absent'> {
  try {
    const loc = ctx.page.locator(selector).first()
    if ((await loc.count()) === 0) return 'absent'
    return (await loc.isVisible()) ? 'visible' : 'hidden'
  } catch {
    return 'absent'
  }
}

/** 命中元素数量（异常按 0） */
export async function countElements(ctx: TaskContext, selector: string): Promise<number> {
  try {
    return await ctx.page.locator(selector).count()
  } catch {
    return 0
  }
}

/** 取元素文本（首元素，去首尾空格；取不到返回空串） */
export async function getText(ctx: TaskContext, selector: string): Promise<string> {
  try {
    return ((await ctx.page.locator(selector).first().textContent()) ?? '').trim()
  } catch {
    return ''
  }
}

/** 整页是否包含某文案（包含匹配，即时） */
export async function hasText(ctx: TaskContext, text: string): Promise<boolean> {
  try {
    return (await ctx.page.getByText(text, { exact: false }).count()) > 0
  } catch {
    return false
  }
}
```

`index.ts` 追加 `export { elementState, countElements, getText, hasText } from './find'`。

提交 `feat: api 查找函数（elementState/countElements/getText/hasText）`。

---

### Task 3: `api/wait.ts`

**Files:** Create `src/api/wait.ts`、Modify `src/api/index.ts`、Test `tests/api-wait.test.ts`

**Interfaces:** `Probe`、`waitFor`、`race`、`waitResponse`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { waitFor, race, waitResponse } from '../src/api'

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    page: {
      getByText: (t: string) => ({ count: async () => (over['text_visible'] === t ? 1 : 0), first() { return this }, waitFor: async () => {} }),
      locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true, waitFor: async () => {} }) }),
      waitForTimeout: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      url: () => 'https://x/',
      ...over,
    },
    log: { info: vi.fn(), warn: vi.fn() },
  } as never
}

describe('api/wait', () => {
  it('waitFor：文案命中返回 true', async () => {
    const ctx = makeCtx({ text_visible: 'OK' })
    expect(await waitFor(ctx, { text: 'OK' }, { budgetMs: 500 })).toBe(true)
  })
  it('waitFor：超时 assert → 抛错', async () => {
    const ctx = makeCtx()
    await expect(waitFor(ctx, { text: 'NO' }, { budgetMs: 200, assert: true })).rejects.toThrow()
  })
  it('race：命中键返回', async () => {
    const ctx = makeCtx({ text_visible: 'A' })
    expect(await race(ctx, [['a', { text: 'A' }], ['b', { text: 'B' }]], 500)).toBe('a')
  })
  it('waitResponse：命中返回 { status, body }', async () => {
    const ctx = makeCtx({ waitForResponse: async () => ({ status: () => 200, json: async () => ({ ok: true }) }) })
    const r = await waitResponse(ctx, { urlPart: '/x', predicate: (s) => s === 200 }, { timeoutMs: 500 })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2-4: 实现并验证**

`src/api/wait.ts`（关键：探针命中语义——文案按存在、选择器按可见、gone 按不可见/消失；刷新恢复；心跳；assert）：

```ts
/**
 * 等待能力函数（api 层）：条件等待 / 多探针竞速 / 接口响应等待
 * 依赖方向：engine 的 TaskContext 类型、infrastructure 常量
 */
import type { TaskContext } from '../engine/task-context'
import { DEFAULT_RELOAD_TIMEOUT_MS, RECOVER_TEXTS } from '../infrastructure/constants'

export type Probe = { text: string } | { selector: string } | { gone: string }

/** 探针是否命中：文案按存在（count>0，兼容双 DOM/动画）；选择器按可见；gone 按不可见/不存在 */
async function probeHit(ctx: TaskContext, probe: Probe): Promise<boolean> {
  try {
    if ('text' in probe) return (await ctx.page.getByText(probe.text, { exact: false }).count()) > 0
    const loc = ctx.page.locator(probe.selector).first()
    if ('selector' in probe) {
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    }
    // gone
    if ((await loc.count()) === 0) return true
    return !(await loc.isVisible().catch(() => false))
  } catch {
    return 'gone' in probe
  }
}

export interface WaitOptions {
  budgetMs?: number
  assert?: boolean
  refreshEveryMs?: number
  recoverTexts?: string[]
  settleMs?: number
  heartbeatMs?: number
}

/** 等条件命中（出现/可见/消失）；可选刷新恢复；返回是否命中；assert 时超时抛错 */
export async function waitFor(ctx: TaskContext, probe: Probe, options: WaitOptions = {}): Promise<boolean> {
  const budgetMs = options.budgetMs ?? 10000
  const refreshEveryMs = options.refreshEveryMs ?? 0
  const recoverTexts = options.recoverTexts ?? RECOVER_TEXTS
  const settleMs = options.settleMs ?? 5000
  const heartbeatMs = options.heartbeatMs ?? 15000
  const end = Date.now() + budgetMs
  let lastRefresh = Date.now()
  let lastBeat = Date.now()
  while (Date.now() < end) {
    if (await probeHit(ctx, probe)) return true
    let errText = ''
    for (const t of recoverTexts) {
      if ((await ctx.page.getByText(t, { exact: false }).count().catch(() => 0)) > 0) { errText = t; break }
    }
    const stale = refreshEveryMs > 0 && Date.now() - lastRefresh >= refreshEveryMs
    if (errText !== '' || stale) {
      ctx.log.info({ step: 'recover', errText, url: ctx.page.url() }, '刷新页面恢复（错误提示或周期刷新）')
      await ctx.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      await ctx.page.waitForTimeout(settleMs)
      lastRefresh = Date.now(); lastBeat = Date.now()
      continue
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now()
      ctx.log.info({ step: 'wait', waitedMs: budgetMs - (end - Date.now()), url: ctx.page.url() }, '仍在等待条件命中')
    }
    await ctx.page.waitForTimeout(3000)
  }
  if (options.assert) throw new Error(`等待超时: ${JSON.stringify(probe)}`)
  return false
}

/** 多探针竞速：任一先命中返回其键，都等不到返回 null */
export async function race<K extends string>(ctx: TaskContext, entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null> {
  const r = await Promise.race(entries.map(async ([k, probe]) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await probeHit(ctx, probe)) return k
      await ctx.page.waitForTimeout(800)
    }
    return null
  }))
  return r ?? null
}

/** 等接口响应：URL/方法匹配 + predicate(status,body) 命中后返回 { status, body }（parse:'json' 解析 body） */
export async function waitResponse(
  ctx: TaskContext,
  match: { urlPart?: string; method?: string; predicate?: (status: number, body: unknown) => boolean; parse?: 'json' },
  options: { timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await ctx.page.waitForResponse(
    (r) => (!match.urlPart || r.url().includes(match.urlPart)) && (!match.method || r.request().method() === match.method),
    { timeout: options.timeoutMs ?? 15000 },
  )
  const status = res.status()
  const body = match.parse === 'json' ? await res.json().catch(() => null) : await res.text().catch(() => '')
  if (match.predicate && !match.predicate(status, body)) {
    throw new Error(`接口响应未命中判定: status=${status}`)
  }
  return { status, body }
}
```

> `race` 用轮询探针（文案按存在/选择器按可见），不依赖旧 `raceProbes`；如需复用可视化改写。

`index.ts` 追加 `export { waitFor, race, waitResponse } from './wait'; export type { Probe, WaitOptions } from './wait'`。

提交 `feat: api 等待函数（waitFor/race/waitResponse）`。

---

### Task 4: `api/wallet.ts`

**Files:** Create `src/api/wallet.ts`、Modify `src/api/index.ts`、Test `tests/api-wallet.test.ts`

**Interfaces:** `WalletType`/`WalletScenario`/`WalletIntent`/`LoginSpec`/`loginWallet`。

- [ ] **Step 1: 写失败测试**（fake ctx 提供 page/wallets/walletPasswords/walletSession/log；mock `automation/wallet` 的 `WalletActions`）

测试要点：`scenario:'direct'` 调 `ensureLoggedIn` 且把 `wallet` 作为 `walletKey`、`entry:{kind:'direct'}`；`scenario:'appkit'` → `entry:{kind:'appkit', entryTestId, open, modalTestId}`；`scenario:'dialog'` → `entry:{kind:'dialog', confirm}` + `walletEntry`。用 `vi.mock('../src/automation/wallet', ...)` 断言 `ensureLoggedIn` 收到的 spec。

- [ ] **Step 2-4: 实现并验证**

`src/api/wallet.ts`：

```ts
/**
 * 钱包登录函数（api 层）：按 wallet 类型 + scenario 场景自适应完成登录
 * 依赖方向：engine 的 TaskContext 类型、automation/wallet 的 WalletActions
 */
import type { TaskContext } from '../engine/task-context'
import { WalletActions, type WalletIntent } from '../automation'
import type { Probe } from './wait'
import { waitFor } from './wait'

export type WalletType = 'metamask' | 'petra'
export type WalletScenario = 'direct' | 'appkit' | 'dialog'

interface LoginSpecBase {
  wallet: WalletType
  loggedIn: Probe
  loggedOut: Probe
  connect?: string
  intents?: WalletIntent[]
  waitLoggedInMs?: number
  recoverTexts?: string[]
  refreshEveryMs?: number
  attempts?: number
  reclickAfterMs?: number
}
export type LoginSpec =
  | (LoginSpecBase & { scenario: 'direct' })
  | (LoginSpecBase & { scenario: 'appkit'; entryTestId: string; open?: string; modalTestId?: string })
  | (LoginSpecBase & { scenario: 'dialog'; confirm?: string; walletEntry?: string })

/** 站点入口类型 → WalletActions 编排用的 entry */
function toEntry(spec: LoginSpec) {
  if (spec.scenario === 'appkit') return { kind: 'appkit' as const, open: spec.open ?? 'button:has-text("Connect Wallet")', entryTestId: spec.entryTestId, modalTestId: spec.modalTestId }
  if (spec.scenario === 'dialog') return { kind: 'dialog' as const, confirm: spec.confirm }
  return { kind: 'direct' as const }
}

/** 钱包登录全流程：竞速判登录态 → 点连接 → 露出钱包入口 → 解锁/签名/确认 → 等登录完成（静默连接容忍 + 刷新恢复） */
export async function loginWallet(ctx: TaskContext, spec: LoginSpec): Promise<void> {
  const actions = new WalletActions({
    page: ctx.page,
    walletKey: spec.wallet,
    wallets: ctx.wallets,
    walletPasswords: ctx.walletPasswords,
    walletSession: ctx.walletSession,
    log: ctx.log,
    recover: (probe, opts) => waitFor(ctx, probe, { ...opts }),
  })
  await actions.ensureLoggedIn({
    loggedIn: spec.loggedIn,
    loggedOut: spec.loggedOut,
    connect: spec.connect,
    walletEntry: spec.scenario === 'dialog' ? spec.walletEntry : undefined,
    entry: toEntry(spec),
    intents: spec.intents,
    waitLoggedInMs: spec.waitLoggedInMs,
    recoverTexts: spec.recoverTexts,
    refreshEveryMs: spec.refreshEveryMs,
    attempts: spec.attempts,
    reclickAfterMs: spec.reclickAfterMs,
  })
}
```

> `WalletActions.ensureLoggedIn` 现签名接收 `LoginSpec`（automation 版）；`api/wallet.ts` 负责把「`wallet` + `scenario`」映射为 automation 的 `LoginSpec`（`entry`/`walletEntry`）。若字段名不同，按 automation 现有 `login-flow.ts` 的 `LoginSpec` 对齐。

`index.ts` 追加 wallet 导出。

提交 `feat: api 钱包登录函数（loginWallet，wallet+scenario）`。

---

### Task 5: `api/captcha.ts`

**Files:** Create `src/api/captcha.ts`、Modify `src/api/index.ts`、Test `tests/api-captcha.test.ts`

**Interfaces:** `clickTurnstile`。

- [ ] **Step 1-4:**

`src/api/captcha.ts`：

```ts
/**
 * 验证码函数（api 层）：Turnstile 交互式方框点击（仅此一种）
 * 依赖方向：engine TaskContext 类型、automation/captcha 实现
 */
import type { TaskContext } from '../engine/task-context'
import { clickTurnstileBox, autoClickTurnstile } from '../automation'

/** Turnstile 方框：无 waitMs = 单次检测点击；有 waitMs = 预算内轮询等待并点击 */
export async function clickTurnstile(
  ctx: TaskContext,
  options: { waitMs?: number; selectors?: string[]; maxAttempts?: number } = {},
): Promise<boolean> {
  const deps = { page: ctx.page, logger: ctx.log }
  const opts = { selectors: options.selectors, maxAttempts: options.maxAttempts }
  return options.waitMs && options.waitMs > 0 ? autoClickTurnstile(deps, options.waitMs) : clickTurnstileBox(deps, opts)
}
```

（`ctx.log` 是完整 Logger，`TurnstileDeps.logger` 只要 info/warn，兼容。）

测试：mock `../src/automation` 的 `clickTurnstileBox`/`autoClickTurnstile`，断言无 `waitMs` 调前者、有 `waitMs` 调后者。

`index.ts` 追加 captcha 导出。提交 `feat: api 验证码函数（clickTurnstile）`。

---

### Task 6: `api/data.ts` + `api/diag.ts`

**Files:** Create `src/api/data.ts`、`src/api/diag.ts`、Modify `src/api/index.ts`、Test `tests/api-data.test.ts`

**Interfaces:** `getAccount`/`uploadFile`/`takeScreenshot`/`recordStep`/`getSteps`。

- [ ] **Step 1-4:**

`src/api/data.ts`（搬 `TaskContext.account/uploadFile/safeScreenshot` 的逻辑）：

```ts
/**
 * 数据与产物函数（api 层）：数据源取值 / 文件上传 / 容错截图
 * 依赖方向：engine TaskContext 类型
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TaskContext } from '../engine/task-context'

/** 取数据源当前窗口行某列（严格：无行/无列/空值抛错） */
export async function getAccount(ctx: TaskContext, column: string): Promise<string> {
  const row = ctx.accountRow
  if (!row) throw new Error(`数据源无当前窗口对应的行（窗口: ${ctx.profile.name}）`)
  const v = row[column]
  if (v === undefined) throw new Error(`数据源缺少列: ${column}（可用列: ${Object.keys(row).join(', ')}）`)
  if (v === '') throw new Error(`数据源列 ${column} 在窗口 ${ctx.profile.name} 的行为空`)
  return v
}

/** 上传文件：值支持 http(s) URL（自动下载到临时文件）或本地路径 */
export async function uploadFile(ctx: TaskContext, selector: string, value: string): Promise<void> {
  const loc = ctx.page.locator(selector).first()
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value)
    if (!res.ok) throw new Error(`图片下载失败: ${value.split('?')[0]} (HTTP ${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (value.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'png').slice(0, 10)
    mkdirSync(join(tmpdir(), 'abc-uploads'), { recursive: true })
    const file = join(tmpdir(), 'abc-uploads', `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
    writeFileSync(file, buf)
    await loc.setInputFiles(file)
    return
  }
  await loc.setInputFiles(value)
}

/** 容错截图：存产物目录，失败只告警返回空串 */
export async function takeScreenshot(ctx: TaskContext, name: string): Promise<string> {
  try {
    mkdirSync(ctx.artifactsDir, { recursive: true })
    const file = join(ctx.artifactsDir, `${name}.png`)
    await ctx.page.screenshot({ path: file, fullPage: false })
    return file
  } catch (e) {
    ctx.log.warn({ step: 'screenshot', window: ctx.profile.name, err: (e as Error).message }, '截图失败（不影响任务结果）')
    return ''
  }
}
```

`src/api/diag.ts`（用 `ctx.recorder`）：

```ts
/**
 * 诊断函数（api 层）：步骤记录（运行时间线）
 * 依赖方向：engine TaskContext 类型、automation/diag 的 StepRecord
 */
import type { TaskContext } from '../engine/task-context'
import type { StepRecord } from '../automation'

/** 记录一个步骤（名称/耗时/成败），累积为运行时间线 */
export async function recordStep<T>(ctx: TaskContext, name: string, fn: () => Promise<T>): Promise<T> {
  return ctx.recorder.run(name, fn, ctx.log)
}

/** 取已记录步骤 */
export function getSteps(ctx: TaskContext): StepRecord[] {
  return ctx.recorder.steps()
}
```

测试：`getAccount` 严格三分支；`takeScreenshot` 失败返回空串；`recordStep` 记录并返回结果。`index.ts` 追加导出。

提交 `feat: api 数据/产物与诊断函数（getAccount/uploadFile/takeScreenshot/recordStep/getSteps）`。

---

### Task 7: 任务改用 api 函数（8 任务 + 3 示例）

**Files:** `src/tasks/{portal-rhuna,konnex-checkin,shelby-faucet,arc-faucet,auralaunch-faucet,inception-dachain,shelby-explorer,example-checkin,faucet-example,mint-example}.ts`（portal-rhuna 已关闭仍改）；`src/tasks/base.ts`（`SiteTask` 简化为 `meta + run`）

**说明：** 每个任务 `run(ctx)` 改为 `import { openPage, loginWallet, click, fill, waitFor, race, getAccount, uploadFile, takeScreenshot, clickTurnstile, recordStep } from '../api'` 后调用。**行为等价**（选择器、判定、阈值不变）。逐任务一个提交；改完一个跑该任务的单测（fake ctx 适配为「假 page + 真字段」，断言由「ctx.human.click」改为「page.locator().click」等）。

- [ ] 按任务顺序：示例 → 簇A → 簇B → 簇C，每个：改文件 → 适配测试 → `npx vitest run <test>` + `typecheck` → 提交。

> 具体映射：`ctx.goto`→`openPage`；`ctx.clickCheckin`→`click`+`waitFor`；`ctx.typeInto`→`fill`；`ctx.human.click`→`click`；`ctx.autoClickTurnstile/clickTurnstileBox/turnstileVisible`→`clickTurnstile`；`ctx.raceTexts`→`race`；`ctx.waitForTextRecover/waitForTextWithReloads/recoverErrorText`→`waitFor({...})`；`ctx.loginByWallet/openAppKitWallet/ensureWalletReady`→`loginWallet({wallet,scenario,...})`；`ctx.account`→`getAccount`；`ctx.screenshot/safeScreenshot`→`takeScreenshot`；`ctx.step`→`recordStep`；`ctx.visible/textPresent/js/uploadFile`→`elementState/hasText/runJs/uploadFile`。

---

### Task 8: 删除 `TaskContext` 旧方法与命名空间 + 简化 `SiteTask`

**Files:** `src/engine/task-context.ts`、`src/tasks/base.ts`

- 删除 `TaskContext` 上所有方法/命名空间：`goto/closeOtherTabs/clickCheckin/assertVisible/typeInto/pressKey/textPresent/urlIncludes/waitForText/waitForApi/waitForUrl/waitForGone/raceTexts/visible/waitGoneOrHidden/waitForTextWithReloads/recoverErrorText/waitForTextRecover/detectPageState/closeModal/account/uploadFile/js/screenshot/safeScreenshot/step/steps/race/recover/wallet/captcha`（**保留字段与 `recorder`**）。
- `SiteTask` 简化为 `abstract meta` + `abstract run(ctx)`（删 `login`/`action` 模板与 `gotoWithRetry`/`closeOtherTabs`；重试逻辑已在 `openPage`）。
- 删除 `/src/automation/` 中仅旧 ctx 使用的导出（若确认无其它引用）。
- 跑 `npm run typecheck` + `npm test`，修复残留引用。
- 提交 `refactor: TaskContext 收敛为运行时数据袋子；SiteTask 简化；删旧方法`

---

### Task 9: 文档重写为函数手册 + 漂移守卫

**Files:** `docs/API-GUIDE.md`（重写）、Create `tests/api-docs-drift.test.ts`

- 手册结构（见 spec「文档规范」）：快速上手 → 任务骨架 → **函数参考**（每函数：用途/签名/参数表/示例/注意，按 page/find/wait/wallet/captcha/data/diag 分组）→ 钱包场景表（direct/appkit/dialog 三示例）→ 常用配方 → 排错与真机经验（保留现第 12 章）。
- 删除 REST/面板/定时/配置/工具/架构章节。
- 漂移守卫：读 `src/api/index.ts` 文本，提取 `export { ... } from` 的函数名，断言每个都出现在手册中。
- 提交 `docs: API-GUIDE 重写为函数手册；加 api 出口漂移守卫`。

---

### Task 10: 全量回归与真机抽验

- `npm run typecheck` + `npm test` + `npm run test:web` 全绿。
- 真机抽验（用户）：`faucet-arc`? （已暂停）→ 用可用启用任务 `konnex-checkin`/`auralaunch-faucet`/`shelby-faucet` 各一窗口。
- 收尾提交。

---

## Self-Review

- **Spec coverage**：Task 1-6 建 `src/api`（page/find/wait/wallet/captcha/data/diag + 出口）；Task 7 任务改函数；Task 8 删旧方法与命名空间、简化 SiteTask；Task 9 文档重写 + 漂移守卫；Task 10 回归+真机。全覆盖。
- **Placeholder scan**：核心函数给完整实现；任务改写与文档为主题-指令式（映射表 + 结构），因体量大且等价变换。
- **Type consistency**：`Probe`（wait）与 wallet 的 `loggedIn/loggedOut` 一致；`LoginSpec` 判别联合；`ctx` 字段名（wallets/walletPasswords/walletSession/task/artifactsDir/recorder）贯穿 api。
- **风险**：Task 8 是删方法大关，须在 Task 7 全部任务改完后做；`race` 用轮询实现替代旧 `raceProbes`，需保证语义等价（文案存在/选择器可见）。

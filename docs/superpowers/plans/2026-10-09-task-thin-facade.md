# 任务层薄门面重构（基础能力库）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立「直调 patchright + 领域能力」的薄门面基础：`dom/` 原语、`diag/` 步骤记录、`wallet/` 四动作与登录编排、`captcha/` 去拟人化、`TaskContext` 命名空间门面、`SiteTask` 模板方法；全部为**增量改动**（旧方法暂留，保证编译与既有测试全绿）。

**Architecture:** 在 `src/automation/` 下按关注点建目录，每个目录一个 `index.ts` 统一出口；新增 `dom/`（race/recover/click 小原语）与 `diag/`（步骤记录）。钱包契约由「unlock + ensureConnected」改造为「unlock / connect / sign / confirmTx」，并新增 `login-flow.ts` 的 `ensureLoggedIn` 编排。`TaskContext` 暴露 `ctx.page`（patchright）+ `ctx.wallet` / `ctx.captcha` 命名空间 + `ctx.step/race/recover`；`SiteTask` 提供默认 `run`（清理→goto→登录→action）。本计划**不删除**旧方法（删除在后续「清理计划」执行），因此可独立测试、可随时回滚。

**Tech Stack:** TypeScript（严格模式）、patchright 1.62.1、vitest 3.2（fake page + `as never` mock）、log4js。

## Global Constraints

- 依赖方向：`tasks → engine → automation/integrations → infrastructure`，不可反向；跨层引用用 `import type` 解运行时环。
- **每个 automation 子目录必须有 `index.ts` 统一出口**；目录外引用只从 `index.ts` 导入，禁止深路径。
- 代码风格：无分号、单引号、2 空格缩进；文件头中文注释块说明「模块职责 + 依赖方向」；命名 camelCase，文件 kebab-case。
- 日志：`logger.info({ step, window, ... }, '中文消息')`；等待循环必须输出心跳日志。
- 共享常量 `RECOVER_TEXTS = ['Network Error', 'Turnstile token request timed out']` 定义在 `src/infrastructure/constants.ts`。
- 提交风格：conventional + 中文，单行 `feat:/fix:/refactor:/docs:/chore:`。
- 验证命令：`npx vitest run <file>`、`npm run typecheck`、`npm test`（vitest run，超时 30s）。
- 运行环境：Windows PowerShell 5.1；工作目录 `D:\StudySpace\AutoBitControl`。
- 真机验证规范：tasks 层改动后须真机闭环（并发≤4；问题自解决；卡住 3 分钟即暂停求助）——本计划为纯能力库，真机验证在后续「任务重写计划」进行。

---

### Task 1: `dom/` 探针原语与竞速

**Files:**
- Create: `src/automation/dom/probe.ts`
- Create: `src/automation/dom/race.ts`
- Create: `src/automation/dom/index.ts`
- Test: `tests/dom-race.test.ts`

**Interfaces:**
- Produces: `type Probe = { text: string } | { selector: string }`；
  `probeLocator(page: Page, probe: Probe): Locator`；
  `probeVisible(page: Page, probe: Probe): Promise<boolean>`；
  `raceProbes<K extends string>(page: Page, entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null>`

- [ ] **Step 1: 写失败测试** `tests/dom-race.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { probeLocator, probeVisible, raceProbes, type Probe } from '../src/automation/dom'

/** 假 locator：按 visible/count 配置行为 */
function locator(opts: { count?: number; visible?: boolean; waitDelayMs?: number; never?: boolean }) {
  return {
    first() { return this },
    count: async () => opts.count ?? 0,
    isVisible: async () => opts.visible ?? true,
    waitFor: async ({ timeout }: { state?: string; timeout?: number }) =>
      new Promise<void>((resolve, reject) => {
        if (opts.never) setTimeout(() => reject(new Error('timeout')), 10)
        else setTimeout(resolve, opts.waitDelayMs ?? 5)
      }),
  }
}

/** 假 page：selector -> 行为；text -> 行为 */
function page(map: Record<string, { count?: number; visible?: boolean; waitDelayMs?: number; never?: boolean }>) {
  return {
    locator: (sel: string) => locator(map[sel] ?? { count: 0 }),
    getByText: (text: string) => locator(map[text] ?? { count: 0 }),
    waitForTimeout: async () => {},
    reload: async () => {},
    url: () => 'https://x.test/',
  }
}

describe('dom probe/race', () => {
  it('probeLocator：text 走 getByText，selector 走 locator', () => {
    const p = page({ '文案A': { count: 1 }, '#id': { count: 1 } }) as never
    expect(probeLocator(p, { text: '文案A' })).toBeTruthy()
    expect(probeLocator(p, { selector: '#id' })).toBeTruthy()
  })

  it('probeVisible：不存在/不可见/异常均 false，正常 true', async () => {
    expect(await probeVisible(page({ '#a': { count: 0 } }) as never, { selector: '#a' })).toBe(false)
    expect(await probeVisible(page({ '#a': { count: 1, visible: false } }) as never, { selector: '#a' })).toBe(false)
    expect(await probeVisible(page({ '#a': { count: 1, visible: true } }) as never, { selector: '#a' })).toBe(true)
  })

  it('raceProbes：先出现者返回其键', async () => {
    const p = page({ '快': { waitDelayMs: 5 }, '慢': { waitDelayMs: 500, never: true } }) as never
    const r = await raceProbes(p, [['fast', { text: '快' }], ['slow', { text: '慢' }]], 1000)
    expect(r).toBe('fast')
  })

  it('raceProbes：都不出现返回 null', async () => {
    const p = page({ 'x': { never: true } }) as never
    expect(await raceProbes(p, [['x', { text: 'x' }]], 50)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/dom-race.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/automation/dom/probe.ts`：

```ts
/**
 * DOM 探针原语（automation/dom 层）：统一「文案 / 选择器」两种定位，供竞速与恢复复用
 * 依赖方向：仅依赖 patchright，被 dom 内 race/recover 与 engine 使用
 */
import type { Locator, Page } from 'patchright'

/** 探针：命中文案（包含匹配）或命中选择器 */
export type Probe = { text: string } | { selector: string }

/** 探针 -> Locator */
export function probeLocator(page: Page, probe: Probe): Locator {
  return 'text' in probe ? page.getByText(probe.text, { exact: false }) : page.locator(probe.selector)
}

/** 探针当前是否可见（不存在/异常按不可见处理，不抛错） */
export async function probeVisible(page: Page, probe: Probe): Promise<boolean> {
  try {
    const loc = probeLocator(page, probe).first()
    if ((await loc.count()) === 0) return false
    return await loc.isVisible()
  } catch {
    return false
  }
}

/** 任一文案是否出现在页面（包含匹配），命中返回该文案，否则空串 */
export async function firstTextPresent(page: Page, texts: string[]): Promise<string> {
  for (const t of texts) {
    try {
      if ((await page.getByText(t, { exact: false }).count()) > 0) return t
    } catch {
      // 单条文案查询失败不影响其余
    }
  }
  return ''
}

/** 探针的可读描述（拼错误/日志用） */
export function probeDesc(probe: Probe): string {
  return 'text' in probe ? `文案 ${probe.text}` : `选择器 ${probe.selector}`
}
```

`src/automation/dom/race.ts`：

```ts
/**
 * 多探针竞速（automation/dom 层）：任一探针先可见则返回其键，都等不到返回 null
 * 依赖方向：依赖 ./probe 与 patchright 类型
 */
import type { Page } from 'patchright'
import { probeLocator, type Probe } from './probe'

export async function raceProbes<K extends string>(
  page: Page,
  entries: Array<[K, Probe]>,
  timeoutMs: number,
): Promise<K | null> {
  const r = await Promise.race(
    entries.map(([k, probe]) =>
      probeLocator(page, probe)
        .first()
        .waitFor({ state: 'visible', timeout: timeoutMs })
        .then(() => k)
        .catch(() => null),
    ),
  )
  return r ?? null
}
```

`src/automation/dom/index.ts`：

```ts
/**
 * dom 能力出口（automation/dom 层）：探针/竞速/恢复/坐标点击
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { type Probe, probeLocator, probeVisible, firstTextPresent, probeDesc } from './probe'
export { raceProbes } from './race'
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/dom-race.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/dom/probe.ts src/automation/dom/race.ts src/automation/dom/index.ts tests/dom-race.test.ts
git commit -m "feat: dom 探针原语与多探针竞速（Probe/raceProbes）"
```

---

### Task 2: `dom/recover` 刷新恢复内核（含心跳）

**Files:**
- Create: `src/automation/dom/recover.ts`
- Modify: `src/automation/dom/index.ts`
- Modify: `src/infrastructure/constants.ts`（新增 `RECOVER_TEXTS`）
- Test: `tests/dom-recover.test.ts`

**Interfaces:**
- Consumes: `probeVisible`、`firstTextPresent`（Task 1）、`DEFAULT_RELOAD_TIMEOUT_MS`（constants）
- Produces: `RECOVER_TEXTS: string[]`（constants）；`recoverProbe(page, probe, log, opts): Promise<boolean>`；
  `interface RecoverOpts { budgetMs: number; refreshEveryMs?: number; recoverTexts?: string[]; settleMs?: number; heartbeatMs?: number }`

- [ ] **Step 1: 写失败测试** `tests/dom-recover.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { recoverProbe } from '../src/automation/dom'

function makePage(opts: { appearAfterMs?: number; errorText?: string; startMs?: number }) {
  const start = Date.now()
  let reloads = 0
  const map: Record<string, number> = {}
  if (opts.appearAfterMs !== undefined) map['目标'] = opts.appearAfterMs
  if (opts.errorText) map[opts.errorText] = 0
  return {
    get reloads() { return reloads },
    locator: () => ({ first() { return this }, count: async () => 0, isVisible: async () => false }),
    getByText: (t: string) => ({
      first() { return this },
      count: async () => {
        const at = map[t]
        if (at === undefined) return 0
        return Date.now() - start >= at ? 1 : 0
      },
      isVisible: async () => true,
      waitFor: async () => {},
    }),
    waitForTimeout: vi.fn(async () => {}),
    reload: vi.fn(async () => { reloads++ }),
    url: () => 'https://x.test/',
  }
}

const log = { info: vi.fn(), warn: vi.fn() } as never

describe('dom recoverProbe', () => {
  it('目标探针出现 → true，不刷新', async () => {
    const page = makePage({ appearAfterMs: 0 }) as never
    expect(await recoverProbe(page, { text: '目标' }, log, { budgetMs: 2000 })).toBe(true)
    expect((page as never as { reload: ReturnType<typeof vi.fn> }).reload).not.toHaveBeenCalled()
  })

  it('预算内不出现 → false（无错误文案时不刷新）', async () => {
    const page = makePage({}) as never
    expect(await recoverProbe(page, { text: '目标' }, log, { budgetMs: 300 })).toBe(false)
  })

  it('出现可恢复错误文案 → 触发刷新', async () => {
    const page = makePage({ errorText: 'Network Error' }) as never
    await recoverProbe(page, { text: '目标' }, log, { budgetMs: 400, recoverTexts: ['Network Error'] })
    expect((page as never as { reload: ReturnType<typeof vi.fn> }).reload).toHaveBeenCalled()
  })

  it('配置 refreshEveryMs → 无错误也周期刷新', async () => {
    const page = makePage({}) as never
    await recoverProbe(page, { text: '目标' }, log, { budgetMs: 600, refreshEveryMs: 100 })
    expect((page as never as { reload: ReturnType<typeof vi.fn> }).reload).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/dom-recover.test.ts`
Expected: FAIL（`recoverProbe` 未导出）

- [ ] **Step 3: 最小实现**

`src/infrastructure/constants.ts` 末尾追加：

```ts
/**
 * Web3 站点通用可恢复错误文案（token 存 localStorage，页面 JS 状态坏了刷新即恢复）：
 * 各任务曾重复定义，收敛为单点；recover 默认使用
 */
export const RECOVER_TEXTS = ['Network Error', 'Turnstile token request timed out']
```

`src/automation/dom/recover.ts`：

```ts
/**
 * 刷新恢复等待内核（automation/dom 层）：目标探针出现即返回；
 * 页面出现可恢复错误文案立即刷新；配置 refreshEveryMs 时周期刷新；每 heartbeatMs 输出心跳
 * 依赖方向：依赖 ./probe、infrastructure/constants 与 logger 类型
 */
import type { Page } from 'patchright'
import type { Logger } from '../../infrastructure/logger'
import { DEFAULT_RELOAD_TIMEOUT_MS, RECOVER_TEXTS } from '../../infrastructure/constants'
import { firstTextPresent, probeDesc, probeVisible, type Probe } from './probe'

export interface RecoverOpts {
  /** 总预算（毫秒） */
  budgetMs: number
  /** 周期主动刷新间隔（毫秒）；缺省 0 = 关闭 */
  refreshEveryMs?: number
  /** 可恢复错误文案，任一出现即刷新（缺省 RECOVER_TEXTS） */
  recoverTexts?: string[]
  /** 刷新后的沉降等待（缺省 5000） */
  settleMs?: number
  /** 心跳日志间隔（缺省 15000） */
  heartbeatMs?: number
}

/**
 * 等待探针出现（刷新恢复导向）
 * @returns 预算内出现 true / 超时 false（不抛错，由调用方决定后续）
 */
export async function recoverProbe(page: Page, probe: Probe, log: Logger, opts: RecoverOpts): Promise<boolean> {
  const reloadTimeoutMs = DEFAULT_RELOAD_TIMEOUT_MS
  const settleMs = opts.settleMs ?? 5000
  const heartbeatMs = opts.heartbeatMs ?? 15000
  const recoverTexts = opts.recoverTexts ?? RECOVER_TEXTS
  const end = Date.now() + opts.budgetMs
  let lastRefresh = Date.now()
  let lastBeat = Date.now()
  while (Date.now() < end) {
    if (await probeVisible(page, probe)) return true
    const errText = await firstTextPresent(page, recoverTexts)
    const stale = (opts.refreshEveryMs ?? 0) > 0 && Date.now() - lastRefresh >= (opts.refreshEveryMs as number)
    if (errText !== '' || stale) {
      log.info({ step: 'recover', errText, url: page.url() }, '刷新页面恢复（错误提示或周期刷新）')
      await page.reload({ timeout: reloadTimeoutMs, waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(settleMs)
      lastRefresh = Date.now()
      lastBeat = Date.now()
      continue
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now()
      log.info({ step: 'recover', waitedMs: opts.budgetMs - (end - Date.now()), url: page.url() }, `仍在等待（${probeDesc(probe)}）`)
    }
    await page.waitForTimeout(3000)
  }
  return false
}
```

`src/automation/dom/index.ts` 追加：

```ts
export { recoverProbe, type RecoverOpts } from './recover'
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/dom-recover.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/dom/recover.ts src/automation/dom/index.ts src/infrastructure/constants.ts tests/dom-recover.test.ts
git commit -m "feat: dom 刷新恢复等待内核（recoverProbe + 心跳），收敛 RECOVER_TEXTS"
```

---

### Task 3: `dom/click` 坐标点击 + captcha 去拟人化

**Files:**
- Create: `src/automation/dom/click.ts`
- Modify: `src/automation/dom/index.ts`
- Modify: `src/automation/captcha/turnstile.ts`（依赖由 `human` 改 `clickPoint`）
- Modify: `src/engine/task-context.ts`（turnstile 调用去掉 `human`）
- Modify: `tests/turnstile.test.ts`（若引用 human）
- Test: `tests/dom-click.test.ts`

**Interfaces:**
- Produces: `clickPoint(page: Page, x: number, y: number): Promise<void>`；
  `TurnstileDeps = { page: Page; logger: Pick<Logger,'info'|'warn'> }`（去掉 `human`）

- [ ] **Step 1: 写失败测试** `tests/dom-click.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { clickPoint } from '../src/automation/dom'

describe('dom clickPoint', () => {
  it('用 patchright 原生 mouse.click 在坐标派发可信点击', async () => {
    const click = vi.fn(async () => {})
    const page = { mouse: { click } } as never
    await clickPoint(page, 12, 34)
    expect(click).toHaveBeenCalledWith(12, 34)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/dom-click.test.ts`
Expected: FAIL（`clickPoint` 未导出）

- [ ] **Step 3: 最小实现**

`src/automation/dom/click.ts`：

```ts
/**
 * 坐标点击原语（automation/dom 层）：用于无选择器场景（验证码方框、遮罩空白处）
 * 依赖方向：仅依赖 patchright；派发 patchright 原生可信鼠标事件（不拟人）
 */
import type { Page } from 'patchright'

/** 在视口坐标 (x,y) 派发一次原生左键点击 */
export async function clickPoint(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y)
}
```

`src/automation/dom/index.ts` 追加：

```ts
export { clickPoint } from './click'
```

`src/automation/captcha/turnstile.ts`：

1. 删除 `import type { Humanizer } from '../humanize'`
2. 顶部新增 `import { clickPoint } from '../dom'`
3. `TurnstileDeps` 改为：

```ts
export interface TurnstileDeps {
  page: Page
  /** 日志器：模块内消息为通用措辞，窗口名等上下文由调用方包装注入 */
  logger: Pick<Logger, 'info' | 'warn'>
}
```

4. `clickTurnstileBox` 内 `await deps.human.clickAt(x, y)` → `await clickPoint(deps.page, x, y)`

`src/engine/task-context.ts`：`clickTurnstileBox` / `autoClickTurnstile` 的依赖参数由
`{ page: this.page, human: this.human, logger: this.turnstileLogger() }` 改为
`{ page: this.page, logger: this.turnstileLogger() }`。

`tests/turnstile.test.ts`：若构造 `TurnstileDeps` 时传了 `human`，删除该字段（改由 `clickPoint` mock）。

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/dom-click.test.ts tests/turnstile.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/dom/click.ts src/automation/dom/index.ts src/automation/captcha/turnstile.ts src/engine/task-context.ts tests/dom-click.test.ts tests/turnstile.test.ts
git commit -m "refactor: captcha 方框点击改用 dom/clickPoint，去掉 Humanizer 依赖"
```

---

### Task 4: `diag/` 步骤记录器

**Files:**
- Create: `src/automation/diag/recorder.ts`
- Create: `src/automation/diag/index.ts`
- Test: `tests/diag-recorder.test.ts`

**Interfaces:**
- Produces: `interface StepRecord { name: string; startMs: number; ms: number; ok: boolean; detail?: string }`；
  `class StepRecorder { run<T>(name: string, fn: () => Promise<T>, log?: Logger): Promise<T>; steps(): StepRecord[] }`

- [ ] **Step 1: 写失败测试** `tests/diag-recorder.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { StepRecorder } from '../src/automation/diag'

describe('StepRecorder', () => {
  it('成功步骤记录 name/耗时/ok=true，并返回结果', async () => {
    const r = new StepRecorder()
    const out = await r.run('step-a', async () => 42)
    expect(out).toBe(42)
    const [s] = r.steps()
    expect(s.name).toBe('step-a')
    expect(s.ok).toBe(true)
    expect(s.ms).toBeGreaterThanOrEqual(0)
  })

  it('失败步骤记录 ok=false 并继续抛出', async () => {
    const r = new StepRecorder()
    await expect(r.run('boom', async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(r.steps()[0].ok).toBe(false)
  })

  it('提供 logger 时输出步骤日志', async () => {
    const log = { info: vi.fn(), warn: vi.fn() } as never
    const r = new StepRecorder()
    await r.run('s', async () => {}, log)
    expect((log as never as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/diag-recorder.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/automation/diag/recorder.ts`：

```ts
/**
 * 步骤记录器（automation/diag 层）：记录任务关键步骤的耗时与结果，累计为运行时间线
 * 依赖方向：仅依赖 logger 类型；每轮运行一个实例（window-runner 装配）
 */
import type { Logger } from '../../infrastructure/logger'

export interface StepRecord {
  name: string
  startMs: number
  ms: number
  ok: boolean
  detail?: string
}

export class StepRecorder {
  private list: StepRecord[] = []

  /** 执行一步并记录耗时/结果（失败记录后继续抛出） */
  async run<T>(name: string, fn: () => Promise<T>, log?: Logger): Promise<T> {
    const startMs = Date.now()
    try {
      const out = await fn()
      const rec: StepRecord = { name, startMs, ms: Date.now() - startMs, ok: true }
      this.list.push(rec)
      log?.info({ step: name, ms: rec.ms }, `步骤完成: ${name}`)
      return out
    } catch (e) {
      const rec: StepRecord = { name, startMs, ms: Date.now() - startMs, ok: false, detail: (e as Error).message }
      this.list.push(rec)
      log?.warn({ step: name, ms: rec.ms, err: rec.detail }, `步骤失败: ${name}`)
      throw e
    }
  }

  /** 已记录步骤（拷贝） */
  steps(): StepRecord[] {
    return [...this.list]
  }
}
```

`src/automation/diag/index.ts`：

```ts
/**
 * diag 能力出口（automation/diag 层）：步骤记录（后续诊断包在此目录扩展）
 * 依赖方向：汇总本目录实现
 */
export { StepRecorder, type StepRecord } from './recorder'
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/diag-recorder.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/diag/recorder.ts src/automation/diag/index.ts tests/diag-recorder.test.ts
git commit -m "feat: diag 步骤记录器（StepRecorder）"
```

---

### Task 5: 钱包四动作契约与适配器实现

**Files:**
- Modify: `src/automation/wallet/types.ts`（契约：删 `ensureConnected`，加 `connect/sign/confirmTx`）
- Modify: `src/automation/wallet/metamask.ts`
- Modify: `src/automation/wallet/petra.ts`
- Modify: `src/engine/task-context.ts`（`loginByWallet` 内 `ensureConnected` → `connect`）
- Test: `tests/wallet.test.ts`（适配新契约）

**Interfaces:**
- Consumes: 现有 `PopupPage`
- Produces: `WalletAdapter.unlock? / connect / sign / confirmTx`；三个动作对按钮同构的钱包共用私有 `confirm(popup)`

- [ ] **Step 1: 更新契约**

`src/automation/wallet/types.ts`：`WalletAdapter` 内把 `ensureConnected(popup): Promise<void>`
替换为：

```ts
  /** 登录/连接授权（站点请求连接钱包） */
  connect(popup: PopupPage): Promise<void>
  /** 消息签名（站点请求 signMessage，如 Petra Sign In） */
  sign(popup: PopupPage): Promise<void>
  /** 交易确认（站点请求发送/授权交易，如 Approve、register_blobs） */
  confirmTx(popup: PopupPage): Promise<void>
```

同步更新文件头注释（「各钱包只实现 unlock + 三确认动作」）。

- [ ] **Step 2: 更新适配器（MetaMask）**

`src/automation/wallet/metamask.ts`：把现有 `ensureConnected(popup)` 改名为私有
`private async confirm(popup: PopupPage): Promise<void>`（实现不变），并新增：

```ts
  async connect(popup: PopupPage): Promise<void> { await this.confirm(popup) }
  async sign(popup: PopupPage): Promise<void> { await this.confirm(popup) }
  async confirmTx(popup: PopupPage): Promise<void> { await this.confirm(popup) }
```

- [ ] **Step 3: 更新适配器（Petra）**

`src/automation/wallet/petra.ts`：同上，`ensureConnected` → 私有 `confirm`，新增三个委托方法。

- [ ] **Step 4: 更新调用点**

`src/engine/task-context.ts` 的 `loginByWallet`：`await adapter.ensureConnected(popup)` →
`await adapter.connect(popup)`。

- [ ] **Step 5: 适配测试**

`tests/wallet.test.ts`：把对 `ensureConnected` 的断言改为对 `connect`（三方法行为一致）；
`tests/login-by-wallet.test.ts` 不受影响（走 ctx.loginByWallet）。

- [ ] **Step 6: 运行验证通过**

Run: `npx vitest run tests/wallet.test.ts tests/login-by-wallet.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/automation/wallet/types.ts src/automation/wallet/metamask.ts src/automation/wallet/petra.ts src/engine/task-context.ts tests/wallet.test.ts
git commit -m "refactor: 钱包适配器四动作契约（unlock/connect/sign/confirmTx）"
```

---

### Task 6: `wallet/login-flow` 登录编排与 `WalletActions`

**Files:**
- Create: `src/automation/wallet/actions.ts`
- Create: `src/automation/wallet/login-flow.ts`
- Create: `src/automation/wallet/index.ts`
- Test: `tests/wallet-login-flow.test.ts`
- Create: `tests/fixtures/wallet-login-flow.md`（说明用，非代码；可省略）

**Interfaces:**
- Consumes: Task 5 四动作、现有 `waitForPopup`、`WalletSession`、Task 1/2 的 `raceProbes`/`recoverProbe`
- Produces:
  ```ts
  type Probe = { text: string } | { selector: string }
  type WalletIntent = 'connect' | 'sign' | 'confirmTx'
  interface LoginSpec { loggedIn; loggedOut; connect?; entry?; intents?; waitLoggedInMs?; recoverTexts?; refreshEveryMs?; attempts?; reclickAfterMs? }
  interface WalletActionsDeps {
    page: Page
    walletKey?: string
    wallets?: WalletRegistry
    walletPasswords: Record<string, string>
    walletSession?: WalletSession
    log: Logger
    human: { click(selector: string): Promise<void> }
    recover(probe: Probe, opts: RecoverOpts): Promise<boolean>
  }
  class WalletActions {
    ready(): Promise<void>
    login(opts?): Promise<{ popupFailed: boolean }>
    sign(opts?): Promise<{ popupFailed: boolean }>
    confirmTx(opts?): Promise<{ popupFailed: boolean }>
    ensureLoggedIn(spec: LoginSpec): Promise<{ skipped: boolean }>
  }
  ```

- [ ] **Step 1: 写失败测试** `tests/wallet-login-flow.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalletActions, type LoginSpec, type WalletActionsDeps } from '../src/automation/wallet'
import { WalletRegistry } from '../src/automation/wallet/types'

vi.mock('../src/automation/wallet/popup', () => ({ waitForPopup: vi.fn() }))
import { waitForPopup } from '../src/automation/wallet/popup'

function adapter(over: Record<string, unknown> = {}) {
  return {
    key: 'metamask',
    extensionUrlPatterns: ['home'],
    extensionId: 'x', probePath: 'home.html', providerFlag: 'isMetaMask',
    unlock: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    sign: vi.fn(async () => {}),
    confirmTx: vi.fn(async () => {}),
    ...over,
  }
}

/** 登录态竞速：loggedInVisible 控制已登录文案是否可见 */
function deps(over: Partial<WalletActionsDeps> & { loggedInVisible?: boolean } = {}): WalletActionsDeps & { clicks: string[] } {
  const clicks: string[] = []
  let loggedIn = over.loggedInVisible ?? false
  const reg = new WalletRegistry()
  reg.register(adapter() as never)
  const base: WalletActionsDeps & { clicks: string[] } = {
    clicks,
    page: {
      context: () => ({}),
      getByText: (t: string) => ({ first() { return this }, count: async () => (loggedIn && t === '已登录' ? 1 : 0), isVisible: async () => loggedIn, waitFor: async () => {} }),
      locator: (sel: string) => ({ first() { return this }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} }),
      waitForTimeout: async () => {},
      reload: async () => {},
      url: () => 'https://x/',
    } as never,
    walletKey: 'metamask',
    wallets: reg,
    walletPasswords: { metamask: 'pw' },
    log: { info: vi.fn(), warn: vi.fn() } as never,
    human: { click: vi.fn(async (s: string) => { clicks.push(s) }) },
    recover: vi.fn(async () => true),
    ...over,
  }
  return base
}

const SPEC: LoginSpec = { loggedIn: { text: '已登录' }, loggedOut: 'Connect Wallet', connect: 'button:has-text("Connect Wallet")', entry: { kind: 'direct' } }

describe('WalletActions.ensureLoggedIn', () => {
  beforeEach(() => vi.mocked(waitForPopup).mockReset())

  it('已登录 → 跳过，不点连接', async () => {
    const d = deps({ loggedInVisible: true })
    expect((await new WalletActions(d).ensureLoggedIn(SPEC)).skipped).toBe(true)
    expect(d.human.click).not.toHaveBeenCalled()
  })

  it('未登录 → 点连接 + 等弹窗 + 解锁 + 连接，最后 recover 等登录完成', async () => {
    vi.mocked(waitForPopup).mockResolvedValue({ url: () => 'home', waitForEvent: async () => {}, isClosed: () => false, getByTestId: () => ({ count: async () => 1, fill: async () => {}, click: async () => {}, first() { return this } }), getByRole: () => ({ first() { return this }, count: async () => 1, click: async () => {} }), locator: () => ({ first() { return this }, count: async () => 0, click: async () => {} }) } as never)
    const d = deps()
    await new WalletActions(d).ensureLoggedIn(SPEC)
    expect(d.clicks).toContain('button:has-text("Connect Wallet")')
    expect(d.recover).toHaveBeenCalled()
  })

  it('弹窗未出现 → 静默连接容忍（不抛错），仍走 recover', async () => {
    vi.mocked(waitForPopup).mockResolvedValue(null)
    const d = deps()
    await expect(new WalletActions(d).ensureLoggedIn(SPEC)).resolves.toBeDefined()
    expect(d.recover).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/wallet-login-flow.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/automation/wallet/actions.ts`：把现有 `TaskContext.loginByWallet` 的核心逻辑搬为类方法
（等待弹窗 + 解锁 + 按 intent 调适配器动作 + 静默连接容忍），并新增 `ready()` 委托
`walletSession.ensureReady`。

```ts
/**
 * 钱包动作门面（automation/wallet 层）：ready/login/sign/confirmTx —— 一次弹窗一次意图
 * 依赖方向：依赖 ./types、./popup、./session、./login-flow 类型
 */
import type { Page } from 'patchright'
import type { Logger } from '../../infrastructure/logger'
import type { RecoverOpts, Probe } from '../dom'
import type { WalletRegistry, PopupPage, WalletAdapter } from './types'
import type { WalletSession } from './session'
import { waitForPopup } from './popup'

export type WalletIntent = 'connect' | 'sign' | 'confirmTx'

export interface WalletActionsDeps {
  page: Page
  walletKey?: string
  wallets?: WalletRegistry
  walletPasswords: Record<string, string>
  walletSession?: WalletSession
  log: Logger
  human: { click(selector: string): Promise<void> }
  recover(probe: Probe, opts: RecoverOpts): Promise<boolean>
}

export interface PopupLoginOpts {
  reclick?: { selector: string; afterMs: number }
}

export class WalletActions {
  constructor(readonly deps: WalletActionsDeps) {}

  /** 会话级扩展就绪检查（未配置 wallet / 未注入会话时跳过） */
  async ready(): Promise<void> {
    const key = this.deps.walletKey
    if (!key) return
    const session = this.deps.walletSession
    if (!session) return
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(key)
    const state = await session.ensureReady(key, adapter)
    if (state === 'missing') throw new Error(`窗口 ${key} 钱包扩展未加载（重试将重启浏览器窗口）`)
  }

  /** 等一次钱包弹窗 → 解锁 → 指定意图；弹窗未出现返回 popupFailed=true（静默连接容忍） */
  async runIntent(intent: WalletIntent, opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> {
    const key = this.deps.walletKey
    if (!key) throw new Error('任务未配置钱包')
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(key)
    const popupPromise = waitForPopup(this.deps.page.context(), adapter.extensionUrlPatterns, 60000)
    if (opts.reclick) {
      const start = Date.now()
      let appeared = false
      while (Date.now() - start < opts.reclick.afterMs) {
        const r = await Promise.race([
          popupPromise.then(() => 'popup' as const).catch(() => 'timeout' as const),
          new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 500)),
        ])
        if (r === 'popup') { appeared = true; break }
      }
      if (!appeared) await this.deps.human.click(opts.reclick.selector).catch(() => {})
    }
    const popup = (await popupPromise) as PopupPage | null
    if (!popup) return { popupFailed: true }
    const password = this.deps.walletPasswords[key]
    if (password && adapter.unlock) await adapter.unlock(popup, password)
    await adapter[intent](popup)
    return { popupFailed: false }
  }

  async login(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('connect', opts) }
  async sign(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('sign', opts) }
  async confirmTx(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('confirmTx', opts) }

  /** 完整登录编排，见 login-flow.ts */
  async ensureLoggedIn(spec: import('./login-flow').LoginSpec): Promise<{ skipped: boolean }> {
    const { ensureLoggedIn } = await import('./login-flow')
    return ensureLoggedIn(this, spec)
  }
}
```

> 说明：`runIntent` 中 `adapter[intent]` 的索引访问需在 `types.ts` 保持三方法同名；若 TS 报索引错误，
> 改为显式 `intent === 'connect' ? adapter.connect(popup) : intent === 'sign' ? adapter.sign(popup) : adapter.confirmTx(popup)`。

`src/automation/wallet/login-flow.ts`：

```ts
/**
 * 登录编排（automation/wallet 层）：竞速判登录态 → 点连接入口 → 露出钱包入口 → 按 intents 处理弹窗 → 等登录完成
 * 真机沉淀：静默连接容忍、AppKit 视图归一化、弹窗慢补点、token localStorage 刷新恢复
 * 依赖方向：依赖 ./actions、../dom、./appkit（运行时按需 import）
 */
import type { Probe } from '../dom'
import type { WalletActions, WalletIntent } from './actions'

export interface LoginSpec {
  loggedIn: Probe
  loggedOut: Probe
  connect?: string
  entry?:
    | { kind: 'direct' }
    | { kind: 'dialog'; confirm?: string }
    | { kind: 'appkit'; open: string; entryTestId: string; modalTestId?: string }
  intents?: WalletIntent[]
  waitLoggedInMs?: number
  recoverTexts?: string[]
  refreshEveryMs?: number
  attempts?: number
  reclickAfterMs?: number
}

export async function ensureLoggedIn(wallet: WalletActions, spec: LoginSpec): Promise<{ skipped: boolean }> {
  const deps = wallet.deps
  const { page } = deps
  await wallet.ready()
  const state0 = await raceState(wallet, spec, 20000)
  if (state0 === 'loggedIn') return { skipped: true }
  const attempts = spec.attempts ?? 2
  const reclickAfterMs = spec.reclickAfterMs ?? 8000
  for (let round = 0; round < attempts; round++) {
    if (round > 0) {
      await page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(5000)
    }
    if (spec.connect) await deps.human.click(spec.connect).catch(() => {})
    const entry = spec.entry
    if (entry?.kind === 'dialog' && entry.confirm) await deps.human.click(entry.confirm).catch(() => {})
    if (entry?.kind === 'appkit') {
      const { openAppKitWallet } = await import('./appkit')
      await openAppKitWallet(deps, entry)
    }
    const intents = spec.intents ?? ['connect']
    for (const intent of intents) {
      const { popupFailed } = await wallet.runIntent(intent, spec.connect
        ? { reclick: { selector: spec.connect, afterMs: reclickAfterMs } }
        : undefined)
      if (popupFailed) deps.log.info({ step: 'login' }, '钱包弹窗未出现（可能静默连接），以登录态判定')
    }
    const ok = await deps.recover(spec.loggedIn, {
      budgetMs: spec.waitLoggedInMs ?? 90000,
      refreshEveryMs: spec.refreshEveryMs ?? 25000,
      recoverTexts: spec.recoverTexts,
    })
    if (ok) return { skipped: false }
    const st = await raceState(wallet, spec, 15000)
    if (st === 'loggedIn') return { skipped: false }
  }
  throw new Error('登录未完成（等待已登录标志超时）')
}

/** 双探针竞速：loggedIn / loggedOut 谁先可见；都等不到返回 null */
async function raceState(wallet: WalletActions, spec: LoginSpec, timeoutMs: number): Promise<'loggedIn' | 'loggedOut' | null> {
  const deps = wallet.deps
  const { raceProbes } = await import('../dom')
  return raceProbes(deps.page, [['loggedIn', spec.loggedIn], ['loggedOut', spec.loggedOut]], timeoutMs) as Promise<'loggedIn' | 'loggedOut' | null>
}
```

> 说明：`appkit.ts` 需从「接收 TaskContext」改为「接收 `WalletActionsDeps`」（见 Task 7）。本任务先只
> 接入 `direct`/`dialog`，`appkit` 分支在 Task 7 接通；测试覆盖 direct。

`src/automation/wallet/index.ts`：

```ts
/**
 * wallet 能力出口（automation/wallet 层）
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { WalletRegistry } from './types'
export type { WalletAdapter, PopupPage, PopupLocator } from './types'
export { WalletActions } from './actions'
export type { WalletActionsDeps, PopupLoginOpts, WalletIntent } from './actions'
export { ensureLoggedIn } from './login-flow'
export type { LoginSpec } from './login-flow'
export { waitForPopup } from './popup'
export { WalletSession } from './session'
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/wallet-login-flow.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/wallet/actions.ts src/automation/wallet/login-flow.ts src/automation/wallet/index.ts tests/wallet-login-flow.test.ts
git commit -m "feat: 钱包动作门面与登录编排（WalletActions/ensureLoggedIn）"
```

---

### Task 7: `appkit` 迁入 wallet 目录并对齐 deps

**Files:**
- Modify: `src/automation/wallet/appkit.ts`（入参由 `TaskContext` 改 `WalletActionsDeps`）
- Modify: `src/engine/appkit.ts`（若存在旧文件，删除或改为 re-export；见下）
- Modify: `src/engine/task-context.ts`（`openAppKitWallet` 委托新实现）
- Test: `tests/appkit.test.ts`（适配）

**Interfaces:**
- Consumes: `WalletActionsDeps`（Task 6）
- Produces: `openAppKitWallet(deps: WalletActionsDeps, opts: AppKitEntry & { walletKey }): Promise<void>`；
  `interface AppKitEntry { open: string; entryTestId: string; modalTestId?: string }`

- [ ] **Step 1: 迁移实现**

将现有 `src/engine/appkit.ts` 的实现移到 `src/automation/wallet/appkit.ts`：
把 `ctx: TaskContext` 换成 `deps: WalletActionsDeps`，调用改为：
`deps.human.click(...)`、`probeVisible(deps.page, { selector })`、`deps.page.waitForTimeout(...)`、
`deps.walletKey`（`walletKey` 从 LoginSpec 传或单独参数），连接动作调 `deps` 内部 wallet 逻辑。
为最小改动，保留独立函数签名：

```ts
export async function openAppKitWallet(
  deps: WalletActionsDeps,
  entry: { open: string; entryTestId: string; modalTestId?: string },
): Promise<void> { /* 归一化逻辑同现有 appkit.ts，改用 deps.page/deps.human/deps.raceProbes */ }
```

（实现体：`deps.human.click(entry.open)` → 等 `[data-testid=modal]` → 归一化循环 →
点 `[data-testid=entryTestId]`；不再直接调 loginByWallet——弹窗连接由调用方 `runIntent` 负责。）

- [ ] **Step 2: 处理旧 engine/appkit.ts**

删除 `src/engine/appkit.ts` 的 `AppKitLoginOptions`/`openAppKitWallet`，`task-context.ts` 的
`openAppKitWallet` 方法改为：从 `src/automation/wallet` 导入并用 `this.walletActions` 调用。

- [ ] **Step 3: 适配测试**

`tests/appkit.test.ts`：把 fake `ctx` 改为 fake `WalletActionsDeps`（`page`/`human`/`raceProbes`），
断言语义不变（归一化四分支 + 入口点击）。

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/appkit.test.ts tests/wallet-login-flow.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/wallet/appkit.ts src/engine/appkit.ts src/engine/task-context.ts tests/appkit.test.ts
git commit -m "refactor: AppKit 归一化迁入 wallet 并改用 WalletActionsDeps"
```

---

### Task 8: `automation/index.ts` 总出口与 `TaskContext` 命名空间门面

**Files:**
- Create: `src/automation/index.ts`
- Modify: `src/engine/task-context.ts`（新增 `wallet` / `captcha` 命名空间、`step` / `race` / `recover`）
- Test: `tests/task-context-namespaces.test.ts`

**Interfaces:**
- Consumes: Task 1–7 全部出口
- Produces: `ctx.wallet: WalletActions`；`ctx.step(name, fn)`；`ctx.race(entries, ms)`；`ctx.recover(probe, opts)`；
  `ctx.page` 直用 patchright

- [ ] **Step 1: 写失败测试** `tests/task-context-namespaces.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { TaskContext, type SiteTask, type TaskMeta } from '../src/tasks/base'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake', name: '假', url: '' }
  async run() {}
}

function makeCtx(): TaskContext {
  return new TaskContext({
    page: {
      context: () => ({}),
      getByText: () => ({ first() { return this }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} }),
      locator: () => ({ first() { return this }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} }),
      waitForTimeout: async () => {},
      reload: async () => {},
      url: () => '',
    } as never,
    task: new FakeTask(),
    human: { click: async () => {} } as never,
    profile: { id: 1, bitbrowserId: 'bb', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('TaskContext 命名空间门面', () => {
  it('ctx.wallet 暴露 ready/login/sign/confirmTx/ensureLoggedIn', () => {
    const ctx = makeCtx()
    expect(typeof ctx.wallet.ready).toBe('function')
    expect(typeof ctx.wallet.login).toBe('function')
    expect(typeof ctx.wallet.sign).toBe('function')
    expect(typeof ctx.wallet.confirmTx).toBe('function')
    expect(typeof ctx.wallet.ensureLoggedIn).toBe('function')
  })

  it('ctx.step 返回结果并记录', async () => {
    const ctx = makeCtx()
    const out = await ctx.step('s', async () => 7)
    expect(out).toBe(7)
    expect(ctx.steps().map((x) => x.name)).toContain('s')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/task-context-namespaces.test.ts`
Expected: FAIL（`ctx.wallet`/`ctx.step` 不存在）

- [ ] **Step 3: 最小实现**

`src/automation/index.ts`：

```ts
/**
 * automation 能力库总出口：engine 层只从这里导入
 * 依赖方向：汇总 dom/wallet/captcha/diag
 */
export * from './dom'
export * from './wallet'
export { StepRecorder } from './diag'
export type { StepRecord } from './diag'
```

`src/engine/task-context.ts` 新增（顶部 import 改为 `from '../automation'`）：

```ts
import { WalletActions, StepRecorder, raceProbes, recoverProbe, type Probe, type RecoverOpts } from '../automation'

// 类内字段与方法：
  private recorder = new StepRecorder()
  private walletActionsInstance: WalletActions | null = null

  /** 钱包动作命名空间（ready/login/sign/confirmTx/ensureLoggedIn） */
  get wallet(): WalletActions {
    if (!this.walletActionsInstance) {
      this.walletActionsInstance = new WalletActions({
        page: this.page,
        walletKey: this.deps.task.meta.wallet,
        wallets: this.deps.wallets,
        walletPasswords: this.deps.walletPasswords,
        walletSession: this.deps.walletSession,
        log: this.log,
        human: { click: (s: string) => this.human.click(s) },
        recover: (probe: Probe, opts: RecoverOpts) => this.recover(probe, opts),
      })
    }
    return this.walletActionsInstance
  }

  /** 多探针竞速 */
  async race<K extends string>(entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null> {
    return raceProbes(this.page, entries, timeoutMs)
  }

  /** 刷新恢复等待（错误文案立即刷 + 周期刷 + 心跳） */
  async recover(probe: Probe, opts: RecoverOpts): Promise<boolean> {
    return recoverProbe(this.page, probe, this.log, opts)
  }

  /** 记录任务步骤（诊断时间线） */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.recorder.run(name, fn, this.log)
  }

  /** 已记录步骤 */
  steps() { return this.recorder.steps() }
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/task-context-namespaces.test.ts`；`npm run typecheck`；`npm test`
Expected: PASS（旧方法保留，全量回归绿）

- [ ] **Step 5: 提交**

```bash
git add src/automation/index.ts src/engine/task-context.ts tests/task-context-namespaces.test.ts
git commit -m "feat: automation 总出口 + TaskContext 命名空间门面（wallet/step/race/recover）"
```

---

### Task 9: `SiteTask` 模板方法（默认 run + action）

**Files:**
- Modify: `src/tasks/base.ts`
- Modify: `src/engine/task.ts`（re-export `LoginSpec`，满足 tasks→engine 分层，禁止 tasks 直接引 automation）
- Test: `tests/site-task-template.test.ts`

**Interfaces:**
- Consumes: `ctx.wallet.ensureLoggedIn`、`ctx.page`
- Produces: `SiteTask` 新增可选 `login?: LoginSpec` 与抽象 `action(ctx)`；默认 `run` 提供
  「清理标签页 → goto → ensureLoggedIn → action」；仍允许子类覆盖 `run`。

- [ ] **Step 1: 写失败测试** `tests/site-task-template.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { SiteTask, type TaskMeta } from '../src/tasks/base'
import type { TaskContext } from '../src/engine/task-context'

class T extends SiteTask {
  meta: TaskMeta = { key: 't', name: 'T', url: 'https://a.test/' }
  acted = false
  async action(): Promise<void> { this.acted = true }
}

describe('SiteTask 模板', () => {
  it('默认 run：goto 后调用 action', async () => {
    const goto = vi.fn(async () => {})
    const ctx = {
      page: { goto, context: () => ({ pages: () => [] }) },
      closeOtherTabs: vi.fn(async () => {}),
      wallet: { ensureLoggedIn: vi.fn(async () => ({ skipped: false })) },
    } as never as TaskContext
    const t = new T()
    await t.run(ctx)
    expect(goto).toHaveBeenCalled()
    expect(t.acted).toBe(true)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/site-task-template.test.ts`
Expected: FAIL（默认 run 未实现 / action 未定义）

- [ ] **Step 3: 最小实现**

`src/engine/task.ts` 末尾追加（engine→automation 合法；tasks 层经 engine 取得类型）：

```ts
/** 登录声明类型再导出：tasks 层经 engine 引用，避免 tasks 直接依赖 automation */
export type { LoginSpec } from '../automation/wallet'
```

`src/tasks/base.ts`：

```ts
import { TaskContext } from '../engine/task-context'
import type { TaskMeta, LoginSpec } from '../engine/task'
import type { LoginSpec } from '../automation/wallet'

export { TaskContext } from '../engine/task-context'
export type { TaskMeta } from '../engine/task'

/** 站点任务抽象类：默认 run 提供统一骨架，子类实现 action（可覆盖 run 处理多页等特殊情况） */
export abstract class SiteTask {
  abstract meta: TaskMeta
  /** 声明式登录（可选）：配置后默认 run 自动执行 ensureLoggedIn */
  login?: LoginSpec
  /** 任务主体：登录完成后要做的站点特有动作 */
  abstract action(ctx: TaskContext): Promise<void>

  /** 默认骨架：清理残留标签页 → goto → 登录 → action */
  async run(ctx: TaskContext): Promise<void> {
    for (const p of ctx.page.context().pages()) {
      if (p !== ctx.page) await p.close().catch(() => {})
    }
    if (this.meta.url) {
      await ctx.page.goto(this.meta.url, { timeout: 45000, waitUntil: 'domcontentloaded' })
    }
    if (this.login) await ctx.wallet.ensureLoggedIn(this.login)
    await this.action(ctx)
  }
}
```

> 兼容说明：既有任务实现的是 `run` 而非 `action`，本任务**仅新增**能力，不强制改旧任务；
> 旧任务继续覆盖 `run` 即可编译（抽象 `action` 会要求旧任务补一个空实现——若想避免，改为
> `action?` 可选 + 默认 `run` 内 `if (this.action) await this.action(ctx)`）。**采用后者**：
> `action?(ctx): Promise<void>`，默认 run 内判空调用。

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/site-task-template.test.ts`；`npm run typecheck`；`npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tasks/base.ts tests/site-task-template.test.ts
git commit -m "feat: SiteTask 模板方法（默认 run + action）"
```

---

### Task 10: 全量回归与收尾

**Files:** 无（仅验证）

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS（旧方法仍在，任务未迁移，行为不变）

- [ ] **Step 2: 确认新能力可用（冒烟）**

Run: `npx vitest run tests/dom-race.test.ts tests/dom-recover.test.ts tests/dom-click.test.ts tests/diag-recorder.test.ts tests/wallet.test.ts tests/wallet-login-flow.test.ts tests/appkit.test.ts tests/task-context-namespaces.test.ts tests/site-task-template.test.ts`
Expected: PASS

- [ ] **Step 3: 提交（如有改动）**

无改动则跳过。

---

## 后续计划（不在本计划范围，依赖本计划）

1. **任务重写与清理计划（P2/P3）**：迁移 8 个真实任务 + 3 个示例到新骨架（DOM 直调 patchright、
   登录改 `login` 声明、接 `ctx.step`）；随后删除旧方法（humanize/find/wait.*/clickCheckin…）、
   移除 `ghost-cursor`、重排 `docs/API-GUIDE.md`、加文档漂移守卫测试。
2. **诊断落库与面板计划（P4）**：`runs.diag_path` migrate、`window-runner` 失败时调
   `diag.bundle`、`GET /api/diagnostics`、看板失败行诊断视图。

## Self-Review

- **Spec coverage**：`dom/`（Task 1–3）、`diag/` 步骤记录（Task 4）、钱包四动作（Task 5）、
  `ensureLoggedIn`（Task 6）、AppKit 迁入（Task 7）、`automation/index.ts` + 命名空间门面（Task 8）、
  `SiteTask` 模板（Task 9）。spec 的任务重写/删除/文档/面板明确列入「后续计划」——本计划只交付
  可独立测试的能力库基础（符合 scope check）。
- **Placeholder scan**：无 TBD/TODO；新模块均含完整代码；钱包/appkit 为「改动 + 精确替换说明」。
- **Type consistency**：`Probe`/`RecoverOpts`/`WalletActionsDeps`/`LoginSpec`/`WalletIntent` 在
  Task 1/2/6 定义，Task 6/8/9 消费一致；`StepRecorder.run/steps` 在 Task 4 定义、Task 8 消费一致；
  `wallet.login/sign/confirmTx` 与适配器方法名一致。
- **注意点**：`WalletActions.runIntent` 的动态索引 `adapter[intent]` 若不通过严格模式，改用显式分支
  （已在 Task 6 注明）；`SiteTask.action` 采用可选以兼容旧任务（已在 Task 9 注明）。
```

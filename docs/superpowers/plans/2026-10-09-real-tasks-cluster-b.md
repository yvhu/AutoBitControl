# 真实任务重写（簇 B：直接登录任务）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2 个需钱包登录的任务（`konnex-checkin` / `portal-rhuna`）重写为新范式：`login: LoginSpec` + `ctx.wallet.ensureLoggedIn` + `ctx.page` 直调 + `ctx.race`/`ctx.recover`/`ctx.captcha.*`/`ctx.safeScreenshot`；并为 `LoginSpec` 补 `walletEntry`（站点弹窗内选钱包入口）。

**Architecture:** 增量改动（旧扁平方法仍存在，Plan 4 才删）。登录交给 `ensureLoggedIn`（竞速判登录态 → 点连接 → 弹窗选钱包 → 签名/确认 → 等登录完成，含静默连接容忍与刷新恢复）；站点业务（进入 Quests / 签到 / 领取 + 方框验证）保留原逻辑，仅换调用层。

**Tech Stack:** TypeScript（严格）、patchright 1.62.1、vitest 3.2。

## Global Constraints

- 依赖方向：`tasks → engine → automation/integrations → infrastructure`；`tasks` 层不直接 import `automation`（经 `./base`）；`RECOVER_TEXTS`/`DEFAULT_RELOAD_TIMEOUT_MS` 经 engine 再导出取得（避免 tasks 直连 infrastructure）。
- 任务里 DOM 直调 `ctx.page`（patchright）；截图 `ctx.safeScreenshot`；竞速 `ctx.race`；刷新恢复 `ctx.recover`；验证码 `ctx.captcha.*`。
- 站点业务逻辑行为等价（选择器、判定、阈值、方框重试语义不变）。
- 代码风格：无分号、单引号、2 空格缩进；文件头/注释中文。
- 提交风格：conventional + 中文，单行。
- 验证：`npx vitest run <file>`、`npm run typecheck`、`npm test`。
- 运行环境：Windows PowerShell 5.1；分支 `feat/task-thin-facade`。真机验证由用户执行（并发≤4；卡住 3 分钟暂停）。

---

### Task 1: `LoginSpec.walletEntry` + engine 常量再导出

**Files:**
- Modify: `src/automation/wallet/login-flow.ts`（`LoginSpec` 增加 `walletEntry?`；编排中点击它）
- Modify: `src/engine/task.ts`（再导出 `RECOVER_TEXTS`/`DEFAULT_RELOAD_TIMEOUT_MS`）
- Modify: `src/tasks/base.ts`（再导出上述两常量，供任务 `./base` 取用）
- Test: `tests/wallet-login-flow.test.ts`

**Interfaces:**
- Produces: `LoginSpec.walletEntry?: string` —— 站点弹窗内「钱包选择入口」（如 MetaMask），在 `dialog.confirm`/`appkit` 之后、等待扩展弹窗之前点击；同时作为 `reclick` 选择器。
- Produces: `BASE`/`task.ts` 再导出 `RECOVER_TEXTS`、`DEFAULT_RELOAD_TIMEOUT_MS`。

- [ ] **Step 1: 写失败测试**（`tests/wallet-login-flow.test.ts` 追加）

```ts
  it('walletEntry → 在该入口点击（软点），并作为补点选择器', async () => {
    vi.mocked(waitForPopup).mockResolvedValue(null)
    const d = deps()
    const spec: LoginSpec = {
      loggedIn: { text: '已登录' }, loggedOut: 'Connect Wallet',
      connect: '#connect',
      entry: { kind: 'dialog', confirm: '#eth' },
      walletEntry: 'text=MetaMask',
      attempts: 1, reclickAfterMs: 600,
    }
    await new WalletActions(d).ensureLoggedIn(spec)
    expect(d.clicks).toContain('text=MetaMask')
  })
```

（该测试的 fake `page.locator(sel).first().click` 已记录到 `clicks`；`human` 已移除。）

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/wallet-login-flow.test.ts`
Expected: FAIL（walletEntry 未实现）

- [ ] **Step 3: 实现**

`src/automation/wallet/login-flow.ts`：`LoginSpec` 增加字段

```ts
  /** 站点弹窗内「钱包选择入口」（如 MetaMask）；在 connect/dialog/appkit 之后、等扩展弹窗之前点击，并作为补点选择器 */
  walletEntry?: string
```

`ensureLoggedIn` 内：`entry` 处理之后、`intents` 之前点击 `walletEntry`；`reclickSelector` 优先取 `walletEntry`：

```ts
    if (spec.walletEntry) await clickSoft(spec.walletEntry)
    const intents = spec.intents ?? ['connect']
    const reclickSelector = entry?.kind === 'appkit'
      ? `[data-testid="${entry.entryTestId}"]`
      : (spec.walletEntry ?? spec.connect)
```

（`clickSoft` 即现有的软点击闭包。）

`src/engine/task.ts` 末尾追加：

```ts
/** 供 tasks 层经 engine 取得运行时常量（避免 tasks 直连 infrastructure） */
export { RECOVER_TEXTS, DEFAULT_RELOAD_TIMEOUT_MS } from '../infrastructure/constants'
```

`src/tasks/base.ts` 追加：

```ts
export { RECOVER_TEXTS, DEFAULT_RELOAD_TIMEOUT_MS } from '../engine/task'
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/wallet-login-flow.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/wallet/login-flow.ts src/engine/task.ts src/tasks/base.ts tests/wallet-login-flow.test.ts
git commit -m "feat: LoginSpec.walletEntry（站点弹窗选钱包入口）+ engine 再导出恢复常量"
```

---

### Task 2: `konnex-checkin` 重写

**Files:**
- Modify: `src/tasks/konnex-checkin.ts`
- Modify: `tests/konnex-checkin.test.ts`

**Interfaces:**
- Consumes: `SiteTask`、`LoginSpec`、`ctx.page`、`ctx.race`、`ctx.js`、`ctx.safeScreenshot`
- Produces: `KonnexCheckinTask`（`login` + `action`），私有 `checkin`/`checkinDone` 保留（测试用）

- [ ] **Step 1: 重写 `src/tasks/konnex-checkin.ts`（完整替换）**

```ts
/**
 * Konnex 签到任务：Check In (Weekly) 每周签到（+10 KP，每周一次）
 * 登录：Connect Wallet → 弹窗「Connect with Ethereum」→ 选 MetaMask → 钱包弹窗确认
 * 已签到两种卡片状态（Great job! 横幅 / RESETS IN 倒计时）都算成功
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

const BALANCE_TEXT = 'Balance'
const CONNECT_WALLET_BTN = '[data-testid="connect-wallet-button"]'
const ETHEREUM_ENTRY_TEXT = 'Connect with Ethereum'
const METAMASK_ENTRY_TEXT = 'MetaMask'
const CHECKIN_BTN = 'button:has-text("Check in")'
const CHECKIN_CARD = '#loyalty-quest-root-check_in'
const SUCCESS_TEXT = 'Check-In Succeeded!'
const DONE_TEXT = 'Great job!'
const RESET_TEXT = 'RESETS IN'

const CHECKIN_CARD_WAIT_MS = 45000
const CHECKIN_SUCCESS_WAIT_MS = 30000

export class KonnexCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'konnex-checkin',
    name: 'Konnex 签到',
    group: { key: 'konnex', name: 'Konnex' },
    url: 'https://hub.konnex.world/points',
    sourceUrl: ['https://cryptorank.io/zh/drophunting/konnex-activity1071', 'https://airdrops.io/konnex/'],
    note: '每周签到（+10 KP）；真机核实：登录后余额小部件 Balance 作登录态标记；签到按钮为唯一 button:has-text("Check in")；成功判定弹窗 h1（Check-In Succeeded!）；当周已签到显示 Great job! 横幅或暗态 RESETS IN，两种都算成功；卡片渲染有延迟；MetaMask 弹窗「连接/确认」由适配器自动处理',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'metamask',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  login: LoginSpec = {
    loggedIn: { text: BALANCE_TEXT },
    loggedOut: 'Connect Wallet',
    connect: CONNECT_WALLET_BTN,
    entry: { kind: 'dialog', confirm: `text=${ETHEREUM_ENTRY_TEXT}` },
    walletEntry: `text=${METAMASK_ENTRY_TEXT}`,
    intents: ['connect'],
  }

  async action(ctx: TaskContext): Promise<void> {
    await this.checkin(ctx)
  }

  /** 卡片当前是否可见 */
  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    try {
      const loc = ctx.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }

  /** 签到：等卡片渲染 → （已签到则成功）点 Check in → 竞速成功弹窗/已签到状态 */
  private async checkin(ctx: TaskContext): Promise<void> {
    const deadline = Date.now() + CHECKIN_CARD_WAIT_MS
    let hasBtn = false
    while (Date.now() < deadline) {
      hasBtn = await this.isVisible(ctx, CHECKIN_BTN)
      if (hasBtn) break
      if (await this.checkinDone(ctx)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '本周已签到（卡片为已签到状态）')
        await ctx.safeScreenshot('konnex-success')
        return
      }
      await ctx.page.waitForTimeout(2000)
    }
    if (!hasBtn) throw new Error('签到卡片未出现（Check in 按钮与已签到状态均无；页面异常或站点改版）')
    await ctx.page.locator(CHECKIN_BTN).first().click()
    const outcome = await ctx.race([['success', { text: SUCCESS_TEXT }], ['done', { text: DONE_TEXT }]], CHECKIN_SUCCESS_WAIT_MS)
    if (outcome === 'success' || outcome === 'done' || (await this.checkinDone(ctx))) {
      ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '签到成功（Check-In Succeeded!）')
      await ctx.safeScreenshot('konnex-success')
      return
    }
    const card = await ctx.js<string>(() => (document.querySelector('#loyalty-quest-root-check_in')?.textContent ?? '').trim().slice(0, 300)).catch(() => '')
    const headings = await ctx.js<string>(() => [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim()).filter(Boolean).join(' | ')).catch(() => '')
    throw new Error(`点击 Check in 后未出现成功弹窗（卡片: ${card || '无'}；h1: ${headings || '无'}；可能已签到/站点改版）`)
  }

  /** 卡片是否处于已签到状态：横幅 Great job! 或暗态 RESETS IN（任一即已签到） */
  private async checkinDone(ctx: TaskContext): Promise<boolean> {
    if (await this.isVisible(ctx, `${CHECKIN_CARD}:has-text("${DONE_TEXT}")`)) return true
    return this.isVisible(ctx, `${CHECKIN_CARD}:has-text("${RESET_TEXT}")`)
  }
}
```

- [ ] **Step 2: 适配 `tests/konnex-checkin.test.ts`**

1. `makeCtx`：删除 `human: { click }` → `human: {} as never`。
2. `makeFakePage` 的 `locator(sel).first()` 增加 `click: vi.fn(async () => { clicks.push(sel) })`（暴露 `clicks` 数组给测试）；保留 `count`/`isVisible`。
3. 把断言 `ctx.human.click).toHaveBeenCalledWith('button:has-text("Check in")')` 改为 `clicks).toContain(CHECKIN_BTN)`（或字面量）；`not.toHaveBeenCalled()` 改为 `clicks).toHaveLength(0)`。
4. `helpers` 类型保持不变（`checkin`/`checkinDone` 仍是私有方法名）。
5. `ctx.js`/`ctx.race` 走 `page.evaluate`/`getByText().waitFor`（fake 已支持）；`safeScreenshot` 内部调 `page.screenshot`（fake 的 `screenshot` 已按 `screenshotFails` 抛错），断言不变。

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/konnex-checkin.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/konnex-checkin.ts tests/konnex-checkin.test.ts
git commit -m "refactor: konnex-checkin 改用 LoginSpec/SiteTask + patchright 直调"
```

- [ ] **Step 5: 真机验证（用户执行）**

`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=konnex-checkin npm run task:run`（未登录窗口 + 当周已签到窗口各一）。

---

### Task 3: `portal-rhuna` 重写

**Files:**
- Modify: `src/tasks/portal-rhuna.ts`
- Modify: `tests/portal-rhuna.test.ts`

**Interfaces:**
- Consumes: `SiteTask`、`LoginSpec`、`ctx.page`、`ctx.race`、`ctx.recover`、`ctx.captcha.*`、`ctx.js`、`ctx.safeScreenshot`、`RECOVER_TEXTS`（经 `./base`）
- Produces: `PortalRhunaTask`（`login` + `action`），私有 `tryClickTurnstile`/`claimLoop` 保留

- [ ] **Step 1: 重写 `src/tasks/portal-rhuna.ts`（完整替换）**

```ts
/**
 * Rhuna 签到任务：Daily Check-in（+20 pts）
 * 登录：Petra（点 Connect Wallet 直接唤起 prompt.html，Sign In 签名）
 * 站点 token 存 localStorage，全程刷新恢复导向
 * 依赖方向：仅依赖 ./base（常量 RECOVER_TEXTS 经 base 取）
 */
import { SiteTask, RECOVER_TEXTS, type LoginSpec, type TaskContext, type TaskMeta } from './base'

const HELLO_TEXT = 'Hello,'
const CONNECT_TEXT = 'Connect Wallet'
const START_QUESTS_TEXT = 'Start Quests'
const CHECKIN_TEXT = 'Daily Check-in'
const SUCCESS_TEXT = 'Quest completed successfully!'
const PROCESSING_TEXT = 'Processing your quest...'

const HELLO_WAIT_MS = 60000
const CHECKIN_ROUNDS = 6
const CLAIM_RACE_MS = 15000
const CLAIM_RECHECK_MS = 10000
const SUCCESS_WAIT_MS = 60000
const DIALOG_SELECTOR = '[role="dialog"]'

export class PortalRhunaTask extends SiteTask {
  meta: TaskMeta = {
    key: 'portal-rhuna',
    name: 'Rhuna 签到',
    group: { key: 'portal', name: 'Portal' },
    url: 'https://portal.rhuna.io/',
    sourceUrl: ['https://cryptorank.io/zh/drophunting/rhuna-activity958'],
    note: '真机核实：登录用 Petra（点 Connect Wallet 直接唤起扩展弹窗 prompt.html，无站内钱包选择）；弹窗流程为输密码+Unlock → Sign In 签名；Petra 不注入页面 provider，就绪判定靠 CDP；站点间歇性报 Network Error，token 存 localStorage，刷新即恢复；领取时弹出 Turnstile 方框，点方框即完成（ISP IP 一点即过）',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'petra',
    timeoutSec: 1200,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 2,
  }

  login: LoginSpec = {
    loggedIn: { text: HELLO_TEXT },
    loggedOut: CONNECT_TEXT,
    connect: 'button:has-text("Connect Wallet"):visible',
    entry: { kind: 'direct' },
    intents: ['sign'],
  }

  async action(ctx: TaskContext): Promise<void> {
    await this.enterQuests(ctx)
    await this.checkin(ctx)
  }

  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    try {
      const loc = ctx.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }

  private async firstTextPresent(ctx: TaskContext, texts: string[]): Promise<string> {
    for (const t of texts) {
      if ((await ctx.page.getByText(t, { exact: false }).count()) > 0) return t
    }
    return ''
  }

  /** 进 Quests 页：Start Quests 优先（含刷新恢复），兜底直达 /quests */
  private async enterQuests(ctx: TaskContext): Promise<void> {
    const startBtn = `button:has-text("${START_QUESTS_TEXT}")`
    if (await this.isVisible(ctx, startBtn)) {
      await ctx.page.locator(startBtn).first().click()
      if (await ctx.recover({ text: CHECKIN_TEXT }, { budgetMs: 60000, refreshEveryMs: 25000, recoverTexts: RECOVER_TEXTS })) return
    }
    await ctx.page.goto('https://portal.rhuna.io/quests', { timeout: 45000, waitUntil: 'domcontentloaded' })
    if (await ctx.recover({ text: CHECKIN_TEXT }, { budgetMs: 60000, refreshEveryMs: 25000, recoverTexts: RECOVER_TEXTS })) return
    throw new Error('Quests 页未出现 Daily Check-in（页面或网络异常）')
  }

  /** 点 Daily Check-in 卡片 → 弹窗竞速 → 领取/已领收尾（最多 CHECKIN_ROUNDS 轮） */
  private async checkin(ctx: TaskContext): Promise<void> {
    for (let round = 0; round < CHECKIN_ROUNDS; round++) {
      try {
        await ctx.page.locator(`div.cursor-pointer:has-text("${CHECKIN_TEXT}")`).first().click()
        await ctx.page.locator(DIALOG_SELECTOR).first().waitFor({ state: 'visible', timeout: 15000 })
      } catch {
        ctx.log.info({ step: 'recover', window: ctx.profile.name }, '领取弹窗打开失败，刷新恢复')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      const outcome = await ctx.race([['success', { text: SUCCESS_TEXT }], ['claim', { text: 'Claim' }]], CLAIM_RACE_MS)
      if (outcome === 'success') {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '今日已领取（弹窗直接显示完成）')
        await ctx.safeScreenshot('rhuna-success')
        return
      }
      if (outcome !== 'claim') {
        const modalText = await ctx.js<string>(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 300)).catch(() => '')
        ctx.log.warn({ step: 'checkin', window: ctx.profile.name, modalText }, '弹窗内未出现 Claim/完成提示，下一轮重开')
        continue
      }
      const claimBtn = '[role="dialog"] button:has-text("Claim")'
      await ctx.page.locator(claimBtn).first().click()
      await ctx.captcha.autoClick()
      const processing = await ctx.race([['processing', { text: PROCESSING_TEXT }], ['success', { text: SUCCESS_TEXT }]], CLAIM_RECHECK_MS)
      if (processing === null) {
        await ctx.page.locator(claimBtn).first().click().catch(() => {})
      }
      if (await this.claimLoop(ctx, claimBtn)) {
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '签到成功（Quest completed successfully!）')
        await ctx.safeScreenshot('rhuna-success')
        return
      }
      const modalText = await ctx.js<string>(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 300)).catch(() => '')
      ctx.log.warn({ step: 'checkin', window: ctx.profile.name, modalText }, '点 Claim 后等待完成提示超时，下一轮重开')
    }
    throw new Error('Daily Check-in 领取未完成（弹窗内未出现完成提示）')
  }

  /** 方框点击容错：瞬时 CDP 拒绝不打断领取 */
  private async tryClickTurnstile(ctx: TaskContext): Promise<'clicked' | 'absent' | 'rejected'> {
    try {
      return (await ctx.captcha.turnstile()) ? 'clicked' : 'absent'
    } catch (e) {
      const msg = (e as Error).message
      if (!/Protocol error|session closed|Target page|target crashed|Navigation failed|Execution context was destroyed|browser has been closed/i.test(msg)) throw e
      ctx.log.warn({ step: 'turnstile', window: ctx.profile.name, err: msg }, '验证方框点击持续被浏览器拒绝（iframe 重渲染），进入冷却期后重试')
      return 'rejected'
    }
  }

  /** Claim 后等待完成循环（单轮内）：成功=true；处理中耐心等；Claim 重现补点；错误/停滞后刷新 */
  private async claimLoop(ctx: TaskContext, claimBtn: string): Promise<boolean> {
    const end = Date.now() + SUCCESS_WAIT_MS
    let clicks = 0
    let lastRefresh = Date.now()
    let lastCheckClick = 0
    let lastCheckLog = 0
    while (Date.now() < end) {
      if (await ctx.page.getByText(SUCCESS_TEXT, { exact: false }).count() > 0) return true
      if (Date.now() - lastCheckClick > 15000) {
        const result = await this.tryClickTurnstile(ctx)
        if (result === 'clicked' || result === 'rejected') lastCheckClick = Date.now()
        if (result === 'clicked') continue
      }
      if (lastCheckClick > 0 && Date.now() - lastCheckClick < 15000 && Date.now() - lastCheckLog > 30000 && (await ctx.captcha.visible())) {
        lastCheckLog = Date.now()
        ctx.log.info({ step: 'checkin', window: ctx.profile.name }, '验证方框已点击但仍存在（验证未通过），冷却期满后重点')
      }
      const errText = await this.firstTextPresent(ctx, RECOVER_TEXTS)
      if (errText !== '') {
        ctx.log.info({ step: 'recover', window: ctx.profile.name, errText }, '领取等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      if ((await ctx.page.getByText(PROCESSING_TEXT, { exact: false }).count()) > 0) {
        await ctx.page.waitForTimeout(3000)
        continue
      }
      if (clicks < 3 && await this.isVisible(ctx, claimBtn)) {
        await ctx.page.locator(claimBtn).first().click().catch(() => {})
        clicks++
        ctx.log.info({ step: 'checkin', window: ctx.profile.name, clicks }, 'Claim 按钮重新出现，补点')
        continue
      }
      if (Date.now() - lastRefresh >= 30000) {
        ctx.log.info({ step: 'recover', window: ctx.profile.name }, '刷新页面恢复（错误提示或周期刷新）')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    return false
  }
}
```

- [ ] **Step 2: 适配 `tests/portal-rhuna.test.ts`**

测试只覆盖 `tryClickTurnstile` 容错分支。改为对 `ctx.captcha.turnstile` 注入：
1. `makeCtx` 保留（`human: {} as never`）。
2. 每个用例用 `Object.defineProperty(ctx, 'captcha', { value: { turnstile: vi.fn().mockResolvedValue(true) }, configurable: true })` 替换实现：
   - 成功 → `mockResolvedValue(true)` → 期望 `'clicked'`。
   - 未出现 → `mockResolvedValue(false)` → `'absent'`。
   - 瞬时 CDP 拒绝 → `mockRejectedValue(new Error(CDP_REJECTED_ERR))` → `'rejected'` 且 `log.warn` 一次（`{ step:'turnstile', window:'窗口1', err: contains 'Protocol error' }`）。
   - 非瞬时 → `mockRejectedValue(new Error('点击失败: 找不到元素 iframe'))` → rejects。
3. `helpers` 类型仍断言 `tryClickTurnstile`（私有方法名保留）。

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/portal-rhuna.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/portal-rhuna.ts tests/portal-rhuna.test.ts
git commit -m "refactor: portal-rhuna 改用 LoginSpec/SiteTask + patchright/ctx.captcha 直调"
```

- [ ] **Step 5: 真机验证（用户执行）**

`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=portal-rhuna npm run task:run`（已领 / 待领 / 未登录窗口覆盖）。

---

### Task 4: 全量回归与真机验证清单

**Files:** 无（验证）

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS

- [ ] **Step 2: 聚焦簇 B**

Run: `npx vitest run tests/konnex-checkin.test.ts tests/portal-rhuna.test.ts tests/wallet-login-flow.test.ts`
Expected: PASS

- [ ] **Step 3: 真机验证清单（用户执行）**

- `konnex-checkin`：未登录 + 当周已签到（横幅/暗态）
- `portal-rhuna`：未登录登录 + 已领取 + 待领取（含 Turnstile 方框）
失败按 AGENTS 规范停下带日志/截图求助。

---

## Self-Review

- **Spec coverage**：簇 B 两任务改为 `login: LoginSpec` + `ensureLoggedIn` + patchright 直调；`LoginSpec.walletEntry` 补齐「站点弹窗选钱包」；`RECOVER_TEXTS` 经 engine 再导出（消除 tasks→infrastructure 直连）。其余簇 C、清理、文档、诊断面板在后续计划。
- **Placeholder scan**：无 TBD；两份任务文件为完整替换；测试为精确编辑说明。
- **Type consistency**：`walletEntry` 在 Task 1 定义、Task 2（konnex）消费；`ctx.race` 收 `[key, Probe]`；`ctx.captcha.turnstile/visible/autoClick` 签名匹配；`tryClickTurnstile`/`checkin`/`checkinDone` 方法名保留以维持测试契约。
- **风险**：`ensureLoggedIn` 的 `intents`（portal-rhuna 用 `['sign']`、konnex 用 `['connect']`）需真机确认；portal-rhuna 的方框容错正则内联（未从 constants 取 `CDP_TRANSIENT_PATTERN`，因该常量在 infrastructure；如需可经 engine 再导出，留待 Plan 4 统一）。

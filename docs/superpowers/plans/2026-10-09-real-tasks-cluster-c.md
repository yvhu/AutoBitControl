# 真实任务重写（簇 C：AppKit / 多签任务）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把最复杂的 2 个任务（`inception-dachain` AppKit 开箱 / `xyz-shelbynet` 站内弹窗 + 双签名 + 文件上传）重写为新范式：`login: LoginSpec` + `ctx.wallet.ensureLoggedIn` + `ctx.page` 直调 + `ctx.race`/`ctx.recover`/`ctx.wallet.sign`/`ctx.safeScreenshot`。

**Architecture:** 增量改动（旧扁平方法仍存在，Plan 4 才删）。登录交给 `ensureLoggedIn`：inception 用 `connect`(Enter Inception) + `entry.appkit`(WALLET→MetaMask)；shelby-explorer 用 `connect`(Connect Wallet) + `entry.dialog`(弹窗内 Connect，静默连接容忍)。站点业务（开箱循环 / 文件上传与查询/双签）保留原逻辑，仅换调用层。

**Tech Stack:** TypeScript（严格）、patchright 1.62.1、vitest 3.2（fake page / 真实 chromium + fixture）。

## Global Constraints

- 依赖方向：`tasks → engine → automation/integrations → infrastructure`；`tasks` 层不直接 import `automation`（经 `./base`）。
- DOM 直调 `ctx.page`（patchright）；截图 `ctx.safeScreenshot`；竞速 `ctx.race`；恢复 `ctx.recover`；等待加载/隐藏用 `ctx.page.locator().waitFor`。
- 站点业务逻辑行为等价（选择器、判定、阈值不变）。
- 代码风格：无分号、单引号、2 空格缩进；文件头/注释中文。
- 提交风格：conventional + 中文，单行。
- 验证：`npx vitest run <file>`、`npm run typecheck`、`npm test`。
- 运行环境：Windows PowerShell 5.1；分支 `feat/task-thin-facade`。真机验证由用户执行。

---

### Task 1: `inception-dachain` 重写

**Files:**
- Modify: `src/tasks/inception-dachain.ts`
- Modify: `tests/inception-dachain.test.ts`

**Interfaces:**
- Consumes: `SiteTask`、`LoginSpec`、`ctx.page`、`ctx.race`、`ctx.js`、`ctx.safeScreenshot`
- Produces: `InceptionDachainTask`（`login` + `action`），私有 `raceAfterOpenFree`/`raceReveal`/`dailyOpens`/`revealInModal` 保留（测试用）

- [ ] **Step 1: 重写 `src/tasks/inception-dachain.ts`（完整替换）**

```ts
/**
 * DAC Inception 任务：量子箱开箱（每日 5 箱）
 * 登录：Enter Inception → Get Started 弹窗点 WALLET → AppKit 归一化 → MetaMask
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

const LIMIT_TEXT = 'Daily limit reached'
const MODAL_TITLE = 'What is inside?'
const REVEAL_TEXTS = ['You Won', 'Better luck next time']
const INSUFFICIENT_TEXT = 'Insufficient QE'
const SIDEBAR_TEXT = 'Quantum Crate'
const ENTER_TEXT = 'Enter Inception'
const METAMASK_ENTRY = 'wallet-selector-io.metamask'

const GET_STARTED_WAIT_MS = 45000
const CRATE_PAGE_WAIT_MS = 20000
const CRATE_PAGE_ATTEMPTS = 2
const CRATE_LOOP_MAX = 8
const OPEN_FREE_RACE_MS = 6000
const OPEN_FREE_ATTEMPTS = 3
const REVEAL_TOTAL_MS = 120000
const REVEAL_RECLICK_AT_MS = 45000
const MODAL_GONE_MS = 10000

type RaceKey = 'loggedIn' | 'landing' | 'limit' | 'modal' | 'revealed' | 'insufficient'

export class InceptionDachainTask extends SiteTask {
  meta: TaskMeta = {
    key: 'inception-dachain',
    name: 'DAC 签到',
    group: { key: 'inception', name: 'Inception' },
    url: 'https://inception.dachain.io/',
    sourceUrl: ['https://airdrops.io/dac/', 'https://cryptorank.io/zh/drophunting/arc-chain-activity911'],
    note: '真机核实：免费箱按钮实为 OPEN FOR 150 QE（余额 ≥150 QE 才可点）；弹窗 Close 常驻，开箱结果需等 You Won / Better luck next time；每日 5 箱上限；登录：Enter Inception → Get Started 点 WALLET → AppKit 归一化点 MetaMask；MetaMask 中文界面（适配器按 testid）',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'metamask',
    timeoutSec: 900,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  login: LoginSpec = {
    loggedIn: { text: SIDEBAR_TEXT },
    loggedOut: ENTER_TEXT,
    connect: `button:has-text("${ENTER_TEXT}")`,
    entry: { kind: 'appkit', open: 'button:has-text("WALLET")', entryTestId: METAMASK_ENTRY },
    intents: ['connect'],
  }

  async action(ctx: TaskContext): Promise<void> {
    await this.enterCratePage(ctx)
    await this.openCrates(ctx)
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

  /** 点 Open Free 后竞速：上限提示 / 开箱弹窗 / 余额不足 */
  private raceAfterOpenFree(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    return ctx.race([['limit', { text: LIMIT_TEXT }], ['modal', { text: MODAL_TITLE }], ['insufficient', { text: INSUFFICIENT_TEXT }]], timeoutMs)
  }

  /** 开箱结果竞速：结果文案任一 / 余额不足 / 弹窗内上限提示 */
  private raceReveal(ctx: TaskContext, timeoutMs: number): Promise<RaceKey | null> {
    const entries: Array<[RaceKey, { text: string }]> = [
      ...REVEAL_TEXTS.map((t) => ['revealed', { text: t }] as [RaceKey, { text: string }]),
      ['insufficient', { text: INSUFFICIENT_TEXT }],
      ['limit', { text: LIMIT_TEXT }],
    ]
    return ctx.race(entries, timeoutMs)
  }

  /** 读页面每日开箱计数器（DAILY OPENS x/y）；解析失败返回 null */
  private async dailyOpens(ctx: TaskContext): Promise<{ opened: number; total: number } | null> {
    return ctx.js<{ opened: number; total: number } | null>(() => {
      const text = (document as unknown as { body?: { innerText?: string } }).body?.innerText ?? ''
      const m = text.match(/DAILY[\s|]*OPENS[\s|]*(\d+)\s*\/\s*(\d+)/)
      return m ? { opened: Number(m[1]), total: Number(m[2]) } : null
    }).catch(() => null)
  }

  private async finishAtLimit(ctx: TaskContext, signal: string): Promise<void> {
    ctx.log.info({ step: 'crates', window: ctx.profile.name, signal }, '每日上限已达成')
    await ctx.safeScreenshot('dac-success')
  }

  /** 点左侧目录栏 Quantum Crate → 等 Open Free；点击可能未生效则补点 */
  private async enterCratePage(ctx: TaskContext): Promise<void> {
    for (let attempt = 0; attempt < CRATE_PAGE_ATTEMPTS; attempt++) {
      await ctx.page.locator(`button:has-text("${SIDEBAR_TEXT}")`).first().click()
      try {
        await ctx.page.getByText('Open Free', { exact: false }).first().waitFor({ state: 'visible', timeout: CRATE_PAGE_WAIT_MS })
        ctx.log.info({ step: 'crates', window: ctx.profile.name }, '进入开箱页面')
        return
      } catch {
        // SPA 路由未生效，补点
      }
    }
    throw new Error('点击 Quantum Crate 后未出现开箱页面（等待 Open Free 超时）')
  }

  /** 反复开箱，直到出现每日上限（toast / 页面计数器 / 弹窗内提示） */
  private async openCrates(ctx: TaskContext): Promise<void> {
    for (let i = 0; i < CRATE_LOOP_MAX; i++) {
      const info = await this.dailyOpens(ctx)
      if (info && info.opened >= info.total) {
        await this.finishAtLimit(ctx, `counter ${info.opened}/${info.total}`)
        return
      }
      let outcome: RaceKey | null = null
      for (let attempt = 0; attempt < OPEN_FREE_ATTEMPTS && !outcome; attempt++) {
        await ctx.page.locator('button:has-text("Open Free")').first().click()
        outcome = await this.raceAfterOpenFree(ctx, OPEN_FREE_RACE_MS)
      }
      if (outcome === 'limit') {
        await this.finishAtLimit(ctx, 'toast')
        return
      }
      if (outcome === 'insufficient') throw new Error('QE 余额不足（Insufficient QE），无法继续开箱')
      if (outcome !== 'modal') throw new Error('点击 Open Free 后既无开箱弹窗也无每日上限提示（页面或网络异常）')

      const revealed = await this.revealInModal(ctx)
      if (revealed === 'limit') {
        await this.finishAtLimit(ctx, 'modal')
        return
      }
      if (revealed === 'insufficient') throw new Error('QE 余额不足（Insufficient QE），无法继续开箱')
      if (revealed !== 'revealed') throw new Error('等待开箱结果超时（视频/接口过慢）')
      await ctx.page.locator('button:has-text("Close")').first().click()
      await this.waitGoneOrHidden(ctx, `text=${MODAL_TITLE}`, MODAL_GONE_MS)
      ctx.log.info({ step: 'crates', window: ctx.profile.name, opened: i + 1 }, '开箱完成')
    }
    throw new Error('开箱次数超过预期仍未出现每日上限提示')
  }

  /** 弹窗内开箱并等结果（结果 / 余额不足 / 弹窗内上限提示 / 超时 null） */
  private async revealInModal(ctx: TaskContext): Promise<RaceKey | null> {
    const deadline = Date.now() + REVEAL_TOTAL_MS
    await ctx.page.locator('button:has-text("Open for")').first().click()
    let revealed = await this.raceReveal(ctx, REVEAL_RECLICK_AT_MS)
    if (!revealed && (await this.isVisible(ctx, 'button:has-text("Open for")'))) {
      await ctx.page.locator('button:has-text("Open for")').first().click()
    }
    if (!revealed) revealed = await this.raceReveal(ctx, Math.max(0, deadline - Date.now()))
    return revealed
  }

  /** 等元素消失或隐藏（最多 timeoutMs） */
  private async waitGoneOrHidden(ctx: TaskContext, selector: string, timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (!(await this.isVisible(ctx, selector))) return
      await ctx.page.waitForTimeout(500)
    }
  }
}
```

> 说明：原 `clickCheckin('Enter Inception', {assert:'Get Started'})` 的「等 Get Started」语义并入 `ensureLoggedIn`（connect 点击后 appkit 打开会等 modal）；`ensureWalletReady` 由 `ensureLoggedIn→wallet.ready()` 覆盖。

- [ ] **Step 2: 适配 `tests/inception-dachain.test.ts`**

1. `makeFakePage` 的 `locator(sel).first()` 增加 `click: vi.fn().mockResolvedValue(undefined)`；`makeCtx` 的 `human` 已经 `{} as never`，无需改。
2. `revealInModal` 用例里的假 page：`locator().first()` 增加 `click`（`const click = vi.fn()...`）；把 `human: { click }` 移除，改为在假 page 的 locator click 上计数；断言 `click` 次数（首次 + 45s 补点 = 2）不变（改为对假 page 的 click mock 断言）。
3. `raceAfterOpenFree`/`raceReveal`：现在走 `ctx.race([['k',{text}]],ms)` → `raceProbes` → `getByText(text,{exact:false}).first().waitFor({state:'visible',timeout})`。假 page 的 getByText 已按 textDelays 实现 `waitFor`，兼容。断言不变。
4. `dailyOpens` 用例：`ctx.js` 经 `page.evaluate(fn, undefined, {}, false)`；假 ctx 的 evaluate 已注入 fake document.body.innerText，兼容。断言不变。

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/inception-dachain.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/inception-dachain.ts tests/inception-dachain.test.ts
git commit -m "refactor: inception-dachain 改用 LoginSpec(connect+appkit)/SiteTask + patchright 直调"
```

- [ ] **Step 5: 真机验证（用户执行）**

`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=inception-dachain npm run task:run`（未登录 + 已登录 + 已达上限窗口）。

---

### Task 2: `xyz-shelbynet`（shelby-explorer）重写

**Files:**
- Modify: `src/tasks/shelby-explorer.ts`
- Modify: `tests/shelby-explorer.test.ts`

**Interfaces:**
- Consumes: `SiteTask`、`LoginSpec`、`ctx.page`、`ctx.wallet.ensureLoggedIn`/`sign`、`ctx.account`、`ctx.uploadFile`、`ctx.safeScreenshot`、`ctx.race`
- Produces: `ShelbyExplorerTask`（`login` + `action`），`ALREADY_DONE_TEXT` 仍导出；可覆盖测试用时间预算字段保留

- [ ] **Step 1: 重写 `src/tasks/shelby-explorer.ts`（完整替换）**

> 保留原有时间预算可覆盖字段（`successWaitMs`/`loginWaitMs`/`uploadEntryWaitMs`/`uploadEnabledWaitMs`/`uploadDialogWaitMs`/`walletDialogWaitMs`/`walletDialogReclickMs`/`accountBaseUrl`）以维持既有测试契约。

```ts
/**
 * Shelby Explorer 上传任务（xyz-shelbynet）：Petra 登录 + 账号页上传文件（数据源「文件地址」列）
 * 站内 Petra Web 弹窗：点弹窗内 Connect（Aptos 默认=Petra）后静默连接；登录结果以 header 0x 地址为准
 * 上传：隐藏 file input → 选文件（站点立即查重：已上传直接 Blob name already taken 视为成功）→ Upload → 两次签名
 * 依赖方向：仅依赖 ./base
 */
import { SiteTask, RECOVER_TEXTS, type LoginSpec, type TaskContext, type TaskMeta } from './base'

const ADDRESS_SELECTOR = 'header button:has-text("0x")'
const CONNECT_SELECTOR = 'header button:has-text("Connect Wallet")'
const DIALOG_SELECTOR = '[role="dialog"]'
const DIALOG_CONNECT_SELECTOR = '[role="dialog"] button:has-text("Connect")'
const UPLOAD_FILES_SELECTOR = 'button:has-text("Upload Files")'
const FILE_INPUT_SELECTOR = '[role="dialog"] input[type="file"]'
const UPLOAD_BUTTON_SELECTOR = '[role="dialog"] button:has-text("Upload")'
const UPLOADING_TEXT = 'Uploading files'
const SUCCESS_TEXT = 'All files uploaded successfully'
export const ALREADY_DONE_TEXT = 'Blob name already taken'

const REFRESH_EVERY_MS = 30000

export class ShelbyExplorerTask extends SiteTask {
  successWaitMs = 180000
  loginWaitMs = 120000
  uploadEntryWaitMs = 120000
  uploadEnabledWaitMs = 30000
  uploadDialogWaitMs = 20000
  walletDialogWaitMs = 45000
  walletDialogReclickMs = 8000
  accountBaseUrl = 'https://explorer.shelby.xyz'

  meta: TaskMeta = {
    key: 'xyz-shelbynet',
    name: 'shelbynet 上传任务',
    group: { key: 'shelby', name: 'Shelby' },
    url: 'https://explorer.shelby.xyz/shelbynet',
    sourceUrl: 'https://cryptorank.io/zh/drophunting/shelby-activity1120',
    note: '真机核实（2026-09-07）：站内 Petra Web 弹窗（非 AppKit），点弹窗内 Connect 后静默连接（扩展已授权无钱包弹窗），登录态以 header 0x 地址按钮为准（首页表格全是 0x 不能全页判定）；上传入口在账号页 Upload Files；file input 隐藏；选文件后站点立即查重——已上传直接 Blob name already taken 且 Upload 永不启用→短路视为成功；未上传则点 Upload 触发两次签名（register_multiple_blobs → commit_object）；成功文案 All files uploaded successfully；上传中不刷新防打断在途请求',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'petra',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 60 },
    concurrency: 4,
    requiresFileAssign: true,
  }

  login: LoginSpec = {
    loggedIn: { selector: ADDRESS_SELECTOR },
    loggedOut: { selector: CONNECT_SELECTOR },
    connect: CONNECT_SELECTOR,
    entry: { kind: 'dialog', confirm: DIALOG_CONNECT_SELECTOR },
    intents: ['connect'],
    waitLoggedInMs: 120000,
  }

  async action(ctx: TaskContext): Promise<void> {
    await this.doLoginIfNeeded(ctx)
    await this.upload(ctx)
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

  /** 账号页会话未恢复时的重新登录（复用 login 声明） */
  private async doLoginIfNeeded(ctx: TaskContext): Promise<void> {
    // 初始 ensureLoggedIn 已由 SiteTask.run 完成；此处仅在账号页会话失效时兜底重登
    if (await this.isVisible(ctx, ADDRESS_SELECTOR)) return
    await ctx.wallet.ensureLoggedIn(this.login)
  }

  /** 上传流程 */
  private async upload(ctx: TaskContext): Promise<void> {
    const address = await ctx.account('petra钱包地址')
    const accountUrl = `${this.accountBaseUrl}/shelbynet/account/${address}/blobs`
    await ctx.page.goto(accountUrl, { timeout: 45000, waitUntil: 'domcontentloaded' })
    if (!(await this.waitSelectorRecover(ctx, UPLOAD_FILES_SELECTOR, this.uploadEntryWaitMs))) {
      await this.doLoginIfNeeded(ctx)
      await ctx.page.goto(accountUrl, { timeout: 45000, waitUntil: 'domcontentloaded' })
      if (!(await this.waitSelectorRecover(ctx, UPLOAD_FILES_SELECTOR, this.uploadEntryWaitMs))) {
        throw new Error('账号页未出现 Upload Files（页面改版或登录态未恢复）')
      }
    }
    let inputAttached = false
    for (let round = 0; round < 2 && !inputAttached; round++) {
      if (round > 0) ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传弹窗未出现，补点 Upload Files')
      await ctx.page.locator(UPLOAD_FILES_SELECTOR).first().click().catch(() => {})
      inputAttached = await this.waitAttached(ctx, FILE_INPUT_SELECTOR, this.uploadDialogWaitMs)
    }
    if (!inputAttached) throw new Error('上传弹窗未出现 file input（弹窗结构异常或点击落空）')
    await ctx.uploadFile(FILE_INPUT_SELECTOR, await ctx.account('文件地址'))
    const settle = await this.waitSettle(ctx)
    if (settle === 'alreadyDone') {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '文件已上传过（Blob name already taken），视为成功')
      await ctx.safeScreenshot('shelby-explorer-success')
      return
    }
    await ctx.page.locator(UPLOAD_BUTTON_SELECTOR).first().click()
    // 双签名：register_multiple_blobs → commit_object（各一次钱包弹窗）
    for (let i = 0; i < 2; i++) {
      const { popupFailed } = await ctx.wallet.sign()
      if (popupFailed) ctx.log.info({ step: 'upload', window: ctx.profile.name }, '钱包弹窗未出现（可能文件已上传不再发起签名），继续等待终态')
    }
    const outcome = await this.waitSuccess(ctx)
    if (outcome === 'alreadyDone') {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '文件已上传过（Blob name already taken），视为成功')
    } else {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传完成（All files uploaded successfully）')
    }
    await ctx.safeScreenshot('shelby-explorer-success')
  }

  /** 选文件后终态分叉：已上传 → alreadyDone；未上传 → Upload 启用 → enabled */
  private async waitSettle(ctx: TaskContext): Promise<'alreadyDone' | 'enabled'> {
    const end = Date.now() + this.uploadEnabledWaitMs
    while (Date.now() < end) {
      if ((await ctx.page.getByText(ALREADY_DONE_TEXT, { exact: false }).count()) > 0) return 'alreadyDone'
      const disabled = await ctx.page.locator(UPLOAD_BUTTON_SELECTOR).first().isDisabled().catch(() => true)
      if (!disabled) return 'enabled'
      await ctx.page.waitForTimeout(1000)
    }
    throw new Error('选文件后 Upload 按钮未启用且无已上传提示（文件过大或上传弹窗状态异常）')
  }

  /** 等元素挂载（hidden 的 file input 不能用可见性判定） */
  private async waitAttached(ctx: TaskContext, selector: string, budgetMs: number): Promise<boolean> {
    const end = Date.now() + budgetMs
    while (Date.now() < end) {
      const n = await ctx.page.locator(selector).count().catch(() => 0)
      if (n > 0) return true
      await ctx.page.waitForTimeout(1000)
    }
    return false
  }

  /** 等选择器可见（刷新恢复导向：错误立即刷 + 每 30s 周期刷） */
  private async waitSelectorRecover(ctx: TaskContext, selector: string, budgetMs: number): Promise<boolean> {
    return ctx.recover({ selector }, { budgetMs, refreshEveryMs: REFRESH_EVERY_MS, recoverTexts: RECOVER_TEXTS })
  }

  /** 等终态：上传成功 / 已上传过；错误且不在上传中才刷新 */
  private async waitSuccess(ctx: TaskContext): Promise<'uploaded' | 'alreadyDone'> {
    const end = Date.now() + this.successWaitMs
    while (Date.now() < end) {
      if ((await ctx.page.getByText(SUCCESS_TEXT, { exact: false }).count()) > 0) return 'uploaded'
      if ((await ctx.page.getByText(ALREADY_DONE_TEXT, { exact: false }).count()) > 0) return 'alreadyDone'
      let errText = ''
      for (const t of RECOVER_TEXTS) { if ((await ctx.page.getByText(t, { exact: false }).count()) > 0) { errText = t; break } }
      const uploading = (await ctx.page.getByText(UPLOADING_TEXT, { exact: false }).count()) > 0
      if (errText !== '' && !uploading) {
        ctx.log.info({ step: 'upload', window: ctx.profile.name, errText }, '上传等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    throw new Error(`上传未完成（等待 ${SUCCESS_TEXT} 或 ${ALREADY_DONE_TEXT} 超时）`)
  }
}
```

> 说明：`waitForSelectorRecover`/`waitSuccess` 的恢复循环改走 `ctx.recover` 与内联 `getByText` 计数；`login` 的静默连接容忍由 `ensureLoggedIn` 承担（`popupFailed` 不判失败）；上传双签由 `ctx.wallet.sign()`（一次弹窗一次签名）完成。

- [ ] **Step 2: 适配 `tests/shelby-explorer.test.ts`**

该测试与旧 ctx 深度耦合，按下述映射重写 `makeCtx` 的假实现与断言：
1. 删除对 `ctx.closeOtherTabs`/`ctx.goto`/`ctx.ensureWalletReady`/`ctx.assertVisible`/`ctx.loginByWallet`/`ctx.textPresent`/`ctx.recoverErrorText`/`ctx.visible` 的 stub。
2. 假 `page` 需支持：`context: () => ({ pages: () => [] })`、`goto: vi.fn()`、`locator(sel)`（按选择器返回带 `click`/`count`/`isVisible`/`isDisabled`/`inputValue`/`fill` 的对象）、`getByText(t,{exact})`（`count` 按可配置集合）、`reload`、`waitForTimeout`、`evaluate`。
3. 登录态：`loggedIn`/`loggedOut` 是选择器探针（`ADDRESS_SELECTOR`/`CONNECT_SELECTOR`）→ `ensureLoggedIn` 用 `raceProbes` 读 `locator(sel).first().isVisible()`；用假 `page.locator` 或 `page.getByText` 驱动。**注意 `ensureLoggedIn` 现在由默认 `run` 调用**；测试若直接调 `task.run(ctx)`，需让假 page 支持 `context().pages()` 与 `goto`；若直接调 `task.action(ctx)` 可绕过登录。
   - 「已登录」用例：让 `locator(ADDRESS_SELECTOR).isVisible() → true`；断言 `ctx.loginByWallet` 不再存在，改为断言 `ctx.wallet.sign` 被调 2 次（或经注入 `Object.defineProperty(ctx,'wallet',...)`）。
   - 「未登录」用例：`locator(ADDRESS_SELECTOR).isVisible()` 先 false 后 true（触发登录）。
4. 双签断言：`ctx.loginByWallet` 2 次 → `ctx.wallet.sign` 2 次（通过 `Object.defineProperty(ctx,'wallet',{ value: { sign: vi.fn(async () => ({ popupFailed: false })), ensureLoggedIn: vi.fn(async () => ({ skipped: false })) }, configurable: true })` 注入）。
5. `ctx.uploadFile`/`ctx.account` 仍是 ctx 方法（保留 stub）。
6. `ctx.screenshot` 仍 stub（`safeScreenshot` 内部调用它）。
7. 登录静默连接容忍用例：让 `ctx.wallet.sign`/`ensureLoggedIn` 不抛；断言不再依赖 `loginByWallet` 抛错。
8. 集成测试：`human: new Humanizer(page)` → `human: {} as never`；钱包弹窗无法模拟 → 注入 `ctx.wallet`（`ensureLoggedIn`/`sign` 均为 `async () => ({ skipped/popupFailed: false })`），其余走真实页面 `page.goto`/`locator`/`getByText`；断言成功文案与签名次数。

> 若逐条改写测试工作量过大，可保留测试的**行为断言**（成功/已上传短路/严格模式/按钮未启用/上传弹窗缺失/错误刷新），只替换「假实现的桩点」与「登录/签名断言目标」。不得删除用例或弱化断言。

- [ ] **Step 3: 运行验证通过**

Run: `npx vitest run tests/shelby-explorer.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tasks/shelby-explorer.ts tests/shelby-explorer.test.ts
git commit -m "refactor: shelby-explorer 改用 LoginSpec/SiteTask + ctx.wallet.sign 直调"
```

- [ ] **Step 5: 真机验证（用户执行）**

`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=xyz-shelbynet npm run task:run`（未上传 + 已上传路径各一）。

---

### Task 3: 全量回归与真机验证清单

**Files:** 无（验证）

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS

- [ ] **Step 2: 聚焦簇 C**

Run: `npx vitest run tests/inception-dachain.test.ts tests/shelby-explorer.test.ts`
Expected: PASS

- [ ] **Step 3: 真机验证清单（用户执行）**

- `inception-dachain`：未登录 + 已登录 + 已达上限
- `xyz-shelbynet`：未上传（双签）+ 已上传（Blob name already taken 短路）
失败按 AGENTS 规范停下带日志/截图求助。

---

## Self-Review

- **Spec coverage**：簇 C 两任务改为 `login: LoginSpec` + `ensureLoggedIn` + patchright/`ctx.wallet.sign` 直调。其余（清理、文档、诊断面板）在后续计划。
- **Placeholder scan**：无 TBD；两份任务文件为完整替换；测试为精确编辑说明（shelby-explorer 测试耦合最深，给映射而非逐行）。
- **Type consistency**：`LoginSpec`（含 `entry.dialog`/`entry.appkit`/selector 探针）在 Plan 3b/1 已定义；`ctx.wallet.sign()` 返回 `{ popupFailed }`；`ctx.race` 收 `[key, {text}]`；`ctx.recover` 收 `Probe`。
- **风险**：inception 的 `connect`(Enter Inception) 与 `entry.appkit`(WALLET) 之间的 Get Started 弹窗渲染时序需真机确认（原代码有 `assert 'Get Started'` 等待，现由 appkit 的 modal 等待部分覆盖）；shelby-explorer 测试改写量大，须保断言强度。

# Shelby Explorer 上传任务（xyz-shelbynet）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增任务 `xyz-shelbynet`：Petra 登录 Shelby Explorer 后上传数据源「文件地址」列的文件。成功判定两条：`All files uploaded successfully`（新上传成功）或 `Error: Blob name already taken`（文件已上传过，视为成功幂等收敛）。

**Architecture:** 新建 `src/tasks/shelby-explorer.ts`（继承 SiteTask），全部复用现有 TaskContext 能力（detectPageState / loginByWallet / uploadFile / waitForTextRecover / textPresent / recoverErrorText / screenshot）；选择器为最佳猜测，真机验证任务（Task 3）按实际页面迭代。单测用注入假 ctx 锁定流程逻辑，集成测试用本地 chromium + fixture 验证全链路（钱包弹窗存根）。

**Tech Stack:** TypeScript 严格模式、patchright、vitest、node:http fixture

## Global Constraints

- 所有注释/文档/commit message 用中文；commit 风格 conventional：`feat:`/`fix:`/`chore:`/`docs:` + 中文描述
- 代码风格：无分号、单引号、2 空格缩进、TS 严格模式；命名 camelCase，文件 kebab-case；文件头中文注释块说明模块职责与依赖方向
- 日志用 logger（中文消息，格式 `logger.info({count}, '消息')`）
- 分层依赖：tasks → engine；任务代码只经 TaskContext 使用引擎能力
- 任务 key 全局唯一；`enabled: true` 为代码默认值（真机调试用 `task:run` 脚本，不受开关限制）
- 改完代码验证：`npm run typecheck` 和 `npm test` 都要过
- 不提交 `config/accounts.xlsx`、`config/.env` 等真实数据文件

---

### Task 1: 任务文件 + 注册 + 单测（TDD）

**Files:**
- Create: `src/tasks/shelby-explorer.ts`
- Create: `tests/shelby-explorer.test.ts`
- Modify: `src/tasks/index.ts`（ALL 数组登记）

**Interfaces:**
- Consumes: `SiteTask`、`TaskContext`、`type TaskMeta`（`src/tasks/base.ts`）；`DEFAULT_RELOAD_TIMEOUT_MS`（`src/infrastructure/constants.ts`）
- Produces: `export class ShelbyExplorerTask extends SiteTask`，公开字段 `successWaitMs = 180000`（上传成功等待预算毫秒，测试覆盖缩短）；`meta` 契约：key `xyz-shelbynet`、name `shelbynet 上传任务`、url `https://explorer.shelby.xyz/shelbynet`、sourceUrl `https://cryptorank.io/zh/drophunting/shelby-activity1120`、category `checkin`、lastUpdated `2026-09-07`、enabled `true`、wallet `petra`、timeoutSec `600`、retry `{ max: 2, backoffSec: 120 }`、captcha `{ auto: true }`、concurrency `4`

- [ ] **Step 1: 写失败的单测**

创建 `tests/shelby-explorer.test.ts`：

```ts
/**
 * ShelbyExplorerTask 单测：登录分支 / 上传流程 / 数据源严格模式（注入假 ctx，不连真浏览器）
 * 背景：真机选择器尚未核实（见本计划 Task 3），单测锁定流程逻辑与错误语义，
 * 使后续选择器迭代不破坏已验证的行为
 */
import { describe, it, expect, vi } from 'vitest'
import { ShelbyExplorerTask } from '../src/tasks/shelby-explorer'
import { TaskContext } from '../src/tasks/base'

/** 构造注入假依赖的 TaskContext：run 用到的全部 ctx 能力替换为假实现 */
function makeCtx(task = new ShelbyExplorerTask()) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const page = {
    reload: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  }
  const human = { click: vi.fn().mockResolvedValue(undefined) }
  const ctx = new TaskContext({
    page: page as never,
    task,
    human: human as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: { petra: 'pw' },
    accountRow: { 文件地址: 'C:\\files\\a.png' },
  })
  ctx.closeOtherTabs = vi.fn().mockResolvedValue(undefined)
  ctx.goto = vi.fn().mockResolvedValue(undefined)
  ctx.detectPageState = vi.fn().mockResolvedValue('loggedIn')
  ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
  ctx.assertVisible = vi.fn().mockResolvedValue(undefined)
  ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
  ctx.waitForTextRecover = vi.fn().mockResolvedValue(true)
  ctx.uploadFile = vi.fn().mockResolvedValue(undefined)
  ctx.account = vi.fn().mockResolvedValue('C:\\files\\a.png')
  ctx.textPresent = vi.fn().mockResolvedValue(true)
  ctx.recoverErrorText = vi.fn().mockResolvedValue('')
  ctx.screenshot = vi.fn().mockResolvedValue('/tmp/s.png')
  return { ctx, log, human }
}

describe('ShelbyExplorerTask run 流程', () => {
  it('已登录：跳过登录，仅上传两次 Approve（loginByWallet 共 2 次）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.detectPageState = vi.fn().mockResolvedValue('loggedIn')
    await task.run(ctx)
    expect(ctx.closeOtherTabs).toHaveBeenCalled()
    expect(ctx.goto).toHaveBeenCalled()
    expect(ctx.ensureWalletReady).not.toHaveBeenCalled()
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(2)
    expect(ctx.uploadFile).toHaveBeenCalledTimes(1)
    expect((ctx.uploadFile as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('C:\\files\\a.png')
    expect(ctx.screenshot).toHaveBeenCalled()
  })

  it('未登录：走登录流程（loginByWallet 共 3 次 = 1 登录 + 2 Approve），日志含未登录', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, log } = makeCtx(task)
    ctx.detectPageState = vi.fn().mockResolvedValue('landing')
    await task.run(ctx)
    expect(ctx.ensureWalletReady).toHaveBeenCalled()
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('未登录'))).toBe(true)
  })

  it('登录后 0x 地址未出现 → 抛登录未完成', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.detectPageState = vi.fn().mockResolvedValue('landing')
    ctx.waitForTextRecover = vi.fn().mockResolvedValue(false)
    await expect(task.run(ctx)).rejects.toThrow('登录未完成')
  })

  it('数据源缺「文件地址」列 → 严格模式抛错（不硬跑）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.account = vi.fn().mockRejectedValue(new Error('数据源缺少列: 文件地址（可用列: ...）'))
    await expect(task.run(ctx)).rejects.toThrow('数据源缺少列')
    expect(ctx.loginByWallet).not.toHaveBeenCalled()
  })

  it('成功文案超时 → 抛上传未完成；错误文案且不在上传中 → 刷新恢复', async () => {
    const task = new ShelbyExplorerTask()
    task.successWaitMs = 10
    const { ctx } = makeCtx(task)
    ctx.textPresent = vi.fn().mockResolvedValue(false)
    ctx.recoverErrorText = vi.fn().mockResolvedValue('Network Error')
    await expect(task.run(ctx)).rejects.toThrow('上传未完成')
    expect(ctx.page.reload).toHaveBeenCalled()
  })
})

describe('ShelbyExplorerTask 元信息', () => {
  it('meta 契约正确', () => {
    const t = new ShelbyExplorerTask()
    expect(t.meta.key).toBe('xyz-shelbynet')
    expect(t.meta.name).toBe('shelbynet 上传任务')
    expect(t.meta.url).toBe('https://explorer.shelby.xyz/shelbynet')
    expect(t.meta.wallet).toBe('petra')
    expect(t.meta.category).toBe('checkin')
    expect(t.meta.enabled).toBe(true)
    expect(t.meta.timeoutSec).toBe(600)
    expect(t.meta.retry).toEqual({ max: 2, backoffSec: 120 })
    expect(t.meta.concurrency).toBe(4)
  })
})
```

- [ ] **Step 2: 跑单测确认失败**

Run: `npx vitest run tests/shelby-explorer.test.ts`
Expected: FAIL（`Failed to resolve import "../src/tasks/shelby-explorer"`，文件不存在）

- [ ] **Step 3: 写任务实现**

创建 `src/tasks/shelby-explorer.ts`：

```ts
/**
 * Shelby Explorer 上传任务（xyz-shelbynet）：Petra 登录 + 上传文件（数据源「文件地址」列）
 * 依赖方向：仅依赖 ./base 与 infrastructure/constants，经 index.ts 登记
 * 流程（按用户操作步骤 + 最佳猜测选择器，真机核实后修正）：
 *   打开 explorer.shelby.xyz/shelbynet → 竞速判定登录态（header 0x 地址 / Connect Wallet）
 *   → 未登录：点 header Connect Wallet → 站内弹窗选 Petra → Petra 扩展弹窗（密码 Unlock → Approve）
 *   → 等 0x 地址出现（登录完成）→ 点 0x 地址 → 页面出现 Upload Files
 *   → 点 Upload Files 打开上传弹窗 → setInputFiles 选数据源文件 → 点 Upload
 *   → 两次 Petra Approve 弹窗（loginByWallet ×2）→ 等 All files uploaded successfully
 * 可重复任务：无「已领取」短路，每次执行都走完整上传流程
 * 待真机核实（task:run 单窗口验证，见实施计划 Task 3）：
 *   1. 站内钱包弹窗结构（AppKit 还是自定义；Petra 入口选择器与 Connect 按钮）
 *   2. 登录是否自动切换网络到 Shelbynet；不切换则补 Petra 扩展内切链步骤
 *   3. 上传弹窗是否有 input[type="file"]（拖拽区则换 CDP 方案）
 *   4. 首页是否还有其它 0x 文案干扰登录态判定
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '../infrastructure/constants'

// —— 站点文案（真机核实后修正）——
/** 已登录标志：header 出现 0x 开头钱包地址 */
const ADDRESS_TEXT = '0x'
/** 未登录落地页按钮文案 */
const CONNECT_TEXT = 'Connect Wallet'
/** 上传任务入口按钮文案（点 0x 地址后出现） */
const UPLOAD_FILES_TEXT = 'Upload Files'
/** 上传中弹窗文案（上传中不刷新页面，防打断在途请求） */
const UPLOADING_TEXT = 'Uploading files'
/** 成功判定文案 */
const SUCCESS_TEXT = 'All files uploaded successfully'
/** 可恢复错误文案（刷新恢复，沿用 portal-rhuna 真机经验） */
const RECOVER_ERROR_TEXTS = ['Network Error', 'Turnstile token request timed out']

// —— 时间配置（真机实测后校准）——
/** 登录态竞速首轮等待（SPA 渲染有延迟，真机经验放宽到 20s） */
const STATE_WAIT_MS = 20000
/** 登录完成等待预算（0x 地址出现，后端链路约 5s，放宽到 60s） */
const LOGIN_WAIT_MS = 60000
/** 上传入口等待预算（点 0x 地址后 Upload Files 出现） */
const UPLOAD_ENTRY_WAIT_MS = 60000

export class ShelbyExplorerTask extends SiteTask {
  /** 上传成功等待预算毫秒（测试覆盖缩短；上传大文件 + 双签名耗时，放宽到 180s） */
  successWaitMs = 180000

  meta: TaskMeta = {
    key: 'xyz-shelbynet',
    name: 'shelbynet 上传任务',
    url: 'https://explorer.shelby.xyz/shelbynet',
    sourceUrl: 'https://cryptorank.io/zh/drophunting/shelby-activity1120',
    note: '可重复任务（每次全流程上传，无已领取短路）；登录 Petra；成功判定 All files uploaded successfully；上传文件取自数据源「文件地址」列（严格模式，缺列/空值即失败）；上传后两次钱包 Approve 弹窗（loginByWallet ×2）；上传中不刷新防打断在途请求；选择器为最佳猜测，待真机核实（站内钱包弹窗结构/网络是否自动切 Shelbynet/上传弹窗 file input/首页 0x 文案干扰）',
    category: 'checkin',
    lastUpdated: '2026-09-07',
    enabled: true,
    wallet: 'petra',
    // 上传大文件 + 双签名耗时，放宽单次超时
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 120 },
    captcha: { auto: true },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
    await ctx.closeOtherTabs()
    await ctx.goto()

    // 登录状态竞速判定：SPA 渲染有延迟，已登录窗口误入登录分支会假报失败；
    // 状态不明时反复刷新（每轮两种状态都认，已登录窗口刷新后直接走已登录分支）
    const state = await ctx.detectPageState({
      loggedInText: ADDRESS_TEXT,
      landingText: CONNECT_TEXT,
      waitMs: STATE_WAIT_MS,
      rounds: 10,
      roundWaitMs: 15000,
      reloadTimeoutMs: DEFAULT_RELOAD_TIMEOUT_MS,
    })
    if (state === 'landing') {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '未登录，进入 Petra 登录流程')
      await this.login(ctx)
    } else {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '已登录（cookie 有效），跳过登录')
    }

    await this.upload(ctx)
  }

  /** Petra 登录：Connect Wallet → 站内弹窗选 Petra → 扩展弹窗（密码 Unlock → Approve）→ 等 0x 出现 */
  private async login(ctx: TaskContext): Promise<void> {
    await ctx.ensureWalletReady()
    const connectBtn = 'header button:has-text("Connect Wallet")'
    await ctx.human.click(connectBtn)
    // 站内钱包弹窗：Aptos 分区下的 Petra 入口（结构真机核实；若为 AppKit 弹窗改用 openAppKitWallet）
    const petraEntry = 'button:has-text("Petra")'
    await ctx.assertVisible(petraEntry, 20000)
    await ctx.human.click(petraEntry)
    await ctx.loginByWallet({ reclick: { selector: petraEntry, afterMs: 8000 } })
    // 等登录完成（header 出现 0x 地址）；站点 token 存 localStorage：每 25s 主动刷新恢复
    if (!(await ctx.waitForTextRecover(ADDRESS_TEXT, { budgetMs: LOGIN_WAIT_MS, refreshEveryMs: 25000, recoverTexts: RECOVER_ERROR_TEXTS }))) {
      throw new Error('钱包签名后登录未完成（等待 0x 地址出现超时，站点登录接口慢或该窗口账号异常）')
    }
  }

  /** 上传流程：点 0x 地址 → Upload Files → 选文件 → Upload → 双 Approve → 等成功文案 */
  private async upload(ctx: TaskContext): Promise<void> {
    await ctx.human.click('header button:has-text("0x")')
    if (!(await ctx.waitForTextRecover(UPLOAD_FILES_TEXT, { budgetMs: UPLOAD_ENTRY_WAIT_MS, refreshEveryMs: 25000, recoverTexts: RECOVER_ERROR_TEXTS }))) {
      throw new Error('点击 0x 地址后未出现 Upload Files（页面改版或入口变化）')
    }
    await ctx.human.click(`button:has-text("${UPLOAD_FILES_TEXT}")`)
    // 上传弹窗 → 选文件（严格模式：缺列/空值即失败，数据没备齐不该硬跑）
    const fileInput = '[role="dialog"] input[type="file"]'
    await ctx.assertVisible(fileInput, 20000)
    await ctx.uploadFile(fileInput, await ctx.account('文件地址'))
    await ctx.human.click('[role="dialog"] button:text-is("Upload")')
    // 双钱包确认：第一个 Approve 弹窗关闭后再等第二个（Petra 适配器自动点 Approve 至弹窗关闭）
    await ctx.loginByWallet()
    await ctx.loginByWallet()
    await this.waitSuccess(ctx)
    ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传完成（All files uploaded successfully）')
    await ctx.screenshot('shelby-explorer-success')
  }

  /** 等成功文案：可恢复错误且不在上传中才刷新（上传中刷新会打断在途请求） */
  private async waitSuccess(ctx: TaskContext): Promise<void> {
    const end = Date.now() + this.successWaitMs
    while (Date.now() < end) {
      if (await ctx.textPresent(SUCCESS_TEXT)) return
      const errText = await ctx.recoverErrorText(RECOVER_ERROR_TEXTS)
      const uploading = await ctx.textPresent(UPLOADING_TEXT)
      if (errText !== '' && !uploading) {
        ctx.log.info({ step: 'upload', window: ctx.profile.name, errText }, '上传等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    throw new Error(`上传未完成（等待 ${SUCCESS_TEXT} 超时）`)
  }
}
```

- [ ] **Step 4: 注册任务**

编辑 `src/tasks/index.ts`：

```ts
import { ShelbyFaucetTask } from './shelby-faucet'
import { ShelbyExplorerTask } from './shelby-explorer'
```

ALL 数组末尾追加 `new ShelbyExplorerTask()`：

```ts
const ALL: SiteTask[] = [new ExampleCheckinTask(), new FaucetExampleTask(), new MintExampleTask(), new InceptionDachainTask(), new PortalRhunaTask(), new ShelbyFaucetTask(), new ShelbyExplorerTask()]
```

- [ ] **Step 5: 跑单测确认通过**

Run: `npx vitest run tests/shelby-explorer.test.ts`
Expected: PASS（6 个用例全过）

- [ ] **Step 6: typecheck + 全量测试**

Run: `npm run typecheck`
Expected: 无输出（通过）

Run: `npm test`
Expected: 全部通过（含既有 28 个测试文件）

- [ ] **Step 7: Commit**

```powershell
git add src/tasks/shelby-explorer.ts src/tasks/index.ts tests/shelby-explorer.test.ts
git commit -m "feat: 新增 Shelby Explorer 上传任务（xyz-shelbynet）"
```

---

### Task 2: 集成测试（本地 chromium + fixture 全链路）

**Files:**
- Create: `tests/fixtures/shelby-explorer.html`
- Modify: `tests/shelby-explorer.test.ts`（追加集成 describe）

**Interfaces:**
- Consumes: `ShelbyExplorerTask`、`TaskContext`（Task 1 产物）；`Humanizer`（`src/automation/humanize.ts`）；patchright `chromium`
- Produces: 无新接口（测试增量）

- [ ] **Step 1: 写 fixture 页面**

创建 `tests/fixtures/shelby-explorer.html`：

```html
<!doctype html>
<html lang="en">
<body>
  <header>
    <button id="connect">Connect Wallet</button>
  </header>
  <div id="wallet-modal" style="display:none">
    <button class="petra">Petra</button>
  </div>
  <div id="upload-entry" style="display:none">
    <button id="upload-files">Upload Files</button>
  </div>
  <div id="upload-dialog" role="dialog" style="display:none">
    <input type="file" />
    <button id="upload">Upload</button>
    <div id="status"></div>
  </div>
  <script>
    document.getElementById('connect').addEventListener('click', () => {
      const btn = document.getElementById('connect')
      if (btn.textContent.startsWith('0x')) {
        document.getElementById('upload-entry').style.display = 'block'
        return
      }
      document.getElementById('wallet-modal').style.display = 'block'
    })
    document.querySelector('.petra').addEventListener('click', () => {
      document.getElementById('connect').textContent = '0x1234567890abcdef'
      document.getElementById('wallet-modal').style.display = 'none'
    })
    document.getElementById('upload-files').addEventListener('click', () => {
      document.getElementById('upload-dialog').style.display = 'block'
    })
    document.getElementById('upload').addEventListener('click', () => {
      const status = document.getElementById('status')
      status.textContent = 'Uploading files…'
      setTimeout(() => {
        status.textContent = 'All files uploaded successfully'
      }, 500)
    })
  </script>
</body>
</html>
```

- [ ] **Step 2: 追加集成测试**

在 `tests/shelby-explorer.test.ts` 顶部追加导入：

```ts
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { Humanizer } from '../src/automation/humanize'
```

文件末尾追加集成 describe：

```ts
describe('ShelbyExplorerTask 集成（真实浏览器 + 本地 fixture，钱包弹窗存根）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'shelby-explorer.html'), 'utf-8'))
    })
    await new Promise<void>((r) => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('run() 完整流程：登录态 → 登录 → 点 0x → 上传 → 双确认 → 成功文案', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      // 真实临时文件（uploadFile 的 setInputFiles 要求文件存在）
      const uploadFilePath = join(tmpdir(), `shelby-explorer-${Date.now()}.txt`)
      writeFileSync(uploadFilePath, 'hello shelby')
      const task = new ShelbyExplorerTask()
      task.meta.url = baseUrl + '/shelbynet'
      const ctx = new TaskContext({
        page,
        task,
        human: new Humanizer(page),
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-explorer-test-artifacts'),
        walletPasswords: { petra: 'pw' },
        accountRow: { 文件地址: uploadFilePath },
      })
      // 钱包扩展弹窗无法在测试浏览器模拟：登录/Approve 弹窗全部存根（站点侧状态由 fixture 模拟）
      ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
      ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
      await task.run(ctx)
      expect(await page.getByText('All files uploaded successfully').count()).toBeGreaterThan(0)
      expect(ctx.loginByWallet).toHaveBeenCalledTimes(3)
    } finally {
      await browser.close()
    }
  }, 90000)
})
```

- [ ] **Step 3: 跑集成测试确认通过**

Run: `npx vitest run tests/shelby-explorer.test.ts`
Expected: PASS（单测 6 个 + 集成 1 个全过）

- [ ] **Step 4: typecheck + 全量测试**

Run: `npm run typecheck` → Expected: 无输出（通过）
Run: `npm test` → Expected: 全部通过

- [ ] **Step 5: Commit**

```powershell
git add tests/shelby-explorer.test.ts tests/fixtures/shelby-explorer.html
git commit -m "test: Shelby Explorer 上传任务集成测试（fixture 全链路）"
```

---

### Task 3: 已上传判定（Blob name already taken → 成功）

**Files:**
- Modify: `src/tasks/shelby-explorer.ts`（waitSuccess 加已上传分支 + 常量/注释/note）
- Modify: `tests/shelby-explorer.test.ts`（新增已上传/上传中不刷新用例 + meta 断言补齐）
- Modify: `tests/fixtures/shelby-explorer.html`（`?alreadydone` 查询参数模拟已上传错误）+ 追加集成用例

**Interfaces:**
- Consumes: `ShelbyExplorerTask`（Task 1 产物）、fixture 与集成 describe（Task 2 产物）
- Produces: `waitSuccess` 返回 `'uploaded' | 'alreadyDone'`；常量 `ALREADY_DONE_TEXT = 'Blob name already taken'`（模块级，测试引用）

背景（用户 2026-09-07 实测）：每窗口的文件（blob name）只能发送一次，重复上传报 `Error: Blob name already taken`——该文案出现视为「已上传=成功」，幂等收敛，不判失败。

- [ ] **Step 1: 改任务实现（waitSuccess 已上传分支）**

编辑 `src/tasks/shelby-explorer.ts`：

1. 在 `SUCCESS_TEXT` 常量后新增：

```ts
/** 已上传判定文案（文件 blob name 唯一，重复上传即报此错误，视为成功幂等收敛） */
const ALREADY_DONE_TEXT = 'Blob name already taken'
```

2. `upload()` 中调用 `waitSuccess` 处替换为：

```ts
    const outcome = await this.waitSuccess(ctx)
    if (outcome === 'alreadyDone') {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '文件已上传过（Blob name already taken），视为成功')
    } else {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传完成（All files uploaded successfully）')
    }
    await ctx.screenshot('shelby-explorer-success')
```

3. `waitSuccess` 整体替换为：

```ts
  /**
   * 等终态：新上传成功 / 已上传过（Blob name already taken，同样算成功）/
   * 可恢复错误且不在上传中才刷新（上传中刷新会打断在途请求）
   */
  private async waitSuccess(ctx: TaskContext): Promise<'uploaded' | 'alreadyDone'> {
    const end = Date.now() + this.successWaitMs
    while (Date.now() < end) {
      if (await ctx.textPresent(SUCCESS_TEXT)) return 'uploaded'
      if (await ctx.textPresent(ALREADY_DONE_TEXT)) return 'alreadyDone'
      const errText = await ctx.recoverErrorText(RECOVER_ERROR_TEXTS)
      const uploading = await ctx.textPresent(UPLOADING_TEXT)
      if (errText !== '' && !uploading) {
        ctx.log.info({ step: 'upload', window: ctx.profile.name, errText }, '上传等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    throw new Error(`上传未完成（等待 ${SUCCESS_TEXT} 或 ${ALREADY_DONE_TEXT} 超时）`)
  }
```

4. 文件头注释与 `meta.note` 补充：「文件一次性（blob name 唯一）：重复上传报 Blob name already taken 视为成功」

- [ ] **Step 2: 补单测**

编辑 `tests/shelby-explorer.test.ts`，`ShelbyExplorerTask run 流程` describe 内追加两个用例：

```ts
  it('已上传过：Blob name already taken 出现 → 视为成功不抛错', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, log } = makeCtx(task)
    ctx.textPresent = vi.fn((t: string) => Promise.resolve(t === 'Blob name already taken'))
    await task.run(ctx)
    expect(ctx.screenshot).toHaveBeenCalled()
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('已上传过'))).toBe(true)
  })

  it('上传中（Uploading）即使出现可恢复错误也不刷新', async () => {
    const task = new ShelbyExplorerTask()
    task.successWaitMs = 10
    const { ctx } = makeCtx(task)
    ctx.textPresent = vi.fn((t: string) => Promise.resolve(t === 'Uploading files'))
    ctx.recoverErrorText = vi.fn().mockResolvedValue('Network Error')
    await expect(task.run(ctx)).rejects.toThrow('上传未完成')
    expect(ctx.page.reload).not.toHaveBeenCalled()
  })
```

「元信息」describe 的 meta 契约用例追加三行断言：

```ts
    expect(t.meta.sourceUrl).toBe('https://cryptorank.io/zh/drophunting/shelby-activity1120')
    expect(t.meta.lastUpdated).toBe('2026-09-07')
    expect(t.meta.captcha).toEqual({ auto: true })
```

- [ ] **Step 3: fixture 支持已上传路径 + 集成用例**

编辑 `tests/fixtures/shelby-explorer.html`，Upload 点击处理替换为：

```js
    document.getElementById('upload').addEventListener('click', () => {
      const status = document.getElementById('status')
      if (new URLSearchParams(location.search).has('alreadydone')) {
        status.textContent = 'Error: Blob name already taken'
        return
      }
      status.textContent = 'Uploading files…'
      setTimeout(() => {
        status.textContent = 'All files uploaded successfully'
      }, 500)
    })
```

在集成 describe 内追加第二个用例（复用同一 server；TaskContext 构造与既有集成用例一致）：

```ts
  it('run() 已上传路径：Blob name already taken → 视为成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const uploadFilePath = join(tmpdir(), `shelby-explorer-${Date.now()}.txt`)
      writeFileSync(uploadFilePath, 'hello shelby again')
      const task = new ShelbyExplorerTask()
      task.meta.url = baseUrl + '/shelbynet?alreadydone'
      const ctx = new TaskContext({
        page,
        task,
        human: new Humanizer(page),
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-explorer-test-artifacts'),
        walletPasswords: { petra: 'pw' },
        accountRow: { 文件地址: uploadFilePath },
      })
      ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
      ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
      await task.run(ctx)
      expect(await page.getByText('Blob name already taken').count()).toBeGreaterThan(0)
    } finally {
      await browser.close()
    }
  }, 90000)
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npx vitest run tests/shelby-explorer.test.ts`
Expected: PASS（单测 8 个 + 集成 2 个全过）

- [ ] **Step 5: typecheck + 全量测试**

Run: `npm run typecheck` → Expected: 无输出（通过）
Run: `npm test` → Expected: 全部通过

- [ ] **Step 6: Commit**

```powershell
git add src/tasks/shelby-explorer.ts tests/shelby-explorer.test.ts tests/fixtures/shelby-explorer.html
git commit -m "feat: xyz-shelbynet 已上传判定（Blob name already taken 视为成功）"
```

---

### Task 4: 真机验证与选择器迭代

**Files:**
- Modify: `src/tasks/shelby-explorer.ts`（按真机观察修正选择器/流程）
- Modify: `tests/shelby-explorer.test.ts`（若行为变化同步修正断言）

**Interfaces:**
- Consumes: Task 1-3 产物、`npm run task:run` 脚本（`scripts/run-task.ts`，不受任务开关限制）
- Produces: 真机核实后的选择器与流程（写入任务 note 与文件头注释）

背景（用户 2026-09-07）：计划内首窗口 `4e6bc67b83a840c7b665d2723c4837f0` 的文件此前已提交过——用它跑任务会命中「已上传判定」路径（Task 3 的 alreadyDone 分支），正好真机验证该分支；新上传路径需要另找一个「文件地址」尚未提交过的窗口（先问用户要窗口 ID）。

- [ ] **Step 1: 开窗冒烟（确认比特浏览器 API 与驱动可用）**

```powershell
$env:BITBROWSER_PROFILE_ID="4e6bc67b83a840c7b665d2723c4837f0"
npm run smoke:window
```

Expected: 开窗 → CDP 接管 → 打开页面 → 关窗全链路成功（窗口 ID 取自 config/accounts.xlsx 首行「窗口」列）

- [ ] **Step 2: 单窗口真跑任务（已上传窗口 → 验证已上传判定分支）**

```powershell
$env:BITBROWSER_PROFILE_ID="4e6bc67b83a840c7b665d2723c4837f0"
$env:TASK_KEY="xyz-shelbynet"
npm run task:run
```

Expected: 任务成功，日志出现「文件已上传过（Blob name already taken），视为成功」+ 成功截图。若失败，到 `data/screenshots/<日期>/<窗口ID>/xyz-shelbynet/` 看截图与终端日志定位卡点。

- [ ] **Step 3: 按真机观察核对五个待核实项并修正代码**

逐项核对（截图 + 日志 + 必要时手动开窗口观察页面）：
1. **站内钱包弹窗结构**：点 Connect Wallet 后弹窗是否为 AppKit（出现 `[data-testid="w3m-modal-card"]`）。是 → login 改走 `ctx.openAppKitWallet({ walletKey: 'petra', openSelector: connectBtn, entryTestId: '<真机核实 testid>' })`；否 → 核实 Petra 入口按钮实际文案/结构，修正 `petraEntry` 选择器（注意 Connect 按钮在水平右侧，可能先点 Petra 入口再点右侧 Connect）
2. **网络切换**：观察登录与上传过程中是否出现 Petra 网络切换/Approve 弹窗（日志含「钱包弹窗」）；若上传报 wrong network 类错误 → 增加切链步骤：打开 Petra 扩展 popup 页 → 点网络选择器 → 选 Shelbynet（真机定选择器后写入任务）
3. **上传弹窗 file input**：`[role="dialog"] input[type="file"]` 是否存在；若为拖拽区 → 改 CDP setInputFiles 或真机实测的选择器
4. **双 Approve 时序**：两次 `loginByWallet()` 是否都命中弹窗；若弹窗同时出现（并发弹窗）→ 改为等待两个弹窗页面分别处理
5. **首页 0x 干扰**：detectPageState 是否把已登录误判（首页无其它 0x 文案才安全）；若干扰 → 换更具体的 loggedInText（如 `0x` 短地址片段或选择器判定）

修正后重复 Step 2，直到已上传窗口真跑成功。

- [ ] **Step 4: 新上传路径验证（需要未提交过的窗口）**

向用户要一个「文件地址」尚未提交过的窗口 ID，`BITBROWSER_PROFILE_ID=<该窗口>` + `npm run task:run` 跑一遍，期望日志「上传完成（All files uploaded successfully）」+ 成功截图。若用户暂时没有可用窗口，报告 DONE_WITH_CONCERNS 并说明此验证项待用户自行确认。

- [ ] **Step 5: 更新注释与测试**

- 把真机核实的结论写进 `src/tasks/shelby-explorer.ts` 文件头注释与 `meta.note`（含核实日期）
- 若流程行为变化（如改 openAppKitWallet），同步修正 `tests/shelby-explorer.test.ts` 断言

- [ ] **Step 6: typecheck + 全量测试**

Run: `npm run typecheck` → Expected: 通过
Run: `npm test` → Expected: 全部通过

- [ ] **Step 7: Commit**

```powershell
git add src/tasks/shelby-explorer.ts tests/shelby-explorer.test.ts
git commit -m "fix: xyz-shelbynet 真机选择器修正（<简述修正点>）"
```

- [ ] **Step 8: 面板抽查**

重启服务后（`npm run dev`），面板任务页确认新任务卡片（名称/分类徽章/备注/来源页）→ 看板行级「执行」单窗口再跑一次 → 核对截图与日志。提醒用户：「定时任务」页需手动新建引用 `xyz-shelbynet` 的计划（scheduler 不会自动加）。

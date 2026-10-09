# 任务层薄门面设计（直调 patchright + 领域能力保留）

日期：2026-10-09
状态：设计已确认，待写实施计划

## 背景

历经多轮迭代，任务层累积了大量 wrapper，出现两类问题：

1. **过度封装**：`humanize`（贝塞尔轨迹/随机停顿/错键）、`find`、`wait.*`、`modal.close` 等
   大部分只是 patchright 原生 API 的薄包，嵌套层数多、维护面大。
2. **该封的没封**：登录/签名/确认在 4 个任务里各手写 40~60 行；可观测性（日志/诊断）缺失。

patchright 是**已打反检测补丁的 Playwright**，`locator().click()/fill()` 本身即为可信输入，
拟人层属冗余。真实任务也已用 `locator().fill()` 直填、钱包弹窗用原生 `locator().click()` 且跑通。

结论：**DOM 操作回归 patchright 直调；只保留 patchright 给不了的领域能力；彻底去掉拟人化。**

## 设计原则

1. **薄门面**：`TaskContext` 是 `ctx.page`（patchright `Page`）+ 少量领域能力的门面，不再是
   一套自造 DSL。通用 DOM 操作任务直接调 patchright。
2. **只留 patchright 办不到的**：钱包（跨 context 弹窗/会话/编排）、数据源、验证码、
   主世界求值、诊断、竞速原语。
3. **改造 + 精简，融合最初 5 诉求**：

   | 最初诉求 | 落点 |
   |---|---|
   | ①登录/签名/确认封装 | `wallet/`：四动作 + `ensureLoggedIn` |
   | ②更多日志 / ④加任务与定位 | `diag/`：步骤记录 + 失败诊断包 + 面板 |
   | ③便于写码 | 任务只用 `ctx.page` + `wallet/login` 声明，样板消失 |
   | ⑤文档列了没用到的 | 删 wrapper 与文档节，重排 + 漂移守卫 |

4. **每个目录一个统一出口 `index.ts`**：跨目录只从出口导入，禁止深路径。

## 目标目录结构

```
src/automation/
  index.ts                 # 能力库唯一总出口（task-context 只从这里 import）
  wallet/                  # 钱包（必须保留：patchright 办不到）
    index.ts               # 统一出口
    types.ts               # WalletAdapter 四动作契约 + WalletRegistry + PopupPage
    popup.ts               # 跨 context 弹窗检测 waitForPopup
    session.ts             # 扩展就绪探测（CDP Target.createTarget，原样搬迁）
    metamask.ts            # MetaMask：unlock / connect / sign / confirmTx
    petra.ts               # Petra：unlock / connect / sign / confirmTx
    login-flow.ts          # ensureLoggedIn 编排（连接入口→AppKit/站内弹窗→intents→等登录完成）
    appkit.ts              # AppKit 视图归一化（login-flow 子模块）
  captcha/                 # 验证码（必须保留）
    index.ts
    turnstile.ts / plugin-wait.ts / frame-find.ts
  diag/                    # 可观测性（新增，诉求②④）
    index.ts
    recorder.ts            # 步骤记录器（内存时间线）
    bundle.ts              # 失败诊断包采集
  dom/                     # 仅放 patchright 缺失的小原语
    index.ts
    race.ts                # 多文案/探针竞速
    recover.ts             # 刷新恢复（错误文案立即刷 + 周期刷新 + 心跳）
    click-robust.ts        # 【可选】动画按钮点击兜底（真机确认原生 click 够用即可删）
```

`src/engine/task-context.ts` 变薄为门面，只 `import ... from '../automation'`。

## 删除清单（回归 patchright 直调）

| 删除的封装 | 直接改用 patchright |
|---|---|
| `humanize` 全部（moveTo/clickAt 拟人轨迹/type 错键/scroll/randomMicroMove/sleep） | `locator().click({force?})` / `fill()` / `type()` / `press()` / `mouse` / `keyboard` |
| `clickCheckin` / `typeInto` / `pressKey` | 上述原生组合 |
| `visible` / `textPresent` / `count` | `locator().isVisible()` / `getByText().count()` |
| `assertVisible` / `waitForText` | `locator(sel)/getByText(t).first().waitFor({ state, timeout })` |
| `waitForGone` / `waitGoneOrHidden` | `locator().waitFor({ state:'detached' })` |
| `waitForUrl` / `urlIncludes` | `page.waitForURL(pred)` / `page.url()` |
| `waitForApi` | `page.waitForResponse(pred)` |
| `closeModal` / 弹窗关闭 | `locator().click()` / `keyboard.press('Escape')` |
| `detectPageState` / `waitForTextRecover` / `waitForTextWithReloads` / `recoverErrorText` | 收进 `wallet.ensureLoggedIn` 或 `dom/recover` |
| `goto` / `closeOtherTabs`（作为任务方法） | 收进 `SiteTask.run` 默认骨架 |
| `raceTexts` / `pageDump`（旧名） | `ctx.race` / `locator().textContent()` |

依赖清理：确认无引用后移除 `ghost-cursor`（拟人轨迹库）。

## 保留的能力（TaskContext 薄门面）

基础：`ctx.page`（patchright `Page`，主入口）、`ctx.log`、`ctx.profile`、
`ctx.account(key)`、`ctx.accountRow`、`ctx.uploadFile(sel, val)`、`ctx.js(fn)`（主世界求值）、
`ctx.screenshot(name)` / `ctx.safeScreenshot(name)`。

命名空间：

| 命名空间 | 方法 | 说明 |
|---|---|---|
| `ctx.wallet` | `ready()` `login(opts?)` `sign(opts?)` `confirmTx(opts?)` `ensureLoggedIn(spec)` | 钱包域（保留） |
| `ctx.captcha` | `turnstile(opts?)` `visible(sel?)` `autoClick(ms?)` `waitPlugin(opts?)` | 验证码域（保留） |
| `ctx.step` | `step(name, fn)` | 步骤记录（诊断） |
| `ctx` | `race(entries, ms)` | 多探针竞速（patchright 缺失原语，~5 行） |
| `ctx` | `recover(probe, opts)` | 刷新恢复（Web3 通用模式，~小助手） |

## 钱包适配器契约（显式四动作）

```ts
interface WalletAdapter {
  key: string
  extensionUrlPatterns: string[]
  extensionId: string
  probePath: string
  providerFlag: string
  expectsProvider?: boolean
  unlock?(popup: PopupPage, password: string): Promise<void>  // 解锁
  connect(popup: PopupPage): Promise<void>                     // 登录/连接授权
  sign(popup: PopupPage): Promise<void>                        // 消息签名（Petra Sign In 等）
  confirmTx(popup: PopupPage): Promise<void>                   // 交易确认（Approve/Register 等）
}
```

- 按钮同构的钱包（MetaMask 多步、Petra）四动作内部可共用私有 `confirm(popup)`；拆分不影响复用。
- `unlock` 可选（未配密码跳过）。

## 登录编排（LoginSpec → ctx.wallet.ensureLoggedIn）

```ts
type Probe = { text: string } | { selector: string }
type WalletIntent = 'connect' | 'sign' | 'confirmTx'

interface LoginSpec {
  loggedIn: Probe            // 已登录标志（文案或选择器）
  loggedOut: Probe           // 未登录标志
  connect?: string           // 站点唤起钱包的连接入口（可选）
  entry?:
    | { kind: 'direct' }                                        // 点 connect 直接唤起扩展弹窗
    | { kind: 'dialog'; confirm?: string }                      // 站内自定义弹窗（Petra Web）
    | { kind: 'appkit'; open: string; entryTestId: string; modalTestId?: string }
  intents?: WalletIntent[]   // 默认 ['connect']；签名登录加 'sign'；交易加 'confirmTx'
  waitLoggedInMs?: number    // 默认 90000
  recoverTexts?: string[]    // 默认共享 RECOVER_TEXTS
  refreshEveryMs?: number    // 默认 25000，0 关闭
  attempts?: number          // 默认 2
  reclickAfterMs?: number    // 默认 8000
}
```

流程：`ready()` → 双探针竞速判登录态（已登录返回 `{skipped:true}`）→ 循环 attempts：
点 connect/补点 → 按 `entry.kind` 露出钱包入口 → 按 `intents` 顺序（每次等弹窗 → `unlock` →
对应动作）→ 等 `loggedIn`（`dom/recover`：错误立即刷 + 周期刷）→ 未完成重判/刷新重试。
静默连接容忍：弹窗未出现不当失败，以登录态收尾。

共享常量：`RECOVER_TEXTS = ['Network Error', 'Turnstile token request timed out']` 定义于
`src/infrastructure/constants.ts`（现状各任务重复定义，收敛单点）。

## 可观测性（诉求②④，一等公民）

- **统一等待心跳**：`dom/recover` 与 wallet 编排每 15s 输出一条心跳（`仍在等 X，已等 Ns，URL=…`），
  静默卡死有迹可循。
- **`ctx.step(name, fn)`**：关键步骤记录 `{name, 耗时, 结果}`，累积为本次运行时间线。
- **失败诊断包**：`window-runner` 失败时调 `diag.bundle`，落盘 URL + 页面关键文本 +
  步骤时间线 + 截图路径 → `runs.diag_path`（加 migrate 补列）。
- **面板**：失败行「诊断」入口展示时间线 + 文本 + 截图（新增 `GET /api/diagnostics`）。

## SiteTask 模板与任务形态

```ts
abstract class SiteTask {
  abstract meta: TaskMeta
  login?: LoginSpec
  abstract action(ctx: TaskContext): Promise<void>
  /** 默认骨架：清理残留标签页 → goto → ensureLoggedIn → action；可覆盖 */
  async run(ctx: TaskContext): Promise<void> {
    for (const p of ctx.page.context().pages()) if (p !== ctx.page) await p.close().catch(() => {})
    await ctx.page.goto(this.meta.url, { timeout: 45000, waitUntil: 'domcontentloaded' })
    if (this.login) await ctx.wallet.ensureLoggedIn(this.login)
    await this.action(ctx)
  }
}
```

任务用 patchright 直写 DOM 操作（示例，对比现状 300+ 行）：

```ts
export class PortalRhunaTask extends SiteTask {
  meta: TaskMeta = { key: 'portal-rhuna', name: 'Rhuna 签到', wallet: 'petra', /* …其余不变… */ }
  login: LoginSpec = {
    loggedIn: { text: 'Hello,' }, loggedOut: 'Connect Wallet',
    connect: 'button:has-text("Connect Wallet"):visible',
    entry: { kind: 'direct' }, intents: ['sign'],
  }
  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page
    await ctx.step('enter-quests', async () => {
      await page.getByText('Daily Check-in').first().waitFor({ timeout: 60000 })
    })
    await page.locator('div.cursor-pointer:has-text("Daily Check-in")').click()
    if (await page.getByText('Quest completed successfully!').count()) return
    await page.locator('[role="dialog"] button:has-text("Claim")').click()
    await ctx.captcha.autoClick()
    await page.getByText('Quest completed successfully!').first().waitFor({ timeout: 60000 })
    await ctx.safeScreenshot('rhuna-success')
  }
}
```

## 文档动作（docs/API-GUIDE.md，硬性同步）

- **删**：第 3 章旧扁平方法小节（`humanize` 全套 / `typeInto` / `pressKey` / `clickCheckin` /
  `visible` / `textPresent` / `assertVisible` / `waitForText` / `waitForGone` / `waitForApi` /
  `waitForUrl` / `waitForTextRecover` / `detectPageState` / `closeModal` 等）及方法对比速查过时条目。
- **改排**：第 3 章改为「`ctx.page` 直调 patchright + 领域能力」：登录（`ctx.wallet`）、
  验证码（`ctx.captcha`）、诊断（`ctx.step`）、竞速/恢复；每节标注「真机在用」。
- 第 4 章钱包按四动作 + `LoginSpec` 重写；第 9 章配方按直调 patchright 重写；AI 帮写模板
  增加硬约束「DOM 操作直接调 patchright；登录用 `wallet.ensureLoggedIn`；禁止手写已有封装」。
- 同步 `docs/TASK-DEVELOPMENT-LESSONS.md`；新增**文档漂移守卫测试**（`TaskContext` 门面
  方法与 API-GUIDE 目录一致，不一致则 `npm test` 失败）。

## 迁移计划（分簇渐进，每簇真机闭环）

- **P1 能力库**：建 `dom/`（race/recover/可选 click-robust）、`diag/`；重构 `wallet/`（四动作 +
  login-flow）与 `captcha/` barrel；`TaskContext` 切薄门面；`SiteTask` 加模板方法；各模块单测。
- **P2 任务重写（按簇，每簇真机验证后再下一簇）**：
  - 簇 A（无钱包地址类）：`arc` / `shelby-faucet` / `auralaunch-faucet`
  - 簇 B（直接登录）：`portal-rhuna` / `konnex-checkin`
  - 簇 C（AppKit/多签）：`inception-dachain` / `shelby-explorer`
  - 示例：`example-checkin` / `faucet-example` / `mint-example`
- **P3 清理**：删旧方法、删文档节、移除 `ghost-cursor`、加漂移守卫测试。
- **P4 面板诊断入口**：`runs.diag_path` migrate + `GET /api/diagnostics` + 看板失败行诊断视图。

## 测试策略

- 单元：`dom/race`、`dom/recover`、`wallet/*`（四动作 + login-flow）、`captcha/*`、`diag/*`
  （沿用现有 fake page + `as never` 模式）。
- 任务层：每个重写任务的现有测试同步适配（门面变化）。
- 漂移守卫：`tests/docs-drift.test.ts` 校验 TaskContext 门面与 API-GUIDE 目录一致。
- 全量：`npm run typecheck` + `npm test` 必过；前端不受影响。
- 真机：每簇按 AGENTS 真机规范（并发≤4、问题自解决、卡住 3 分钟即暂停）。

## 风险

- **动画按钮点击**：`humanize.click` 原为解决带动画按钮 `boundingBox` 稳定等待 30s 超时（真机
  inception）。改 patchright 原生 `locator().click()` 后，真机确认该场景；若超时用 `{ force:true }`
  或 `page.mouse.click`（先 `scrollIntoViewIfNeeded`）兜底，必要时启用 `dom/click-robust`。
- **钱包 intents 顺序**站点相关，需真机确认（Petra 的 `sign`、MetaMask 的 `connect`）。
- LoginSpec 无法覆盖全部站点：`SiteTask.run` 可覆盖 / `entry.kind='dialog'` 预留逃生口。
- 彻底删旧方法会让未迁移任务暂时编译不过——分簇迁移同步适配测试，避免长时间红。

## 与既有 spec 的关系

本设计**取代**本目录下同日期的「任务能力库重封装（命名空间 DSL + 拟人瘦身）」草案，并**推翻**
《2026-09-01 任务通用化封装》中「不做登录状态机（YAGNI）」的结论：真机数据（4 个任务各手写
40~60 行登录）证明登录编排是高频刚需，应作为一等配方下沉；同时将无证据支持的拟人层删除。

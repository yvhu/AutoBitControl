# 任务能力库重封装设计（命名空间 API + 显式钱包动作）

日期：2026-10-09
状态：设计已确认，待写实施计划

## 背景与问题

2026-09-01 的《任务通用化封装（方案 B）》已把一批站点无关模式下沉到 TaskContext
（`raceTexts/visible/waitGoneOrHidden/waitForTextWithReloads/detectPageState` + `openAppKitWallet`），
并把「配置驱动的登录状态机」判为范围外（YAGNI）。真机运行至今暴露两个根因：

1. **封装建了，任务没吃进去**。逐任务核对复用情况：

   | 任务 | 登录态判定 | 登录封装 | 刷新恢复等待 | 复用度 |
   |---|---|---|---|---|
   | inception-dachain | `ctx.detectPageState` | `ctx.openAppKitWallet` | `ctx.waitForTextWithReloads` | 基本复用 |
   | portal-rhuna | `ctx.detectPageState` | 手写 `loginWithRetry/loginByPetra` | `ctx.waitForTextRecover` | 半复用 |
   | konnex-checkin | `ctx.detectPageState` | 手写 `loginByMetaMask` | 手写卡片等待 | 半复用 |
   | shelby-explorer | 手写 `detectHeaderState` | 手写 `login` | 手写 `waitForSelectorRecover` | 几乎零复用 |
   | auralaunch-faucet | — | — | 全模块级手写 | 几乎零复用 |
   | arc / shelby-faucet | — | — | 手写（接口驱动，特殊） | 部分 |

2. **封装只覆盖「文案」维度，没覆盖「选择器/条件」维度**。shelby-explorer 需要按
   `header button:has-text("0x")` 判定登录态、按选择器可见性等恢复；`detectPageState` /
   `waitForTextRecover` 只收文案，套不上 → 就地手写，而不是扩封装。

3. **旧的扁平方法集分散且部分从未被真实任务使用**（`typeInto/closeModal/waitForApi/
   waitForUrl/pressKey/urlIncludes/waitForGone/accountRow` 真实任务零使用），文档与真机写法脱节。

结论：封装方向正确，但需 ①补齐覆盖面（选择器/条件）②把登录提升为配方（推翻当年 YAGNI）
③按关注点重组文件 ④全量重写任务并删除冗余方法与文档。

## 目标

1. 任务只声明站点差异；所有浏览器能力下沉、单点维护，任务 `run` 塌缩到 15~30 行。
2. 能力按关注点分目录/文件：钱包四动作同文件、不同钱包同目录；查找元素、等待加载各自独立。
3. 对外 API 采用**命名空间分组**（`ctx.wallet.*` / `ctx.wait.*` / `ctx.find.*` …），自解释、便于 AI 与人使用。
4. 全量重写任务层，**彻底删除**旧扁平方法与过时文档节，不留兼容层。

## 非目标（范围外）

- 不改 infrastructure（config/logger/db/datasource/http）、queue/scheduler/window-runner 的调度语义。
- 不改钱包扩展就绪探测算法（`session.ts` 逻辑仅搬迁不改）。
- 不引入配置驱动的多站点插件系统；LoginSpec 是声明式参数，不是站点配置表。
- 本轮不实现「失败自动诊断包 + 面板可视化」（问题 2/4），作为后续独立阶段。

## 目标目录结构

```
src/automation/
  interact/
    humanize.ts        # 拟人交互：click/clickAt/type/scroll/moveTo（原 humanize.ts 迁入）
  element/
    find.ts            # 查找元素（即时判断）：exists/visible/count/text/present/dump/race
  wait/
    element.ts         # 等元素：visible/hidden/attached/gone
    load.ts            # 等页面加载：domReady / fullyLoaded / networkIdle / url
    api.ts             # 等接口：response(谓词) / apiJson(urlPart)
    recover.ts         # 刷新恢复内核：probe + recoverTexts + 周期刷新 + 心跳日志
    state.ts           # 双探针竞速判定（原 detectPageState 泛化，支持文案/选择器）
  wallet/
    types.ts           # WalletAdapter 契约（unlock/connect/sign/confirmTx）+ WalletRegistry + Popup 接口
    popup.ts           # 弹窗检测 waitForPopup
    session.ts         # 扩展就绪探测（原样搬迁）
    metamask.ts        # MetaMask：unlock / connect / sign / confirmTx
    petra.ts           # Petra：unlock / connect / sign / confirmTx
    login-flow.ts      # ensureLoggedIn 编排：连接入口→AppKit/站内弹窗→intents→等登录完成
    appkit.ts          # AppKit 视图归一化（login-flow 子模块，不再对任务公开）
  modal/
    close.ts           # closeModal 家族（收敛为 modal.close）
  captcha/
    turnstile.ts / plugin-wait.ts / frame-find.ts   # 现状保留
```

`src/engine/task-context.ts` 变薄为「组装 + 门面」：实现全部委托给上述模块。

## 钱包适配器契约（显式四动作）

```ts
type PopupPage = /* 现状接口不变 */

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

class WalletRegistry { register(a): void; get(key): WalletAdapter; has(key): boolean }
```

- 四动作为**显式契约**（语义清晰、可单测、可分别扩展选择器）。
- 对按钮同构的钱包（MetaMask 多步、Petra），`connect/sign/confirmTx` 内部可共用私有
  `confirm(popup)` 实现（点确认按钮 → 等弹窗关闭，最多 3 轮）；拆成四个方法不影响复用。
- `unlock` 保持可选（未配密码跳过）。

## 登录编排（LoginSpec → ctx.wallet.ensureLoggedIn）

```ts
type Probe = { text: string } | { selector: string }
type WalletIntent = 'connect' | 'sign' | 'confirmTx'

interface LoginSpec {
  /** 已登录 / 未登录标志（文案或选择器） */
  loggedIn: Probe
  loggedOut: Probe
  /** 站点页面上「唤起钱包」的连接入口（可选；不填=直接等弹窗/静默） */
  connect?: string
  /** 站点如何露出钱包入口 */
  entry?:
    | { kind: 'direct' }                                              // 点 connect 直接唤起扩展弹窗
    | { kind: 'dialog'; confirm?: string }                            // 站内自定义弹窗（如 Petra Web）
    | { kind: 'appkit'; open: string; entryTestId: string; modalTestId?: string } // AppKit 归一化
  /** 钱包需依次处理的意图（默认 ['connect']；签名登录站点加 'sign'；交易加 'confirmTx'） */
  intents?: WalletIntent[]
  /** 登录完成等待预算（默认 90000） */
  waitLoggedInMs?: number
  /** 可恢复错误文案（默认共享 RECOVER_TEXTS） */
  recoverTexts?: string[]
  /** 周期刷新间隔（默认 25000，0 关闭） */
  refreshEveryMs?: number
  /** 登录整体重试轮数（默认 2） */
  attempts?: number
  /** 补点间隔（默认 8000） */
  reclickAfterMs?: number
}
```

`ensureLoggedIn(spec)` 流程（把现有 4 个任务手写的 40~60 行一次封装）：

1. `wallet.ready()`（配了 `meta.wallet` 才做）
2. 双探针竞速判定登录态 + 多轮刷新恢复 → 已登录则直接返回 `{ skipped: true }`
3. 循环 `attempts` 轮：
   a. 点 `connect`（若声明）+ 补点
   b. 按 `entry.kind`：`direct` 直接等弹窗；`dialog` 点 confirm；`appkit` 走视图归一化
   c. 按 `intents` 顺序：每个 intent 等一次钱包弹窗 → `unlock` → 调用对应动作
   d. 等 `loggedIn` 出现（`wait.recover`：可恢复错误立即刷新 + 周期刷新）
   e. 未完成则重新判定登录态；仍为 `loggedOut` 且还有轮次 → 刷新重试
4. 失败抛出带状态快照的类型化错误

静默连接容忍：钱包弹窗未出现时不当失败，以登录态收尾（现状逻辑不变）。

## TaskContext 新暴露面

顶层基础（保留）：`log` `profile` `page` `human` `goto` `closeOtherTabs` `screenshot`
`safeScreenshot` `account` `accountRow` `uploadFile` `js`。

命名空间：

| 命名空间 | 方法 | 对应旧方法 |
|---|---|---|
| `ctx.find` | `exists(sel)` `visible(sel)` `count(sel)` `text(sel)` `present(text)` `dump(sel?)` `race(entries,ms)` | `visible` `textPresent` `raceTexts` `pageDump` |
| `ctx.wait` | `visible(sel,ms?)` `hidden(sel,ms?)` `attached(sel,ms?)` `gone(sel,ms?)` `text(text,ms?)` `assert(probe,ms?)` `domReady(ms?)` `fullyLoaded(ms?)` `networkIdle(ms?)` `url(part,ms?)` `api(urlPart,ms?)` `response(pred,ms?)` `recover(probe,opts)` `state(a,b,opts)` | `assertVisible` `waitForText` `waitForGone` `waitGoneOrHidden` `waitForApi` `waitForUrl` `waitForTextRecover` `waitForTextWithReloads` `detectPageState` |
| `ctx.wallet` | `ready()` `login(opts?)` `sign(opts?)` `confirmTx(opts?)` `ensureLoggedIn(spec)` | `ensureWalletReady` `loginByWallet` `openAppKitWallet` |
| `ctx.modal` | `close(opts)` | `closeModal` |
| `ctx.captcha` | `turnstile(opts?)` `visible(sel?)` `autoClick(ms?)` `waitPlugin(opts?)` | `clickTurnstileBox` `turnstileVisible` `autoClickTurnstile` `waitCaptchaPassed` |

语义分工：`ctx.find.*` 是**即时判断**（不等待、不抛错为主），`ctx.wait.*` 是**等待**
（可超时抛错）。`recover` 是统一的刷新恢复内核（probe 支持 `{text}|{selector}`，
含错误文案立即刷新、周期刷新、心跳日志）。

### 删除清单（彻底删，任务全量重写不需要兼容层）

`typeInto`（= `human.type`）、`pressKey`、`clickCheckin`（= `human.click` + `wait.assert`）、
`assertVisible`、`waitForText`、`waitForGone`、`waitGoneOrHidden`、`waitForApi`、
`waitForUrl`、`waitForTextRecover`、`waitForTextWithReloads`、`detectPageState`、
`recoverErrorText`、`raceTexts`、`textPresent`、`visible`、`urlIncludes`、
`loginByWallet`、`ensureWalletReady`、`openAppKitWallet`、`closeModal`、
`clickTurnstileBox`、`turnstileVisible`、`autoClickTurnstile`、`waitCaptchaPassed`。

（均以新命名空间形态存在或被任务内组合替代；`human.type`/`human` 按键保留。）

共享常量：`RECOVER_TEXTS = ['Network Error', 'Turnstile token request timed out']` 定义于
`src/infrastructure/constants.ts`（现状各任务重复定义，收敛为单点）。

## SiteTask 模板与任务形态

```ts
abstract class SiteTask {
  abstract meta: TaskMeta
  /** 声明式登录（可选） */
  login?: LoginSpec
  /** 任务主体（已登录后要做的站点特有动作） */
  abstract action(ctx: TaskContext): Promise<void>
  /** 默认骨架：清理 → goto → ensureLoggedIn → action；可覆盖（如 shelby 多页） */
  async run(ctx: TaskContext): Promise<void> {
    await ctx.closeOtherTabs()
    await ctx.goto()
    if (this.login) await ctx.wallet.ensureLoggedIn(this.login)
    await this.action(ctx)
  }
}
```

重写后示例（portal-rhuna，对比现状 300+ 行）：

```ts
export class PortalRhunaTask extends SiteTask {
  meta = { key: 'portal-rhuna', name: 'Rhuna 签到', wallet: 'petra', /* …其余不变… */ } as TaskMeta
  login: LoginSpec = {
    loggedIn: { text: 'Hello,' },
    loggedOut: 'Connect Wallet',
    connect: 'button:has-text("Connect Wallet"):visible',
    entry: { kind: 'direct' },
    intents: ['sign'],           // Petra 弹窗为 Sign In Request
  }
  async action(ctx: TaskContext): Promise<void> {
    await ctx.wait.recover({ text: 'Daily Check-in' }, { budgetMs: 60000, refreshEveryMs: 25000, recoverTexts: RECOVER_TEXTS })
    await ctx.human.click('div.cursor-pointer:has-text("Daily Check-in")')
    const outcome = await ctx.find.race([['success', 'Quest completed successfully!'], ['claim', 'Claim']], 15000)
    if (outcome !== 'claim') return
    await ctx.human.click('[role="dialog"] button:has-text("Claim")')
    await ctx.captcha.autoClick()
    await ctx.wait.recover({ text: 'Quest completed successfully!' }, { budgetMs: 60000, recoverTexts: RECOVER_TEXTS })
    await ctx.safeScreenshot('rhuna-success')
  }
}
```

## 文档动作（docs/API-GUIDE.md，硬性同步）

- **删**：第 3 章旧扁平方法小节（`typeInto`/`closeModal`/`waitForApi`/`waitForUrl`/
  `waitForGone`/`pressKey`/`clickCheckin`/`assertVisible`/`textPresent` 等约 10 节）与方法对比速查过时条目。
- **改排**：第 3 章改为「能力地图」——`ctx.find.*` / `ctx.wait.*` / `ctx.wallet.*` /
  `ctx.human.*` / `ctx.modal.*` / `ctx.captcha.*`，每节标注「真机在用」。
- 第 4 章钱包弹窗按四动作 + `LoginSpec` 重写；第 9 章配方按新 API 重写；AI 帮写模板
  增加硬约束「只用封装，禁止在任务里手写 reload/等待循环，不够就地扩封装」。
- 同步 `docs/TASK-DEVELOPMENT-LESSONS.md`；新增**文档漂移守卫测试**：`TaskContext`
  命名空间方法 ↔ API-GUIDE 目录一致，不一致则 `npm test` 失败。

## 迁移计划（分簇渐进，每簇真机闭环）

- **P0** 冻结 + 定 API（本 spec）。
- **P1 能力库**：建上述模块与单测；`task-context` 切到新门面；`SiteTask` 加模板方法。
- **P2 任务重写（按簇，每簇真机验证后再下一簇）**：
  - 簇 A（无钱包地址类）：`arc` / `shelby-faucet` / `auralaunch-faucet`
  - 簇 B（直接登录）：`portal-rhuna` / `konnex-checkin`
  - 簇 C（AppKit/多签）：`inception-dachain` / `shelby-explorer`
  - 示例：`example-checkin` / `faucet-example` / `mint-example`
- **P3 清理**：删旧方法、删旧文档节、加漂移守卫测试。
- **P4 可观测性（独立阶段）**：等待内核统一心跳日志 + 失败自动诊断包 + 面板诊断入口。

## 测试策略

- 单元：`element/find`、`wait/*`、`wallet/login-flow`、`wallet/*` 四动作、`modal/close`、
  `captcha/*` 各自 fake-page 单测（沿用现有 `tests/*.test.ts` 的 fake page + `as never` 模式）。
- 任务层：每个重写任务的现有测试同步适配（fake ctx 暴露命名空间）。
- 漂移守卫：`tests/docs-drift.test.ts` 校验 TaskContext 方法与 API-GUIDE 目录一致。
- 全量：`npm run typecheck` + `npm test` 必过；前端不受影响。
- 真机：每簇按 AGENTS 真机规范验证（并发≤4、问题自解决、卡住 3 分钟即暂停）。

## 风险

- 运行时全量改动：每个任务必须真机验证；按簇推进保证可回滚。
- 钱包 `intents` 顺序是站点相关，需真机确认（如 Petra 的 `sign`、MetaMask 的 `connect`）；
  按钮同构的钱包用共享 `confirm` 内部实现降低脆弱性。
- LoginSpec 无法覆盖全部站点：`SiteTask.run` 可覆盖 / `entry.kind='dialog'` 预留逃生口。
- 彻底删旧方法会让未迁移任务暂时编译不过——按簇迁移时同步适配测试，避免长时间红。

## 与既有 spec 的关系

本设计**推翻**《2026-09-01 任务通用化封装》中「不做登录状态机（YAGNI）」的结论：真机数据
（4 个任务各手写 40~60 行登录）证明登录编排是高频刚需，应作为一等配方下沉。

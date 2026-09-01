# 任务通用化封装设计（方案 B）

日期：2026-09-01
状态：设计已确认，待实施

## 背景

inception-dachain 真机实测沉淀了一批与站点无关的可复用模式（多文案竞速、元素可见/
消失等待、登录态竞速 + 刷新重试、AppKit 弹窗视图归一化）。未来新增站点任务会重复
编写同一套 ~100 行登录样板，且 AppKit 的坑（初始视图不定、入口点击不注册）会重复踩。
本设计将这些模式下沉为全局能力，inception-dachain 瘦身为站点特有部分。

## 目标

1. 通用页面工具下沉到 TaskContext（任务编写者唯一接触的运行环境接口）
2. AppKit 钱包登录流程封装为 `ctx.openAppKitWallet(opts)`，集中归一化/补点逻辑
3. inception-dachain 重构为等价变换（行为不变），保持真机验证过的时序
4. 未来任务：`detectPageState` + `ensureWalletReady` + `openAppKitWallet` + 站点特有流程即可

## 设计

### 1. TaskContext 通用页面工具（src/engine/task-context.ts）

```ts
/** 多文案竞速：任一出现返回其键，都等不到返回 null */
async raceTexts<K extends string>(entries: Array<[K, string]>, timeoutMs: number): Promise<K | null>

/** 元素是否可见（任何异常按不可见处理） */
async visible(selector: string): Promise<boolean>

/** 等元素消失或隐藏（元素从未出现视为已消失；最多 timeoutMs） */
async waitGoneOrHidden(selector: string, timeoutMs: number): Promise<void>

/**
 * 等文案出现 + 刷新兜底：先被动等 passiveMs，再最多 rounds 轮刷新（每轮等 roundWaitMs）
 * @returns 出现 true / 全部超时 false
 */
async waitForTextWithReloads(
  text: string,
  opts: { passiveMs: number; rounds?: number; roundWaitMs?: number; reloadTimeoutMs?: number },
): Promise<boolean>

/**
 * 登录状态竞速判定：已登录文案 / 未登录文案谁先出现；都不出现则刷新重试
 * （已登录窗口误入登录分支时，仪表盘永远不出现未登录文案——假报网络异常的根因修复）
 * @throws 多轮刷新后两者均未出现（信息含两个文案）
 */
async detectPageState(opts: {
  loggedInText: string
  landingText: string
  waitMs: number
  rounds?: number
  roundWaitMs?: number
  reloadTimeoutMs?: number
}): Promise<'loggedIn' | 'landing'>
```

默认参数沿用实测值：rounds 10、roundWaitMs 15000、reloadTimeoutMs 45000
（waitForTextWithReloads 的 rounds 默认 0——纯被动等待语义）。

### 2. AppKit 登录封装（src/engine/appkit.ts + TaskContext.openAppKitWallet）

```ts
export interface AppKitLoginOptions {
  /** 钱包类型（与 WalletAdapter.key 对应，弹窗连接时取适配器） */
  walletKey: string
  /** 站点页面上「打开 AppKit 弹窗」的按钮（如 button:has-text("WALLET")） */
  openSelector: string
  /** 钱包入口 data-testid（如 wallet-selector-io.metamask） */
  entryTestId: string
  /** 弹窗容器 testid（默认 w3m-modal-card） */
  modalTestId?: string
  /** 弹窗出现等待（默认 45000） */
  modalWaitMs?: number
  /** 视图归一化轮数（默认 5） */
  normalizeRounds?: number
  /** 每轮归一化后停顿（默认 3000） */
  roundSleepMs?: number
  /** 弹窗 8s 未出现时补点入口（默认 8000） */
  reclickAfterMs?: number
}

/** @returns popupFailed：钱包弹窗未出现（静默连接容忍，调用方结合登录态判定） */
async function openAppKitWallet(ctx: TaskContext, opts: AppKitLoginOptions): Promise<boolean>
```

流程（与现任务等价）：
1. `ctx.human.click(openSelector)`
2. `ctx.assertVisible(modalTestId, modalWaitMs)`
3. 归一化循环（≤ normalizeRounds）：入口可见 → 命中；否则 header-back → all-wallets →
   tab-browser 依次尝试，每轮后 sleep roundSleepMs
4. 未命中 → throw `AppKit 弹窗未出现 ${walletKey} 钱包入口（弹窗视图异常，归一化未命中）`
5. `ctx.human.click(entryTestId)`
6. `ctx.loginByWallet({ reclick: { selector: entryTestId, afterMs: reclickAfterMs } })`
   → 返回 popupFailed（'钱包弹窗未出现' 容忍语义不变）

边界：`ensureWalletReady` 不放进封装（保持在任务登录入口调用，维持已验证的
「扩展轮询与后续 UI 流程重叠」时序）；站点专属的登录入口（如 Enter Inception 点击 +
Get Started 断言）留在任务内。

### 3. inception-dachain 瘦身（等价变换）

- 删除私有 `raceTexts/visible/waitGoneOrHidden`（改调 ctx.*）
- `detectState` → `ctx.detectPageState({ loggedInText: SIDEBAR_TEXT, landingText: ENTER_TEXT, ... })`
- `waitForSidebar` → `ctx.waitForTextWithReloads(SIDEBAR_TEXT, { passiveMs: SIDEBAR_PASSIVE_MS, rounds: SIDEBAR_RELOAD_ROUNDS, roundWaitMs: SIDEBAR_RELOAD_WAIT_MS })`
- `loginByMetaMask` 的 AppKit 部分 → `ctx.openAppKitWallet({ walletKey: 'metamask', openSelector: 'button:has-text("WALLET")', entryTestId: METAMASK_ENTRY })`；
  保留任务内：ensureWalletReady、Enter Inception 点击 + Get Started 断言、popupFailed 语义
- 保留任务内（站点特有）：文案常量、时间参数常量、`dailyOpens` 计数器解析、
  `raceAfterOpenFree`/`raceReveal`（基于 ctx.raceTexts 的任务级组合）、
  `finishAtLimit`、`openCrates` 开箱循环

### 4. 范围外

- 不做配置驱动的站点登录状态机（方案 C，YAGNI）
- 不改任何时间/次数参数值（仅搬移位置）
- 不改 WalletSession/钱包适配器/调度/DB

## 测试

- 新增 `tests/task-context-generic.test.ts`（或并入 task-context-scenarios）：raceTexts /
  visible / waitGoneOrHidden / waitForTextWithReloads / detectPageState 的 fake page 单测
- 新增 `tests/appkit.test.ts`：归一化各分支（直接命中 / header-back / all-wallets /
  tab-browser / 未命中抛错）、popupFailed 返回语义、reclick 传递
- `tests/inception-dachain.test.ts` 适配新 ctx 方法（竞速组合用例保留）
- 全量回归：后端 `npm test` + typecheck；前端不受影响（本设计只动后端任务层）

## 真机验证

- 重构为等价变换后，由用户在真实窗口复跑 inception-dachain 确认登录/开箱行为不变
  （抽 3-5 个窗口验证即可）

## 风险

- 封装的默认参数与任务内常量重复定义需对齐（在 appkit.ts 用与任务相同的默认值）
- 过度抽象风险：若未来站点 AppKit 交互差异大，opts 需扩展（保持可选参数模式）

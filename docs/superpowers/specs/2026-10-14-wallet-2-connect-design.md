# 钱包 2.0：connectWallet 自适应 + 配置驱动适配器（Block 1b）

日期：2026-10-14
状态：待用户确认（依赖 Block 0 命名规范）

## 目标

按 Block 0 约定，把钱包登录从「声明式 scenario + intents」改为「**只描述可见行为、自动推断**」，并让**新增钱包 = 填一条配置**。行为目标：

- `connectWallet(ctx, { wallet: 'metamask' })` 即可跑通常见站点（连接按钮、站内钱包列表、扩展弹窗、静默连接、连接后自动签名）。
- 去库名（appkit/reown/rainbowkit/w3m），去 `scenario`/`intents`/`entry`/`export 的 walletEntry` 等内部概念。
- **安全边界**：登录阶段只自动处理 `unlock`/`connect`/`sign`，**绝不自动确认交易**（`confirmTx`）。

## ConnectOptions（最终形状）

```ts
interface ConnectOptions {
  wallet: WalletType
  connected?: Matcher
  disconnected?: Matcher
  connect?: string
  walletOption?: Matcher
  confirm?: string
  waitConnectedMs?: number   // 缺省 90000
  errorTexts?: string[]
  refreshEveryMs?: number    // 缺省 25000
  attempts?: number          // 缺省 2
  reclickAfterMs?: number    // 缺省 8000
}
```

（Block 0 已定；由 `src/api/wallet.ts` 导出 `ConnectOptions`。`src/automation` 内部规格类型改名 `LoginFlowOptions` 以消除同名冲突。）

## connectWallet 算法

1. 取适配器 `wallet`（须有 `displayName`）；无则抛错。
2. **判初始态**：有 `connected`/`disconnected` 用它们竞速（20s）；否则启发式——`disconnected' = 连接按钮候选可见；`connected' = 页面出现地址样式文本 `/0x[a-fA-F0-9]{6,}/`。命中 `connected` 直接返回（`connectWallet` 返回 `Promise<void>`，与现签名一致）。
3. `wallet.ready()`：探测扩展已加载（若适配器未配 `extensionId`，跳过探测、视为就绪）。
4. **点连接按钮**：`connect ?? findConnectButton(page)`——按候选文案（`Connect Wallet`/`连接钱包`/`Connect`）找首个可见并点。
5. **自适应处理循环**（直到 `connected` 或预算耗尽，`attempts` 轮）：
   - 每轮先 `raceProbes`：`[站内钱包项 (walletOption ?? { text: displayName }), 扩展弹窗, connected, disconnected]`。
   - 命中**站内钱包项** → 点击它（若列表未露出，先内部归一化：点 `返回/全部钱包/浏览器标签` 候选，再重试）。
   - 命中**扩展弹窗** → `wallet.handleLoginPopup(popup)` 按适配器分类（`unlock`/`connect`/`sign`）自动完成；**分类为 `tx` 的绝不处理**，改为告警并继续等（交易由任务显式 `confirmTransaction`）。
   - 什么都没命中且超 `reclickAfterMs` → 补点连接按钮一次。
   - 命中 **connected** → 成功返回；命中 **disconnected** 且无更多动作 → 进入下一轮（第二轮起先 `page.reload`）。
6. 等 `connected`（显式或启发式），走 `recover`（`errorTexts` 命中刷新、`refreshEveryMs` 周期刷新）。
7. 全部轮次失败 → 抛「登录未完成（等待已连接标志超时）」。

**判据暴露**：日志打印本轮实际使用的判据（显式/启发式）与候选，便于排障。

## 适配器：`displayName` + 弹窗分类 + 配置驱动

### WalletAdapter 增量字段（`src/automation/wallet/types.ts`）
```ts
interface WalletAdapter {
  key: string
  displayName: string                     // 新增：'MetaMask' / 'Petra'（walletOption 缺省匹配用）
  extensionUrlPatterns: string[]
  extensionId?: string                    // 改可选：缺省则 ready 不探测
  probePath?: string
  providerFlag?: string
  expectsProvider?: boolean
  unlock?(popup, password): Promise<void>
  connect(popup): Promise<void>
  sign(popup): Promise<void>
  confirmTx(popup): Promise<void>
  /** 新增：分类当前弹窗（登录自适应用；tx 不被登录流程自动处理） */
  // 返回 Promise：需读 DOM 可见性（isVisible/count 为异步），且要区分「存在但隐藏」与「可见」
  classifyPopup(popup): Promise<'unlock' | 'connect' | 'sign' | 'tx' | 'unknown'>
  /** 新增：登录自适应入口——按分类自动点击；返回是否处理 */
  handleLoginPopup(popup, password): Promise<boolean>
}
```

### 配置驱动的通用适配器（新钱包首选）
`src/automation/wallet/config-adapter.ts`：`createConfigWalletAdapter(config): WalletAdapter`

```ts
interface WalletAdapterConfig {
  key: string
  displayName: string
  extensionId?: string
  probePath?: string
  providerFlag?: string
  buttons?: { unlock?: string[]; connect?: string[]; sign?: string[]; confirmTx?: string[] }
}
```
内置多语言按钮候选；`classifyPopup` 按「哪些候选可见」判定；`unlock` 用密码框 + 提交候选。**多数新钱包只需 `key`+`displayName`+`extensionId`。**

### 现有 MetaMask / Petra
**保留其自定义适配器代码**（解锁/URL 逻辑成熟、真机验证过），仅**补 `displayName` 与 `classifyPopup`/`handleLoginPopup`**；不强行迁配置。新钱包一律走配置驱动。

### 新增钱包 checklist（写入文档）
1. 真机开该钱包，取 `extensionId`/`probePath`（取不到则省略走降级）。
2. 写 `WalletAdapterConfig`（通常只 `key`/`displayName`/`extensionId`）。
3. `app.ts` 注册（配置驱动用 `createConfigWalletAdapter`）。
4. 手册钱包表加一行。
5. 测试：适配器单测 + 真机 `task:run`。

## 现有任务迁移

`scenario`/`intents`/`walletEntry`/`entryTestId`/`modalTestId`/`open`/`confirm`（部分）删除；各任务的 `loginWallet({ scenario, ... })` 改为 `connectWallet({ wallet, connected, disconnected, connect?, walletOption? })`：
- 原 `direct` → 通常 `{ wallet, connected, disconnected, connect }`（多可省 connect）。
- 原 `dialog` → 加 `walletOption`（或省略，按显示名）。
- 原 `appkit` → 什么都不用加（内部自动归一化）。
影响：`src/tasks/*` 10 个任务的登录块、`tests/wallet-login-flow.test.ts`、`tests/api-wallet.test.ts`、手册第 4 章。

## 兼容与清理

- `loginWallet` 别名保留（指向 `connectWallet`）。
- `WalletScenario` 类型删除；`WalletIntent` 不再从 api 暴露（内部动作枚举改名/内敛）。
- automation 内部 `ConnectOptions`（含 entry/intents）改名 `LoginFlowOptions`，消除与 api 层 `ConnectOptions` 同名冲突。

## 安全与边界

- 登录阶段永不自动确认交易（`tx` 分类不处理）。
- 登录态启发式不可靠时，任务应显式给 `connected`（框架日志提示）。
- 站点把登录包成自定义流程（如先点站内「Sign In」）的，任务里显式 `click` 后再 `signMessage`。

## 验证

- 单测：`connectWallet` 的自适应轮（模拟：站内列表、静默连接、连接后签名、已登录、tx 弹窗不处理）；`createConfigWalletAdapter` 的分类与点击；启发式判据。
- 真机：至少 2 个不同站点（一个站内列表如 `auralaunch-checkin`、一个直接唤起扩展）`task:run` 跑通；已登录窗口幂等跳过。
- `npm run typecheck` + `npm test` + `npm run test:web` 全绿。

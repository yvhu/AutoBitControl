# Rhuna 自动签到任务设计（portal-rhuna）

日期：2026-09-02
状态：已确认（用户确认后直接实施）

## 目标

新增 faucet 任务 `portal-rhuna`：Rhuna Portal（https://portal.rhuna.io/）Daily Check-in 每日签到，Petra 钱包登录。

## 真机核实（本次探索实测沉淀）

- 未登录落地页有多个 `Connect Wallet` 按钮（header 1 个不可见 + hero/footer 可见，用 `:visible` 过滤）
- 点击后**直接唤起 Petra 扩展弹窗 `chrome-extension://ejjladinnckdgjemekebdpeokbikhfci/prompt.html`**（无站内钱包选择弹窗；现有适配器 URL 模式不匹配 prompt.html，必须补）
- 弹窗流程：锁屏页（输密码 + Unlock）→ Sign In Request 页（Cancel / Sign In，Aptos signMessage 签名）
- 点 Sign In 后弹窗关闭，站点 5s 内完成登录（后端链路：`GET /api/v1/auth/siwa/input` → `POST /api/v1/auth/siwa/verify` → `POST /api/v1/auth/validate`），头部出现 `Hello, 0x...!`
- 已登录首页有 `Start Quests` 按钮；Quests 页 https://portal.rhuna.io/quests
- Daily Check-in 卡片：`div.cursor-pointer:has-text("Daily Check-in")`（桌面/移动两套 DOM，卡片整体可点）
- 点卡片弹 `section[role="dialog"]`：
  - 未领取：有 `Claim` 按钮 → 点击后出现 `Processing your quest...`（约 15s）→ `Quest completed successfully!`
  - 已领取：弹窗直接显示 `Quest completed successfully!`（按任务要求同样算成功）
- 成功判定：弹窗内出现 `Quest completed successfully!`

## 踩坑记录（写入 meta.note）

1. Sign In 必须在**新鲜请求**上点：过期/重复请求的签名通过后站点不登录（探索阶段误判"弹窗没出现"的根因之一）
2. Petra 弹窗在部分窗口 >30s 才出现：等待必须 60s 预算 + 8s 补点（复用 `loginByWallet` 的 reclick）
3. `getByRole('button', { name: /sign in/i })` 匹配不到 Sign In 按钮（0 个），`button:has-text("Sign In")` 可以——适配器确认步改用 has-text
4. 本环境 Petra **不注入页面 provider**（`window.petra`/`window.aptos` 在 example.com 与 rhuna 均不存在，轮询 120s 证实）——现有 `WalletSession` 的 provider 轮询会误判"扩展未加载"，任务必败。需给适配器加 `expectsProvider: false`，Petra 只靠 CDP 扩展页探测（`Target.createTarget`）判定就绪
5. 个别窗口代理网络不稳（chrome-error 错误页），任务侧用 `detectPageState` 多轮刷新兜底

## 改动清单

### 1. `src/automation/wallet/petra.ts`（适配器修复）

- `extensionUrlPatterns` 追加 `chrome-extension://.*/prompt.html`（保留原两模式）
- `unlock`：输密码后优先点 `Unlock` 按钮，兜底回车
- `ensureConnected`：改用 `locator('button:has-text(...)')` 依序尝试 `Sign In`/`Connect`/`Approve`/`Confirm`，点后等弹窗关闭；保留原 getByRole 正则兜底
- 新增 `expectsProvider = false`（不依赖页面 provider 注入判定扩展就绪）

### 2. `src/automation/wallet/types.ts`

- `WalletAdapter` 增加可选字段 `expectsProvider?: boolean`（默认 true，MetaMask 等不变）

### 3. `src/automation/wallet/session.ts`

- `probe`：`expectsProvider === false` 时跳过 provider 轮询，只做 CDP 扩展页探测（成功即 ready）

### 4. `src/tasks/portal-rhuna.ts`（新任务）

meta：key `portal-rhuna`、name `Rhuna 签到`、category `faucet`、wallet `petra`、无 schedule（手动/窗口立即跑）、timeoutSec 600、retry { max: 2, backoffSec: 600 }、captcha { auto: true, maxCost: 1500 }

流程（全部选择器为真机元素）：

1. `closeOtherTabs` → `goto`
2. `detectPageState({ loggedInText: 'Hello,', landingText: 'Connect Wallet' })` 竞速判定登录态（10 轮刷新兜底）
3. 未登录分支：`ensureWalletReady` → 点 `button:has-text("Connect Wallet"):visible` → `loginByWallet({ reclick: { selector, afterMs: 8000 } })`（等弹窗 60s → 解锁 → Sign In）→ `waitForTextWithReloads('Hello,')`，超时抛错
4. 进 Quests：`Start Quests` 按钮存在则点并断言 `Daily Check-in`，否则直接 `goto /quests`；`Daily Check-in` 等待带刷新兜底
5. 点卡片 `div.cursor-pointer:has-text("Daily Check-in")` → 等 `[role="dialog"]`
6. 弹窗内竞速 `raceTexts`: `Quest completed successfully!`（已领=成功）/ `Claim`（待领）
7. 有 Claim：点 `[role="dialog"] button:has-text("Claim")` → 10s 内未见 `Processing your quest...` 补点一次 → 等 `Quest completed successfully!`（预算 90s，实测约 15s）
8. 成功：截图 `rhuna-success` + 日志

### 5. `src/tasks/index.ts`

- ALL 数组登记 `PortalRhunaTask`

## 验证计划（真机）

- 02/03/04：完整"登录 + Claim"路径，`npm run task:run` 单窗口跑，期望 success
- 01/06：已登录且当日已领，走"已领取=成功"路径，期望 success
- `npm run typecheck` + `npm test` 通过

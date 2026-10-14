# 钱包 2.0：connectWallet 自适应 + 配置驱动适配器（Block 1b）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把钱包登录从「scenario + intents」改为「只描述可见行为、自动推断」的自适应 `connectWallet`，并让新增钱包 = 填一条配置。

**Architecture:** `src/api/wallet.ts` 的 `connectWallet(ctx, ConnectOptions)` → `WalletActions` → 自适应编排（`raceProbes` 竞速「站内钱包项 / 扩展弹窗 / connected / disconnected」，扩展弹窗按适配器 `classifyPopup` 自动 unlock/connect/sign，**绝不处理 tx**）。适配器新增 `displayName`/`classifyPopup`/`handleLoginPopup`；新增配置驱动 `createConfigWalletAdapter`；MetaMask/Petra 保留自定义代码仅补分类。automation 内部规格类型改名 `LoginFlowOptions`。

**Tech Stack:** TypeScript 严格模式、patchright、vitest（注入假 PopupPage 单测）。

## Global Constraints

- 代码风格：无分号、单引号、2 空格、TS 严格；注释中文；依赖方向不可反向。
- **安全边界**：登录流程只自动处理 `unlock`/`connect`/`sign`，**绝不自动确认交易**（`tx`）。
- `connectWallet` 返回 `Promise<void>`（与现签名一致）。
- `loginWallet` 保留为 `connectWallet` 别名。
- 去库名：`appkit/reown/rainbowkit/w3m/scenario/intents/entryTestId/modalTestId/open` 不出现在任务可见 API。
- 不改 `docs/superpowers/**` 历史文档。
- 验证：`npm run typecheck` + `npm test` + `npm run test:web` 全绿；真机验证由用户执行（无法在 CI 完成）。
- 本会话不提交（用户未要求）。

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/automation/wallet/types.ts` | 改 | WalletAdapter 加 `displayName`/`classifyPopup`/`handleLoginPopup`；`extensionId` 改可选 |
| `src/automation/wallet/config-adapter.ts` | 新建 | `createConfigWalletAdapter` |
| `src/automation/wallet/metamask.ts` / `petra.ts` | 改 | 补 displayName + classify + handleLoginPopup |
| `src/automation/wallet/login-flow.ts` | 改 | 自适应编排；`LoginSpec`→`LoginFlowOptions` |
| `src/automation/wallet/actions.ts` / `index.ts` | 改 | 类型/导出同步 |
| `src/api/wallet.ts` | 改 | `connectWallet` + ConnectOptions + 启发式；删 WalletScenario |
| `src/tasks/*.ts`（10） | 改 | 登录块改新形状 |
| `tests/*` | 改/加 | 适配器/自适应/迁移测试 |
| `docs/API-GUIDE.md` | 改 | 第 4 章钱包 |

---

### Task 1: 适配器层（displayName + 分类 + 配置驱动）

**Files:** `src/automation/wallet/{types,config-adapter,metamask,petra,index}.ts`、`tests/config-adapter.test.ts`

**Interfaces:**
- Produces: `WalletAdapter` 增 `displayName: string`、`classifyPopup(popup): 'unlock'|'connect'|'sign'|'tx'|'unknown'`、`handleLoginPopup(popup, password?): Promise<boolean>`；`createConfigWalletAdapter(config: WalletAdapterConfig): WalletAdapter`。

- [ ] **Step 1: 扩展 WalletAdapter 类型**

`types.ts`：加 `displayName: string`、`extensionId?: string`（改可选）、`classifyPopup`、`handleLoginPopup`；注释中文。

- [ ] **Step 2: 写 `createConfigWalletAdapter` 失败测试**

`tests/config-adapter.test.ts`：注入假 `PopupPage`（按 testid/role 返回可点按钮），断言：按钮候选命中→分类正确→`handleLoginPopup` 点击对应按钮并返回 true；无候选→`unknown`→返回 false。

- [ ] **Step 3: 实现 `config-adapter.ts`**

内置多语言候选：
```ts
const DEFAULT_BUTTONS = {
  unlock: ['button:has-text("Unlock")', 'button:has-text("解锁")', 'button:has-text("确认")'],
  connect: ['button:has-text("Connect")', 'button:has-text("连接")', 'button:has-text("下一步")', 'button:has-text("Next")'],
  sign: ['button:has-text("Sign")', 'button:has-text("签名")', 'button:has-text("确认")', 'button:has-text("Confirm")'],
  confirmTx: ['button:has-text("Confirm")', 'button:has-text("确认")', 'button:has-text("Approve")'],
}
```
`classifyPopup`：按各候选在当前弹窗可见性判定（unlock/connect/sign/tx/unknown）。`handleLoginPopup`：`unlock` 用密码框（候选 `input[type=password]`）+ 提交；`connect`/`sign` 点候选；`tx` **返回 false（不处理）**。

- [ ] **Step 4: MetaMask / Petra 补字段**

各加 `displayName`（`'MetaMask'`/`'Petra'`）、`classifyPopup`（按各自弹窗 URL/按钮判类）、`handleLoginPopup`（复用手头 unlock/connect/sign 方法，`tx` 不处理）。

- [ ] **Step 5: 运行并通过**

Run: `npx vitest run tests/config-adapter.test.ts tests/wallet.test.ts`; `npm run typecheck` → 绿。

---

### Task 2: connectWallet 自适应编排

**Files:** `src/api/wallet.ts`、`src/automation/wallet/{login-flow,actions,index}.ts`、`tests/api-wallet.test.ts`、`tests/wallet-login-flow.test.ts`

**Interfaces:**
- Consumes: Task 1 适配器。
- Produces: `connectWallet(ctx, opts: ConnectOptions): Promise<void>`；automation `LoginFlowOptions`（原 `ConnectOptions`）。

- [ ] **Step 1: 重写 `ConnectOptions`（api 层）**

移除 `scenario` 及 appkit/dialog 专属字段；按 Block 0 形状（wallet + 可选 connected/disconnected/connect/walletOption/confirm/waitConnectedMs/errorTexts/refreshEveryMs/attempts/reclickAfterMs）。保留 `WalletType`。删 `WalletScenario`。

- [ ] **Step 2: 自适应 `ensureConnected`（login-flow.ts）**

用 `raceProbes` 实现 Block 1b spec 的算法（判初始态/连接按钮/自适应循环/归一化/等 connected）。分类 `tx` 的弹窗不处理。`LoginSpec`→`LoginFlowOptions`。`actions.ts`/`index.ts` 同步。

- [ ] **Step 3: `connectWallet` 映射 + 启发式**

`api/wallet.ts`：`connectWallet` 组装 `LoginFlowOptions`；内部 `findConnectButton(page)`（候选文案）；启发式 connected/disconnected（地址正则 / 连接按钮候选）。

- [ ] **Step 4: 测试（注入假 Page/Popup）**

`tests/api-wallet.test.ts`、`tests/wallet-login-flow.test.ts` 覆盖：站内列表自动选、静默连接（无弹窗）、连接后自动签名、已登录直接返回、**tx 弹窗不被处理**、配置缺省 walletOption 按 displayName。断言与命名更新。

- [ ] **Step 5: 运行并通过**

Run: `npx vitest run tests/api-wallet.test.ts tests/wallet-login-flow.test.ts`; `npm run typecheck` → 绿。

---

### Task 3: 任务与文档迁移

**Files:** `src/tasks/*.ts`（10）、`tests/{inception-dachain,portal-rhuna,shelby-explorer}.test.ts`、`docs/API-GUIDE.md`

- [ ] **Step 1: 迁移任务登录块**

`loginWallet({ scenario, ... })` → `connectWallet({ wallet, connected, disconnected, connect?, walletOption? })`。
- 原 `direct` → `{ wallet, connected, disconnected, connect? }`
- 原 `dialog` → 加 `walletOption`（或省略）
- 原 `appkit` → 不加（自动归一化）

- [ ] **Step 2: 迁移测试**

断言更新为新形状；`api-docs-drift` 守卫通过。

- [ ] **Step 3: 文档第 4 章重写**

去掉 `direct/appkit/dialog` 三场景叙事，改为「**自适应登录**：通常只写 `wallet`；复杂站点覆盖 `connected`/`connect`；站内列表可省 `walletOption`」+ 新增钱包 checklist + 安全边界说明。

- [ ] **Step 4: 运行并通过**

Run: `npm run typecheck`; `npm test`; `npx vitest run tests/api-docs-drift.test.ts` → 全绿。

---

### Task 4: 全量验证

- [ ] **Step 1:** `npm run typecheck` 干净；`npm test` 全绿；`npm run test:web` 全绿。
- [ ] **Step 2: 残留检查**（应为 0，除别名/文档说明）：`Get-ChildItem -Recurse -File -Include *.ts,*.tsx -Path src,tests | Select-String -Pattern "scenario:|entryTestId|modalTestId|walletEntry|'appkit'|'dialog'|'direct'|WalletScenario|intents:"`
- [ ] **Step 3: 真机验证（用户执行）**：`auralaunch-checkin`（站内列表）+ 一个直接唤起扩展的站点，各 `task:run` 跑通；已登录窗口幂等跳过。

---

## Self-Review

- 覆盖 Block 1b spec：ConnectOptions 形状（T2）、自适应算法（T2）、安全边界 tx（T1+T2）、displayName/分类（T1）、配置驱动新增钱包（T1）、迁移（T3）、兼容别名（T2/T3）、同名冲突清理（T2）。
- 无占位符；命令明确；类型名一致（`ConnectOptions` api 层、`LoginFlowOptions` automation 层）。
- 风险：自适应编排为行为改造，真机验证必须由用户完成（CI 仅覆盖注入假件单测）。

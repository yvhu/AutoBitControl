# 任务侧 API 改名（Block 1a）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 Block 0 约定，对任务侧 API（`src/api` + 类型 + 参数名）做**纯改名**，**行为完全不变**；同步所有任务、测试、用户手册。钱包 `scenario/ConnectOptions` 的形状改造留到 Block 1b。

**Architecture:** 以 `npm run typecheck` 为向导做机械改名：先改 `src/api` 定义与出口 → 逐步修全部调用点（typecheck 会逐一报出）→ 改测试 → 改手册。`loginWallet` 保留为 `connectWallet` 的兼容别名。

**Tech Stack:** TypeScript（严格模式）、vitest、patchright、Express。

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块说明职责与依赖方向。
- 注释 / 文档 / commit message 一律中文。
- **纯改名，不改任何运行时行为**；不改逻辑、不改默认值、不改流程。
- 依赖方向不可反向。
- `loginWallet` 保留为 `connectWallet` 的**兼容别名**（`export const loginWallet = connectWallet`），本轮不删。
- 不改 `docs/superpowers/**` 下的历史 spec/plan（仅改用户手册 `docs/API-GUIDE.md`）。
- 验证：`npm run typecheck` + `npm test` + `npm run test:web` 全绿。

## 改名映射（唯一真值）

**函数：**
| 现 | 改为 |
| --- | --- |
| `pressKey` | `press` |
| `runJs` | `evaluate` |
| `elementState` | `getElementState` |
| `waitResponse` | `waitForResponse` |
| `loginWallet` | `connectWallet`（另留 `loginWallet` 别名） |
| `getAccount` | `getAccountValue` |
| `uploadFile` | `setInputFiles` |

**类型：**
| 现 | 改为 |
| --- | --- |
| `Probe` | `Matcher` |
| `WaitProbe` | `WaitMatcher` |
| `LoginSpec`（`src/api/wallet.ts` 里的那个，任务可见） | `ConnectOptions` |

**探针等待态：** `{ gone: string }` → `{ hidden: string }`。

**参数名（仅函数签名，行为不变）：** 选项对象参数 `options` → `opts`；匹配器参数 `probe` / `match` → `matcher`；选择器参数保持/统一为 `selector`（`click` 的 `target` 保留）。

> **替换顺序坑**：必须**先长后短**替换，避免子串误伤——`WaitProbe` 先于 `Probe`；`WaitMatcher` 同理。逐符号用「整词/单词边界」替换，别用裸子串。

---

### Task 1: `src/api` 定义与出口改名

**Files:**
- Modify: `src/api/page.ts`（`pressKey`→`press`、`runJs`→`evaluate`）
- Modify: `src/api/find.ts`（`elementState`→`getElementState`）
- Modify: `src/api/wait.ts`（`waitResponse`→`waitForResponse`；`Probe`→`Matcher`、`WaitProbe`→`WaitMatcher`；`{ gone }`→`{ hidden }`；参数 `options`→`opts`、`probe`→`matcher`、`match`→`matcher`）
- Modify: `src/api/wallet.ts`（`loginWallet`→`connectWallet` + 别名；`LoginSpec`→`ConnectOptions`；`signMessage`/`confirmTransaction` 的 `options`→`opts`）
- Modify: `src/api/data.ts`（`getAccount`→`getAccountValue`、`uploadFile`→`setInputFiles`）
- Modify: `src/api/index.ts`（出口名同步；`export type { Matcher, WaitMatcher, WaitOptions }`；`export { connectWallet, loginWallet, ... }`）
- Modify: `src/api/captcha.ts`、`src/api/ai.ts`（`options`→`opts`；`answerQuiz` 的 `spec`→`opts`）

**Interfaces:**
- Produces: 新导出名（见映射）；`loginWallet` 别名指向 `connectWallet`。

- [ ] **Step 1: 改 `src/api/wait.ts` 的类型与函数名**

先改 `WaitProbe`→`WaitMatcher`，再 `Probe`→`Matcher`（顺序不可反）：

```ts
export type Matcher = string | { text: string } | { selector: string }
export type WaitMatcher = Matcher | { hidden: string }
```

`waitFor(ctx, matcher: WaitMatcher, opts: WaitOptions = {})`：函数体内 `options`→`opts`、`probe`→`matcher`；把 `{ gone }` 的判定分支改为 `{ hidden }`（`src/automation/dom` 内核如需同步，见 Task 2）。
`race(ctx, entries: Array<[K, Matcher]>, timeoutMs)` 类型注释同步。
`waitResponse` 改名 `waitForResponse`，签名第二参 `match`→`matcher`（类型内字段名不变）、第三参 `options`→`opts`。

- [ ] **Step 2: 改 `src/api/page.ts` / `find.ts` / `data.ts`**

- `pressKey`→`press`（实现与注释同步）。
- `runJs`→`evaluate`。
- `elementState`→`getElementState`。
- `getAccount`→`getAccountValue`。
- `uploadFile`→`setInputFiles`（参数名 `value` 可保留或改 `files`，行为不变即可）。

- [ ] **Step 3: 改 `src/api/wallet.ts`**

```ts
export async function connectWallet(ctx: TaskContext, opts: ConnectOptions): Promise<void> { /* 原 loginWallet 体，spec → opts */ }
/** @deprecated 用 connectWallet；保留别名过渡 */
export const loginWallet = connectWallet
```
把 `type LoginSpec = ...` 改名 `ConnectOptions`（形状不变，`scenario` 等字段留到 Block 1b 删）。`signMessage`/`confirmTransaction` 的 `options` 参数改名 `opts`。

- [ ] **Step 4: 改 `src/api/index.ts` 出口**

```ts
export { openPage, click, fill, press, evaluate } from './page'
export { getElementState, getText, hasText } from './find'
export { waitFor, race, waitForResponse } from './wait'
export type { Matcher, WaitMatcher, WaitOptions } from './wait'
export { connectWallet, loginWallet, signMessage, confirmTransaction } from './wallet'
export type { WalletType, WalletScenario, WalletIntent, ConnectOptions, WalletActionOptions } from './wallet'
export { clickTurnstile } from './captcha'
export { askAi, answerQuiz } from './ai'
export { getAccountValue, setInputFiles, takeScreenshot } from './data'
export { recordStep, getSteps } from './diag'
export type { StepRecord } from '../automation'
```

- [ ] **Step 5: 改 `src/api/captcha.ts` / `ai.ts` 参数名**

`clickTurnstile(ctx, opts = {})`、`askAi(ctx, prompt, opts = {})`、`answerQuiz(ctx, opts)`（原 `spec`）；函数体内引用同步。

- [ ] **Step 6: 类型检查（会报出所有待改调用点）**

Run: `npm run typecheck`
Expected: 一批「Cannot find name / has no exported member」错误——记录待改文件清单，交给 Task 2/3。

---

### Task 2: 引擎 / 自动化层的类型引用同步

**Files:**
- Modify: `src/engine/task.ts`（若 re-export `LoginSpec` → `ConnectOptions`）
- Modify: `src/automation/**`（仅当它引用 `src/api` 的 `Probe`/`LoginSpec` 名字；内部自有 `Probe` 类型**不改**）

**Interfaces:**
- Consumes: Task 1 的新名字。

- [ ] **Step 1: 按 typecheck 报错逐一修 `src/engine`、`src/automation`**

只改「引用 api 层导出名」的地方；automation 内部自有的 `Probe`（`src/automation/dom/probe.ts`）**保持不动**（不是任务可见 API）。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: `src/` 内无错误（tests 的错误留 Task 3）。

---

### Task 3: 任务侧调用点改名（`src/tasks/*`）

**Files:** `src/tasks/example-checkin.ts`、`faucet-example.ts`、`mint-example.ts`、`inception-dachain.ts`、`portal-rhuna.ts`、`shelby-faucet.ts`、`shelby-explorer.ts`、`arc-faucet.ts`、`konnex-checkin.ts`、`auralaunch-faucet.ts`、`auralaunch-checkin.ts`

- [ ] **Step 1: 逐一改调用点**

把任务里的 `pressKey(`→`press(`、`runJs(`→`evaluate(`、`elementState(`→`getElementState(`、`waitResponse(`→`waitForResponse(`、`getAccount(`→`getAccountValue(`、`uploadFile(`→`setInputFiles(`、`loginWallet(`→`connectWallet(`；`import { ... } from '../api'` 的名字同步；若任务里用了 `Probe`/`WaitProbe` 类型或 `{ gone }`，改为 `Matcher`/`WaitMatcher`、`{ hidden }`。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: `src/` 全绿（仅 tests 可能仍报错）。

---

### Task 4: 测试改名

**Files:** `tests/api-page.test.ts`、`api-find.test.ts`、`api-wait.test.ts`、`api-wallet.test.ts`、`api-data.test.ts`、`wallet-login-flow.test.ts`、`windowRunner.test.ts`、`inception-dachain.test.ts`、`portal-rhuna.test.ts`、`shelby-explorer.test.ts` 等（凡引用被改名的导出）

- [ ] **Step 1: 按 typecheck / 测试报错逐一修测试引用**

导入名、调用名、类型名同步（`pressKey`→`press` 等）。**不断言行为变化**——纯改名，断言不变。

- [ ] **Step 2: 类型检查 + 后端测试**

Run: `npm run typecheck`
Expected: 全绿。

Run: `npm test`
Expected: 全部 PASS（用例数与改名前后一致）。

---

### Task 5: 用户手册同步（`docs/API-GUIDE.md`）

**Files:** `docs/API-GUIDE.md`

- [ ] **Step 1: 替换手册中的旧名**

`pressKey`→`press`、`runJs`→`evaluate`、`elementState`→`getElementState`、`waitResponse`→`waitForResponse`、`loginWallet`→`connectWallet`（首次出现注明旧名别名）、`getAccount`→`getAccountValue`、`uploadFile`→`setInputFiles`、`Probe`→`Matcher`、`WaitProbe`→`WaitMatcher`、`LoginSpec`→`ConnectOptions`；`{ gone }`→`{ hidden }`。**不改** `docs/superpowers/**`。

- [ ] **Step 2: 漂移守卫**

Run: `npx vitest run tests/api-docs-drift.test.ts`
Expected: PASS（每个 `src/api/index.ts` 导出名在手册出现）。

---

### Task 6: 全量验证

**Files:** 无

- [ ] **Step 1: 三套验证**

Run: `npm run typecheck` → 干净。
Run: `npm test` → 全绿。
Run: `npm run test:web` → 全绿。

- [ ] **Step 2: 关键字残留检查（应为 0）**

Run: `Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.md -Path src,tests,docs\API-GUIDE.md | Select-String -Pattern '\bpressKey\b|\brunJs\b|\belementState\b|\bwaitResponse\b|\bgetAccount\b|\buploadFile\b|\bWaitProbe\b|\bLoginSpec\b'`
Expected: 无输出（`loginWallet` 作为别名允许保留；`docs/superpowers/**` 不计）。

---

## Self-Review

**Spec coverage（Block 0 映射 → 任务）：**
- 函数改名（press/evaluate/getElementState/waitForResponse/connectWallet/getAccountValue/setInputFiles）→ Task 1、3、4、5。
- 类型改名（Matcher/WaitMatcher/ConnectOptions）→ Task 1、2、3、4、5。
- 探针 `{ gone }`→`{ hidden }` → Task 1、2、5。
- 参数名（opts/matcher/selector）→ Task 1。
- `loginWallet` 别名 → Task 1、5。
- 钱包形状改造（scenario 删除、自适应、配置驱动适配器）→ **不在本块**，留 Block 1b。

**Placeholder scan：** 无 TBD/TODO；步骤含具体改名与命令。

**Type consistency：** 映射表与各任务用名一致；`ConnectOptions` 在 Task 1 定义、Task 5 文档同步；`WaitMatcher` 先于 `Matcher` 替换的顺序已标注。

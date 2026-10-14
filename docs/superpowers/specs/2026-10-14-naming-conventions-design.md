# 命名与术语规范设计（Block 0）

日期：2026-10-14
状态：已确认（用户确认方向后实施；本文件为后续所有改名块的依据）

## 目标

统一全项目「任务 API / 类型 / TaskMeta / 配置 / REST+错误码 / 代码风格」的命名与参数形状。核心诉求（用户原话）：

- 名字要**见名知意**，一眼看出含义。
- **不暴露底层实现/第三方库名**（如 `appkit`/Reown/RainbowKit/`intent`/`probe`/`spec`/`entry`）——任务作者不需要懂这些。
- 接口只描述**站点上可观察的行为**；能自动推断的就不让用户写。

本文件是地基（Block 0），Block 1-5 的改名/文档都引用它。

## 核心原则（P）

- **P1** 标识符英文；注释 / 文档 / commit 中文。
- **P2** 动作函数动词开头（open/click/fill/wait/connect/…）；查询用 `getX` / `isX` / `hasX`。
- **P3** 参数形状：**≥2 个可选参数 → 一律单个 `opts` 对象**；**单一必填参数 → 位置参数**。
- **P4** 布尔字段**肯定式**（`enabled` / `isX` / `hasX`）；禁止 `noX` / `disableX` / `skipX` 这类反向命名。
- **P5** 时间带单位后缀：毫秒 `Ms`、秒 `Sec`、天 `Days`；**同一层内统一**（TaskMeta 用 `Sec`，config 用 `Ms`，文档写明）。
- **P6** 选择器字段名以 `Selector` 结尾或本身就是选择器名；文案字段用 `Text`；集合字段用复数。
- **P7** **不暴露第三方库 / SDK / 实现概念名**：`appkit`、`reown`、`rainbowkit`、`w3m`、`intent`、`entry`、`probe`、`spec`、`modalTestId` 等一律不出现在任务可见 API 与文档里；改按「站点上看得见的行为」命名。
- **P8** 匹配器（“一段文案或一个选择器”）统一为单一概念 **`Matcher`**；凡是框架能按上下文推断的，就不作为参数暴露。

## 任务 API 改名映射（`src/api`）

| 现用 | 改为 | 依据 |
| --- | --- | --- |
| `openPage` | `openPage` | 保留 |
| `click` | `click` | 保留（`target` 可为选择器或坐标） |
| `fill` | `fill` | 保留 |
| `pressKey` | `press` | 简洁动词 |
| `runJs` | `evaluate` | 对齐通用术语，避开 `Js` 这种实现细节 |
| `elementState` | `getElementState` | P2 查询动词前缀 |
| `getText` | `getText` | 保留 |
| `hasText` | `hasText` | 保留（P4 肯定式） |
| `waitFor` | `waitFor` | 保留 |
| `race` | `race` | 保留 |
| `waitResponse` | `waitForResponse` | P2 动词补全 |
| `loginWallet` | `connectWallet` | 只描述「连接钱包」这一可见行为 |
| `signMessage` | `signMessage` | 保留 |
| `confirmTransaction` | `confirmTransaction` | 保留 |
| `clickTurnstile` | `clickTurnstile` | 保留（Turnstile 是站点上可见的验证码控件名） |
| `askAi` | `askAi` | 保留 |
| `answerQuiz` | `answerQuiz` | 保留 |
| `getAccount` | `getAccountValue` | 明确返回的是「数据源某一列的值」 |
| `uploadFile` | `setInputFiles` | 对齐通用术语（设置文件输入） |
| `takeScreenshot` | `takeScreenshot` | 保留 |
| `recordStep` / `getSteps` | 保留 | |

## 类型改名映射

| 现用 | 改为 | 依据 |
| --- | --- | --- |
| `Probe` | `Matcher` | P8：统一「文案或选择器」概念 |
| `WaitProbe` | `WaitMatcher` | 同上（含 `{ hidden }` 等待态） |
| `WaitOptions` | `WaitOptions` | 保留 |
| `LoginSpec` | `ConnectOptions` | P7：去掉 `Spec`；与 `connectWallet` 对应 |
| `WalletScenario` | **删除** | P7：`scenario` 概念整体去除 |
| `WalletIntent` | **删除** | P7：`intent` 不暴露 |
| `WalletType` | `WalletType` | 保留 |
| `WalletActionOptions` | `WalletActionOptions` | 保留 |
| `StepRecord` | `StepRecord` | 保留 |

## 参数名统一

- 选择器参数一律 `selector`；`click` 的坐标分支保留 `target`（选择器或坐标两态）。
- 选项对象参数一律 `opts`（现混用 `options` / `spec` / `match`）。
- 「匹配器」参数一律 `matcher`（原 `probe` / `match`）。
- 探针 `{ gone: string }` 等待态改名 `{ hidden: string }`（语义不变：不可见或消失）。

## 钱包 API：`connectWallet`（去库名 + 全自动推断）

替代原 `loginWallet(ctx, LoginSpec)`。**除 `wallet` 外全部可选**，缺省走启发式，复杂站点可覆盖：

```ts
interface ConnectOptions {
  wallet: WalletType                      // 必填：用哪个钱包
  connected?: Matcher                     // 已登录判据；缺省启发式（见下），复杂站点建议显式
  disconnected?: Matcher                  // 未登录判据；缺省启发式
  connect?: string                        // 站点「连接钱包」按钮选择器；缺省用文案候选
  walletOption?: Matcher                  // 站内钱包列表要选的项；缺省按钱包显示名匹配
  confirm?: string                        // 列表前的中间确认按钮（少用）
  waitConnectedMs?: number                // 等已登录判据的最长毫秒（缺省 90000）
  errorTexts?: string[]                   // 命中即刷新恢复的错误文案
  refreshEveryMs?: number                 // 等待期间周期刷新间隔
  attempts?: number                       // 整体重试轮数
  reclickAfterMs?: number                 // 弹窗慢渲染补点间隔
}
```

**自动推断（任务作者只写 `{ wallet: 'metamask' }` 即可）**：
1. **判初始态**：有 `connected`/`disconnected` 用它们竞速；否则启发式——已连接 = 页面出现地址样式文本（`/0x[a-fA-F0-9]{6,}/`）；未连接 = 出现连接按钮（见下）。已连接直接返回。
2. **连接按钮**：`connect` 缺省用文案候选（`Connect Wallet` / `连接钱包` / `Connect`）逐个尝试首个可见者。
3. **站内钱包列表自动检测**：点完连接后**运行时竞速**「扩展弹窗出现」vs「站内出现钱包项」——谁先出现走谁，**作者无需声明**。若弹窗停在非列表视图，内部自动「拨回列表」（返回/全部钱包/浏览器标签）。
4. **选钱包**：`walletOption` 缺省按钱包显示名匹配（`metamask`→`MetaMask`、`petra`→`Petra`）。
5. **弹窗驱动自适应（去 `intents`）**：在等 `connected` 的窗口期内，**出现钱包弹窗就按类型自动派发**——按弹窗识别出的动作点对应按钮（解锁 / 连接 / 签名），循环直到 `connected` 出现或超时。
   - **安全边界**：登录阶段**只处理 connect / sign，绝不自动确认交易**（`confirmTx` 只由任务显式 `confirmTransaction` 触发）。
   - 覆盖：已授权静默连接（无弹窗）；连接后站点自动发起签名（SIWE）；站内列表；本就是登录态（初始竞速即返回）。站点把登录包成自定义流程的，仍需任务显式 `click`+`signMessage` 编排。
6. **等已连接**：用 `connected` 或启发式。

**启发式可靠性说明**：登录态启发式跨站点不保证（有的显示 ENS/头像/异常文案）；**关键站点或启发式误判风险高时，务必显式给 `connected`**（本框架铁律：成功必须显式断言；启发式判「已连接」可能误判成功）。框架会在日志里打印检测到的判据与候选，便于排障。

**显示名来源**：Block 1 给 `WalletAdapter` 增加 `displayName`（如 `MetaMask` / `Petra`），`walletOption` 缺省匹配即取它——任务作者不写、也不硬编码文案。

**兼容**：`loginWallet` 暂时保留为别名（内部转 `connectWallet`），下一轮清理。

## 新增钱包：配置驱动的通用适配器

目标：**新增钱包 = 填一条配置 + 注册**，通常不写代码。把现有 `WalletAdapter`（每钱包一个文件）改为「通用适配器（配置驱动）」+「可选自定义」：

```ts
interface WalletAdapterConfig {
  key: string                 // 唯一标识，与 meta.wallet 对应（'metamask' | 'petra' | ...）
  displayName: string         // 展示名（如 'MetaMask'/'Petra'），walletOption 缺省按它匹配
  extensionId?: string        // 扩展 ID（就绪探测用；缺省则降级为不探测扩展、直接 ready）
  probePath?: string          // 扩展页路径（缺省自动推断）
  providerFlag?: string       // window 注入标识（如 'isMetaMask'），区分多钱包
  buttons?: {                 // 各类弹窗的按钮文案/选择器候选；缺省用内置多语言候选
    unlock?: string[]
    connect?: string[]
    sign?: string[]
    confirmTx?: string[]
  }
  custom?: WalletAdapter      // 特殊钱包：整包自定义，覆盖上面的配置
}
```

内置多语言按钮候选（`Connect`/`连接`/`Sign`/`签名`/`Confirm`/`Approve`/…），所以多数新钱包通常只填 `key` + `displayName` + `extensionId`。

**新增钱包 checklist**（写入文档）：
1. 真机开该钱包，从 CDP 扩展页取 `extensionId` / `probePath`（取不到就省略，走降级）。
2. 填 `WalletAdapterConfig`（key/displayName/extensionId + 必要时按钮文案）。
3. 在 `app.ts` 的钱包注册表登记。
4. `docs/API-GUIDE.md` 钱包表加一行。
5. 测试：适配器单测（模拟弹窗）+ 真机 `task:run` 跑通。

## TaskMeta / 配置

- **TaskMeta** 字段已基本清晰，**保留**：`key`/`name`/`url`/`sourceUrl`/`note`/`category`/`group`/`lastUpdated`/`enabled`/`wallet`/`timeoutSec`/`retry.{max,backoffSec}`/`concurrency`/`requiresFileAssign`。仅文档写明时间单位为秒。
- **配置** 段名与键**保留**（`execution`/`scheduler`/… 与 `Ms`/`Sec`/`Days` 单位后缀已统一）；文档写明 `bitbrowser.retryBackoffMs` 与 `execution.retryBackoffSec` 属不同层、单位不同。

## REST / 错误码 / swagger

- 路由命名与响应 envelope（`{ code, message, data }`）**保持**（已资源化、已统一）。
- **错误码**：按 HTTP 段（400xx / 404xx / 409xx / 5xxxx）重排常量并加分组注释，**数值保持不变**（避免破坏前端/测试/文档引用）。
- **swagger summary** 统一为中文短句（「动词 + 对象」，不带句号）。

## 代码风格总规范（`AGENTS.md` 摘要，Block 5 落地）

- 文件头中文注释块模板：模块职责 + 依赖方向（`依赖方向：…`）+ 可选设计思路。
- 命名：文件 kebab-case、类 PascalCase、函数/变量 camelCase、常量 SCREAMING_SNAKE。
- 类型/接口名**禁用缩写**；导出即公共契约，命名同函数。
- 测试文件 `<模块>.test.ts`；用例名中文描述行为。
- 扩展 `tests/api-docs-drift.test.ts` 守卫：`src/api/index.ts` 每个导出名必须在 `docs/API-GUIDE.md` 出现（已有，随改名同步）。

## 实施分块（各自独立 spec → 计划 → 实现 → 文档同步）

- **Block 1** 任务侧 API 重构（本文件映射；含钱包 2.0：`connectWallet` 去 scenario/intents、弹窗驱动自适应、配置驱动通用适配器；影响 ~11 个任务、tests、文档第 3/4 章）。
- **Block 2** TaskMeta / 配置命名（本文件仅小调整，主要是文档）。
- **Block 3** REST + swagger 规范（错误码重排 + summary 统一）。
- **Block 4** 文档结构重构（决策树 / 速查 / 术语表 / 可跑示例；用最终命名）。
- **Block 5** 代码风格总规范（AGENTS + 守卫）。

## 验证

- 每块结束：`npm run typecheck` + `npm test` + `npm run test:web` 全绿。
- 破坏性改名在**同一块内一次到位**：所有调用点（任务、tests、文档示例）同步，不留半截别名（`loginWallet` 除外，按上文过渡）。

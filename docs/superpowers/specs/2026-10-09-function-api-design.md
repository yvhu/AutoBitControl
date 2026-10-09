# 能力函数库与统一出口设计（`src/api`）

日期：2026-10-09
状态：设计已确认，待写实施计划

## 背景与目标

当前对外 API 是「`ctx` 上的命名空间 + 方法」（`ctx.wallet.ensureLoggedIn(spec)`、`ctx.captcha.*`、`ctx.race/recover/step`…）。用户诉求：
1. 对外是**普通函数**，参数直接传（如钱包类型、场景类型），任务只从一个统一出口 `import` 后调用。
2. `ctx` 退化为**运行时数据袋子**（本次运行的环境），不再是能力载体。
3. 文档只讲**函数怎么用**，不讲 REST/面板/定时/配置/架构。

目标：
- 新增唯一出口 `src/api/index.ts`，导出全部能力函数（动词命名，可读规范）。
- `ctx` 只保留运行时字段；能力全部为函数。
- 文档重写为**函数手册**（每函数：用途/参数表/示例/注意）。
- 彻底替换旧的 `ctx.*` 命名空间（不并存）。

## 设计原则

- **函数化**：能力是纯函数，首参统一为 `ctx`（运行时袋），其余为业务参数。
- **统一出口**：任务只 `import { ... } from '../api'`；`src/api/` 内部按能力分文件，出口汇总。
- **命名规范**：动词/动词短语开头、无缩写、语义自解释；`ctx` 数据字段用名词。
- **类型兜底**：能用判别联合约束的（钱包场景）就用，编辑器直接提示必填项。
- **文档即函数手册**：每函数必有参数表 + 至少一个可运行示例；用测试守卫「出口函数都有文档」。

## 分层

```
tasks → api → engine → automation/integrations → infrastructure
```

`api` 为新增的对外层：依赖 `engine`（`TaskContext` 类型、`StepRecorder` 等）与 `automation`（`dom/wallet/captcha` 的实现）。`tasks` 只依赖 `api`（与 `./base` 的任务基类）。

## 运行时 `ctx`（数据袋子）

`TaskContext` 不再有方法，只暴露函数需要的运行时数据：

```ts
interface TaskContext {
  readonly page: Page                 // patchright 页面（逃生口）
  readonly log: Logger                // 日志器
  readonly profile: ProfileRow        // 当前窗口信息
  readonly artifactsDir: string       // 截图产物目录
  readonly accountRow: Record<string, string> | null  // 数据源当前行
  readonly task: TaskRef              // 当前任务 meta
  // 钱包内部依赖（仅 loginWallet 使用）
  readonly wallets?: WalletRegistry
  readonly walletPasswords: Record<string, string>
  readonly walletSession?: WalletSession
}
```

由框架（`window-runner`）每个窗口每次尝试创建并注入，任务永不 `new`。

## 出口与文件

```
src/api/
  index.ts      # 唯一出口：re-export 下列全部函数与类型
  page.ts       # openPage / click / fill / pressKey / runJs
  find.ts       # elementState / countElements / getText / hasText
  wait.ts       # waitFor / race / waitResponse
  wallet.ts     # loginWallet
  captcha.ts    # clickTurnstile
  data.ts       # getAccount / uploadFile / takeScreenshot
  diag.ts       # recordStep / getSteps
```

## 函数清单（最终命名与签名）

### 页面（`page.ts`）

```ts
/** 打开网页：默认 meta.url，失败重试（默认 3 次），等加载完成 */
openPage(ctx, url?: string, options?: { retries?: number; timeoutMs?: number; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }): Promise<void>

/** 点击：选择器字符串，或坐标 { x, y }（坐标用于无选择器目标，如验证码方框） */
click(ctx, target: string | { x: number; y: number }): Promise<void>

/** 填入输入框（设置为给定值） */
fill(ctx, selector: string, text: string): Promise<void>

/** 按键（'Enter' / 'Control+A' 等） */
pressKey(ctx, key: string): Promise<void>

/** 主世界执行 JS 并返回结果（读站点注入的全局变量必须用主世界） */
runJs<T>(ctx, fn: () => T): Promise<T>
```

### 查找（即时，不等待）

```ts
/** 元素状态：可见 / 隐藏（在 DOM 但不可见）/ 不存在 */
elementState(ctx, selector: string): Promise<'visible' | 'hidden' | 'absent'>

/** 命中元素数量 */
countElements(ctx, selector: string): Promise<number>

/** 取元素文本（首元素，去首尾空格；取不到返回空串） */
getText(ctx, selector: string): Promise<string>

/** 整页是否包含某文案（包含匹配，即时） */
hasText(ctx, text: string): Promise<boolean>
```

### 等待（`wait.ts`）

```ts
type Probe = { text: string } | { selector: string } | { gone: string }

/** 等条件命中（文案出现 / 元素可见 / 元素消失）；可选刷新恢复；返回是否命中 */
waitFor(ctx, probe: Probe, options?: {
  budgetMs?: number        // 总预算，默认 10000
  assert?: boolean         // true=超时抛错；false=返回 false（默认 false）
  refreshEveryMs?: number  // >0 周期刷新（刷新恢复，原 recover 语义）
  recoverTexts?: string[]  // 出现这些文案立即刷新（默认 RECOVER_TEXTS）
  settleMs?: number        // 刷新后沉降，默认 5000
  heartbeatMs?: number     // 心跳日志间隔，默认 15000
}): Promise<boolean>

/** 多探针竞速：任一先可见返回其键，都等不到返回 null */
race<K extends string>(ctx, entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null>

/** 等接口响应，按状态/值判定命中后返回 { status, body }（body 为 JSON 解析结果或原始文本） */
waitResponse(ctx, match: {
  urlPart?: string                                        // 只等 URL 含此片段
  method?: string                                         // 只等此 HTTP 方法
  predicate?: (status: number, body: unknown) => boolean  // 命中条件：值/状态
  parse?: 'json'                                          // 解析 body 为 JSON（默认返回文本）
}, options?: { timeoutMs?: number }): Promise<{ status: number; body: unknown }>
```

### 钱包（`wallet.ts`）

```ts
type WalletType = 'metamask' | 'petra'
type WalletScenario = 'direct' | 'appkit' | 'dialog'
type WalletIntent = 'connect' | 'sign' | 'confirmTx'

interface LoginSpecBase {
  wallet: WalletType
  loggedIn: Probe               // 已登录标志
  loggedOut: Probe              // 未登录标志
  connect?: string              // 站点"连接钱包"入口选择器
  intents?: WalletIntent[]      // 钱包要做的动作序列，默认 ['connect']
  waitLoggedInMs?: number       // 登录完成等待，默认 90000
  recoverTexts?: string[]       // 可恢复错误文案，默认 RECOVER_TEXTS
  refreshEveryMs?: number       // 周期刷新，默认 25000
  attempts?: number             // 登录整体重试轮数，默认 2
  reclickAfterMs?: number       // 补点间隔，默认 8000
}
type LoginSpec =
  | (LoginSpecBase & { scenario: 'direct' })
  | (LoginSpecBase & { scenario: 'appkit'; entryTestId: string; open?: string; modalTestId?: string })
  | (LoginSpecBase & { scenario: 'dialog'; confirm?: string; walletEntry?: string })

/** 钱包登录全流程（按 wallet 取适配器、按 scenario 露出钱包入口，自适应完成） */
loginWallet(ctx, spec: LoginSpec): Promise<void>
```

`scenario` 判别必填项（TS 提示）：`appkit` 需 `entryTestId`；`dialog` 用 `confirm`/`walletEntry`。

### 验证码（`captcha.ts`）

```ts
/** Turnstile 交互式方框：无 waitMs=单次检测点击；有 waitMs=在预算内轮询等待并点击 */
clickTurnstile(ctx, options?: { waitMs?: number; selectors?: string[]; maxAttempts?: number }): Promise<boolean>
```

### 数据与产物（`data.ts`）

```ts
/** 取数据源当前窗口行的列值（严格：缺行/缺列/空值抛错） */
getAccount(ctx, column: string): Promise<string>

/** 上传文件（值支持 http(s) URL 自动下载，或本地路径） */
uploadFile(ctx, selector: string, value: string): Promise<void>

/** 截图存产物目录（容错：失败只告警返回空串） */
takeScreenshot(ctx, name: string): Promise<string>
```

### 诊断（`diag.ts`）

```ts
/** 记录一个步骤（名称/耗时/成败），累积为运行时间线 */
recordStep<T>(ctx, name: string, fn: () => Promise<T>): Promise<T>

/** 取已记录步骤 */
getSteps(ctx): StepRecord[]
```

## 任务形态

```ts
import { openPage, loginWallet, click, waitFor, takeScreenshot } from '../api'

export class MyTask extends SiteTask {
  meta: TaskMeta = { key: 'my', name: '我的任务', url: 'https://x', wallet: 'metamask' }

  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url)
    await loginWallet(ctx, {
      wallet: 'metamask', scenario: 'appkit',
      loggedIn: { text: 'Balance' }, loggedOut: 'Connect Wallet',
      connect: '[data-testid="connect-wallet-button"]', entryTestId: 'wallet-selector-io.metamask',
    })
    await click(ctx, '#checkin-btn')
    await waitFor(ctx, { text: 'Check-In Succeeded!' }, { budgetMs: 30000, assert: true })
    await takeScreenshot(ctx, 'my-success')
  }
}
```

## 文档规范（函数手册）

`docs/API-GUIDE.md` 重写为纯函数手册，只含：
1. 五分钟上手（最小任务）
2. 任务骨架（`meta` + `run(ctx)`；可选 `action`/`login` 声明可保留或简化）
3. **函数参考**（按上面分组；每函数：用途 / 签名 / 参数表（名称/类型/必填/默认/含义）/ 示例 / 注意）
4. 钱包登录场景表（`wallet` × `scenario` 组合 + 三个完整示例 direct/appkit/dialog）
5. 常用配方（签到/领水/登录/多签上传/Turnstile）
6. 排错与真机经验（保留现第 12 章内容）

**删除**：REST 接口总表、面板使用、定时任务/文件分配、配置、工具中心、架构/分层等章节（非"函数使用"内容）。

**漂移守卫测试**：`src/api/index.ts` 导出的每个函数名都必须在手册中出现，否则 `npm test` 失败。

## 迁移计划（分阶段）

- **P1 建库**：新增 `src/api/*` + `index.ts`（内部复用 `automation/*`）；`TaskContext` 收敛为数据袋子（去方法/命名空间，保留字段）。
- **P2 任务重写**：8 任务 + 3 示例改为 `import { ... } from '../api'` + 函数调用（等价变换，行为不变）。
- **P3 文档**：`API-GUIDE.md` 重写为函数手册；漂移守卫测试。
- **P4 回归与真机**：`typecheck` + `npm test` + `test:web`；可用任务真机抽验。

## 非目标

- 不改 REST 接口、面板、调度、DB、调用方行为。
- 不改 `automation/*` 的实现（仅被 `api` 复用；`goto` 重试等从 `tasks/base.ts` 下沉到 `api`）。
- 不引入配置驱动的站点插件系统。

## 风险

- 又一次任务层改写（机械、等价变换），需真机复验可用任务；`portal-rhuna` 已关闭、`xyz-shelbynet` 站点问题，真机覆盖受影响。
- `ctx` 暴露钱包内部依赖（passwords/wallets/session）属内部契约，仅在 `api` 内使用，任务不直接读。

## 与既有 spec 的关系

本设计**取代**同日《任务能力库重封装（命名空间 DSL）》一案：把对外的 `ctx.wallet/captcha/race/recover/step` 命名空间，改为**函数库 + 统一出口 `src/api/index.ts`**，`ctx` 降级为运行时数据袋子。

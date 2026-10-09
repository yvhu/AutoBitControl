# AutoBitControl API 使用手册

> 目标读者：第一次接触自动化的你。本手册按「是什么 → 什么时候用 → 怎么用 → 注意什么」的顺序讲解，不预设编程背景。
>
> **所有方法签名、字段名与默认值，均以仓库当前源码为唯一真值**：`src/engine/task-context.ts`、`src/engine/task.ts`、`src/tasks/base.ts`、`src/automation/wallet/login-flow.ts`、`src/automation/wallet/types.ts`、`src/automation/captcha/turnstile.ts`、`src/infrastructure/config.ts`、`src/server/routes/*`。源码改了、文档没跟上，以源码为准并回来同步本手册。

配套资源：

- 面板「文档」页在线渲染本手册（左侧章节树 + 示例源码视图）。
- 「任务示例」源码视图展示三个带注释的示例任务：`src/tasks/example-checkin.ts`（签到）、`faucet-example.ts`（领水）、`mint-example.ts`（铸币）。
- 新增任务从复制 `example-checkin.ts` 改起最快。

---

## 先读我

**这个系统里，谁负责什么：**

| 部件 | 大白话 |
| --- | --- |
| **任务文件**（`src/tasks/*.ts`） | 一份「操作说明书」：打开哪个网址、点哪个按钮、怎么算成功 |
| **框架**（引擎 + 浏览器） | 替你操作浏览器的「手」：读说明书去点网页、失败自动重试 |
| **面板**（Web 界面） | 看结果的地方：哪个任务成功/失败、现场截图长什么样 |

**心智模型：**

```
写任务（写说明书） → 试跑（本地单窗口验证） → 上线（面板开开关 + 手动/定时触发）
```

1. **写任务**：新建文件继承 `SiteTask`，写 `meta`（这任务叫什么、要不要钱包）+ 可选 `login`（登录声明）+ 可选 `action`（具体操作）。
2. **试跑**：本地测试（秒级反馈）→ `npm run task:run` 单窗口真跑 → 看截图确认没点错。
3. **上线**：面板任务页打开开关（或改代码 `enabled: true`），之后手动触发或由定时计划触发。

**三句话记住怎么用：**

1. 所有能力都挂在 `ctx` 上：`ctx.page` 直调 patchright 做 DOM 操作，`ctx.wallet` 管钱包登录，`ctx.captcha` 管人机验证，`ctx.account`/`accountRow` 取数据源。
2. 任何一步抛错（`throw`）都等于「这次任务失败」，框架按 `retry` 配置自动重试，并在面板留档。
3. 成功与否由**断言**说了算（「该出现的东西出现了没有」），而不是「点到了按钮」就算数。

**名词表：**

| 名词 | 一句话大白话 |
| --- | --- |
| 任务 / Task | 一个站点的自动化流程（如「每天去 X 站签到」），对应 `src/tasks/` 一个文件 |
| 选择器 / Selector | 定位网页元素的规则，如 `#checkin-btn` 表示 id 为 `checkin-btn` 的按钮 |
| 断言 / Assertion | 检查「该出现的东西出现了没有」，没出现就报错 |
| 弹窗 / Popup | 网页上浮出的小窗口，或浏览器钱包插件弹出的确认窗口 |
| 遮罩 / Mask | 弹窗背后盖住整页的半透明灰层 |
| DOM | 浏览器把网页解析成的一棵树，每个元素都能按规则定位 |
| 隔离世界 / 主世界 | 自动化工具默认在隔离世界看网页；站点自己注入的全局变量只能进主世界读 |
| CDP | 浏览器调试协议；框架通过它把真事件派发给页面 |
| 窗口 / Profile | 一个比特浏览器环境（独立代理、指纹、Cookie），面板「窗口」页管理的单位 |
| 熔断 / Circuit Breaker | 保险丝：一个窗口连续失败 N 次后当天不再跑任何任务 |
| 重试 / Retry | 任务失败后自动再跑，次数与间隔可配置 |
| 退避 / Backoff | 重试前的等待时间，给站点限流留冷却 |
| 数据源 / DataSource | 预先准备的账号/素材 Excel（`config/accounts.xlsx`），每个窗口按行领取 |
| patchright | 我们用的隐形浏览器驱动，自动屏蔽自动化痕迹 |
| log4js | 写日志的库 |

---

## 0. 五分钟上手

新增一个任务共 5 步：

**第 1 步：建文件** `src/tasks/my-checkin.ts`。

**第 2 步：写 meta**（任务基本信息，字段见第 2 章）。

**第 3 步：写 login / action**（登录声明与站点动作，见第 3、4 章）。

**第 4 步：注册** 在 `src/tasks/index.ts` 的 `ALL` 数组加入实例（`key` 必须全局唯一）。

**第 5 步：验证** 重启服务（`npm run dev`，后端 API + 前端 Vite 面板同启）→ 面板「任务」页出现新任务卡片 → 手动触发 → 看板查看结果与截图。

完整最小任务：

```ts
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

export class MyCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'my-checkin',              // 全局唯一标识：API / 数据库 / 面板都用它
    name: '我的签到',               // 面板显示名
    url: 'https://example.com/',    // 任务入口页
    wallet: 'metamask',             // 登录用钱包适配器 key（不连钱包则省略）
  }

  login: LoginSpec = {
    loggedIn: { text: '已连接' },   // 站点已登录标志（文案或 { selector }）
    loggedOut: '连接钱包',          // 站点未登录标志（字符串等价 { text }）
    connect: 'button:has-text("连接钱包")',
    entry: { kind: 'direct' },
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page // ← 直接调 patchright 做 DOM 操作
    if ((await page.getByText('已签到').count()) > 0) return // 已签到 = 成功
    await page.locator('#checkin-btn').click()
    await page.locator('#checked-badge').waitFor({ state: 'visible', timeout: 10000 })
  }
}
```

注册（`src/tasks/index.ts`）：

```ts
import { ExampleCheckinTask } from './example-checkin'
import { MyCheckinTask } from './my-checkin'

const ALL: SiteTask[] = [new ExampleCheckinTask(), new MyCheckinTask()]
```

注意：`url` 为空串的任务（如三个示例）只能在面板手动触发或用 `task:run` 脚本跑；示例任务都显式写了 `enabled: false`，不参与日常执行。

### 写好之后怎么验证

按三层流程验证（从快到真）：

1. **本地测试**：注入假驱动，秒级反馈；先验证流程逻辑，不依赖真实站点与窗口。
2. **单窗口单任务真跑**：`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run`（不受任务开关与错峰限制，打印结果后退出）。
3. **面板验证**：看板行级「执行」（单窗口单任务）或任务页「立即触发」（全部启用窗口），人工核对截图与日志。
4. **开窗冒烟**：`BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window`，验证「开窗 → CDP 接管 → 打开页面 → 关窗」整条链路。
5. **钱包冒烟**：`BITBROWSER_PROFILE_ID=<窗口ID> WALLET_KEY=metamask|petra npm run smoke:wallet`，验证钱包弹窗识别是否命中真实插件。

---

## 1. 架构与分层

系统是一个 Node 单进程服务（后端 API + 自研引擎）加一个 Vite/React 面板。依赖方向不可反向：

```
tasks → engine → {integrations, automation} → infrastructure
server → {engine, infrastructure}      （唯一例外：server 可对 tasks 做 type-only import）
src/app.ts 组装一切（compose root，只被 index.ts 调用）
```

| 层 | 目录 | 职责 |
| --- | --- | --- |
| infrastructure | `src/infrastructure/` | config / logger(log4js) / db(本地 SQLite) / datasource(Excel 账号表) / http 封装 |
| integrations | `src/integrations/` | bitbrowser.ts（本地 API，默认 `http://127.0.0.1:54345`） |
| automation | `src/automation/` | 钱包适配器（metamask/petra）、Turnstile 方框、DOM 探针（竞速/恢复）、步骤记录 |
| engine | `src/engine/` | 队列（双闸门并发 + 同窗口任务合并）、定时调度、窗口执行器、任务上下文、状态机、重试恢复 |
| tasks | `src/tasks/` | 站点任务，只经 `TaskContext` 使用引擎能力 |
| server | `src/server/` | express 路由（按资源分文件），统一 `{code,message,data}` 响应 |
| web | `web/` | React 18 + Vite 5 + antd 5 + react-query + react-router 面板 |

- `src/app.ts`：组装全部依赖（数据库、队列、调度器、窗口执行器、任务表、路由），是唯一 compose root。
- `src/index.ts`：启动入口，先取单实例锁（`data/app.lock`）再调用 `startApp`。

---

## 2. TaskMeta 字段全解

`TaskMeta` 定义于 `src/engine/task.ts`。除 `key`/`name`/`url` 必填外，其余可选，缺省时按默认行为。

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `key` | `string` | 无（必填） | 全局唯一标识；API 路由 `/api/tasks/:key/trigger` 与数据库 runs 表都用它 |
| `name` | `string` | 无（必填） | 面板任务页显示名 |
| `url` | `string` | 无（必填，可为 `''`） | 站点入口页；默认 `run` 从这里 `goto`。空串 → 仅可手动触发（示例任务用） |
| `sourceUrl` | `string \| string[]` | `undefined` | 信息来源页：选择器从哪个页面确认的；站点改版时回这里重查；多步骤可给多个地址 |
| `note` | `string?` | `undefined` | 备注：站点的坑与特殊逻辑，面板任务页直接可见 |
| `category` | `'checkin' \| 'faucet' \| 'mint' \| 'other'` | `undefined` | 面板显示对应颜色徽章 |
| `group` | `{ key: string; name: string }?` | `undefined` | 空投分组：同一空投的多个任务写相同的 key+name，面板按组折叠展示 |
| `lastUpdated` | `string?` | `undefined` | 最后核对站点的日期（文档约定，如 `'2026-10-09'`） |
| `deprecated` | `boolean?` | `false` | `true` → 面板置灰显示「已失效」 |
| `enabled` | `boolean?` | `true` | 任务开关的代码默认值：`false` 时手动触发接口 409。面板开关写入本地库 `task_states` 覆盖，立即生效、重启保留 |
| `wallet` | `string?` | `undefined` | 钱包适配器 key（`'metamask'`/`'petra'`）；登录相关能力按此查找适配器 |
| `timeoutSec` | `number?` | 180 | 单次运行超时（秒）；缺省取全局 `execution.taskTimeoutMs / 1000` |
| `retry` | `{ max: number; backoffSec: number }?` | `{ max: 2, backoffSec: 600 }` | 失败重试次数与间隔秒数；缺省取全局 `execution.retryMax`/`execution.retryBackoffSec` |
| `concurrency` | `number?` | 4 | 任务级并发：同一时间最多几个窗口并行跑该任务；缺省 `DEFAULT_TASK_CONCURRENCY`（4） |
| `requiresFileAssign` | `boolean?` | `undefined` | 声明依赖「上传前自动文件随机分配」：计划配置 `fileAssign` 时先分配，失败则本任务本次跳过 |

示例（`src/tasks/example-checkin.ts`）：

```ts
meta: TaskMeta = {
  key: 'example-checkin',
  name: '示例签到',
  group: { key: 'example', name: '示例' },
  url: '',
  sourceUrl: '',
  note: '示例任务：url 为空且开关默认关闭；调试时在面板打开开关，或用 task:run 脚本直接跑（不受开关限制）',
  category: 'checkin',
  lastUpdated: '2026-10-09',
  enabled: false,
  wallet: 'metamask',
  timeoutSec: 180,
  retry: { max: 2, backoffSec: 600 },
  concurrency: 4,
}
```

---

## 3. 任务范式（SiteTask）

`SiteTask`（`src/tasks/base.ts`）是所有站点任务的抽象基类。一个任务 = `meta` + 可选 `login: LoginSpec` + 可选 `action(ctx)`。

```ts
export abstract class SiteTask {
  abstract meta: TaskMeta
  login?: LoginSpec
  action?(ctx: TaskContext): Promise<void>
  async run(ctx: TaskContext): Promise<void> { /* 默认骨架 */ }
}
```

**默认 `run` 骨架**（三件事，按序）：

1. `closeOtherTabs(ctx.page)`：关掉当前上下文里除当前页外的所有标签页（窗口复用会残留标签页）。
2. `gotoWithRetry(ctx.page, meta.url, ctx.log)`：打开 `meta.url`，最多 3 次，失败按 2-5 秒随机退避；`url` 为空则跳过。
3. 若声明了 `login` → `ctx.wallet.ensureLoggedIn(login)`。
4. 若实现了 `action` → `await this.action(ctx)`。

**最简单任务只写 `action`**（无登录、单页）。**多页任务覆盖 `run`**（如 `shelby-faucet` 连续领两页），此时可复用导出的 `closeOtherTabs` / `gotoWithRetry`：

```ts
import { SiteTask, closeOtherTabs, gotoWithRetry, type TaskContext, type TaskMeta } from './base'

export class TwoPageTask extends SiteTask {
  meta: TaskMeta = { key: 'two-page', name: '两页任务', url: 'https://a.example.com/' }

  async run(ctx: TaskContext): Promise<void> {
    await closeOtherTabs(ctx.page)
    await gotoWithRetry(ctx.page, this.meta.url, ctx.log)
    // …第一页动作
    await gotoWithRetry(ctx.page, 'https://a.example.com/second', ctx.log)
    // …第二页动作
  }
}
```

**工具函数：**

- `gotoWithRetry(page, url, log)`：打开页面，最多 3 次，失败按 2-5 秒随机退避重试，第 3 次仍失败才抛出。
- `closeOtherTabs(page)`：关闭当前页之外的标签页，关闭失败静默跳过。

**重新导出**：`base.ts` 再导出 `TaskContext`、`type TaskMeta`、`type LoginSpec`、`RECOVER_TEXTS`、`DEFAULT_RELOAD_TIMEOUT_MS`，任务文件只需 `import { ... } from './base'`。

**注意什么：**

- 页面已到达 ≠ 任务成功，成功要靠 `action` 里的断言。
- 每个任务一个文件，类名唯一，`meta.key` 全局唯一。
- 新增依赖注入（如新的上下文能力）要改 engine，不在任务里自己实现。

---

## 4. TaskContext 能力地图

`TaskContext`（`src/engine/task-context.ts`）是 `run(ctx)` 唯一的操作入口。**旧扁平方法已删除，仅保留 3 个 Turnstile 包装方法（`clickTurnstileBox`/`turnstileVisible`/`autoClickTurnstile`，见 §4.3），新代码请统一用 `ctx.captcha.*`**，即「访问器 + 命名空间」：

| 成员 | 形态 | 用途 |
| --- | --- | --- |
| `ctx.page` | 访问器（patchright `Page`） | DOM 操作直调 patchright |
| `ctx.wallet` | 命名空间 | 钱包就绪/连接/签名/交易确认/完整登录编排 |
| `ctx.captcha` | 命名空间 | 仅交互式 Turnstile 方框 |
| `ctx.recover(probe, opts)` | 方法 | 刷新恢复等待 |
| `ctx.race(entries, ms)` | 方法 | 多探针竞速 |
| `ctx.account(key)` / `ctx.accountRow` / `ctx.uploadFile(sel, value)` | 方法 + 访问器 | 数据源取值与文件上传 |
| `ctx.js(fn)` | 方法 | 主世界求值 |
| `ctx.step` / `ctx.steps` / `ctx.screenshot` / `ctx.safeScreenshot` | 方法 | 诊断与截图 |
| `ctx.log` / `ctx.profile` | 访问器 | 日志与当前窗口 |

### 4.1 ctx.page

**是什么**：当前窗口的 patchright `Page` 对象。DOM 操作**直接调 patchright**，框架不再包一层扁平方法。

**什么时候用**：任何网页元素操作——定位、点击、填表、等待、读属性、等接口、监听新页签。

**怎么用**（常用 API 速览）：

```ts
const page = ctx.page

// 定位与交互
await page.locator('#checkin-btn').click()
await page.getByText('已签到').count()
await page.getByRole('button', { name: 'Claim' }).click()
await page.getByTestId('submit').click()
await page.locator('input[name="email"]').fill('a@b.com')
await page.locator('textarea').pressSequentially('慢速逐键输入', { delay: 80 })
await page.keyboard.press('Enter')
await page.mouse.click(320, 240)

// 等待
await page.locator('.success-toast').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForURL(/dashboard/)
const resp = await page.waitForResponse((r) => r.url().includes('/api/claim'))

// 跳转与状态
await page.goto('https://example.com/step2', { timeout: 45000, waitUntil: 'domcontentloaded' })
await page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' })
await page.waitForLoadState('domcontentloaded')

// 求值（默认隔离世界；读站点全局变量用 ctx.js 主世界）
await page.evaluate(() => document.title)
await page.screenshot({ path: 'data/tmp.png' })

// 新页签：先注册监听、再触发点击，顺序反了会错过
const [newPage] = await Promise.all([
  page.context().waitForEvent('page'),
  page.locator('#open-btn').click(),
])
await newPage.waitForLoadState('domcontentloaded')
```

**注意什么：**

- `ctx.page` 上的操作作用在**主页面**；新页签上的操作要自己用 `newPage.locator(...)` 完成。
- 读站点全局变量（`window.__APP_STATE__`）必须用 `ctx.js`（主世界），`page.evaluate` 默认在隔离世界读不到。
- 等待优先用 `waitFor` / `waitForResponse` / `waitForURL`，**别写固定 `sleep`**。
- 窗口是复用的，`run` 默认已清理残留标签页。

### 4.2 ctx.wallet（钱包四动作 + ensureLoggedIn + LoginSpec）

钱包能力命名空间，方法定义于 `src/automation/wallet/actions.ts`，适配器契约见 `src/automation/wallet/types.ts`。

**四个动作 + 完整编排：**

| 方法 | 签名 | 是什么 |
| --- | --- | --- |
| `ready()` | `(): Promise<void>` | 会话级扩展就绪检查；扩展未加载抛错（重试会重启窗口，扩展随之重载） |
| `login(opts?)` | `(opts?: { reclick?: { selector: string; afterMs: number } }): Promise<{ popupFailed: boolean }>` | 等一次钱包弹窗 → 解锁（若配密码）→ 连接确认 |
| `sign(opts?)` | 同上 | 等一次钱包弹窗 → 解锁 → 消息签名确认 |
| `confirmTx(opts?)` | 同上 | 等一次钱包弹窗 → 解锁 → 交易确认 |
| `ensureLoggedIn(spec)` | `(spec: LoginSpec): Promise<{ skipped: boolean }>` | 完整登录编排（见下） |

- **何时用 `login`/`sign`/`confirmTx`**：自己控制流程时，逐个动作调用（如上传任务先点 Upload，再 `ctx.wallet.sign()` 处理两次签名）。
- **何时用 `ensureLoggedIn`**：声明式登录，交给框架判登录态、点入口、等完成；推荐在 `login` 字段声明、由默认 `run` 自动执行。
- **`opts.reclick`**：弹窗在 `afterMs` 内没出现时，自动再点一次 `selector`（AppKit 动画未稳时首次点击可能不注册）。
- **返回 `popupFailed: true`**：弹窗没出现——可能是**静默连接**（扩展已授权站点）。**不要直接当失败**，结合登录态判定（`ensureLoggedIn` 内部已容忍）。

**LoginSpec（`src/automation/wallet/login-flow.ts`）字段：**

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `loggedIn` | `Probe \| string` | 无（必填） | 已登录标志；字符串等价 `{ text }` |
| `loggedOut` | `Probe \| string` | 无（必填） | 未登录标志 |
| `connect` | `string?` | `undefined` | 站点连接入口选择器（先点它唤起登录/弹窗） |
| `entry` | 见下 | `undefined` | 钱包入口类型：直接 / 站内弹窗 / AppKit |
| `walletEntry` | `string?` | `undefined` | 站内弹窗内「钱包选择入口」（如 MetaMask），在 connect/dialog/appkit 之后、等扩展弹窗之前点击，并作为补点选择器 |
| `intents` | `WalletIntent[]?` | `['connect']` | 要执行的动作序列（`connect`/`sign`/`confirmTx`） |
| `waitLoggedInMs` | `number?` | `90000` | 等已登录标志的总预算（配合刷新恢复） |
| `recoverTexts` | `string[]?` | `RECOVER_TEXTS` | 可恢复错误文案，出现即刷新 |
| `refreshEveryMs` | `number?` | `25000` | 周期主动刷新间隔 |
| `attempts` | `number?` | `2` | 登录轮数（每轮失败会 reload 重来） |
| `reclickAfterMs` | `number?` | `8000` | 弹窗未出现时补点入口的间隔 |

`Probe` 定义于 `src/automation/dom/probe.ts`：`{ text: string }`（包含匹配）或 `{ selector: string }`。

**`entry` 三种形态：**

```ts
// 1) direct：点 connect 直接唤起扩展弹窗（如 Petra 点 Connect Wallet 直开 prompt.html）
entry: { kind: 'direct' }

// 2) dialog：点 connect 后站内弹出钱包选择弹窗，需先点确认（可含 walletEntry 选钱包）
entry: { kind: 'dialog', confirm: 'text=Connect with Ethereum' }

// 3) appkit：站点用 AppKit(Reown) 弹窗，框架做视图归一化后点钱包入口
entry: { kind: 'appkit', open: 'button:has-text("WALLET")', entryTestId: 'wallet-selector-io.metamask', modalTestId: 'w3m-modal-card' }
```

**怎么用（完整登录的例子，`konnex-checkin.ts`）：**

```ts
login: LoginSpec = {
  loggedIn: { text: 'Balance' },
  loggedOut: 'Connect Wallet',
  connect: '[data-testid="connect-wallet-button"]',
  entry: { kind: 'dialog', confirm: 'text=Connect with Ethereum' },
  walletEntry: 'text=MetaMask',
  intents: ['connect'],
}
```

`ensureLoggedIn` 内部流程：竞速判登录态（已登录直接返回 `{ skipped: true }`）→ `wallet.ready()` → 点 `connect` → 处理 `entry`（dialog 点确认 / appkit 归一化）→ 点 `walletEntry` → 按 `intents` 逐个 `runIntent` → 用 `recover(loggedIn, { budgetMs: waitLoggedInMs, refreshEveryMs, recoverTexts })` 等登录完成；超时后竞速再判，命中即成功；`attempts` 轮仍失败则抛 `登录未完成（等待已登录标志超时）`。

**钱包适配器四动作**（`WalletAdapter`，`src/automation/wallet/types.ts`）：`unlock?(popup, password)`、`connect(popup)`、`sign(popup)`、`confirmTx(popup)`。内置：

| key | 扩展 ID | provider 标识 | 弹窗 URL 正则 |
| --- | --- | --- | --- |
| `metamask` | `nkbihfbeogaeaoehlefnkodbefgpgknn` | `isMetaMask` | `home.html` / `notification.html` / `metamask://` |
| `petra` | `ejjladinnckdgjemekebdpeokbikhfci` | 不注入 provider（`expectsProvider=false`，仅 CDP 探测） | `prompt.html` / `index.html` / `popup.html` |

**解锁密码**：钱包类型级（同类型所有窗口共用），通过 `config/.env` 的 `WALLET_PASSWORDS` 或 `config/config.json` 的 `wallet.passwords` 配置（详见第 8 章）。仅当该钱包类型配置了密码时才执行解锁。

**新增钱包适配器：**

1. 实现 `WalletAdapter`（参考 `src/automation/wallet/metamask.ts` / `petra.ts`）；弹窗 UI 渲染有延迟，适配器内部全部用**轮询等待状态**，不做单次 count 判定。
2. 在 `src/app.ts` 的 `WalletRegistry` 注册。
3. 任务 `meta.wallet = 'phantom'`（举例）即可。

**注意什么：**

- 调用 `login`/`sign`/`confirmTx` 前任务必须配置 `meta.wallet`，否则抛 `任务未配置钱包`；未注册的 key 抛 `未注册的钱包适配器: X`。
- 等弹窗最长 60 秒；高并发慢代理下弹窗可能超过 30 秒才出现，属正常。
- MetaMask 用官方 data-testid 定位（中文界面的按钮文案匹配不到，改版也稳）；Petra 用 `has-text` 定位（其按钮无障碍名异常，`getByRole` 匹配不到 Sign In）。
- 静默连接：扩展已授权过站点时可能不弹钱包弹窗——以登录态为准，不要当失败。

### 4.3 ctx.captcha（仅 Turnstile 方框）

**是什么**：交互式 Cloudflare Turnstile 人机验证方框的处理命名空间，实现于 `src/automation/captcha/turnstile.ts`。**只处理方框**：检测到方框即坐标点击，ISP 住宅 IP 一点即过（无需图片题）。站点的 v3 隐形评分由页面自行完成，任务不介入。

| 方法 | 签名 | 是什么 |
| --- | --- | --- |
| `turnstile(opts?)` | `(opts?: { selectors?: string[]; maxAttempts?: number }): Promise<boolean>` | 检测到方框即点击；返回是否执行了点击（方框未出现返回 `false`） |
| `visible(selectors?)` | `(selectors?: string[]): Promise<boolean>` | 方框当前是否可见（轻量 `count` 检查，低频追踪用） |
| `autoClick(budgetMs?)` | `(budgetMs?: number): Promise<boolean>` | 等方框出现并点击，默认预算 10000ms |

**什么时候用**：站点点提交/领取后弹出 Turnstile 方框（右下角浮层）时。

**怎么用：**

```ts
// 点 Claim 后：方框 1-3s 内渲染即自动点击（预算 10s）
await page.locator('[role="dialog"] button:has-text("Claim")').click()
await ctx.captcha.autoClick()

// 领取循环里补点 + 追踪方框是否仍在
if (await ctx.captcha.turnstile()) { /* 已点击 */ }
if (await ctx.captcha.visible()) { /* 方框仍在：验证可能未通过 */ }
```

**注意什么：**

- 默认选择器：`div[data-turnstile-container] iframe:visible` + `iframe[src*="challenges.cloudflare.com"]:visible`；站点结构特殊时用 `opts.selectors` 覆盖。
- 点击被浏览器拒绝（iframe 重渲染期间的 CDP 瞬时错误）会**自动重新取盒重试**（最多 `maxAttempts`，默认 3 次，间隔 1-2 秒随机；非瞬时错误直接抛）。
- TaskContext 上还保留同名的扁平方法 `clickTurnstileBox` / `turnstileVisible` / `autoClickTurnstile`（命名空间就是它们的封装），新代码统一用 `ctx.captcha.*`。
- 方框能否点过取决于出口 IP（ISP 住宅 IP 通常一点即过）；点不过属 IP 问题，不是任务逻辑问题。

### 4.4 ctx.recover 与 ctx.race

**`ctx.recover(probe, opts)`**（刷新恢复等待，`src/automation/dom/recover.ts`）：

- **是什么**：等 `probe` 出现；期间页面出现可恢复错误文案**立即刷新**；配置 `refreshEveryMs` 时周期主动刷新；每 `heartbeatMs` 输出心跳日志。预算内出现返回 `true`，超时返回 `false`（**不抛错**）。
- **什么时候用**：站点 token 存 `localStorage`、页面 JS 状态坏了刷新即恢复的场景（Web3 站点普遍模式）——登录完成等待、页面跳转等待、慢渲染等待。
- **怎么用**：

```ts
// 等登录完成标志：Network Error 出现立即刷；每 25s 周期主动刷
if (await ctx.recover({ text: 'Hello,' }, {
  budgetMs: 60000,
  refreshEveryMs: 25000,
  recoverTexts: RECOVER_TEXTS, // 默认值
})) return

// 纯被动等 + 错误恢复（不周期刷新）
await ctx.recover({ selector: '#upload-files' }, { budgetMs: 120000, refreshEveryMs: 30000, recoverTexts: RECOVER_TEXTS })
```

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `budgetMs` | 无（必填） | 总预算（毫秒） |
| `refreshEveryMs` | `0`（关闭） | 周期主动刷新间隔 |
| `recoverTexts` | `RECOVER_TEXTS` | 可恢复错误文案，任一出现立即刷新 |
| `settleMs` | `5000` | 刷新后的沉降等待 |
| `heartbeatMs` | `15000` | 心跳日志间隔 |

`RECOVER_TEXTS`（`src/infrastructure/constants.ts`）默认 `['Network Error', 'Turnstile token request timed out']`。

**`ctx.race(entries, timeoutMs)`**（多探针竞速，`src/automation/dom/race.ts`）：

- **是什么**：任一探针先可见即返回它的键，都等不到返回 `null`。
- **什么时候用**：一个动作后可能出现多种互斥结果（成功弹窗 / 已签到横幅 / 上限提示 / 余额不足）——分别命名竞速，比连续判断更可靠、更省时。
- **怎么用**：

```ts
const outcome = await ctx.race([
  ['success', { text: 'Check-In Succeeded!' }],
  ['done', { text: 'Great job!' }],
  ['limit', { text: 'Daily limit reached' }],
], 30000)
if (outcome === 'success' || outcome === 'done') return // 已签到
if (outcome === 'limit') return                        // 达上限 = 成功幂等
throw new Error('签到未完成')
```

**注意什么**：`race` 都等不到返回 `null`（不抛错），由任务决定后续；键是自定义泛型字符串；空数组直接返回 `null`。

### 4.5 数据源与文件上传（account / accountRow / uploadFile）

数据源是预先准备的 Excel（`config/accounts.xlsx`），第一行表头、每行一个窗口的数据。任务运行时每个窗口领走自己那一行。

**`account(key)`（严格取数）：**

- **是什么**：取当前窗口对应行的某一列值。严格模式：行不存在 / 列缺失 / 值为空都抛错，错误带窗口名与列名。
- **什么时候用**：数据必须备齐时——邮箱、邀请码、钱包地址、图片地址等。
- **怎么用**：

```ts
const address = await ctx.account('metamask钱包地址')
await page.locator('input[name="address"]').fill(address)
```

- **注意什么**：报错形态有三——`数据源无当前窗口对应的行（窗口: X）` / `数据源缺少列: X（可用列: …）` / `数据源列 X 在窗口 Y 的行为空`。报错即任务失败，通常正是你想要的（数据没备齐就不该硬跑）。

**`accountRow`（宽松取数）：**

- **是什么**：只读访问器，返回当前窗口整行（列名 → 字符串值）；无映射为 `null`。
- **什么时候用**：数据可有可无、缺了用 faker 兜底时。
- **怎么用**：

```ts
const email = ctx.accountRow?.['邮箱'] || faker.internet.email()
```

- **注意什么**：值是整行拷贝，改它不影响数据源；空串会被 `||` 判为假而走兜底。

**`uploadFile(selector, value)`：**

- **是什么**：往 file 输入框设置文件。`value` 支持 **http(s) URL**（自动下载到临时文件）或**本地路径**。
- **什么时候用**：站点要求上传图片/附件且文件来自数据源时。
- **怎么用**：

```ts
await ctx.uploadFile('input[type="file"]', await ctx.account('图片地址')) // URL
await ctx.uploadFile('input[type="file"]', 'D:/avatars/my-avatar.png')   // 本地路径
```

- **注意什么**：URL 下载失败抛 `图片下载失败: <url> (HTTP <状态码>)`；临时文件落在系统临时目录 `abc-uploads/`；内部用 `setInputFiles`，不用弹系统文件框，对 `display:none` 的隐藏 input 也可用。

**「窗口」列与行映射规则**（示例表 `config/accounts.example.xlsx`）：

- **推荐填窗口 ID**：32 位十六进制，永久稳定唯一；面板「窗口」页行内「复制ID」一键复制。
- **窗口名也可用**：须与面板窗口名完全一致；改名后要同步更新数据源。
- 有「窗口」列 → 按 ID/名字精确匹配；无「窗口」列 → 按面板窗口列表顺序取第 i 行。
- 数据源改完不用重启：面板「设置」页点「重载」即时生效（`POST /api/datasource/reload`）。

### 4.6 ctx.js（主世界求值）

**是什么**：在页面**主世界**执行一段 JS 并返回结果（自动处理 patchright 的隔离世界参数）。

**什么时候用**：读站点注入的全局变量（`window.__APP_STATE__` 等）、读 `localStorage` 判断登录态/任务状态——这些在隔离世界看不到。

**怎么用：**

```ts
const state = await ctx.js<{ user?: { id: string } }>(() => (window as any).__APP_STATE__)
if (!state?.user) throw new Error('未登录')

const done = await ctx.js<boolean>(() => localStorage.getItem('claimed_today') === '1')
if (done) return // 今日已做 → 成功
```

**注意什么**：函数体必须**自包含**（会被序列化后送进页面执行，引用外部变量拿不到值）。

### 4.7 诊断与截图（step / steps / screenshot / safeScreenshot）

| 方法 | 签名 | 是什么 |
| --- | --- | --- |
| `step(name, fn)` | `<T>(name: string, fn: () => Promise<T>): Promise<T>` | 包裹一步并记录耗时/结果（失败记录后继续抛出） |
| `steps()` | `(): StepRecord[]` | 已记录的步骤时间线（拷贝） |
| `screenshot(name)` | `(name: string): Promise<string>` | 截当前视口存到产物目录，返回绝对路径 |
| `safeScreenshot(name)` | `(name: string): Promise<string>` | 容错截图：失败只告警不判任务失败，返回路径或空串 |

`StepRecord = { name, startMs, ms, ok, detail? }`（`src/automation/diag/recorder.ts`）。

**怎么用：**

```ts
await ctx.step('open-crate', async () => {
  await page.locator('button:has-text("Open Free")').first().click()
  await ctx.race([['modal', { text: 'What is inside?' }]], 6000)
})

await ctx.safeScreenshot('checkin-success') // 成功留档一律用 safeScreenshot
```

**注意什么：**

- 成功截图**一律用 `safeScreenshot`**：持续动画页面（倒计时/动态榜）会让 CDP 截图偶发挂起，直接 await 会把已成功的任务误报失败（真机教训，见第 12 章）。
- 截图目录为 `data/screenshots/<日期>/<比特窗口ID>/<任务key>/`；成功/失败截图框架会自动补拍。
- `steps()` 是运行内的时间线，排障时配合日志看。

### 4.8 日志与窗口（log / profile）

**`ctx.log`**：当前窗口的 log4js `Logger`。格式 `ctx.log.info({count}, '消息')`（对象在前、消息在后），中文消息。

```ts
ctx.log.info({ step: 'faucet', window: ctx.profile.name, claim: 3 }, '领取成功')
ctx.log.warn({ step: 'faucet', err: e.message }, '点击落空，补点')
```

**`ctx.profile`**：当前窗口记录（`ProfileRow`），含 `id`、`bitbrowserId`、`name`、`enabled`、`circuitBreakerCount` 等，日志里常用来注入窗口名。

---

## 5. 手动触发与守卫

系统有两类触发：**手动触发**（面板按钮）与**定时计划**（第 6 章）。失败重试自动补跑与二者无关。

### 触发入口

| 入口 | 接口 | 语义 |
| --- | --- | --- |
| 任务页「立即触发」 | `POST /api/tasks/:key/trigger`（不带 body） | 该任务推给**全部启用窗口** |
| 看板行级「执行/重跑」 | `POST /api/tasks/:key/trigger`，body `{ bitbrowserId }` | **单窗口单任务** |
| 失败重试（自动） | — | 失败进入 `retry_wait`，退避到期自动重新入队 |

### 触发守卫

`POST /api/tasks/:key/trigger` 前置检查（顺序）：

1. 任务未注册 → 404（码 40401）；
2. 任务已停用（本地库 `task_states` 或代码 `enabled: false`）→ 409（码 40901）`任务已停用`；
3. 带 `bitbrowserId` 时窗口不存在 → 404（码 40402）；
4. 在途检查：该任务（或该窗口该任务）已有 pending/running/retry_wait 行或已排队 → 409（码 40902）`任务执行中`。

### 入队语义

- 手动触发与失败重试都经 `CoalescingEnqueuer.enqueue(profile, taskKey)`：**同一窗口的多个任务合并为一次开窗会话**（开窗/连接只做一遍）；窗口正在执行时新触发进入 follow-up 队列，跑完再补跑，不会并发开同一窗口；并发触发竞态下同窗口同任务自动去重。
- **双闸门**：① 任务级 `meta.concurrency`（缺省 4，管站点风控）；② 全局 `execution.maxConcurrentWindows`（缺省 4，管机器资源）。取更严者：任务额度满的窗口进该任务等待队列，全局超额的会话进全局 FIFO，某会话结束即滚动续跑。
- **错峰**：批量触发与失败重试的窗口会话开窗前，各自在 `[0, execution.staggerMaxSec]`（默认 120 秒）内随机延迟；设 `0` 关闭。单窗口入口（看板行级「执行」、`task:run`）不等待。

### 面板运行时覆盖

任务页卡片开关调用 `PATCH /api/tasks/:key`，写本地库 `task_states`（`key → enabled`），**立即生效（含重新启用，无需重启）**、重启保留（换设备重置回代码默认值）。无覆盖记录时回落到 `meta.enabled ?? true`。

### 触发后的状态流转

```
pending（排队，还没轮到）
   │ 窗口轮到 → 开窗 → CDP 接管
   ▼
running（执行中）
   ├─ run() 正常返回 ───────────────────────▶ success
   ├─ 抛普通错误，还有重试名额 ───────────────▶ retry_wait ──退避到期──▶ 重新入队
   ├─ 抛普通错误，重试耗尽 ──────────────────▶ failed
   └─ 超过 timeoutSec ──────────────────────▶ 按普通失败处理（可重试）
```

`skipped` 不经过 `running` 直接终态：开窗失败 / 窗口熔断 / 窗口超时，行内记具体原因。`captcha_failed` 为历史遗留终态，无产生路径，保留状态机兼容。

- **失败自动重试**：普通错误按 `retry.max`（默认 2）重试，加首次共 3 次；间隔 `backoffSec`（默认 600 秒）。计数存数据库，重启不丢。
- **重试不占窗**：`retry_wait` 期间窗口立即释放，到点由重试定时器重新入队。
- **熔断**：终态失败让窗口熔断计数 +1，达到 `circuitBreakerThreshold`（默认 2）后该窗口当天剩余任务全部 `skipped`（窗口熔断）；任一任务成功清零。
- **窗口超时**：单窗口会话总时长 `windowTimeoutMs`（默认 15 分钟），到点后剩余任务 `skipped`（窗口超时）。
- 同日多轮（手动重复/重试）在 `runs` 表按 `slot` 列各占一行，互不覆盖。

---

## 6. 定时任务

### 心智模型

- **计划与任务解耦**：一份「时间配置 + 任务列表」就是一条计划，存本地库 `schedules` 表，面板「定时任务」栏目管理，无需改代码重启。
- **触发范围**：到点对**全部启用窗口**入队，与任务页「立即触发」同构（沿用全局错峰）。
- **错过即跳过**：机器没开机/进程没跑，错过的触发不补跑。
- **在途则跳过**：到点时任务已有在途运行（手动/重试/另一计划），跳过并记日志（`in-flight`）。
- **熔断共用**：定时触发的失败同样计入窗口熔断。

### 四种频率模式

| 模式 | 配置 | 语义 |
| --- | --- | --- |
| `interval` | `everyHours` 1–23 | 自 00:00 起每 N 小时（00:00 不触发） |
| `daily` | `times` 多个 `HH:mm` | 每日各时间点各触发一次 |
| `weekly` | `weekdays`（1=周一…7=周日）+ `times` | 每周指定星期的时间点 |
| `monthly` | `days`（1–31）+ `times` | 每月指定日期的时间点；小月无该日（如 31 号）自然跳过 |

**时区**：固定 `config/config.json` 的 `scheduler.timezone`（默认 `Asia/Shanghai`），面板「下次执行」按此时区的墙上时钟计算。

### 上传前自动文件随机分配（`fileAssign`）

计划 `config` 可带可选 `fileAssign` 段（`{ sourceDir, column, template }`，与工具页参数同构）。配置后每次触发都在开窗前先执行一次分配：重命名源文件夹内文件 → 写回 `accounts.xlsx` 的 `column` 列 → 重载数据源 → 再入队。详见第 7 章。

### 独立定时分配（纯分配计划）

工具页「文件随机分配」面板的「定时执行」区创建的是**纯分配计划**：`taskKeys` 为空、`config.fileAssign` 非空。到点只执行一次分配（成功记日志），不触发任务、不开窗口；系统内至多一条（重复创建 409，码 40906）。计划列表显示紫色「仅分配」标签。

### REST 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/schedules` | 计划列表（含 `ruleText` 摘要、`nextRun` 下次执行、`taskNames`） |
| POST | `/api/schedules` | 新建：`{ name, mode, config, taskKeys }`；`config` 可带 `fileAssign`；`taskKeys` 可为空数组=纯分配计划（须带 fileAssign，至多一条） |
| PATCH | `/api/schedules/:id` | 改名称/开关/配置/任务列表（可部分）；不存在 404（码 40406） |
| DELETE | `/api/schedules/:id` | 删除；不存在 404（码 40406） |
| POST | `/api/schedules/:id/run` | 「立即运行一次」（跳过时间判断，守卫保留）；响应含 `fileAssign` 本次分配结果；停用 409（码 40903） |

### 面板使用

定时任务页：新建计划 → 选频率模式 → 按模式填参数 → 多选任务 → 保存。列表行内可开关计划、立即运行、编辑、删除。看板批次列表中定时触发的批次带「定时」徽标。

---

## 7. 上传前文件自动随机分配

**工具页「文件随机分配」**：把本机文件夹里的文件按名称模板重命名，随机分配给 `config/accounts.xlsx` 各账号行，并把新路径写回目标列（如「图片地址」/「文件地址」）。

- **手动流程**：填源文件夹绝对路径 → 选目标列与名称模板 → 「生成预览」（校验目录/列/数量，展示分配计划表）→「执行分配」（改名 + 写回 + 自动重载数据源）。
- **规则**：文件数少于账号行数报错不执行；只改被分配到的 N 个文件，其余不动；模板由英文/数字/特殊字符组件组合，插入位置支持替换/前/后/指定位置后/指定文本后。
- **执行是破坏性操作且不回滚**（错误信息附已改名清单），执行前务必核对预览。
- **定时执行**：面板「定时执行」区开启后形成纯分配计划——「保存定时配置」时把源文件夹/目标列/名称模板**固化进计划**，按四种频率到点自动执行一次；失败仅记日志、错过即跳过。
- **与任务计划的联动**：普通计划的 `config.fileAssign` 在触发时先分配再开窗；只有声明 `meta.requiresFileAssign: true` 的任务能通过守卫，避免在途/停用时白白改名；分配失败则依赖文件的任务本次跳过（日志记 `file-assign-failed`），计划内其它任务照常触发。手动路径（任务页「立即触发」、看板行级执行、`task:run`）不经过计划，不受自动分配保护。

---

## 8. 配置（config.json / .env）

### 三层配置与环境变量

配置一共三层，**后面的覆盖前面的**（逐键深合并）：代码默认值 ← `config/config.json` ← `config/config.local.json` ← 环境变量（含 `config/.env`，由 dotenv 加载）。本地差异写 `config.local.json`（不进版本库），部署密钥用环境变量注入。**任何配置改动都要重启服务（`npm run dev`）才生效。**

`src/infrastructure/config.ts` 的 `loadConfig` 是唯一入口。全部配置段：

| 配置段 | 关键键 | 说明 |
| --- | --- | --- |
| `bitbrowser` | `apiBase`、`openTimeoutMs`、`maxRetries`、`retryBackoffMs` | 比特浏览器本地 API：默认 `http://127.0.0.1:54345`；开窗请求超时 30 秒；开窗失败最多重试 3 次；退避 5/30/120 秒 |
| `execution` | `staggerMaxSec`、`windowTimeoutMs`、`taskTimeoutMs`、`retryMax`、`retryBackoffSec`、`circuitBreakerThreshold`、`maxConcurrentWindows` | 执行引擎默认值：错峰上限 120 秒（0 关闭）；单窗口会话超时 15 分钟；单任务超时 180 秒；重试 2 次、退避 600 秒；熔断阈值 2；全局窗口上限 4 |
| `web` | `host`、`port` | **后端 API** 监听地址，默认 `127.0.0.1:3000`（仅本机，只出接口不托管页面）。前端面板由 Vite dev server 提供（`npm run dev`） |
| `wallet` | `passwords` | 钱包解锁密码映射（钱包类型 key → 密码，如 `metamask`/`petra`）；同类型钱包共用同一密码 |
| `storage` | `dbPath`、`screenshotDir`、`logDir`、`logLevel`、`prettyColorize`、`logRetainDays`、`dbRetainDays`、`screenshotRetainDays` | 本地 SQLite 库（默认 `data/app.db`）；截图/日志目录；日志级别（默认 `info`）；日志保留 7 天；数据库历史保留 90 天；截图按日期保留 90 天 |
| `dataSource` | `path` | 账号数据源 Excel 路径（默认 `config/accounts.xlsx`，相对路径按项目根解析）；不存在仅告警，任务可用 faker 兜底 |
| `scheduler` | `timezone` | 定时任务时区（IANA 名称，默认 `Asia/Shanghai`） |

> 说明：`execution` 段**已无拟人/打码相关配置**；配置里也没有 `captcha` 段。

> 当前仓库 `config/config.json` 的 `execution` 覆盖了部分默认值：`maxConcurrentWindows: 6`（代码默认 4）。以实际文件为准。

### 环境变量（`config/.env` 或部署环境）

| 变量 | 作用 |
| --- | --- |
| `BITBROWSER_API_BASE` | 覆盖比特浏览器 API 地址 |
| `WEB_PORT` | 后端 API 端口（默认 3000；非整数或越界静默忽略） |
| `VITE_PORT` | 前端面板端口（默认 5173；Vite 的 `/api` 代理自动跟随 `WEB_PORT`） |
| `WALLET_PASSWORDS` | JSON 字符串映射钱包类型 → 密码，覆盖配置文件同名 key；格式错不抛错、启动告警 |

`WALLET_PASSWORDS` 示例：

```env
WALLET_PASSWORDS={"metamask":"MetaMask 解锁密码","petra":"Petra 解锁密码"}
```

也可在 `config/config.json` / `config/config.local.json` 的 `wallet.passwords` 配置：

```json
{ "wallet": { "passwords": { "metamask": "MetaMask 解锁密码", "petra": "Petra 解锁密码" } } }
```

两者并存时环境变量覆盖同名 key。**修改后需重启服务生效。**

---

## 9. 面板使用

面板基于 antd（`web/`，Vite + React），左侧导航**八个页面**，顶栏右侧有主题切换 Segmented（浅色/深色/跟随系统，写入浏览器 localStorage 即时生效）。

- **看板（首页）**：运行批次时间线——顶部 Segmented 选时间范围（今天/近 7 天/全部）＋ 实时运行窗口数；每次触发形成一张批次卡（时间/类型徽章/任务名/进度/各状态计数，展开看窗口明细）；明细行含窗口/任务（带空投分组名）/开始/耗时/状态/错误/截图，行级「执行/重跑」= 单窗口单任务触发。停留时每 15 秒自动刷新。
- **窗口页**：搜索框 ＋「同步比特浏览器」按钮（拉取窗口列表入库，含备注/序号/最近 IP/国家/内核版本）＋ 窗口表（名字/序号、备注、IP、国家、内核、熔断计数与进度条、启用开关、操作列）。操作列有「打开/关闭」（打开即拉起窗口并登记 `open_windows`）、「复制ID」；熔断计数 > 0 时显示「重置熔断」。表头复选框多选后出现批量「打开/关闭/复制 ID/重置熔断」。
- **任务页**：按空投分组卡片分区（组头彩色图标 + 组名 + 任务数，可展开收起，未写 group 归「未分组」）。任务卡含任务名/key/分类徽章/钱包·并发·重试摘要/备注/来源页链接。卡片开关写本地库 `task_states`，立即生效；「立即触发」= 该任务在全部启用窗口跑一遍（在途时禁用显示「运行中」）。
- **空投追踪页**：空投项目备忘录 + 待办清单看板。状态列可自定义（默认五列：关注中/待参与/进行中/已完成/已放弃），卡片可拖拽流转；项目含优先级、时间节点（到期提醒）、链接、备注与待办子项。页头「从系统任务导入」可批量导入系统任务为项目卡片。
- **定时任务页**：计划列表（名称/频率摘要/下次执行/任务/自动分配标记），支持新建（四种频率）、编辑、删除、开关与「立即运行」；新建/编辑弹窗可开启「上传前自动文件随机分配」。纯分配计划标「仅分配」。
- **工具页**：工具卡片中心（数据来自 `GET /api/tools`），目前一个工具「文件随机分配」，点卡片展开面板（手动分配 ＋ 定时执行区）。
- **文档页**：左侧章节树（本手册目录 + 三个示例源码节点 + API 接口文档节点），右侧渲染正文；点章节锚点滚动定位，点示例节点切换源码视图（带行号），点 API 接口文档节点新窗口打开 `/api-docs`；正文滚动时树自动高亮当前章节。
- **设置页**：比特浏览器卡（API 地址 + 「测试连接」）；执行参数只读展示（错峰上限/熔断阈值/全局窗口上限/版本）；数据源卡（路径 + N 行 + 列名，改完 xlsx 点「重载」即时生效）；主题卡。

---

## 10. REST 接口总表

面板与外部都通过 `/api` 下的 JSON 接口交互，统一响应 `{ code, message, data }`，业务码见 `/api-docs`。下表以 `src/server/routes/*` 的 `@swagger` 注解为准。

**运行与批次**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/batches` | 运行批次列表（`?range=today/7d/all`，含每批统计、未分批行与全局数字） |
| GET | `/api/batches/:id` | 批次明细（该批全部窗口运行行） |

**任务**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/tasks` | 任务列表（meta 全字段 + 本地库开关状态 + `inFlight`） |
| PATCH | `/api/tasks/:key` | 任务开关（写本地库，立即生效） |
| POST | `/api/tasks/:key/trigger` | 手动触发（body 可带 `bitbrowserId` 只跑单窗口） |

**定时计划**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/schedules` | 计划列表（面板视图） |
| POST | `/api/schedules` | 新建计划（`config` 可带 `fileAssign`；`taskKeys` 空=纯分配计划） |
| PATCH | `/api/schedules/:id` | 更新计划（字段可部分传） |
| DELETE | `/api/schedules/:id` | 删除计划 |
| POST | `/api/schedules/:id/run` | 立即运行一次（返回 `skipped` 与 `fileAssign` 结果） |

**窗口**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/profiles` | 窗口列表（启用状态、熔断计数、打开状态、备注/IP/国家/内核） |
| PATCH | `/api/profiles/:id` | 窗口开关 |
| POST | `/api/profiles/:id/open` | 打开窗口（已开则复用；登记 `open_windows`） |
| POST | `/api/profiles/:id/close` | 关闭窗口 |
| POST | `/api/profiles/:id/breaker/reset` | 重置该窗口熔断计数 |
| POST | `/api/profiles/batch` | 批量操作（`action=open/close/resetBreaker` + `ids`，逐项汇总） |

**比特浏览器与设置**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/bitbrowser/test` | 比特浏览器本地 API 连接测试（返回 `ok`） |
| POST | `/api/bitbrowser/sync` | 拉取比特窗口列表入库（返回同步数量） |
| GET | `/api/settings` | 公开只读设置（不含密钥）+ 数据源状态 |
| POST | `/api/datasource/reload` | 重载数据源 Excel |

**截图与文档**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/screenshots?path=<目录内相对路径>` | 取截图文件（双层防目录穿越） |
| GET | `/api/docs/guide` | 本手册 markdown 原文 |
| GET | `/api/docs/examples` | 示例文件清单（白名单） |
| GET | `/api/docs/examples/:name` | 单个示例源码 |

**诊断**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/diagnostics/:runId` | 按 run id 取失败诊断包 JSON（run 不存在/无诊断/文件不可读统一 404，业务码 40408） |

**工具**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/tools` | 工具清单（工具中心卡片数据源） |
| POST | `/api/tools/file-assign/preview` | 文件随机分配预览（校验并生成计划，不落盘） |
| POST | `/api/tools/file-assign/apply` | 文件随机分配执行（改名 + 写回 xlsx + 重载数据源） |

**空投追踪**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/airdrop/statuses` | 状态列清单（含每列项目数） |
| POST | `/api/airdrop/statuses` | 新增状态列 |
| PATCH | `/api/airdrop/statuses/:id` | 状态列改名/换序 |
| DELETE | `/api/airdrop/statuses/:id` | 删除状态列（列下非空 409） |
| GET | `/api/airdrop/projects` | 项目清单（含子项） |
| POST | `/api/airdrop/projects` | 新建项目（可带 `taskKey` 绑定系统任务） |
| POST | `/api/airdrop/projects/import` | 从系统任务批量导入项目（返回 imported/failed） |
| PATCH | `/api/airdrop/projects/:id` | 更新项目（拖拽流转 statusId；`taskKey:null` 解绑） |
| DELETE | `/api/airdrop/projects/:id` | 删除项目（级联删子项） |
| POST | `/api/airdrop/projects/:id/todos` | 加待办子项 |
| PATCH | `/api/airdrop/todos/:id` | 更新子项（勾选/内容/日期/优先级） |
| DELETE | `/api/airdrop/todos/:id` | 删除子项 |
| GET | `/api/airdrop/reminders` | 到期提醒汇总（未来 5 天内 + 已过期） |

完整参数、请求体、响应与业务错误码见面板文档页 → API 接口文档（`/api-docs`，Swagger UI，可当场试调；原始 spec 见 `/api/docs/openapi.json`）。

---

## 11. 实战配方

### 配方一：签到一条龙

适用：每天固定时间开放签到、打开先弹公告、钱包登录的站点。

```ts
login: LoginSpec = {
  loggedIn: { text: 'Balance' },
  loggedOut: 'Connect Wallet',
  connect: '[data-testid="connect-wallet-button"]',
  entry: { kind: 'dialog', confirm: 'text=Connect with Ethereum' },
  walletEntry: 'text=MetaMask',
  intents: ['connect'],
}

async action(ctx: TaskContext): Promise<void> {
  const page = ctx.page
  // 等签到卡片渲染；已签到（Great job! 横幅 / RESETS IN 倒计时）任一即成功
  if ((await page.locator('#card:has-text("Great job!")').count()) > 0) return
  if ((await page.locator('#card:has-text("RESETS IN")').count()) > 0) return
  await page.locator('button:has-text("Check in")').first().click()
  // 成功弹窗与已签到横幅可能先后出现，竞速判定
  const outcome = await ctx.race([
    ['success', { text: 'Check-In Succeeded!' }],
    ['done', { text: 'Great job!' }],
  ], 30000)
  if (outcome === 'success' || outcome === 'done') {
    await ctx.safeScreenshot('checkin-success')
    return
  }
  throw new Error('点击签到后未出现成功/已签到状态')
}
```

### 配方二：领水（含 Turnstile 方框）

适用：有频率限制、要填邮箱、提交后弹 Turnstile 方框的水龙头。

```ts
async action(ctx: TaskContext): Promise<void> {
  const page = ctx.page
  if ((await page.getByText('已领取').count()) > 0) return          // 今日已领 → 成功
  if ((await page.getByText('维护中').count()) > 0) throw new Error('水龙头维护中')
  const email = await ctx.account('邮箱')                            // 或 accountRow + faker 兜底
  await page.locator('input[name="email"]').fill(email)
  await page.locator('#claim-btn').click()
  await ctx.captcha.autoClick()                                      // 方框 1-3s 渲染即点（预算 10s）
  await page.locator('.success-toast').waitFor({ state: 'visible', timeout: 30000 })
  await ctx.safeScreenshot('faucet-success')
}
```

### 配方三：钱包登录三种入口

```ts
// direct：点 Connect 直接唤起扩展弹窗（Petra 常见）
login: LoginSpec = {
  loggedIn: { text: 'Hello,' },
  loggedOut: 'Connect Wallet',
  connect: 'button:has-text("Connect Wallet"):visible',
  entry: { kind: 'direct' },
  intents: ['sign'],           // Petra 登录是签名（Sign In）
}

// dialog：站内钱包选择弹窗后再等扩展弹窗（Konnex）
login: LoginSpec = {
  loggedIn: { text: 'Balance' },
  loggedOut: 'Connect Wallet',
  connect: '[data-testid="connect-wallet-button"]',
  entry: { kind: 'dialog', confirm: 'text=Connect with Ethereum' },
  walletEntry: 'text=MetaMask',
  intents: ['connect'],
}

// appkit：AppKit(Reown) 弹窗，框架做视图归一化（DAC Inception）
login: LoginSpec = {
  loggedIn: { text: 'Quantum Crate' },
  loggedOut: 'Enter Inception',
  connect: 'button:has-text("Enter Inception")',
  entry: { kind: 'appkit', open: 'button:has-text("WALLET")', entryTestId: 'wallet-selector-io.metamask' },
  intents: ['connect'],
}
```

### 配方四：多签上传（自己控制钱包动作）

站点一个动作可能触发多次钱包签名（如 Shelby 上传：`register_multiple_blobs` → `commit_object`）。此时不声明 `login`，在 `action` 里按需调 `ctx.wallet.sign()`：

```ts
async action(ctx: TaskContext): Promise<void> {
  const page = ctx.page
  await page.locator('[role="dialog"] button:has-text("Upload")').first().click()
  for (let i = 0; i < 2; i++) {
    const { popupFailed } = await ctx.wallet.sign() // 每次签名一次弹窗
    if (popupFailed) ctx.log.info({ step: 'upload' }, '弹窗未出现（可能已上传），继续等终态')
  }
  await page.getByText('All files uploaded successfully', { exact: false }).first().waitFor({ state: 'visible', timeout: 180000 })
}
```

### 配方五：已领取 / 限频收敛

站点限频提示分两种语义，判定必须分开：

```ts
// 已领取（今日额度用完，如 Daily limit reached / 24 hours）→ 直接成功返回
if ((await page.getByText('Daily limit reached').count()) > 0) { await ctx.safeScreenshot('limit'); return }
// 冷却中（距上次未满 N 小时，如 Please wait 30 minutes）→ 抛错失败，靠重试退避覆盖冷却
if ((await page.getByText('Please wait').count()) > 0) throw new Error('领取冷却中')
```

千万不要把冷却中当成功，否则整轮虚报。重跑幂等：已领取一律视为成功。

### 配方六：数据源 + faker

```ts
// 数据源优先、faker 兜底（任务不因数据缺档失败）
const email = ctx.accountRow?.['邮箱'] || faker.internet.email()
await page.locator('input[name="email"]').fill(email)

// 严格取数（数据必须备齐，缺了宁可失败）
const address = await ctx.account('metamask钱包地址')

// 纯随机场景
const tokenName = faker.word.words(2)
await page.locator('textarea[name="description"]').fill(faker.lorem.sentence())
```

### 选择器查找技巧

- 用浏览器 DevTools：右键元素 → Copy → Copy selector；优先 `data-testid` 与语义属性（`name`/`type`/`role`），其次稳定 class，最后才是结构路径。
- 不要用 `:nth-child` 深路径与框架随机 class（改版即失效）。
- 断言元素选「成功后才会出现」的标志（徽章/文案），宁严勿松；多步骤表单用等待下一步元素出现代替固定 `sleep`。
- 同文案多个按钮时加 `:visible` 或更具体的容器限定。

---

## 12. 排错与真机经验

### 12.1 报错速查表

任务失败时，看板行内错误与日志里能找到下列关键词。文案均取自仓库当前代码。

| 报错关键词 | 含义 | 常见原因 | 解决 |
| --- | --- | --- | --- |
| `页面加载失败，第 3/3 次` | 打开网页失败（日志警告，每次重试一条） | 站点挂了/超时、代理 IP 不通、网址写错 | 第 3 次会把真实原因抛出；看日志原始错误与失败截图，核对 url 与窗口代理 |
| `点击失败` / 元素定位不到 | 想点的元素没找到 | 选择器写错、页面没加载完就点、站点改版 | 回 `meta.sourceUrl` 用 DevTools 重取选择器（见 12.2） |
| `waitFor` 超时（断言失败） | 等成功标志超时未出现 | 操作其实失败、断言元素选错、渲染慢 | 拉长 timeout、换成「成功后才会出现」的标志、看失败截图 |
| `图片下载失败: <url> (HTTP <状态码>)` | 上传图片 URL 下载失败 | 地址失效/404/需登录 | 换可用地址或本地路径；核对数据源「图片地址」列 |
| `数据源无当前窗口对应的行（窗口: X）` | 严格取数时表里没这个窗口的行 | 数据源没填该窗口；填了窗口名但改名了 | 补行；按窗口 ID 填更稳（见 4.5） |
| `数据源缺少列: X（可用列: …）` | 表头没这个列名 | 列名拼写/大小写不一致 | 按报错「可用列」核对拼写 |
| `数据源列 X 在窗口 Y 的行为空` | 单元格是空的 | 忘了填 | 补数据；想「缺了就用 faker」改用 `accountRow` |
| `任务未配置钱包` | 调钱包动作但没配 `meta.wallet` | meta 漏了 wallet | 补 `wallet`；或该任务本就不该用钱包动作 |
| `未注册的钱包适配器: X` | `meta.wallet` 的 key 没人认领 | key 拼错或没在 `src/app.ts` 注册 | 核对 key 与注册列表（见 4.2） |
| 钱包弹窗未出现（`popupFailed` / 登录超时） | 等钱包弹窗超时 | 未配/未注册 wallet；站点要先点连接按钮；扩展未加载；静默连接 | 核对 `meta.wallet`；先点连接再等；先 `ctx.wallet.ready()` 排除扩展未加载；静默连接以登录态为准（见 12.3） |
| `窗口 X 钱包扩展未加载（重试将重启浏览器窗口）` | `wallet.ready()` 探测扩展未加载 | 窗口实例异常/扩展未启用 | 等重试重启窗口恢复；连续出现检查比特窗口扩展安装 |
| `MetaMask 已锁定且未配置解锁密码` | 弹窗停在解锁页但没配密码 | `WALLET_PASSWORDS` 漏了该类型 | 配置密码（见第 8 章） |
| `MetaMask 解锁失败（密码错误或解锁页未离开）` | 密码错或解锁页没走 | 密码错 | 核对 `WALLET_PASSWORDS` |
| `AppKit 弹窗未出现 X 钱包入口` | AppKit 视图异常，归一化没命中 | 站点改版/渲染异常/`entryTestId` 错 | 核对 `entryTestId` 与站点当前 AppKit 视图（见 4.2） |
| `任务 X 超时` | 单次运行超过 `timeoutSec` | 卡死；某等待超时太长 | 核对各等待超时；必要时上调 `meta.timeoutSec` 或 `execution.taskTimeoutMs` |
| `任务已停用` | 手动触发被拒（409） | 开关关着 | 面板打开开关（立即生效） |
| `任务未注册` | 队列有 key 但框架找不到任务 | key 拼错/没在 `src/tasks/index.ts` 注册 | 核对 key 与注册数组 |
| `窗口熔断` | 该窗口连续失败太多，剩余任务全 skip | 前面任务终态失败把熔断计数顶到阈值 | 先修失败任务；面板「窗口」页「重置熔断」（见 12.4） |
| `窗口超时` | 单窗口会话到点（默认 15 分钟） | 窗口任务太多/某任务跑太久 | 精简窗口任务；查耗时异常；上调 `execution.windowTimeoutMs` |
| 开窗失败 | 比特窗口打不开，整轮任务全 skip | 比特客户端未登录/API 不可达；窗口 ID 不存在 | 设置页「测试连接」；核对窗口 ID |
| CDP 连接失败 | 窗口开了但接管失败，整轮 failed | 调试端口/内核异常 | 看日志与截图；重启比特客户端后重试 |

完整业务错误码清单见 `/api-docs`。

### 12.2 选择器失效

- **症状**：元素定位不到 / `waitFor` 超时。
- **对策**：`meta.sourceUrl` 记录了选择器当初从哪个页面确认；站点改版时回来源页用 DevTools 重取，优先换 `data-testid` 与语义属性，避免深路径与随机 class。

### 12.3 钱包弹窗不出现

- **症状**：`ensureLoggedIn` 登录超时，或 `ctx.wallet.*` 返回 `popupFailed`。
- **对策**：
  1. 检查 `meta.wallet` 的 key 是否已注册（未注册报 `未注册的钱包适配器: X`）；
  2. 登录前先调 `ctx.wallet.ready()`：扩展未加载会快速失败，等重试重启窗口恢复，比空等高效；
  3. 用 DevTools 查看弹窗实际 URL，对照适配器 `extensionUrlPatterns` 是否匹配；
  4. 若站点要先点「连接」按钮才弹窗，确保 `LoginSpec.connect` 正确；
  5. **静默连接**：扩展已授权站点时可能不弹窗——以登录态判定，不要当失败。

### 12.4 熔断触发与重置

- 窗口任务终态失败时 `circuitBreakerCount + 1`；计数 ≥ `execution.circuitBreakerThreshold`（默认 2）后，该窗口后续任务直接 `skipped`（窗口熔断）。
- 重置：面板「窗口」页「重置熔断」（`POST /api/profiles/:id/breaker/reset`）；任一任务成功后自动清零。

### 12.5 截图与日志位置

- **截图**：`data/screenshots/<日期>/<比特窗口ID>/<任务key>/`；看板批次明细可点开截图。
- **日志**：`data/logs/app.log`（当天）+ `data/logs/app.log.<日期>`（按天滚动，保留 `storage.logRetainDays` 天，默认 7）；级别由 `storage.logLevel` 控制，控制台同步输出。
- **运行状态**：`pending → running → success | failed | retry_wait → …`，`skipped` = 开窗失败/窗口超时/熔断跳过（见第 5 章）。

### 12.6 失败自动诊断包

任务失败时（含重试前每次尝试），框架自动采集当前窗口的排障上下文并落盘，面板看板失败行点「诊断」即可查看，不必先翻日志文件。

- **采集内容**：失败时的页面 URL、页面可见文本（截前 2000 字）、弹窗文本（`[role="dialog"]` 截前 1000 字）、步骤时间线（`ctx.step` 记录的每步耗时与成败）、错误信息、窗口名与任务 key；另有失败截图。
- **落盘位置**：`data/screenshots/<日期>/<比特窗口ID>/<任务key>/<日期>-attempt<n>.diag.json`（与截图同目录，`attempt<n>` 对应第 n 次尝试）；路径记在该 run 的 `runs.diag_path`。
- **面板入口**：看板批次明细的失败行（`status=failed`）「诊断」按钮，弹窗展示错误 / URL / 步骤时间线 / 弹窗文本 / 页面文本，并可跳转失败截图。
- **接口**：`GET /api/diagnostics/:runId` 按 run id 返回诊断包 JSON（DiagBundle）；run 不存在、无诊断或文件不可读统一 404（业务码 `40408`）。
- **不影响成败**：采集全程 best-effort，采集或写盘异常只告警，绝不改变任务成功/失败结果，也不计入熔断。

### 12.7 真机经验（合并自原《真机踩坑录》）

**1）真机核实是唯一标准，选择器先猜后验**

- SPA 静态 HTML 看不到登录后内容：初始选择器必然靠猜，写完立刻 `task:run` 单窗口真跑，按截图/日志迭代。
- 真机核实结论必须写进任务文件头注释 + `meta.note`（含核实日期）。
- 每个断言失败都有截图，先看图再改码。

**2）登录态判定：别用全页文本**

- 首页表格/数据可能全是 `0x` 开头内容（区块链站常见）——全页文案判定必误判。
- 正确做法：用**范围选择器**（如 `header button:has-text("0x")`）作 `Probe`，交给 `ensureLoggedIn` 竞速（已登录/未登录谁先可见）或 `ctx.race`；不要自己写全页文本判断。
- SPA 渲染有 0-3s 延迟，首轮竞速至少 20 秒。

**3）钱包弹窗三个坑**

1. **静默连接**：扩展已授权的窗口点 Connect 后可能根本不弹钱包弹窗——以页面登录态为准，不能判失败（`ensureLoggedIn` 已容忍 `popupFailed`）。
2. **弹窗渲染慢 / 点击未注册**：高并发 + 慢代理下弹窗可能 30s+ 不出。对策：预算放宽到 45s+；用 `opts.reclick` 补点（弹窗遮罩出现说明点击已生效，补点前确认目标按钮仍可见，避免误点遮罩）；每轮等待都要打日志，别静默循环。
3. **网络切换**：任务上线前真机确认钱包网络是否在目标链；若站点不自动切链，需在钱包扩展 UI 加切链步骤。

**4）文件上传两个坑**

1. **隐藏 file input**：`display:none` 的 input 不能用可见性等待，用挂载判定（`locator.count() > 0` 轮询）；`ctx.uploadFile` / `setInputFiles` 对隐藏 input 可用。
2. **一次性文件（blob 名查重）**：站点可能在选文件后立即查重——已上传的文件弹窗直接报错（如 `Blob name already taken`）且提交按钮**永不启用**。必须把该错误文案短路视为「已上传=成功」（幂等收敛），不能等按钮启用、更不能当失败重试。

**5）任务卡死：先看日志，别盲目重跑（最重要）**

- 卡死第一反应：`data/logs/app.log` 最新日志 + 对应窗口截图目录。日志「静默期」本身是线索——说明卡在某个不打日志的等待循环。
- 真机实况：某窗口一次尝试静默卡 15 分钟（代理/会话坏），直到任务超时兜底才暴露。**每类等待循环必须打日志**。
- **明确标准：真机运行连续 2 次失败或 10 分钟无进展 → 立刻停下，带日志+截图找用户请求人工接入**，不要继续派自动化重跑。
- 反复开合过的窗口代理/会话可能变差：换新窗口验证，别跟旧窗口死磕。
- 开窗失败（比特 API 瞬时错误）会跳过不重试——重触发一次即可，属环境抖动不是任务 bug。

**6）运维要点**

- 后端 `tsx src/index.ts` **无 watch**：改完任务代码必须重启 dev 才生效；重启会打断在途窗口会话，批量运行中不要重启。
- 单窗口触发：`POST /api/tasks/:key/trigger` + body `{"bitbrowserId":"<id>"}`（不等待错峰）；批量触发不带 body。
- 结果核对：`GET /api/batches` 的 `stats`；每窗口今日成功数查 SQLite `runs` 表。
- 熔断修复后可 `POST /api/profiles/:id/breaker/reset` 复位。
- 任务 key 全局唯一，登记 `src/tasks/index.ts`；面板定时计划引用新 key 需手动新建计划。

**7）性能参数建议（真机校准）**

- `retry.backoffSec` 60 秒即可（瞬时问题重试快）；瞬时失败通常一次就过。
- `timeoutSec` 给真实最慢路径留 2 倍余量即可，别给 15 分钟——卡死窗口会白占并发槽。
- 卡死类等待循环收敛到 3-4 轮，每轮打日志。

**8）比特开窗 API 异步语义（2026-09-11 窗口泄漏事故）**

- `POST /browser/open` 是「发出即开」的异步操作：请求发出后比特客户端就开始打开浏览器（30-90s），**API 报错/超时 ≠ 窗口没开**。
- 事故复盘：手动「立即触发」全部 100 窗口 + 内存不足 → 每个窗口开窗「失败」重试 3 次后跳过，但旧代码失败路径不清理 → 客户端侧窗口一个个真开起来、没人关 → 堆积几十个 → 内存 ≥95% → 拒绝新开窗 → 剩余全部失败。
- **并发闸门限制的是系统侧会话数，管不住客户端侧窗口泄漏**——排查「开了一大堆窗口」先看是不是开窗失败泄漏。
- 修复：`window-runner.openWithRetry` 每次 `openBrowser` 失败后补一次 `closeBrowser`。写开窗相关代码记住：**失败路径必须清理，报错 ≠ 副作用没发生**。

**9）状态判定三连坑（2026-10-07 konnex 每周签到）**

1. **卡片渲染延迟**：goto 后 SPA 数据异步加载，约 1s 后签到卡片才渲染——`goto → 立即判定` 会假报「按钮不存在」。判定前先**循环等待卡片状态出现**（按钮或已签到信号任一），预算 45s，每轮打日志。
2. **「已签到」不止一种界面**：konnex 当周已签到时按钮消失，卡片先显示 "Great job!" 横幅，用户点 Close 后变暗态 "RESETS IN <倒计时>"——**两种状态都要算成功**，否则用户手动关横幅后批量运行会整批误报失败。做法：`#卡片:has-text("Great job!")` / `:has-text("RESETS IN")` 任一命中即已签到。
3. **签到成功判定用竞速而不是单断言**：点按钮后成功弹窗与已签到横幅可能先后出现，用 `ctx.race` 两者任一命中即成功；竞速漏检再兜底查一次已签到状态。
4. **成功截图必须容错**：站点页面有持续动画（倒计时/动态榜）时 CDP 截图会偶发 30s 超时挂起，成功截图若直接 await 会把已成功的签到误报失败（窗口 89 实测）。**成功截图一律用 `ctx.safeScreenshot`**，签到成功的唯一判定是弹窗/卡片状态。

---

## 13. 工具中心

工具页是随需扩展的工具集合（卡片数据来自 `GET /api/tools`，在 `src/tools/index.ts` 的 `TOOLS` 注册表登记）。目前一个工具：**文件随机分配**。

**文件随机分配**：把本机文件夹里的文件按名称模板重命名，随机分配到 `config/accounts.xlsx` 各账号行，并写回目标列。

- **手动流程**：源文件夹绝对路径 → 目标列 + 名称模板 → 「生成预览」→「执行分配」（改名 + 写回 + 自动重载数据源）。
- **规则**：文件数少于账号行数报错不执行；只改被分配到的 N 个文件；执行是破坏性且不回滚，执行前务必核对预览。
- **定时执行**：形成纯分配计划（`taskKeys` 空 + `config.fileAssign`），源文件夹/目标列/名称模板在保存时固化进计划；到点自动分配一次，不触发任务、不开窗口；与任务计划的联动见第 7 章。

---

## 附录 A：AI 帮写任务模板（元素清单式）

> 新增任务不用自己写代码：把下面模板填了丢给 AI 帮你写。**元素你给，其余 AI 查**——按钮写文案或直接贴选择器（原始长选择器不用筛选，AI 负责筛选），AI 补全缺失信息后直接写代码。

**硬约束（AI 必须遵守）：**

- DOM 操作**直调 patchright**（`ctx.page.locator(...)` 等）；登录用 `ctx.wallet.ensureLoggedIn`（声明式 `login: LoginSpec`）。
- 只用框架已封装的 `ctx` 能力，**禁止手写 reload / 等待循环**；封装不够用，就**就地扩封装**（改 engine/automation，而不是在任务里堆循环）。
- 成功必须显式断言；已领取/限频一律幂等收敛为成功；成功截图用 `ctx.safeScreenshot`。

### 填空模板（直接复制，按提示填写）

```text
【新任务】

名称：
key：
类型：checkin / faucet / mint / other（四选一）
网址：
钱包：metamask / petra / 邮箱密码 / 无需登录
备注（可选）：

元素清单（每行一个动作；按钮写文案或贴选择器，原始长选择器直接粘，AI 会筛选）：
- 点：
- 填：        →        （数据源列名 / 固定值 / faker）
- 等：（成功后才出现的文案原文）
- 已领取：（今天已领过时的提示原文，没有写「无」）
- 弹窗（可选）：
```

### 字段怎么填

| 字段 | 怎么填 | 例子 |
| --- | --- | --- |
| 名称 | 面板任务页显示的中文名 | ZooFaucet 领水 |
| key | 英文小写 + 连字符，全局唯一，起完尽量不改 | zoo-faucet |
| 类型 | checkin 签到（绿）/ faucet 领水（蓝）/ mint 铸币（黄）/ other 其他（灰） | faucet |
| 网址 | 浏览器地址栏完整 URL；任务从子页面开始就填子页面 | https://zoofaucet.example.com/ |
| 钱包 | metamask / petra / 邮箱密码 / 无需登录 | metamask |
| 备注 | 想交代的坑（改版频繁、有倒计时等），会写进面板任务卡备注 | 站点偶尔改版 |

| 行开头 | 怎么填 |
| --- | --- |
| 点： | 优先写按钮上的字（如 `Claim`）；文案重复/难描述时贴选择器；补充说明写同一行括号里 |
| 填： | `输入框（选择器或描述）→ 填什么`。填什么三选一：数据源列名 / 固定值 / faker |
| 等： | 成功后才出现的文案原文（语言、大小写照抄）——成功判定依据，宁严勿松 |
| 已领取： | 今天已领过时的提示原文；站点没有这种状态写「无」 |
| 弹窗（可选）： | 打开会弹公告/新手引导吗？怎么关（右上角 X / 「知道了」） |

### 填写示例

```text
【新任务】

名称：ZooFaucet 领水
key：zoo-faucet
类型：faucet
网址：https://zoofaucet.example.com/
钱包：metamask
备注：站点偶尔改版，成功文案会变

元素清单：
- 点：右上角 X（公告弹窗，选择器 .announce-modal button.close）
- 点：Connect Wallet（页面有两个同文案按钮，用 button:has-text("Connect Wallet"):visible）
- 填：input[type="email"] → 「邮箱」列
- 点：Claim
- 等：Claimed!（绿色提示即成功）
- 已领取：Please wait 24 hours
- 弹窗：打开弹公告，右上角 X 关
```

AI 拿到这段会：① 筛选稳定选择器（优先 id / data-testid / 按钮文案）；② 缺登录标志/成功判定/数据源列时一次性列全问题；③ 写任务文件（`meta` + 可选的 `login`/`action`）并在 `src/tasks/index.ts` 注册；④ 跑 `npm test` 确认无语法/逻辑错误；⑤ 给你单窗口真跑命令 `BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<key> npm run task:run`；⑥ 你验收后上线（面板开开关 + 手动/定时触发）。

---

## 附录 B：示例任务源码

三个带注释的示例任务（面板「文档」页示例视图可直接看源码，带行号）：

| 文件 | 说明 | 关键点 |
| --- | --- | --- |
| `src/tasks/example-checkin.ts` | 示例签到 | `login: LoginSpec` + `action`；已签到短路 |
| `src/tasks/faucet-example.ts` | 示例领水 | 无 login；`accountRow` + faker 兜底；断言成功文案 |
| `src/tasks/mint-example.ts` | 示例铸币 | 多步骤表单 + `ctx.wallet.confirmTx` + 链上结果断言 |

**最小任务（只有 action，无登录）：**

```ts
import { SiteTask, type TaskContext, type TaskMeta } from './base'

export class TinyTask extends SiteTask {
  meta: TaskMeta = {
    key: 'tiny',
    name: '最小任务',
    url: 'https://example.com/',
    enabled: false,
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page
    await page.locator('#do-btn').click()
    await page.locator('.done').waitFor({ state: 'visible', timeout: 10000 })
  }
}
```

登记到 `src/tasks/index.ts` 的 `ALL` 数组后即自动获得 API 与面板能力。

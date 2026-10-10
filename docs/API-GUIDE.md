# AutoBitControl 函数手册

> 目标读者：第一次接触本站自动化的你。本手册只讲「函数怎么用」——不预设编程背景，按「用途 → 签名 → 参数 → 示例 → 注意」的顺序讲。
>
> 站点任务的能力**全部是普通函数**，从唯一出口 `src/api/index.ts` 引入（任务里写 `import { ... } from '../api'`）。运行时数据（当前页面、日志、窗口、数据源行、任务本身）装在 `ctx` 里，作为每个函数的**第一个参数**传入。`ctx` 只有数据、没有方法。
>
> **签名、参数与默认值以 `src/api/{page,find,wait,wallet,captcha,data,diag,ai}.ts` 源码为唯一真值**；框架级配置（`config.json` / `.env`）见第 7 章；源码改了、手册没跟上，以源码为准并回来同步本手册。

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
| **框架**（引擎 + 浏览器） | 替你操作浏览器的「手」：按说明书去点网页、失败自动重试 |
| **面板**（Web 界面） | 看结果的地方：哪个任务成功/失败、现场截图长什么样 |

**心智模型：**

```
写任务（写说明书） → 试跑（本地单窗口验证） → 上线（面板开开关 + 手动/定时触发）
```

**三句话记住怎么用：**

1. 能力都是函数：`import { ... } from '../api'` 后用，**首参传 `ctx`**；`ctx` 只是数据袋子（`ctx.page`、`ctx.log`、`ctx.profile`、`ctx.accountRow`、`ctx.task`、`ctx.ai`），不再有方法或命名空间。
2. 任何一步抛错（`throw`）都等于「这次任务失败」，框架按 `retry` 配置自动重试，并在面板留档。
3. 成功与否由**断言**说了算（「该出现的东西出现了没有」），而不是「点到了按钮」就算数。

**名词表：**

| 名词 | 一句话大白话 |
| --- | --- |
| 任务 / Task | 一个站点的自动化流程（如「每天去 X 站签到」），对应 `src/tasks/` 一个文件 |
| 选择器 / Selector | 定位网页元素的规则，如 `#checkin-btn` 表示 id 为 `checkin-btn` 的按钮 |
| 探针 / Probe | 一个「等什么」的描述：一段文案，或一个选择器 |
| 断言 / Assertion | 检查「该出现的东西出现了没有」，没出现就报错 |
| 弹窗 / Popup | 网页上浮出的小窗口，或浏览器钱包插件弹出的确认窗口 |
| 遮罩 / Mask | 弹窗背后盖住整页的半透明灰层 |
| DOM | 浏览器把网页解析成的一棵树，每个元素都能按规则定位 |
| 隔离世界 / 主世界 | 自动化工具默认在隔离世界看网页；站点自己注入的全局变量只能进主世界读 |
| CDP | 浏览器调试协议；框架通过它把真事件派发给页面 |
| 窗口 / Profile | 一个比特浏览器环境（独立代理、指纹、Cookie），面板「窗口」页管理的单位 |
| 熔断 / Circuit Breaker | 保险丝：一个窗口连续失败 N 次即熔断、剩余任务跳过；每日 23:59 自动重置（任一任务成功也清零） |
| 重试 / Retry | 任务失败后自动再跑，次数与间隔可配置 |
| 退避 / Backoff | 重试前的等待时间，给站点限流留冷却 |
| 数据源 / DataSource | 预先准备的账号/素材 Excel（`config/accounts.xlsx`），每个窗口按行领取 |
| patchright | 我们用的隐形浏览器驱动，自动屏蔽自动化痕迹 |
| log4js | 写日志的库 |

---

## 1. 五分钟上手

新增一个任务共 5 步：

**第 1 步：建文件** `src/tasks/my-checkin.ts`。

**第 2 步：写 `meta`**（任务基本信息，字段见第 2 章）。

**第 3 步：写 `run(ctx)`**（用 `../api` 的函数完成站点动作，见第 3 章）。

**第 4 步：注册** 在 `src/tasks/index.ts` 的 `ALL` 数组加入实例（`key` 必须全局唯一）。

**第 5 步：验证** 重启服务（`npm run dev`，后端 API + 前端 Vite 面板同启）→ 面板「任务」页出现新任务卡片 → 手动触发 → 看板查看结果与截图。

完整最小任务：

```ts
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, loginWallet, click, hasText, waitFor } from '../api'

export class MyCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'my-checkin', // 全局唯一标识：API / 数据库 / 面板都用它
    name: '我的签到', // 面板显示名
    url: 'https://example.com/', // 任务入口页
    wallet: 'metamask', // 登录用钱包适配器 key（不连钱包则省略）
  }

  async run(ctx: TaskContext): Promise<void> {
    // 打开任务页（首屏顺带清掉残留标签页）
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    // 声明式钱包登录：竞速判登录态 → 点连接 → 等登录完成
    await loginWallet(ctx, {
      wallet: 'metamask',
      scenario: 'direct',
      loggedIn: { text: '已连接' }, // 已登录标志
      loggedOut: '连接钱包', // 未登录标志（字符串等价 { text }）
      connect: 'button:has-text("连接钱包")',
    })
    // 已签到直接成功返回（幂等：重复触发不报错）
    if (await hasText(ctx, '已签到')) return
    // 点签到按钮 → 断言成功标志（宁严勿松）
    await click(ctx, '#checkin-btn')
    await waitFor(ctx, { selector: '#checked-badge' }, { assert: true, budgetMs: 10000 })
  }
}
```

注册（`src/tasks/index.ts`）：

```ts
import { ExampleCheckinTask } from './example-checkin'
import { MyCheckinTask } from './my-checkin'

const ALL: SiteTask[] = [new ExampleCheckinTask(), new MyCheckinTask()]
```

**试跑与验证：**

1. **单窗口真跑**：`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=my-checkin npm run task:run`（不受开关与错峰限制，打印结果后退出）。
2. **面板验证**：任务页开开关后「立即触发」（全部启用窗口），或看板行级「执行」（单窗口单任务）。
3. **看现场**：截图在 `data/screenshots/<日期>/<比特窗口ID>/<任务key>/`，日志在 `data/logs/app.log`。

注意：三个示例任务用占位地址 `https://example.com/`（可直接跑通导航步骤），但都显式写了 `enabled: false`，不参与日常执行；调试时在面板手动触发或用 `task:run` 脚本跑。改完任务代码必须**重启服务**才生效（后端无 watch）。

---

## 2. 任务骨架：`SiteTask`

`SiteTask`（`src/tasks/base.ts`）是所有站点任务的抽象基类。一个任务 = 必填的静态元信息 `meta` + 运行主体 `run(ctx)`：

```ts
export abstract class SiteTask {
  abstract meta: TaskMeta
  abstract run(ctx: TaskContext): Promise<void>
}
```

`run(ctx)` 内**只经 `../api` 的能力函数**操作 `ctx`（加载页面、登录、等待、截图等）。

### 2.1 `meta`（`TaskMeta` 字段全解）

`TaskMeta` 定义于 `src/engine/task.ts`。除 `key`/`name`/`url` 必填外，其余可选，缺省时按默认行为。

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `key` | `string` | 无（必填） | 全局唯一标识；数据库 runs 表与面板都用它 |
| `name` | `string` | 无（必填） | 面板任务页显示名 |
| `url` | `string` | 无（必填，可为 `''`） | 站点入口页；`openPage()` 不传 url 时用它。空串时 `openPage()` 抛错，任务需自行处理（示例任务改用占位地址 `https://example.com/`） |
| `sourceUrl` | `string \| string[]` | `undefined` | 信息来源页：选择器从哪个页面确认的；站点改版时回这里重查；多步骤可给多个地址 |
| `note` | `string?` | `undefined` | 备注：站点的坑与特殊逻辑，面板任务页直接可见 |
| `category` | `'checkin' \| 'faucet' \| 'mint' \| 'other'` | `undefined` | 面板显示对应颜色徽章 |
| `group` | `{ key: string; name: string }?` | `undefined` | 空投分组：同一空投的多个任务写相同的 key+name，面板按组折叠展示 |
| `lastUpdated` | `string?` | `undefined` | 最后核对站点的日期（文档约定，如 `'2026-10-09'`） |
| `deprecated` | `boolean?` | `false` | `true` → 面板置灰显示「已失效」 |
| `enabled` | `boolean?` | `true` | 任务开关的代码默认值：`false` 时手动触发接口 409。面板开关写入本地库 `task_states` 覆盖，立即生效、重启保留 |
| `wallet` | `string?` | `undefined` | 钱包适配器 key（`'metamask'`/`'petra'`）；`loginWallet`/`signMessage`/`confirmTransaction` 按此查找适配器 |
| `timeoutSec` | `number?` | 180 | 单次运行超时（秒）；缺省取全局 `execution.taskTimeoutMs / 1000` |
| `retry` | `{ max: number; backoffSec: number }?` | `{ max: 2, backoffSec: 600 }` | 失败重试次数与间隔秒数；缺省取全局 `execution.retryMax`/`execution.retryBackoffSec` |
| `concurrency` | `number?` | 4 | 任务级并发：同一时间最多几个窗口并行跑该任务；缺省 `DEFAULT_TASK_CONCURRENCY`（4） |
| `requiresFileAssign` | `boolean?` | `undefined` | 声明依赖「上传前自动文件随机分配」：定时计划配置 `fileAssign` 时先分配，失败则本任务本次跳过 |

示例（`src/tasks/example-checkin.ts`）：

```ts
meta: TaskMeta = {
  key: 'example-checkin',
  name: '示例签到',
  group: { key: 'example', name: '示例' },
  url: 'https://example.com/',
  sourceUrl: '',
  note: '示例任务：url 为占位地址且开关默认关闭；调试时在面板打开开关，或用 task:run 脚本直接跑（不受开关限制）',
  category: 'checkin',
  lastUpdated: '2026-10-09',
  enabled: false,
  wallet: 'metamask',
  timeoutSec: 180,
  retry: { max: 2, backoffSec: 600 },
  concurrency: 4,
}
```

### 2.2 `run(ctx)` 要点

- 打开页面一律用 `openPage`（自带失败重试）。
- 要钱包登录就调 `loginWallet`；只做单次签名/确认就调 `signMessage`/`confirmTransaction`。
- 页面判定用 `waitFor` / `race` / `hasText` / `elementState`，**别写固定 sleep**。
- **成功必须显式断言**：要么 `waitFor(..., { assert: true })`，要么自己 `throw`。
- 多页流程在一个 `run` 里连续调 `openPage` 即可（首屏可 `closeOtherTabs: true`）。

---

## 3. 函数参考

函数统一从 `import { ... } from '../api'` 引入（对应源码 `src/api/`）。除特别说明外，**第一个参数永远是 `ctx`**，任务侧只读它。

### 公共类型

```ts
/** 探针：一段文案，或一个选择器；字符串等价于 { text } */
type Probe = string | { text: string } | { selector: string }

/** 等待探针：在 Probe 基础上增加“等消失” */
type WaitProbe = Probe | { gone: string }
```

- `{ text }`（或字符串）：按**存在**判定（元素数 > 0，不判可见性，兼容双 DOM / 动画态）。
- `{ selector }`：按**可见**判定（需元素存在且 `isVisible()`）。
- `{ gone }`：按**不可见或不存在**判定（仅等待类函数支持）。

### 3.1 页面（`src/api/page.ts`）

#### `openPage(ctx, url?, options?)`

**用途**：打开网页（默认 `meta.url`），失败自动重试，等加载完成。

**签名**：

```ts
openPage(
  ctx: TaskContext,
  url?: string,
  options?: {
    retries?: number
    timeoutMs?: number
    waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'
    closeOtherTabs?: boolean
  },
): Promise<void>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `url` | `string` | 否 | `ctx.task.meta.url` | 目标地址；两者都为空串则抛错 |
| `options.retries` | `number` | 否 | `3` | 加载失败重试次数（含首次）；失败按 2–5 秒随机退避 |
| `options.timeoutMs` | `number` | 否 | `45000` | 单次 `goto` 超时（毫秒） |
| `options.waitUntil` | `string` | 否 | `'domcontentloaded'` | 等待的加载状态 |
| `options.closeOtherTabs` | `boolean` | 否 | `false` | 打开前是否关闭当前上下文里其它标签页 |

**示例**：

```ts
await openPage(ctx, this.meta.url, { closeOtherTabs: true })
await openPage(ctx, 'https://example.com/second', { waitUntil: 'load' })
```

**注意**

- 窗口是复用的，`closeOtherTabs: true` 用来清掉上次残留的标签页（多页任务通常在首屏开一次）。
- 第 3 次仍失败会把真实原因抛出，日志里每条带上 `页面加载失败，第 N/3 次`。

#### `click(ctx, target)`

**用途**：点击元素；也支持按坐标点击（用于无选择器的目标，如验证码方框）。

**签名**：

```ts
click(ctx: TaskContext, target: string | { x: number; y: number }): Promise<void>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `target` | `string` | 是 | — | 选择器：走 `locator(selector).first().click()` |
| `target` | `{ x: number; y: number }` | 是 | — | 视口坐标：走 CDP `Input.dispatchMouseEvent`（跨域 iframe 也能点） |

**示例**：

```ts
await click(ctx, '#checkin-btn')
await click(ctx, { x: 120, y: 300 }) // 坐标点击
```

**注意**

- 选择器点击只作用于**首个**匹配元素；同文案多个按钮时加 `:visible` 或用更具体的容器限定。
- 坐标是视口像素坐标，页面滚动后需重新计算。

#### `fill(ctx, selector, text)`

**用途**：把输入框设置为给定值（一次性填值，不是逐键输入）。

**签名**：`fill(ctx: TaskContext, selector: string, text: string): Promise<void>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `selector` | `string` | 是 | — | 输入框选择器（如 `input[name="email"]`），取首个匹配 |
| `text` | `string` | 是 | — | 要填入的值 |

**示例**：`await fill(ctx, 'input[name="email"]', 'a@b.com')`

**注意**：需要逐键慢速输入、触发输入事件时才用 `ctx.page.locator(...).pressSequentially()`（patchright 逃生口）。

#### `pressKey(ctx, key)`

**用途**：在当前焦点上按键。

**签名**：`pressKey(ctx: TaskContext, key: string): Promise<void>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `key` | `string` | 是 | — | 键名或组合键，如 `'Enter'`、`'Control+A'` |

**示例**：`await pressKey(ctx, 'Enter')`

**注意**：先确保目标输入框已聚焦（`click` 或 `fill` 过后一般已聚焦）。

#### `runJs(ctx, fn)`

**用途**：在页面**主世界**执行一段 JS 并返回结果（读站点注入的全局变量、`localStorage` 必须用主世界）。

**签名**：`runJs<T>(ctx: TaskContext, fn: () => T): Promise<T>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `fn` | `() => T` | 是 | — | 自包含的求值函数，返回值原样透传 |

**示例**：

```ts
const state = await runJs<{ user?: { id: string } }>(ctx, () => (window as any).__APP_STATE__)
if (!state?.user) throw new Error('未登录')

const done = await runJs<boolean>(ctx, () => localStorage.getItem('claimed_today') === '1')
if (done) return // 今日已做 → 成功
```

**注意**

- 函数体必须**自包含**：它会被序列化后送进页面执行，引用外部变量拿不到值。
- 默认隔离世界的 `ctx.page.evaluate` 读不到站点注入的全局变量，改用本函数。

### 3.2 查找（`src/api/find.ts`，即时判断，不等待）

#### `elementState(ctx, selector)`

**用途**：判断元素状态：可见 / 隐藏 / 不存在。

**签名**：`elementState(ctx: TaskContext, selector: string): Promise<'visible' | 'hidden' | 'absent'>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `selector` | `string` | 是 | — | 元素选择器（取首个匹配） |

**返回值**：`'visible'`（可见）、`'hidden'`（在 DOM 但不可见）、`'absent'`（不存在；查询异常也按不存在处理）。

**示例**：

```ts
if ((await elementState(ctx, ADDRESS_SELECTOR)) === 'visible') return // 已登录
```

**注意**：是即时快照，不做等待；要等它出现用 `waitFor`。

#### `getText(ctx, selector)`

**用途**：取元素文本（首个匹配，去首尾空格；取不到返回空串）。

**签名**：`getText(ctx: TaskContext, selector: string): Promise<string>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `selector` | `string` | 是 | — | 元素选择器 |

**示例**：`const addr = await getText(ctx, 'header button')`

**注意**：失败（元素不存在 / 异常）返回 `''`，不抛错，调用方自行判定。

#### `hasText(ctx, text)`

**用途**：整页是否包含某文案（包含匹配，即时）。

**签名**：`hasText(ctx: TaskContext, text: string): Promise<boolean>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `text` | `string` | 是 | — | 要查找的文案（子串即可命中） |

**示例**：

```ts
if (await hasText(ctx, '已领取')) return // 幂等：今日已领 = 成功
if (await hasText(ctx, '维护中')) throw new Error('水龙头维护中')
```

**注意**：全页扫描，**别拿它判登录态**（区块链站点首页大量 `0x` 文案会误判，见第 6 章）；范围用 `{ selector }` 探针交给 `waitFor` / `race`。

### 3.3 等待（`src/api/wait.ts`）

#### `waitFor(ctx, probe, options?)`

**用途**：等条件命中（文案出现 / 元素可见 / 元素消失）；可选**刷新恢复**（出错或周期性刷新页面）；返回是否命中。

**签名**：

```ts
waitFor(ctx: TaskContext, probe: WaitProbe, options?: {
  budgetMs?: number
  assert?: boolean
  refreshEveryMs?: number
  recoverTexts?: string[]
  settleMs?: number
  heartbeatMs?: number
}): Promise<boolean>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `probe` | `WaitProbe` | 是 | — | 等待条件：`{ text }`/字符串按存在、`{ selector }` 按可见、`{ gone }` 按消失 |
| `options.budgetMs` | `number` | 否 | `10000` | 总预算（毫秒），超时即结束 |
| `options.assert` | `boolean` | 否 | `false` | `true` → 超时抛错；`false` → 返回 `false` |
| `options.refreshEveryMs` | `number` | 否 | `0`（关闭） | 周期主动刷新间隔（刷新恢复，原 `recover` 语义） |
| `options.recoverTexts` | `string[]` | 否 | `[]` | 页面出现这些文案立即刷新；恢复型等待显式传 `RECOVER_TEXTS`（默认 `['Network Error', 'Turnstile token request timed out']`，从 `./base` 引入） |
| `options.settleMs` | `number` | 否 | `5000` | 刷新后的沉降等待（毫秒） |
| `options.heartbeatMs` | `number` | 否 | `15000` | 心跳日志间隔（毫秒） |

**示例**：

```ts
// 简单断言：等成功标志出现，10s 不到即失败
await waitFor(ctx, { selector: '.success-toast' }, { assert: true, budgetMs: 10000 })

// 已领取 / 上限文案任一命中（不等可见，出现就算）
if (await waitFor(ctx, { text: 'Daily limit reached' }, { budgetMs: 3000 })) return

// 刷新恢复：出现可恢复错误立即刷，每 30s 周期主动刷
await waitFor(ctx, { selector: '#upload-files' }, {
  budgetMs: 120000,
  refreshEveryMs: 30000,
  recoverTexts: RECOVER_TEXTS,
})

// 等弹窗消失
await waitFor(ctx, { gone: `text=${MODAL_TITLE}` }, { budgetMs: 10000 })
```

**注意**

- `assert: true` 是**成功断言**的主力：该出现的东西没出现就报错。默认 `false` 时超时只是返回 `false`，由任务决定后续（适合「已领取」这类幂等判定）。
- `recoverTexts` 默认空数组；要错误恢复务必显式传 `RECOVER_TEXTS`（或自定义文案）。

#### `race(ctx, entries, timeoutMs)`

**用途**：多探针竞速——任一先命中即返回它的键；都等不到返回 `null`（**不抛错**）。

**签名**：`race<K extends string>(ctx: TaskContext, entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `entries` | `Array<[键, Probe]>` | 是 | — | 键为自定义字符串，值为探针；空数组直接返回 `null` |
| `timeoutMs` | `number` | 是 | — | 竞速总时长（毫秒） |

**示例**：

```ts
const outcome = await race(ctx, [
  ['success', { text: 'Check-In Succeeded!' }],
  ['done', { text: 'Great job!' }],
  ['limit', { text: 'Daily limit reached' }],
], 30000)
if (outcome === 'success' || outcome === 'done') return
if (outcome === 'limit') return // 达上限 = 成功幂等
throw new Error('签到未完成')
```

**注意**：一个动作后可能出现多种**互斥**结果时（成功 / 已做 / 上限 / 余额不足），用竞速比连续判断更可靠、更省时；返回值是 `null` 时不抛错，由任务决定后续。

#### `waitResponse(ctx, match, options?)`

**用途**：等接口响应，按 URL/方法过滤、按状态/值判定命中，返回 `{ status, body }`。

**签名**：

```ts
waitResponse(ctx: TaskContext, match: {
  urlPart?: string
  method?: string
  predicate?: (status: number, body: unknown) => boolean
  parse?: 'json' | 'text'
}, options?: { timeoutMs?: number }): Promise<{ status: number; body: unknown }>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `match.urlPart` | `string` | 否 | 不限 | 只等 URL 含此片段 |
| `match.method` | `string` | 否 | 不限 | 只等此 HTTP 方法（如 `'POST'`） |
| `match.predicate` | `(status, body) => boolean` | 否 | 不限 | 命中条件：不满足则抛错 `接口响应未命中判定` |
| `match.parse` | `'json' \| 'text'` | 否 | `'json'` | body 解析方式；`'text'` 返回原文，JSON 解析失败为 `null` |
| `options.timeoutMs` | `number` | 否 | `15000` | 等待响应的超时（毫秒） |

**示例**：

```ts
const { status, body } = await waitResponse(ctx, {
  urlPart: '/api/claim',
  method: 'POST',
  predicate: (s, b) => s === 200 && Boolean((b as { tx?: string })?.tx),
})
ctx.log.info({ status }, '领取接口命中')
```

**注意**

- 要在**点击前**先注册等待（先 `const p = waitResponse(...)`，再点，再 `await p`），否则可能错过响应。
- `predicate` 不满足时抛错；想自己判 body，省略 `predicate` 拿返回值即可。

### 3.4 钱包动作（`src/api/wallet.ts`）

#### `loginWallet(ctx, spec)`

**用途**：钱包登录全流程（按 `wallet` 取适配器、按 `scenario` 露出钱包入口，自适应完成连接/签名/确认并等登录态）。

**签名**：

```ts
type WalletType = 'metamask' | 'petra'
type WalletScenario = 'direct' | 'appkit' | 'dialog'
type WalletIntent = 'connect' | 'sign' | 'confirmTx'

type LoginSpec =
  | (LoginSpecBase & { scenario: 'direct' })
  | (LoginSpecBase & { scenario: 'appkit'; entryTestId: string; open?: string; modalTestId?: string })
  | (LoginSpecBase & { scenario: 'dialog'; confirm?: string; walletEntry?: string })

loginWallet(ctx: TaskContext, spec: LoginSpec): Promise<void>
```

**参数（`LoginSpec` 字段）**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `wallet` | `'metamask' \| 'petra'` | 是 | — | 钱包适配器 key |
| `loggedIn` | `Probe` | 是 | — | 已登录标志探针（出现即认定已登录） |
| `loggedOut` | `Probe` | 是 | — | 未登录标志探针（出现即走登录流程） |
| `scenario` | `'direct' \| 'appkit' \| 'dialog'` | 是 | — | 站点连接入口形态（判别字段，见第 4 章） |
| `connect` | `string` | 否 | `undefined` | 站点「连接钱包」按钮选择器 |
| `entryTestId` | `string` | appkit 必填 | — | AppKit 钱包选择项的 `data-testid`（如 `wallet-selector-io.metamask`） |
| `open` | `string` | 否 | `'button:has-text("Connect Wallet")'` | appkit：打开钱包列表的按钮选择器 |
| `modalTestId` | `string` | 否 | `undefined` | appkit：弹窗根节点 testid（可选） |
| `confirm` | `string` | 否 | `undefined` | dialog：站内对话框的确认按钮选择器（如 `text=Connect with Ethereum`） |
| `walletEntry` | `string` | 否 | `undefined` | dialog：弹窗内钱包选择项（如 `text=MetaMask`），也用作补点选择器 |
| `intents` | `WalletIntent[]` | 否 | `['connect']` | 要依次处理的钱包动作序列 |
| `waitLoggedInMs` | `number` | 否 | `90000` | 等「已登录」标志出现的最长毫秒数 |
| `recoverTexts` | `string[]` | 否 | `[]` | 可恢复错误文案（透传 `waitFor`，默认不因文案刷新，仅靠周期刷新） |
| `refreshEveryMs` | `number` | 否 | `25000` | 等待登录期间周期刷新间隔（毫秒） |
| `attempts` | `number` | 否 | `2` | 登录整体重试轮数（第二轮起先刷新页面重来） |
| `reclickAfterMs` | `number` | 否 | `8000` | 弹窗未按时出现时，补点入口前的等待毫秒数 |

**示例**：见第 4 章（三种场景各一份完整示例）。

**注意**

- 进页面先竞速 `loggedIn`/`loggedOut`（20s），已登录直接返回，不点任何按钮。
- 内部会先做扩展就绪检查（`ready`）：扩展未加载会快速失败，重试会重启浏览器窗口恢复。
- **静默连接**（扩展已授权站点，点了却不弹钱包弹窗）不判失败，以登录态为准。
- 失败最终抛 `登录未完成（等待已登录标志超时）`。

#### `signMessage(ctx, options?)`

**用途**：等一次钱包弹窗并完成**消息签名**（适用于自己控制流程的多签场景，如上传需两次签名）。

**签名**：

```ts
signMessage(ctx: TaskContext, options?: { reclick?: { selector: string; afterMs: number } }): Promise<{ popupFailed: boolean }>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `options.reclick.selector` | `string` | 否 | — | 弹窗没出现时补点的选择器（如提交按钮） |
| `options.reclick.afterMs` | `number` | 否 | — | 等 `afterMs` 毫秒弹窗仍未出现就补点一次 |

**返回值**：`{ popupFailed }` —— `true` 表示弹窗根本没出现（可能静默/无需签名），调用方按业务态判定，**不要直接当失败**。

**示例**：

```ts
for (let i = 0; i < 2; i++) {
  const { popupFailed } = await signMessage(ctx)
  if (popupFailed) ctx.log.info({ step: 'upload' }, '钱包弹窗未出现（可能文件已上传），继续等终态')
}
```

**注意**：作用于任务配置的钱包 `meta.wallet`——未配置会抛 `任务未配置钱包`；未注册的 key 抛 `未注册的钱包适配器: X`。

#### `confirmTransaction(ctx, options?)`

**用途**：等一次钱包弹窗并**确认交易**。签名与参数、返回值同 `signMessage`。

**签名**：

```ts
confirmTransaction(ctx: TaskContext, options?: { reclick?: { selector: string; afterMs: number } }): Promise<{ popupFailed: boolean }>
```

**示例**：

```ts
await click(ctx, '#mint-submit')
await confirmTransaction(ctx, { reclick: { selector: '#mint-submit', afterMs: 8000 } })
await waitFor(ctx, { selector: '.tx-success' }, { assert: true, budgetMs: 30000 })
```

**注意**：同 `signMessage`；`popupFailed: true` 时结合页面/链上结果判定，不要直接失败。

### 3.5 验证码（`src/api/captcha.ts`）

#### `clickTurnstile(ctx, options?)`

**用途**：处理交互式 Cloudflare Turnstile 人机验证**方框**（检测到方框即坐标点击；ISP 住宅 IP 一点即过）。站点的 v3 隐形评分由页面自行完成，任务不介入。

**签名**：

```ts
clickTurnstile(ctx: TaskContext, options?: {
  waitMs?: number
  selectors?: string[]
  maxAttempts?: number
}): Promise<boolean>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `options.waitMs` | `number` | 否 | 无 | 有值（>0）→ 在预算内轮询等待方框并点击；无值 → 单次检测点击 |
| `options.selectors` | `string[]` | 否 | Turnstile 默认选择器 | 覆盖方框 iframe 选择器（**仅 `waitMs` 未设置时生效**） |
| `options.maxAttempts` | `number` | 否 | `3` | 点击被瞬时拒绝时的重试次数（**仅 `waitMs` 未设置时生效**） |

**返回值**：执行了点击为 `true`；预算内/单次未检测到方框为 `false`。

**示例**：

```ts
// 点 Claim 后：方框 1–3s 内渲染即自动点击（预算 10s）
await click(ctx, '[role="dialog"] button:has-text("Claim")')
await clickTurnstile(ctx, { waitMs: 10000 })

// 单次检测点击（不等待）
if (await clickTurnstile(ctx)) ctx.log.info({ step: 'turnstile' }, '已点击方框')
```

**注意**

- 默认选择器：`div[data-turnstile-container] iframe:visible` + `iframe[src*="challenges.cloudflare.com"]:visible`；站点结构特殊时用 `selectors` 覆盖（但用 `waitMs` 时该字段不生效）。
- 点击走 CDP `Input.dispatchMouseEvent`（跨域 iframe 里 `page.mouse.click` 不生效）；被浏览器瞬时拒绝会自动重新取盒重试，非瞬时错误直接抛。
- 点不过通常是出口 IP 问题，不是任务逻辑问题。

### 3.6 数据与产物（`src/api/data.ts`）

#### `getAccount(ctx, column)`

**用途**：取数据源当前窗口行的列值（**严格**：缺行/缺列/空值都抛错）。

**签名**：`getAccount(ctx: TaskContext, column: string): Promise<string>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `column` | `string` | 是 | — | 数据源列名（表头），如 `'邮箱'`、`'metamask钱包地址'` |

**示例**：

```ts
const address = await getAccount(ctx, 'metamask钱包地址')
await fill(ctx, 'input[name="address"]', address)
```

**注意**：报错三形态——`数据源无当前窗口对应的行（窗口: X）` / `数据源缺少列: X（可用列: …）` / `数据源列 X 在窗口 Y 的行为空`。报错即任务失败，通常正是你想要的（数据没备齐就不该硬跑）。想「缺了用 faker 兜底」改用 `ctx.accountRow?.['邮箱'] || faker.internet.email()`。

#### `uploadFile(ctx, selector, value)`

**用途**：往 file 输入框设置文件。`value` 支持 **http(s) URL**（自动下载到临时文件）或**本地路径**。

**签名**：`uploadFile(ctx: TaskContext, selector: string, value: string): Promise<void>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `selector` | `string` | 是 | — | file input 选择器（取首个匹配） |
| `value` | `string` | 是 | — | 文件地址：`http(s)://...` 视为 URL 下载；否则按本地路径 |

**示例**：

```ts
await uploadFile(ctx, 'input[type="file"]', await getAccount(ctx, '图片地址')) // URL
await uploadFile(ctx, 'input[type="file"]', 'D:/avatars/my-avatar.png') // 本地路径
```

**注意**

- URL 下载失败抛 `图片下载失败: <url> (HTTP <状态码>)`；临时文件落在系统临时目录 `abc-uploads/`。
- 内部用 `setInputFiles`，不弹系统文件框，对 `display:none` 的隐藏 input 也可用（隐藏 input 用 `elementState(...) !== 'absent'` 判挂载，别用可见性等待）。

#### `takeScreenshot(ctx, name)`

**用途**：截当前视口存到产物目录；**容错**：失败只告警返回空串，不判任务失败。

**签名**：`takeScreenshot(ctx: TaskContext, name: string): Promise<string>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `name` | `string` | 是 | — | 文件名（不含扩展名），存为 `<name>.png` |

**示例**：`await takeScreenshot(ctx, 'checkin-success')`

**注意**

- **成功截图一律用它**：持续动画页面（倒计时/动态榜）会让 CDP 截图偶发挂起，直接 await 会把已成功的任务误报失败（真机教训，见第 6 章）。
- 目录为 `data/screenshots/<日期>/<比特窗口ID>/<任务key>/`；成功/失败截图框架还会自动补拍。

### 3.7 诊断（`src/api/diag.ts`）

#### `recordStep(ctx, name, fn)`

**用途**：包裹一步执行并记录耗时/成败，累积为运行时间线（失败诊断包会带上）。

**签名**：`recordStep<T>(ctx: TaskContext, name: string, fn: () => Promise<T>): Promise<T>`

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `name` | `string` | 是 | — | 步骤名（如 `'open-crate'`） |
| `fn` | `() => Promise<T>` | 是 | — | 要执行的异步函数，返回值原样透传 |

**示例**：

```ts
await recordStep(ctx, 'open-crate', async () => {
  await click(ctx, 'button:has-text("Open Free")')
  await race(ctx, [['modal', { text: 'What is inside?' }]], 6000)
})
```

**注意**：`fn` 抛错时先记录失败步骤（带错误信息）再**原样重抛**，不吞异常。

#### `getSteps(ctx)`

**用途**：取已记录的步骤时间线（浅拷贝）。**签名**：`getSteps(ctx: TaskContext): StepRecord[]`。

**返回值**：`StepRecord[]`，每项 `{ name, startMs, ms, ok, detail? }`（定义于 `src/automation/diag/recorder.ts`）。

**示例**：`ctx.log.info({ steps: getSteps(ctx).length }, '本次运行步骤数')`

**注意**：是运行内的时间线，排障时配合日志看；失败时框架会自动采集进诊断包。

### 3.8 AI 问答（`src/api/ai.ts`）

需在 `config/.env` 配 `AI_API_KEY`（OpenAI 兼容，默认 DeepSeek，见第 7 章配置速查）。未配置时 `ctx.ai` 为 `undefined`，`askAi`/`answerQuiz` 抛 `AI 未配置（AI_API_KEY）`；任务侧可先判空 `ctx.ai` 再决定是否调用。

#### `askAi(ctx, prompt, options?)`

**用途**：问 AI 要一段文本（可带 system 提示）。

**签名**：

```ts
askAi(ctx: TaskContext, prompt: string, options?: { system?: string; maxTokens?: number; timeoutMs?: number }): Promise<string>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `prompt` | `string` | 是 | — | 用户提问内容 |
| `options.system` | `string` | 否 | — | system 提示（约束输出格式等） |
| `options.maxTokens` | `number` | 否 | 客户端默认（300） | 输出上限 |
| `options.timeoutMs` | `number` | 否 | `cfg.ai.timeoutMs` | 请求超时毫秒 |

**返回值**：模型输出的文本（由 AI 客户端去除首尾空格）。

**示例**：

```ts
const summary = await askAi(ctx, '用一句话概括这段文本', { system: '只输出一句话' })
```

**注意**：`ctx.ai` 仅在配置了 `AI_API_KEY` 时注入；未配置时为 `undefined`，`askAi` 直接抛错，不静默返回空串。

#### `answerQuiz(ctx, spec)`

**用途**：页面选择题——读题干与选项文本 → 问 AI → 点击对应项；**解析不出答案时兜底随机点一项**（`fallback:true`，「答了就算成功」）。

**签名**：

```ts
answerQuiz(ctx: TaskContext, spec: {
  question: string | { selector: string }
  options: { selector: string }
  match?: 'letter' | 'index' | 'text'
}): Promise<{ answer: string; clicked: boolean; fallback: boolean }>
```

**参数**

| 名称 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `spec.question` | `string \| { selector }` | 是 | — | 题干文本；给 `{ selector }` 时经 `getText` 读取 |
| `spec.options.selector` | `string` | 是 | — | 选项元素选择器（全部匹配项按 DOM 顺序编号 A/B/C…） |
| `spec.match` | `'letter' \| 'index' \| 'text'` | 否 | `'letter'` | 让 AI 返回的答案格式：字母 / 1 基序号 / 选项文本 |

**返回值**：`{ answer, clicked, fallback }`——AI 原始答案、是否已点击、是否走了兜底随机。

**示例**：

```ts
const { fallback } = await answerQuiz(ctx, {
  question: '.question',
  options: '.option',
})
if (fallback) ctx.log.warn('AI 未给出可用答案，已随机作答')
```

**注意**

- 无匹配选项元素（`count() === 0`）时抛错，不做兜底。
- 答案越界或无法解析（含推理模型返回空 `content`）→ 随机点击一项并返回 `fallback:true`，任务不应把 `fallback` 当失败。

---

## 4. 钱包登录场景（`wallet` × `scenario`）

`loginWallet` 用 `scenario` 描述**站点连接入口的形态**，用 `wallet` 选择**钱包适配器**。三个场景：

| `scenario` | 适用站点 | 额外字段 | 说明 |
| --- | --- | --- | --- |
| `direct` | 点连接直接唤起扩展弹窗 | 无 | 如 Petra 点 Connect Wallet 直开 `prompt.html`；登录常走 `intents: ['sign']` |
| `dialog` | 点连接后先弹**站内**钱包选择对话框 | `confirm`（确认按钮）、`walletEntry`（钱包选择项） | 如 Konnex：Connect Wallet → Connect with Ethereum → MetaMask |
| `appkit` | 站点用 **AppKit（Reown）** 弹窗 | `entryTestId`（必填）；`open`、`modalTestId`（可选） | 框架做视图归一化后点钱包入口，如 DAC Inception |

`entryTestId` 是 AppKit 钱包选择项的 `data-testid`（如 `wallet-selector-io.metamask`）；`open` 缺省 `button:has-text("Connect Wallet")`。

### 4.1 direct（Petra，直接唤起扩展）

```ts
await loginWallet(ctx, {
  wallet: 'petra',
  scenario: 'direct',
  loggedIn: { text: '连接钱包' },
  loggedOut: '连接钱包',
  connect: 'button:has-text("连接钱包")',
  intents: ['sign'], // Petra 登录是签名（Sign In）
})
```

### 4.2 appkit（MetaMask，AppKit 归一化）

```ts
await loginWallet(ctx, {
  wallet: 'metamask',
  scenario: 'appkit',
  loggedIn: { text: 'Quantum Crate' },
  loggedOut: 'Enter Inception',
  connect: 'button:has-text("Enter Inception")',
  open: 'button:has-text("WALLET")', // 打开 AppKit 钱包列表
  entryTestId: 'wallet-selector-io.metamask', // 钱包选择项的 testid
  intents: ['connect'],
})
```

### 4.3 dialog（MetaMask，站内对话框后选钱包）

```ts
await loginWallet(ctx, {
  wallet: 'metamask',
  scenario: 'dialog',
  loggedIn: { text: 'Balance' },
  loggedOut: 'Connect Wallet',
  connect: '[data-testid="connect-wallet-button"]',
  confirm: 'text=Connect with Ethereum', // 站内对话框确认
  walletEntry: 'text=MetaMask', // 弹窗内钱包选择项（兼作补点）
  intents: ['connect'],
})
```

---

## 5. 常用配方

### 配方一：签到一条龙

适用：每天/每周固定时间开放签到、已签到有多种界面、钱包登录的站点。

```ts
import { openPage, loginWallet, click, hasText, race, runJs, takeScreenshot } from '../api'

async run(ctx: TaskContext): Promise<void> {
  await openPage(ctx, this.meta.url, { closeOtherTabs: true })
  await loginWallet(ctx, {
    wallet: 'metamask',
    scenario: 'dialog',
    loggedIn: { text: 'Balance' },
    loggedOut: 'Connect Wallet',
    connect: '[data-testid="connect-wallet-button"]',
    confirm: 'text=Connect with Ethereum',
    walletEntry: 'text=MetaMask',
    intents: ['connect'],
  })
  // 已签到两种界面（横幅 / 倒计时）任一即成功
  if (await hasText(ctx, 'Great job!')) return
  if (await hasText(ctx, 'RESETS IN')) return
  await click(ctx, 'button:has-text("Check in")')
  // 成功弹窗与已签到横幅可能先后出现，竞速判定
  const outcome = await race(ctx, [
    ['success', { text: 'Check-In Succeeded!' }],
    ['done', { text: 'Great job!' }],
  ], 30000)
  if (outcome === 'success' || outcome === 'done') {
    await takeScreenshot(ctx, 'checkin-success')
    return
  }
  throw new Error('点击签到后未出现成功/已签到状态')
}
```

### 配方二：领水（含数据源 + Turnstile 方框）

适用：有频率限制、要填邮箱、提交后弹 Turnstile 方框的水龙头。

```ts
import { openPage, click, fill, hasText, clickTurnstile, waitFor, takeScreenshot } from '../api'

async run(ctx: TaskContext): Promise<void> {
  await openPage(ctx, this.meta.url, { closeOtherTabs: true })
  if (await hasText(ctx, '已领取')) return // 今日已领 → 成功（幂等）
  if (await hasText(ctx, '维护中')) throw new Error('水龙头维护中')
  const email = ctx.accountRow?.['邮箱'] || faker.internet.email() // 数据源优先、faker 兜底
  await fill(ctx, 'input[name="email"]', email)
  await click(ctx, '#claim-btn')
  await clickTurnstile(ctx, { waitMs: 10000 }) // 方框 1–3s 渲染即点（预算 10s）
  await waitFor(ctx, { selector: '.success-toast' }, { assert: true, budgetMs: 30000 })
  await takeScreenshot(ctx, 'faucet-success')
}
```

### 配方三：钱包登录三种入口

见第 4 章三份完整示例。速查：

```ts
// direct：点 Connect 直接唤起扩展弹窗（Petra 常见）
scenario: 'direct', connect: 'button:has-text("Connect Wallet"):visible', intents: ['sign']

// dialog：站内钱包选择弹窗后再等扩展弹窗（Konnex）
scenario: 'dialog', confirm: 'text=Connect with Ethereum', walletEntry: 'text=MetaMask'

// appkit：AppKit(Reown) 弹窗，框架做视图归一化（DAC Inception）
scenario: 'appkit', open: 'button:has-text("WALLET")', entryTestId: 'wallet-selector-io.metamask'
```

### 配方四：多签上传（自己控制钱包动作）

适用：一个动作触发多次钱包签名（如 Shelby 上传：`register_multiple_blobs` → `commit_object`）。此时不声明登录，在流程里按需调 `signMessage`：

```ts
import { openPage, click, waitFor, signMessage, takeScreenshot } from '../api'

async run(ctx: TaskContext): Promise<void> {
  await openPage(ctx, this.meta.url, { closeOtherTabs: true })
  await click(ctx, '[role="dialog"] button:has-text("Upload")')
  for (let i = 0; i < 2; i++) {
    const { popupFailed } = await signMessage(ctx) // 每次签名一次弹窗
    if (popupFailed) ctx.log.info({ step: 'upload' }, '弹窗未出现（可能已上传），继续等终态')
  }
  await waitFor(ctx, { text: 'All files uploaded successfully' }, { assert: true, budgetMs: 180000 })
  await takeScreenshot(ctx, 'upload-success')
}
```

### 配方五：Turnstile 方框单独处理

```ts
import { click, clickTurnstile, hasText } from '../api'

await click(ctx, 'button:has-text("Submit")')
if (await clickTurnstile(ctx, { waitMs: 10000 })) {
  ctx.log.info({ step: 'turnstile' }, '已点击人机验证方框')
}
// 方框点不过通常是出口 IP 问题：换 ISP 住宅 IP 窗口；站点自身 token 超时按可恢复错误刷新（recoverTexts: RECOVER_TEXTS）
```

### 已领取 / 限频收敛

站点限频提示分两种语义，判定必须分开：

```ts
// 已领取（今日额度用完，如 Daily limit reached / 24 hours）→ 直接成功返回
if (await hasText(ctx, 'Daily limit reached')) return
// 冷却中（距上次未满 N 小时，如 Please wait 30 minutes）→ 抛错失败，靠重试退避覆盖冷却
if (await hasText(ctx, 'Please wait')) throw new Error('领取冷却中')
```

千万不要把冷却中当成功，否则整轮虚报。重跑幂等：已领取一律视为成功。

### 选择器查找技巧

- 用浏览器 DevTools：右键元素 → Copy → Copy selector；优先 `data-testid` 与语义属性（`name`/`type`/`role`），其次稳定 class，最后才是结构路径。
- 不要用 `:nth-child` 深路径与框架随机 class（改版即失效）。
- 断言元素选「成功后才会出现」的标志（徽章/文案），宁严勿松；多步骤表单用等待下一步元素出现代替固定 `sleep`。
- 同文案多个按钮时加 `:visible` 或更具体的容器限定。

---

## 6. 排错与真机经验

### 6.1 报错速查表

任务失败时，看板行内错误与日志里能找到下列关键词。文案均取自仓库当前代码。

| 报错关键词 | 含义 | 常见原因 | 解决 |
| --- | --- | --- | --- |
| `页面加载失败，第 3/3 次` | 打开网页失败（日志警告，每次重试一条） | 站点挂了/超时、代理 IP 不通、网址写错 | 第 3 次会把真实原因抛出（`openPage`）；看日志原始错误与失败截图，核对 url 与窗口代理 |
| `点击失败` / 元素定位不到 | 想点的元素没找到 | 选择器写错、页面没加载完就点、站点改版 | 回 `meta.sourceUrl` 用 DevTools 重取选择器（见 6.2） |
| `waitFor` 超时（断言失败） | 等成功标志超时未出现 | 操作其实失败、断言元素选错、渲染慢 | 拉长 `budgetMs`、换成「成功后才会出现」的标志、看失败截图 |
| `图片下载失败: <url> (HTTP <状态码>)` | 上传图片 URL 下载失败 | 地址失效/404/需登录 | 换可用地址或本地路径；核对数据源「图片地址」列 |
| `数据源无当前窗口对应的行（窗口: X）` | 严格取数时表里没这个窗口的行 | 数据源没填该窗口；填了窗口名但改名了 | 补行；按窗口 ID 填更稳（见 3.6） |
| `数据源缺少列: X（可用列: …）` | 表头没这个列名 | 列名拼写/大小写不一致 | 按报错「可用列」核对拼写 |
| `数据源列 X 在窗口 Y 的行为空` | 单元格是空的 | 忘了填 | 补数据；想「缺了就用 faker」改用 `ctx.accountRow` |
| `任务未配置钱包` | 调钱包动作但没配 `meta.wallet` | meta 漏了 wallet | 补 `wallet`；或该任务本就不该用钱包动作 |
| `未注册的钱包适配器: X` | `meta.wallet` 的 key 没人认领 | key 拼错或没在 `src/app.ts` 注册 | 核对 key 与注册列表（见第 4 章） |
| 钱包弹窗未出现（`popupFailed` / 登录超时） | 等钱包弹窗超时 | 未配/未注册 wallet；站点要先点连接按钮；扩展未加载；静默连接 | `loginWallet` 内部会先做扩展就绪检查（扩展未加载会快速失败，重试重启窗口恢复）；确保先点连接；静默连接以登录态为准（见 6.3） |
| `窗口 X 钱包扩展未加载（重试将重启浏览器窗口）` | 钱包就绪检查探测扩展未加载 | 窗口实例异常/扩展未启用 | 等重试重启窗口恢复；连续出现检查比特窗口扩展安装 |
| `MetaMask 已锁定且未配置解锁密码` | 弹窗停在解锁页但没配密码 | `WALLET_PASSWORDS` 漏了该类型 | 在 `config/.env` 的 `WALLET_PASSWORDS` 配置密码 |
| `MetaMask 解锁失败（密码错误或解锁页未离开）` | 密码错或解锁页没走 | 密码错 | 核对 `WALLET_PASSWORDS` |
| `AppKit 弹窗未出现 X 钱包入口` | AppKit 视图异常，归一化没命中 | 站点改版/渲染异常/`entryTestId` 错 | 核对 `entryTestId` 与站点当前 AppKit 视图（见第 4 章） |
| `任务 X 超时` | 单次运行超过 `timeoutSec` | 卡死；某等待超时太长 | 核对各等待超时；必要时上调 `meta.timeoutSec` 或 `execution.taskTimeoutMs` |
| `任务已停用` | 手动触发被拒（409） | 开关关着 | 面板打开开关（立即生效） |
| `任务未注册` | 队列有 key 但框架找不到任务 | key 拼错/没在 `src/tasks/index.ts` 注册 | 核对 key 与注册数组 |
| `窗口熔断` | 该窗口连续失败太多，剩余任务全 skip | 前面任务终态失败把熔断计数顶到阈值 | 先修失败任务；面板「窗口」页「重置熔断」（见 6.4）；每日 23:59 也会自动重置（见第 7 章） |
| `窗口超时` | 单窗口会话到点（默认 15 分钟） | 窗口任务太多/某任务跑太久 | 精简窗口任务；查耗时异常；上调 `execution.windowTimeoutMs` |
| 开窗失败 | 比特窗口打不开，整轮任务全 skip | 比特客户端未登录/API 不可达；窗口 ID 不存在 | 设置页「测试连接」；核对窗口 ID |
| CDP 连接失败 | 窗口开了但接管失败，整轮 failed | 调试端口/内核异常 | 看日志与截图；重启比特客户端后重试 |

### 6.2 选择器失效

- **症状**：元素定位不到 / `waitFor` 超时。
- **对策**：`meta.sourceUrl` 记录了选择器当初从哪个页面确认；站点改版时回来源页用 DevTools 重取，优先换 `data-testid` 与语义属性，避免深路径与随机 class。

### 6.3 钱包弹窗不出现

- **症状**：`loginWallet` 登录超时，或 `signMessage`/`confirmTransaction` 返回 `popupFailed: true`。
- **对策**：
  1. 检查 `meta.wallet` 的 key 是否已注册（未注册报 `未注册的钱包适配器: X`）；
  2. 登录流程内部会先做扩展就绪检查（`ready`）：扩展未加载会快速失败，等重试重启窗口恢复，比空等高效；
  3. 用 DevTools 查看弹窗实际 URL，对照适配器 `extensionUrlPatterns` 是否匹配；
  4. 若站点要先点「连接」按钮才弹窗，确保 `LoginSpec.connect` 正确；
  5. **静默连接**：扩展已授权站点时可能不弹窗——以登录态判定，不要当失败。

### 6.4 熔断触发与重置

- 窗口任务终态失败时 `circuitBreakerCount + 1`；计数 ≥ `execution.circuitBreakerThreshold`（默认 2）后触发熔断，该窗口后续任务直接 `skipped`。
- **自动重置**：每日 `execution.circuitBreakerResetAt`（默认 `23:59`，时区 `scheduler.timezone`）到点自动归零所有窗口的熔断计数；设为空串 `""` 关闭（见第 7 章）。
- 其他重置途径：任一任务成功后自动清零；面板「窗口」页「重置熔断」（`POST /api/profiles/:id/breaker/reset`）。

### 6.5 截图与日志位置

- **截图**：`data/screenshots/<日期>/<比特窗口ID>/<任务key>/`；看板批次明细可点开截图。
- **日志**：`data/logs/app.log`（当天）+ `data/logs/app.log.<日期>`（按天滚动，保留 `storage.logRetainDays` 天，默认 7）；级别由 `storage.logLevel` 控制，控制台同步输出。
- **运行状态**：`pending → running → success | failed | retry_wait → …`，`skipped` = 开窗失败 / 窗口超时 / 熔断跳过。

### 6.6 失败自动诊断包

任务失败时（含重试前每次尝试），框架自动采集当前窗口的排障上下文并落盘，面板看板失败行点「诊断」即可查看，不必先翻日志文件。

- **采集内容**：失败时的页面 URL、页面可见文本（截前 2000 字）、弹窗文本（`[role="dialog"]` 截前 1000 字）、步骤时间线（`recordStep` 记录的每步耗时与成败）、错误信息、窗口名与任务 key；另有失败截图。
- **落盘位置**：`data/screenshots/<日期>/<比特窗口ID>/<任务key>/<日期>-attempt<n>.diag.json`（与截图同目录，`attempt<n>` 对应第 n 次尝试）；路径记在该 run 的 `runs.diag_path`。
- **面板入口**：看板批次明细的失败行（`status=failed`）「诊断」按钮，弹窗展示错误 / URL / 步骤时间线 / 弹窗文本 / 页面文本，并可跳转失败截图。
- **接口**：`GET /api/diagnostics/:runId` 按 run id 返回诊断包 JSON（DiagBundle）；run 不存在、无诊断或文件不可读统一 404（业务码 `40408`）。
- **不影响成败**：采集全程 best-effort，采集或写盘异常只告警，绝不改变任务成功/失败结果，也不计入熔断。

### 6.7 真机经验（合并自原《真机踩坑录》）

**1）真机核实是唯一标准，选择器先猜后验**

- SPA 静态 HTML 看不到登录后内容：初始选择器必然靠猜，写完立刻 `task:run` 单窗口真跑，按截图/日志迭代。
- 真机核实结论必须写进任务文件头注释 + `meta.note`（含核实日期）。
- 每个断言失败都有截图，先看图再改码。

**2）登录态判定：别用全页文本**

- 首页表格/数据可能全是 `0x` 开头内容（区块链站常见）——全页文案判定必误判（`hasText` 尤其危险）。
- 正确做法：用**范围选择器**（如 `header button:has-text("0x")`）作探针，交给 `loginWallet` 竞速（已登录/未登录谁先可见）或 `race`；不要自己写全页文本判断。
- SPA 渲染有 0-3s 延迟，首轮竞速至少 20 秒。

**3）钱包弹窗三个坑**

1. **静默连接**：扩展已授权的窗口点 Connect 后可能根本不弹钱包弹窗——以页面登录态为准，不能判失败（登录流程已容忍静默连接）。
2. **弹窗渲染慢 / 点击未注册**：高并发 + 慢代理下弹窗可能 30s+ 不出。对策：预算放宽到 45s+；用 `reclick` 补点（弹窗遮罩出现说明点击已生效，补点前确认目标按钮仍可见，避免误点遮罩）；每轮等待都要打日志，别静默循环。
3. **网络切换**：任务上线前真机确认钱包网络是否在目标链；若站点不自动切链，需在钱包扩展 UI 加切链步骤。

**4）文件上传两个坑**

1. **隐藏 file input**：`display:none` 的 input 不能用可见性等待，用挂载判定（`elementState(...) !== 'absent'` 轮询）；`uploadFile` / `setInputFiles` 对隐藏 input 可用。
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
- 熔断修复后可 `POST /api/profiles/:id/breaker/reset` 复位；熔断每日 23:59 也会自动重置（`execution.circuitBreakerResetAt`，见第 7 章）。
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

1. **卡片渲染延迟**：goto 后 SPA 数据异步加载，约 1s 后签到卡片才渲染——`openPage → 立即判定` 会假报「按钮不存在」。判定前先**循环等待卡片状态出现**（按钮或已签到信号任一），预算 45s，每轮打日志。
2. **「已签到」不止一种界面**：konnex 当周已签到时按钮消失，卡片先显示 "Great job!" 横幅，用户点 Close 后变暗态 "RESETS IN <倒计时>"——**两种状态都要算成功**，否则用户手动关横幅后批量运行会整批误报失败。做法：`#卡片:has-text("Great job!")` / `:has-text("RESETS IN")` 任一命中即已签到。
3. **签到成功判定用竞速而不是单断言**：点按钮后成功弹窗与已签到横幅可能先后出现，用 `race` 两者任一命中即成功；竞速漏检再兜底查一次已签到状态。
4. **成功截图必须容错**：站点页面有持续动画（倒计时/动态榜）时 CDP 截图会偶发 30s 超时挂起，成功截图若直接 await 会把已成功的签到误报失败（窗口 89 实测）。**成功截图一律用 `takeScreenshot`**（它失败只告警、返回空串），签到成功的唯一判定是弹窗/卡片状态。

**10）2026-10-09 薄门面重构真机纪实（替换中暴露的两个回归）**

1. **`waitFor` 文案命中必须按「存在」而非「可见」**：旧 `waitForTextRecover` 用 `count>0`；重构一度用 `.first().isVisible()`，站点双 DOM/动画态下首元素不可见即误判超时（portal-rhuna 实测：诊断包 `visibleText` 已有 "Daily Check-in"，任务却报「未出现」）。现 `{ text }` 探针按存在判定、`{ selector }` 探针按可见判定（见 3.3）。
2. **Turnstile 方框点击必须走 CDP `Input.dispatchMouseEvent`**：跨域 iframe 里 `page.mouse.click` 直跳单点不生效；现 `clickPoint`（`src/automation/dom/click.ts`）用 CDP 分步移动 + 按下/抬起派发。
3. **失败时先看诊断包、别只翻日志**：失败自动落盘 URL/页面文本/步骤/错误；Turnstile 未检测到时会额外记录页面全部 iframe 及其尺寸（`iframes:[]` 即页面当时根本没有方框），面板看板失败行点「诊断」即可查（见 6.6）。
4. **站点侧问题要与代码问题分开**：官方下线/站点服务端渲染报错（如 `We couldn't render this page`）会导致固定失败，属站点环境，不是任务逻辑；连续失败按第 5 条停手求助，别反复重跑。

---

## 7. 配置速查（`config.json` / `.env`）

任务代码里不需要写这些配置，它们是**框架级配置**，改完重启 `npm run dev` 生效。配置以 `src/infrastructure/config.ts` 为唯一真值，本节只做速查；真实密钥只写 `config/.env`（gitignore），示例值见 `config/.env.example`。

**三层配置，后者覆盖前者**：代码默认值 → `config/config.json`（通用，已提交）→ `config/config.local.json`（本机覆盖，gitignore）→ 环境变量（`config/.env`，优先级最高）。配置文件只需写与默认不同的差异项。

| 段 | 键（括号内为默认值） | 说明 |
| --- | --- | --- |
| `bitbrowser` | `apiBase`（`http://127.0.0.1:54345`）、`openTimeoutMs`、`maxRetries`、`retryBackoffMs` | 比特浏览器本地 API；只有端口/地址改过才需要动 |
| `execution` | `staggerMaxSec`（120 秒）、`windowTimeoutMs`（900000）、`taskTimeoutMs`（180000）、`retryMax`（2）、`retryBackoffSec`（600）、`circuitBreakerThreshold`（2）、`maxConcurrentWindows`（4）、**`circuitBreakerResetAt`（`"23:59"`）** | 执行引擎全局默认值（任务级可覆盖部分字段，见第 2 章）。`circuitBreakerThreshold` 是连续失败达阈值即熔断；`circuitBreakerResetAt` 是熔断**每日自动重置时刻**（本地 `HH:mm`，空串 `""` 关闭），时区沿用 `scheduler.timezone`；`maxConcurrentWindows` 是全局开窗上限（与任务级 `concurrency` 双闸门取更严者） |
| `scheduler` | `timezone`（`Asia/Shanghai`） | 定时计划与熔断每日重置统一按此时区的墙上时钟 |
| `ai` | `provider`（`openai-compatible`）、`apiBase`（`https://api.deepseek.com`）、`model`（`deepseek-flash`）、`apiKey`（空）、`timeoutMs`（30000） | AI 能力（`askAi`/`answerQuiz`，见 3.8）：OpenAI 兼容接口，默认 DeepSeek。**密钥只写 `config/.env` 的 `AI_API_KEY`**，`config.json` 的 `apiKey` 必须留空 |
| `web` | `host`（`127.0.0.1`）、`port`（3000） | 后端 API 监听；端口一般用环境变量 `WEB_PORT` 覆盖 |
| `wallet` | `passwords`（`{}`） | 钱包解锁密码映射（key 为钱包类型）；一般用环境变量 `WALLET_PASSWORDS`（JSON）配置 |
| `dataSource` | `path`（`config/accounts.xlsx`） | 账号/素材数据源 Excel，每个窗口按行领取 |
| `storage` | `dbPath`、`screenshotDir`、`logDir`、`logLevel`、`logRetainDays`（7）、`dbRetainDays`（90）、`screenshotRetainDays`（90） | 本地 SQLite、截图与日志的路径与保留天数 |

**环境变量覆盖**（写在 `config/.env`，优先级最高）：

| 变量 | 覆盖 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | `ai.apiKey` | AI 接口密钥（**只进本机 `.env`，绝不提交**） |
| `AI_API_BASE` | `ai.apiBase` | 可选：OpenAI 兼容根地址 |
| `AI_MODEL` | `ai.model` | 可选：模型 id |
| `CIRCUIT_BREAKER_RESET_AT` | `execution.circuitBreakerResetAt` | 可选：熔断每日重置时刻（`HH:mm`，`""` 关闭） |
| `WALLET_PASSWORDS` | `wallet.passwords` | JSON 映射 `{"metamask":"密码","petra":"密码"}`，同类型钱包共用一个密码 |
| `WEB_PORT` | `web.port` | 后端 API 端口（Vite 代理自动跟随） |
| `VITE_PORT` | — | 前端 Vite 面板端口（前端也读同一份 `.env`） |
| `BITBROWSER_API_BASE` | `bitbrowser.apiBase` | 可选：比特浏览器 API 地址 |

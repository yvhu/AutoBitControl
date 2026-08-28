# AutoBitControl API 使用手册

本文档是 AutoBitControl 的任务开发手册，覆盖任务模型（`TaskMeta`）、运行时上下文（`TaskContext`）、拟人化输入（`Humanizer`）、钱包弹窗、验证码、调度与排错。所有签名与默认值以仓库当前代码为准。

配套资源：

- 面板「文档」页在线渲染本手册；「任务示例」页展示三个带逐行注释的示例任务源码。
- 示例任务位于 `src/tasks/`：`example-checkin.ts`（签到）、`faucet-example.ts`（领水）、`mint-example.ts`（铸币）。
- 新增任务从复制 `src/tasks/example-checkin.ts` 改起最快。

---

## 1. 快速开始

新增一个签到任务共 5 步：

**第 1 步：建文件** `src/tasks/my-checkin.ts`。

**第 2 步：写 meta**（任务元信息，字段含义见第 2 章）。

**第 3 步：写 run**（任务流程，可用方法见第 3 章）。

**第 4 步：注册** 在 `src/tasks/index.ts` 的 `ALL` 数组中加入实例。

**第 5 步：面板验证** 重启服务（`npm start`）→ 面板「任务」页应出现新任务卡片（含分类徽章、来源页、备注）→ 点「立即触发」手动跑一次 → 看板查看结果与截图。

完整最小任务代码：

```ts
import { SiteTask, TaskContext, type TaskMeta } from './base'

export class MyCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'my-checkin',        // 全局唯一，API 与数据库都用它标识任务
    name: '我的签到',          // 面板显示名
    url: 'https://example.com/', // 任务入口页（从这里开始）
    wallet: 'metamask',       // 登录用的钱包适配器 key
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()                              // 打开 url（失败自动重试 3 次）
    await ctx.loginByWallet()                     // 等钱包弹窗 → 解锁 → 连接
    await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' }) // 点击 + 断言成功标志
  }
}
```

`src/tasks/index.ts` 注册：

```ts
import { ExampleCheckinTask } from './example-checkin'
import { MyCheckinTask } from './my-checkin'
// ...

const ALL: SiteTask[] = [new ExampleCheckinTask(), new MyCheckinTask()]
```

注意：`url` 为空字符串的任务不会参与调度（见第 7 章），只能在面板手动触发——示例任务正是如此。

### 任务开发与测试

新任务或改动选择器后，按三层流程验证（从快到真，逐层递进）：

1. **fixture 集成测试**：参考 `tests/task-base.test.ts` 的模式（注入假驱动，秒级反馈）。把选择器换成本地 fixture 页面先验证流程逻辑，不依赖真实站点与窗口。
2. **单窗口单任务真实验证**：`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run`——只开一个窗口、只跑指定任务、打印结果后退出（脚本：`scripts/run-task.ts`），比面板全量触发轻量。
3. **面板验证**：面板看板行级「执行」（单窗口单任务）或任务页「立即触发」（全部启用窗口），人工核对截图与日志。

示例任务默认 `enabled: false`（不参与日常执行），调试时把代码改为 `true` 并重启服务、直接在面板任务页打开开关（立即生效，无需重启），或用第 2 层的 `task:run` 脚本（不受开关限制）。

---

## 2. TaskMeta 字段全解

`TaskMeta` 定义于 `src/engine/task.ts`。除 `key`/`name`/`url` 必填外，其余均可选，未填时使用默认行为（默认值列注明）。

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `key` | `string` | 无（必填） | 全局唯一标识。API 路由（`/api/tasks/:key/trigger`）、数据库 runs 表、调度器都用它 |
| `name` | `string` | 无（必填） | 面板任务页显示名 |
| `url` | `string` | 无（必填，可为 `''`） | 站点入口页 URL，`goto()` 从这里开始。空串 → 调度器跳过，仅可手动触发 |
| `sourceUrl` | `string?` | `undefined` | 信息来源页：记录选择器是从哪个页面确认的，站点改版时回这里重查（排错见第 9 章） |
| `note` | `string?` | `undefined` | 备注，面板任务页直接可见，记录站点的坑与特殊逻辑 |
| `category` | `'checkin' \| 'faucet' \| 'mint' \| 'other'` | `undefined` | 面板显示对应颜色徽章 |
| `lastUpdated` | `string?` | `undefined` | 最后核对站点的日期（文档约定，如 `'2026-08-28'`） |
| `deprecated` | `boolean?` | `false` | `true` → 调度器跳过该任务并告警（仅能手动触发） |
| `enabled` | `boolean?` | `true` | 任务开关的代码默认值：`false` → 调度器跳过、窗口「立即跑」排除、手动触发接口返回 409。面板任务页开关写入云端 `task_states` 表覆盖（立即生效——停用即停 cron、重新启用即重注册 cron，无需重启；跨机器生效、重启保留） |
| `schedule` | `string \| { stagger: [string, string] }` | `undefined` | cron 字符串或错峰窗口；缺省则不参与调度（见第 7 章） |
| `wallet` | `string?` | `undefined` | 钱包适配器 key（`'metamask'`/`'petra'`），`loginByWallet()` 按此查找适配器（见第 4 章） |
| `timeoutSec` | `number?` | `180` | 单次运行超时秒数；默认取全局 `execution.taskTimeoutMs / 1000`，超时抛 `任务 X 超时` |
| `retry` | `{ max: number; backoffSec: number }?` | `{ max: 2, backoffSec: 600 }` | 失败重试次数与间隔秒数；默认取全局 `execution.retryMax`/`execution.retryBackoffSec` |
| `captcha` | `{ auto?: boolean; maxCost?: number }?` | `{ auto: true }` | 验证码处理（见第 5 章）。`auto` 控制调用 `solveCaptcha()` 时是否实际打码；`maxCost` 是声明性字段——当前代码中费用上限统一由 `config.json` 的 `captcha.maxCostPerTask` 全局控制，任务级 `maxCost` 仅作预算记录，不参与运行时判断 |

字段齐全的示例（摘自 `src/tasks/example-checkin.ts`）：

```ts
meta: TaskMeta = {
  key: 'example-checkin',
  name: '示例签到',
  url: '',
  sourceUrl: '',
  note: '示例任务，未配置真实 url，仅手动触发演示',
  category: 'checkin',
  lastUpdated: '2026-08-28',
  schedule: { stagger: ['09:00', '11:00'] },
  wallet: 'metamask',
  timeoutSec: 180,
  retry: { max: 2, backoffSec: 600 },
  captcha: { auto: true, maxCost: 1500 },
}
```

**错峰写法**：`{ stagger: ['09:00', '11:00'] }` 表示每天在 9 点到 11 点之间随机取一个分钟级时间点执行（含两端）。时间点每日 00:01 重新随机（进程启动时定一次，重启与每日刷新都会重新随机），支持跨天窗口——结束时间早于开始时间视为跨天（如 `['23:00', '01:00']` 随机落在当晚 23:00-24:00 或次日 00:00-01:00）。

**cron 写法**：5 段式 `分 时 日 月 周`，由 croner 解析，时区取 `execution.timezone`（默认 `Asia/Shanghai`）：

- `'0 9 * * *'` — 每天 9:00
- `'30 8 * * 1'` — 每周一 8:30
- `'0 */4 * * *'` — 每 4 小时一次
- `'15 10 * * 1-5'` — 工作日 10:15

---

## 3. TaskContext 方法全解

`TaskContext` 定义于 `src/engine/task-context.ts`，是 `run(ctx)` 的全部操作入口。另有只读访问器：`ctx.page`（patchright `Page`）、`ctx.human`（`Humanizer`，见第 6 章）、`ctx.profile`（窗口行 `ProfileRow`）。

### goto

```ts
async goto(url?: string): Promise<void>
```

打开页面。`url` 缺省时取 `meta.url`；两者皆空抛 `任务未配置 url`。内部行为：

- `page.goto(target, { timeout: 45000, waitUntil: 'domcontentloaded' })`，随后拟人停顿 0.8s-3s。
- **失败自动重试 3 次**，每次间隔 2s-5s；第 3 次仍失败则原样抛出，任务进入失败/重试流程。

```ts
await ctx.goto()                    // 打开 meta.url
await ctx.goto('https://a.com/b')   // 打开指定页（适合流程中的跳转）
```

### clickCheckin

```ts
async clickCheckin(selector: string, opts?: { assert?: string; assertTimeoutMs?: number }): Promise<void>
```

拟人点击（见第 6 章 `Humanizer.click`），点击后若给了 `assert`，等待该元素可见。`assertTimeoutMs` 默认 `10000`。

| 参数 | 含义 |
| --- | --- |
| `selector` | 点击目标选择器 |
| `opts.assert` | 点击后应出现的成功标志元素；断言失败抛 `断言超时: 元素 X 未出现` |
| `opts.assertTimeoutMs` | 断言等待时长（毫秒），默认 10000 |

```ts
await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
await ctx.clickCheckin('#claim-btn', { assert: '.success-toast' })
```

### assertVisible

```ts
async assertVisible(selector: string, timeoutMs = 10000): Promise<void>
```

等待 `locator(selector).first()` 可见；超时抛 `断言超时: 元素 X 未出现`。适合等待异步结果（如链上交易确认）：

```ts
await ctx.assertVisible('.tx-success', 30000)
```

### typeInto

```ts
async typeInto(selector: string, text: string): Promise<void>
```

拟人输入：先点击聚焦，逐键输入（每键 40-130ms 随机延迟，约 3% 概率错键回删重输，见第 6 章）。

```ts
await ctx.typeInto('input[name="email"]', faker.internet.email())
```

### solveCaptcha

```ts
async solveCaptcha(): Promise<'none' | 'solved' | 'failed'>
```

处理验证码，详见第 5 章。返回语义：

- `'none'` — 未注入验证码服务、`captcha.auto` 为 false、或页面上未检测到验证码。
- `'solved'` — 检测到并解题成功（token 已回填页面）。
- `'failed'` — 类型上存在，但实现中失败一律抛 `CaptchaFailure`（任务进入 `captcha_failed`，见第 5/8 章）。

### screenshot

```ts
async screenshot(name: string): Promise<string>
```

截当前视口保存为 `${name}.png`（`fullPage: false`），返回绝对路径。存档目录为 `data/screenshots/<日期>/<比特窗口ID>/<任务key>/`。

```ts
await ctx.screenshot('faucet-success')
```

### loginByWallet

```ts
async loginByWallet(): Promise<void>
```

等待站点唤起钱包弹窗并完成连接，详见第 4 章：

1. 取 `meta.wallet` 作为适配器 key（未配置抛 `任务未配置钱包`）。
2. 从 `WalletRegistry` 取适配器（未注册抛 `未注册的钱包适配器: X`）。
3. `waitForPopup(context, adapter.extensionUrlPatterns, 15000)` 等待弹窗（15 秒超时，未出现抛 `钱包弹窗未出现`）。
4. 若该窗口配置了钱包解锁密码（`WALLET_PASSWORDS` 环境变量映射，见第 4 章）且适配器实现了 `unlock`，先解锁。
5. `adapter.ensureConnected(popup)` 点连接/确认按钮。

### textPresent

```ts
async textPresent(text: string): Promise<boolean>
```

页面上是否存在该文本（`getByText(text, { exact: false })`，包含即命中）：

```ts
if (await ctx.textPresent('已领取')) return        // 已领过 → 直接成功
if (await ctx.textPresent('维护中')) throw new Error('水龙头维护中')
```

### urlIncludes

```ts
async urlIncludes(part: string): Promise<boolean>
```

当前 URL 是否包含指定子串：

```ts
if (await ctx.urlIncludes('/dashboard')) { /* 已登录，跳过登录 */ }
```

### 选择器查找技巧

- 用浏览器 DevTools：右键目标元素 → Copy → Copy selector。
- **优先** `data-testid`（如钱包弹窗内部按钮）与语义属性（`name`、`type`、`role`），其次稳定 class，最后才是结构路径。
- **稳定选择器原则**：不要用 `:nth-child` 深路径与前端框架生成的随机 class（改版即失效）；断言元素选「成功后才会出现」的标志（徽章/文案），宁严勿松。
- 多步骤表单用 `assert` 等待下一步元素出现，不要写固定 `sleep`。

---

## 4. 钱包弹窗

### 任务级钱包配置

`meta.wallet` 指定适配器 key（目前内置 `'metamask'` 与 `'petra'`），`loginByWallet()` 按此查找。任务未配置 wallet 时调用会抛 `任务未配置钱包`。

### 窗口级密码配置

钱包解锁密码是**窗口级**的，通过环境变量 `WALLET_PASSWORDS` 配置（JSON 字符串，映射比特窗口 ID → 密码）：

```env
# config/.env（或部署环境变量）
WALLET_PASSWORDS={"bb-1001":"钱包解锁密码","bb-1002":"另一个密码"}
```

也可以在 `config/config.json` / `config/config.local.json` 的 `wallet.passwords` 对象中配置：

```json
{
  "wallet": { "passwords": { "bb-1001": "钱包解锁密码" } }
}
```

两者并存时环境变量覆盖同名 key。**修改后需重启服务生效**。密码 key 取窗口的比特浏览器窗口 ID（面板「窗口」页可见）。仅当窗口配置了密码时，`loginByWallet` 才会调用适配器的 `unlock`。

### 弹窗识别机制

适配器通过 `extensionUrlPatterns`（URL 正则数组）声明自己的弹窗页面：

| 适配器 | key | URL 正则 |
| --- | --- | --- |
| MetaMask | `metamask` | `chrome-extension://.*/home.html`、`chrome-extension://.*/notification.html`、`metamask://` |
| Petra | `petra` | `chrome-extension://.*/index.html`、`chrome-extension://.*/popup.html` |

`waitForPopup(context, patterns, timeoutMs)`（`src/automation/wallet/popup.ts`）的实现：用 `new RegExp(pattern).test(page.url())` 匹配；先查已打开的页面，再监听 context 的 `page` 事件，同时每 100ms 轮询一次，超时返回 `null`。`loginByWallet` 传入 15 秒超时。

弹窗内操作通过 `PopupPage` 接口（`getByRole`/`getByTestId`/`locator`/`waitForEvent`）完成：

- MetaMask `unlock`：`getByTestId('unlock-password')` 填密码 → `unlock-submit` 点击 → 等 `close` 事件（15s）。
- `ensureConnected`：最多 3 轮，按角色正则（`/connect|next|confirm|approve|sign/i`，Petra 另含 `unlock`）找按钮点击，每轮等 `close` 事件 5 秒，弹窗关闭即视为完成。

### 新增钱包适配器步骤

**第 1 步** 实现 `WalletAdapter` 接口（`src/automation/wallet/types.ts`）：

```ts
import type { WalletAdapter, PopupPage } from './types'

export class PhantomAdapter implements WalletAdapter {
  key = 'phantom'
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html']

  async unlock(popup: PopupPage, password: string): Promise<void> {
    await popup.getByTestId('unlock-password').fill(password)
    await popup.getByTestId('unlock-submit').click()
    await popup.waitForEvent('close', { timeout: 15000 })
  }

  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = popup.getByRole('button', { name: /connect|confirm|approve/i })
      await btn.first().click({ timeout: 8000 })
      const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
      if (closed) return
    }
  }
}
```

**第 2 步** 在 `src/app.ts` 注册：

```ts
const wallets = new WalletRegistry()
wallets.register(new MetaMaskAdapter())
wallets.register(new PetraAdapter())
wallets.register(new PhantomAdapter())
```

**第 3 步** 任务 `meta.wallet = 'phantom'`。

---

## 5. 验证码

### 支持类型与 yescaptcha 类型映射

检测器（`src/integrations/yescaptcha.ts`）支持 5 种类型，映射（`config.json` 的 `captcha.taskTypes`，默认可覆盖）：

| 类型 | 检测 iframe | yescaptcha 任务类型 | 估算费用（点） |
| --- | --- | --- | --- |
| `turnstile`（Cloudflare） | `iframe[src*="challenges.cloudflare.com"]` | `TurnstileTaskProxyless` | 25 |
| `recaptcha_v2` | `iframe[src*="recaptcha/api2/anchor"]` | `NoCaptchaTaskProxyless` | 15 |
| `recaptcha_v3` | 无 iframe（需业务侧处理） | `RecaptchaV3TaskProxyless` | 20 |
| `hcaptcha` | `iframe[src*="hcaptcha.com/captcha"]` | `HCaptchaTaskProxyless` | 30 |
| `image` | 手动场景 | `ImageToTextTask` | 4 |

费用仅为估算（`ESTIMATED_COST_POINTS`），用于每次打码的日志统计（`logCaptcha`，看板「验证码」卡片汇总）。sitekey 从 iframe src 的 `k=`/`sitekey=` 参数或页面 `data-sitekey` 属性读取；检测每 300ms 轮询一次，最多 5 秒，没检测到返回 `none`。

### auto 配置

`meta.captcha.auto`（默认 `true`）控制 `solveCaptcha()` 调用时是否实际打码：`auto: false` 时直接返回 `'none'`，不产生费用。**打码只发生在任务显式调用 `ctx.solveCaptcha()` 的位置**——框架不会在 `goto` 后自动打码。任务应在验证码可能出现的位置（通常就在点击提交按钮之前）调用一次：

```ts
await ctx.typeInto('input[name="email"]', email)
await ctx.solveCaptcha()                                  // 此时才检测 + 解题
await ctx.clickCheckin('#claim-btn', { assert: '.success-toast' })
```

解题成功后 token 按类型回填页面并派发 `input` 事件：

- turnstile → `input[name="cf-turnstile-response"]`
- hcaptcha → `textarea[name="h-captcha-response"]` 与 `textarea[name="g-recaptcha-response"]`
- 其他 → `textarea[name="g-recaptcha-response"]`

### 手动 solveCaptcha 时机

「点击领取/提交时才出现验证码」的站点，在点击前显式调用：

```ts
await ctx.solveCaptcha()
await ctx.clickCheckin('#claim-btn', { assert: '.success-toast' })
```

### 费用上限与余额不足

- 费用上限：`config.json` 的 `captcha.maxCostPerTask`（默认 1500 点）。每次打码前 `ensureBalance(上限)` 检查余额。
- 余额不足：抛 `yescaptcha 余额不足: X 点 < Y 点`（`CaptchaFailure`）。
- 查询余额：面板「设置」页点「查询余额」→ `GET /api/captcha/balance`（返回 `{ points, yuan }`，1 元 = 1000 点）。

### 失败行为

打码失败（创建任务失败 / 解题超时 / 回填异常）统一抛 `CaptchaFailure`。窗口运行器识别该异常后：

- 运行状态直接进入 `captcha_failed`（**不按 retry 配置重试**）；
- 计入窗口熔断计数（见第 9 章）；
- 每次尝试都记录 `logCaptcha(kind, ok, costPoints)`，看板可见。

---

## 6. 拟人接口（Humanizer）

`Humanizer`（`src/automation/humanize.ts`）负责所有拟人化输入。构造：`new Humanizer(page, { minDelayMs = 800, maxDelayMs = 3000 })`（延迟选项为通用默认值）。

点击前犹豫的停顿区间由全局配置 `execution.humanize`（`config/config.json`）注入（`src/engine/window-runner.ts` 构造时传入 `cfg.execution.humanize`），默认 `{ "minDelayMs": 800, "maxDelayMs": 3000 }`，可按需调整快慢；未配置时回落构造函数默认值（同样为 800/3000ms）。

| 方法 | 签名 | 行为 |
| --- | --- | --- |
| `click` | `click(selector): Promise<void>` | boundingBox 定位 → 在元素内四周各留 7.5%（合计 15%）边距的区域随机取点 → hover（5s 超时，失败忽略）→ 贝塞尔轨迹移动 → 停顿 800-3000ms（区间由 `execution.humanize` 配置）→ 按下 → 停顿 40-150ms → 释放。找不到元素抛 `点击失败: 找不到元素 X` |
| `type` | `type(selector, text): Promise<void>` | 先 click 聚焦，再逐键输入：每键延迟 40-130ms；约 3% 概率按 Backspace、停顿 100-300ms 后重输该键（模拟错键回删） |
| `moveTo` | `moveTo(x, y): Promise<void>` | ghost-cursor 生成贝塞尔路径（`spreadOverride: 25`），逐点派发移动事件，每点间隔 8~23ms；记住终点作为鼠标当前位置 |
| `scroll` | `scroll(deltaY): Promise<void>` | 在鼠标当前位置派发滚轮事件，随后停顿 100-400ms |
| `sleep` | `static sleep(minMs, maxMs): Promise<void>` | 区间内均匀随机停顿 |
| `randomMicroMove` | `randomMicroMove(): Promise<void>` | 在当前位置 ±60px 内随机微移（模拟真实用户小动作） |

用法示例：

```ts
await ctx.human.scroll(400)                 // 向下滚 400px
await ctx.human.randomMicroMove()           // 微动一下
await Humanizer.sleep(1000, 2000)           // 随机停顿 1-2 秒
```

### CDP 派发原理（为什么不用原生 mouse）

所有鼠标/滚轮事件通过 `page.context().newCDPSession(page)` 拿到 CDP 会话后用 `Input.dispatchMouseEvent` 直接派发给渲染进程，而不是用 Playwright/Patchright 原生的 `page.mouse`：

1. **轨迹可控**：原生 `mouse.move` 一步到位，而这里用 ghost-cursor 生成人类手抖的贝塞尔曲线，逐点以 8~23ms 间隔派发。
2. **事件可信**：CDP 层派发的输入事件在页面侧 `isTrusted` 语义与真实输入一致，不易被站点的反自动化脚本标记。
3. **模型统一**：与比特浏览器的 CDP 连接模型一致，行为在不同窗口/内核间一致。

---

## 7. 调度

### 两种 schedule 写法

```ts
schedule: '0 9 * * *'                      // cron：每天 9:00
schedule: { stagger: ['09:00', '11:00'] }   // 错峰：9:00-11:00 内随机分钟（含两端，每日 00:01 重随机）
```

错峰在进程启动时用 `staggerToCron` 定一次具体分钟，生成普通 cron（重启服务与每日 00:01 都会重新随机）；结束早于开始视为跨天窗口（如 `['23:00', '01:00']`，随机落点覆盖当晚与次日凌晨）。cron 时区为 `execution.timezone`（默认 `Asia/Shanghai`），由 croner 解析。

### 跳过规则

`Scheduler.start()`（`src/engine/scheduler.ts`）按顺序跳过：

1. `deprecated: true` → 告警 `任务已标记失效，跳过调度`；
2. 停用 → 告警 `任务已停用，跳过调度`（开关读取云端 `task_states` 覆盖，代码 `enabled: false` 为默认值）；
3. `url` 为空 → 告警 `任务未配置 url，跳过调度`；
4. `schedule` 缺失 → 不建 cron（仅能手动触发）。

停用任务不注册 cron；窗口「立即跑」（`POST /api/profiles/:id/run`）也会排除停用任务，返回的 `count` 为实际入队数量。

### 面板运行时覆盖

面板任务页每张卡片的开关为**运行时覆盖**：点开关调用 `PATCH /api/tasks/:key`，写入云端 `task_states` 表（`key → enabled`），**立即生效（含重新启用，无需重启服务）**：开关切换会按 key 即时停止或重新注册该任务的 cron（`Scheduler.refreshTask`），调度器到点触发、手动触发接口、窗口「立即跑」也都实时读取；覆盖值云端持久，重启保留、多台机器部署同库时跨机器生效。无覆盖记录时回落到代码 `meta.enabled ?? true`。

### 手动触发

| 入口 | 接口 | 语义 |
| --- | --- | --- |
| 面板任务页「立即触发」 | `POST /api/tasks/:key/trigger`，body `{ bitbrowserId? }` | 带 `bitbrowserId` → 只跑该窗口（窗口不存在返回 404）；不带 → 全部启用窗口 |
| 面板看板「全部窗口执行」 | 逐窗口 `POST /api/profiles/:id/run` | 任意窗口 id（含禁用窗口，find 基于 listProfiles(false)）跑全部任务 |
| 面板看板「重跑今日失败」 | `POST /api/runs/rerun-failed`，body `{ date }` | 当日失败行重新入队 |
| 代码内 `Scheduler.fireNow(taskKey)` | — | 对**全部启用窗口**逐窗口入队（与 `POST /api/tasks/:key/trigger` 不带 body 等价） |

`重跑今日失败` 会重跑失败记录对应的任务，即使该任务当前已停用（显式恢复操作，语义等同手动触发）。

### fireNow 语义

`fireNow(taskKey)` 遍历 `db.listProfiles(true)`（启用窗口），逐个调用 `CoalescingEnqueuer.enqueue(profile, taskKey)`。入队器保证：同一窗口的任务合并为一次开窗执行；窗口正在执行时新的触发进入 follow-up 队列，窗口跑完再补跑，**不会并发开同一个窗口**。

---

## 8. 常用模式

### 签到成功 / 已签到

```ts
// 成功：点击后断言成功标志（徽章/文案），宁严勿松
await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })

// 已签到：出现"已签到"类文案直接返回（run 正常返回 = 任务 success）
if (await ctx.textPresent('已签到')) return
```

### 频率限制 / 维护中

```ts
if (await ctx.textPresent('操作过于频繁')) return      // 视为当日已尝试，返回即可
if (await ctx.textPresent('维护中')) throw new Error('站点维护中') // 抛错 → 面板可见错误与截图
```

### faker 填表单

```ts
const email = faker.internet.email()                     // 拟人化邮箱（随机真实域名）
const tokenName = faker.word.words(2)                    // 代币名
const tokenSymbol = tokenName.replace(/[aeiou]/gi, '').slice(0, 4).toUpperCase() // 去元音做符号
await ctx.typeInto('textarea[name="description"]', faker.lorem.sentence())
await ctx.typeInto('input[name="amount"]', String(faker.number.int({ min: 1, max: 100 })))
```

### 多步骤流程

```ts
// 点击"下一步"后等待第二步元素出现（用断言等待，而非固定 sleep）
await ctx.clickCheckin('#step-next', { assert: '#step-2' })
```

### 条件分支与抛错重试

`run` 内抛任意 `Error` 都会触发失败处理：按 `retry` 配置重试（总尝试 `max + 1` 次，间隔 `backoffSec` 秒），状态流转 `running → retry_wait → running → … → failed`；最终失败时窗口熔断计数 +1。验证码失败（`CaptchaFailure`）不重试，直接 `captcha_failed`。

重试要点：

- **重试不占窗**：进入 `retry_wait` 后立即释放窗口（不 sleep 占并发名额），当前窗口会话正常继续处理其他任务或关闭；退避到期由调度器重新入队，开新一轮窗口会话从续跑轮次开始执行。
- **跨会话续算**：尝试计数存在数据库 run 记录里（`attempts=N` 表示已跑 N 次），重启服务后到期的重试仍从 N+1 续跑，重试上限跨会话生效，最终必达 `failed`，不会无限重试。
- 重试前页面自动复位（`about:blank`），避免上一轮残留 DOM/事件干扰。

### 成功断言写法

- 断言元素选「成功后才会出现」的标志，不要选「点击前就存在」的元素。
- 链上交易类异步结果用长超时断言：`await ctx.assertVisible('.tx-success', 30000)`，超时抛 `断言超时: 元素 X 未出现` 进入失败流程。
- 成功自动留档：任务成功后框架自动补拍 `<日期>-success.png`；`run` 内也可显式 `await ctx.screenshot('xxx')`。

---

## 9. 排错

### 选择器失效

- **症状**：`点击失败: 找不到元素 X` / `断言超时: 元素 X 未出现`。
- **对策**：`meta.sourceUrl` 记录了选择器当初是从哪个页面确认的，站点改版时回来源页用 DevTools 重新取选择器；优先换 `data-testid` 与语义属性，避免深路径 `:nth-child` 与随机 class。

### 钱包弹窗不出现

- **症状**：`loginByWallet` 抛 `钱包弹窗未出现`（15 秒超时）。
- **对策**：
  1. 检查 `meta.wallet` 的 key 是否已注册（未注册报 `未注册的钱包适配器: X`）；
  2. 用 DevTools 查看弹窗实际 URL，对照适配器 `extensionUrlPatterns` 正则是否匹配；
  3. 若站点在点击「连接」按钮后才弹窗，先在 `run` 里点击该按钮再调 `loginByWallet()`（它会等弹窗出现并完成连接）。

### 打码失败与余额

- `yescaptcha 余额不足: X 点 < Y 点` → 充值或下调 `config.json` 的 `captcha.maxCostPerTask`；
- `yescaptcha 创建任务失败` / `yescaptcha 解题超时` → 检查 `CAPTCHA_CLIENT_KEY` 与站点验证码类型是否被支持；
- 看板「验证码」卡片汇总每次打码的 `kind/cost/ok`；运行状态 `captcha_failed` 表示打码失败（不重试）。

### 熔断触发与重置

- 窗口任务最终失败（含 `captcha_failed`）时 `circuitBreakerCount + 1`；计数 ≥ `execution.circuitBreakerThreshold`（默认 2）后，该窗口后续任务直接 `skipped`（错误「窗口熔断」）。
- 重置：面板「窗口」页「重置熔断」按钮（`POST /api/profiles/:id/breaker/reset`）；任一任务成功后自动清零。

### 截图与日志位置

- **截图**：`data/screenshots/<日期>/<比特窗口ID>/<任务key>/`；失败尝试存 `<日期>-attempt<n>.png`，成功存 `<日期>-success.png`，`run` 内自定义截图同目录。看板矩阵行内可点开截图。
- **日志**：`data/logs/app.log`（pino，级别由 `config.json` 的 `storage.logLevel` 控制，控制台同步输出）；任务失败时日志携带 `status/err`。
- **运行状态速查**：`pending → running → success | failed | captcha_failed | retry_wait → …`，`skipped` 表示开窗失败/探活失败/熔断跳过。

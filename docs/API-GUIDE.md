# AutoBitControl API 使用手册（小白友好版）

> 目标读者：第一次接触自动化的你。本文按「是什么 → 什么时候用 → 怎么用 → 注意什么」的顺序讲解，不预设任何编程背景。所有代码签名、默认值与报错文案，均以仓库当前代码为准（`src/engine/task-context.ts`、`src/automation/humanize.ts`、`src/engine/task.ts`、`src/engine/scheduler.ts`、`src/integrations/yescaptcha.ts`、`src/infrastructure/config.ts`、`src/server/routes/*`、`scripts/*`）。

配套资源：

- 面板「文档」页在线渲染本手册；「任务示例」页展示三个带逐行注释的示例任务源码。
- 示例任务位于 `src/tasks/`：`example-checkin.ts`（签到）、`faucet-example.ts`（领水）、`mint-example.ts`（铸币）。
- 新增任务从复制 `src/tasks/example-checkin.ts` 改起最快。

---

## 先读我（5 分钟）

### 这个系统里，谁负责什么

AutoBitControl 一共三块，分工如下：

| 部件 | 大白话解释 |
| --- | --- |
| **任务文件**（`src/tasks/*.ts`） | 一份「操作说明书」。你用代码写下：打开哪个网址、点哪个按钮、怎么算成功 |
| **框架**（引擎 + 调度器 + 浏览器） | 替你操作浏览器的「手」。它读你的说明书，定时开窗口、真的去点网页、失败还会重试 |
| **面板**（Web 界面） | 看结果的地方。哪个任务成功、哪个失败、现场截图长什么样，都在这里看 |

### 写一个任务的心智模型

```
写任务（写说明书） → 试跑（本地单窗口验证） → 上线（面板开开关，交给调度器）
```

1. **写任务**：复制示例文件，改两处——`meta`（这任务叫什么、几点跑、要不要钱包）和 `run`（具体操作步骤）。
2. **试跑**：先跑本地测试（秒级反馈）→ 再用 `npm run task:run` 单窗口真跑一次 → 看截图确认没点错。
3. **上线**：面板任务页打开开关，调度器（Scheduler，负责「到点自动开跑」的组件）每天准时执行，看板自动记录结果。

一个完整的「9 点签到站点」任务长什么样，见第 9 章开头的完整示例。

### 三句话记住怎么用

1. 所有操作都通过 `ctx.` 开头的方法完成：`ctx.goto()` 打开页面，`ctx.clickCheckin()` 点按钮，`ctx.waitForText()` 等结果。
2. 任何一步抛错（throw）都等于「这次任务失败」，框架按重试配置自动再跑，并在面板留档。
3. 成功与否由**断言**说了算（检查「该出现的东西出现了没有」），而不是「点到了按钮」就算数。

---

## 名词表

正文中出现的黑话都在这里。第一次看按 Ctrl+F 查这个词即可。

| 名词 | 英文 | 一句话大白话 |
| --- | --- | --- |
| 任务 | Task | 一个站点的自动化流程（如「每天去 X 站签到」），对应 `src/tasks/` 里一个文件 |
| 任务文件 | Task file | 上面说的那份「操作说明书」，含 `meta`（基本信息）和 `run`（操作步骤） |
| 选择器 | Selector | 用来「定位」网页上某个元素的规则，比如 `#checkin-btn` 表示 id 为 `checkin-btn` 的按钮 |
| 断言 | Assertion | 检查「该出现的东西出现了没有」，没出现就报错 |
| cron | cron | 一种定时表达式，`0 9 * * *` 表示每天 9:00（写法见第 2/7 章） |
| 错峰 | Stagger | 不写死几点，而是在一个时间段里随机挑一分钟（多窗口不扎堆、站点压力分散） |
| 弹窗 | Popup | 网页上浮出来的小窗口（公告、通知、新手引导） |
| 遮罩 | Mask | 弹窗背后盖住整页的半透明灰层，挡住页面、逼你先处理弹窗 |
| 钱包弹窗 | Wallet popup | 浏览器钱包插件（如 MetaMask）弹出的确认小窗口（解锁、连接） |
| 验证码 | CAPTCHA | 「证明你是人」的验证（Cloudflare 转圈、九宫格点图等），由打码平台代答 |
| DOM | DOM | 网页的「零件清单」。浏览器把网页解析成一棵树，每个元素都能按规则定位 |
| URL | URL | 网址/链接，浏览器地址栏那一串 |
| 接口 | API | 网页背后偷偷发的数据请求；「接口返回 ok」＝服务器说操作成功 |
| 隔离世界 / 主世界 | Isolated / Main world | 两个平行宇宙：自动化工具默认在隔离世界看网页，站点自己注入的全局变量只能进主世界读 |
| CDP | CDP | 浏览器调试协议；本框架模拟鼠标键盘，就是通过它把「真事件」直接派发给页面 |
| 代理 | Proxy | 每个窗口独立的 IP 出口，避免所有窗口同一个 IP |
| 指纹 | Fingerprint | 浏览器可被识别的特征（版本、语言、插件等），窗口之间要各不相同 |
| 熔断 | Circuit Breaker | 保险丝：一个窗口连续失败 N 次后，当天不再跑任何任务（保护站点账号） |
| 重试 | Retry | 任务失败后自动再跑，次数与间隔可配置 |
| 超时 | Timeout | 最多等多久；超过就按失败处理 |
| sitekey | sitekey | 验证码的「身份证号」，站点注册验证码服务时分配；打码平台必须带上它 |
| token | token | 打码平台解完题返回的「通过凭证」，回填进页面后站点才放行 |
| 回落 / 兜底 | Fallback | 主方案失败时用的备选方案（如 `closeModal` 点按钮失败 → 点遮罩 → 按 Esc） |
| 拟人化 | Humanize | 让点击/移动/打字像真人（随机轨迹、随机停顿），降低被站点识别为脚本的风险 |
| 贝塞尔轨迹 | Bezier path | 一种像人手抖出来的平滑曲线，鼠标移动沿它逐点走 |
| 窗口 | Profile | 一个比特浏览器环境（独立代理、指纹、Cookie），面板「窗口」页管理的单位 |
| 退避 | Backoff | 重试前的等待时间；失败越多往往等得越久，给站点限流留冷却时间 |
| 探活 | Probe | 开窗后先访问一个探活地址，确认代理 IP 已生效再跑任务 |
| 调度器 | Scheduler | 框架里「看表的人」：到点把任务推进执行队列，到点前啥也不干 |
| patchright | patchright | 我们用的「隐形浏览器驱动」，自动屏蔽自动化痕迹 |
| croner | croner | 实现定时任务的库 |
| ghost-cursor | ghost-cursor | 生成人类鼠标轨迹的库 |
| pino | pino | 写日志的库 |

---

## 1. 快速开始

新增一个签到任务共 5 步：

**第 1 步：建文件** `src/tasks/my-checkin.ts`。

**第 2 步：写 meta**（任务的基本信息：叫什么、几点跑、要不要钱包，字段含义见第 2 章）。

**第 3 步：写 run**（具体操作步骤，可用方法见第 3 章）。

**第 4 步：注册** 在 `src/tasks/index.ts` 的 `ALL` 数组中加入实例。

**第 5 步：面板验证** 重启服务（`npm start`）→ 面板「任务」页应出现新任务卡片（含分类徽章、来源页、备注）→ 点「立即触发」手动跑一次 → 看板查看结果与截图。

完整最小任务代码：

```ts
import { SiteTask, TaskContext, type TaskMeta } from './base'

export class MyCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'my-checkin',              // 全局唯一名字，面板与数据库都用它标识任务
    name: '我的签到',               // 面板上显示的名字
    url: 'https://example.com/',    // 任务入口页（从这里开始）
    wallet: 'metamask',             // 登录用的钱包适配器 key（见第 4 章）
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()                                          // 打开 url（失败自动重试 3 次）
    await ctx.loginByWallet()                                 // 等钱包弹窗 → 解锁 → 点连接
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

### 写好之后怎么验证

新任务或改动选择器后，按三层流程验证（从快到真，逐层递进）：

1. **本地测试**：参考 `tests/task-base.test.ts` 的模式（注入假驱动，秒级反馈）。把选择器换成本地 fixture 页面先验证流程逻辑，不依赖真实站点与窗口。
2. **单窗口单任务真实验证**：`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run`——只开一个窗口、只跑指定任务、打印结果后退出（脚本：`scripts/run-task.ts`），比面板全量触发轻量。
3. **面板验证**：面板看板行级「执行」（单窗口单任务）或任务页「立即触发」（全部启用窗口），人工核对截图与日志。
4. **开窗冒烟（部署后先跑这个）**：`BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window`——验证「开窗 → CDP 接管 → 打开探活页 → 关窗」整条链路（脚本：`scripts/smoke-open-window.ts`），一次确认比特浏览器 API、驱动与代理 IP 都可用。
5. **钱包冒烟**：`BITBROWSER_PROFILE_ID=<窗口ID> WALLET_KEY=metamask|petra npm run smoke:wallet`——打开站点后手动点「连接钱包」，脚本等 60 秒检测弹窗并自动确认（脚本：`scripts/smoke-wallet.ts`）。**新钱包适配器写好后，用这个验证弹窗识别正则是否命中真实插件**（见第 4 章「新增钱包适配器步骤」）。

示例任务默认 `enabled: false`（不参与日常执行），调试时把代码改为 `true` 并重启服务、直接在面板任务页打开开关（立即生效，无需重启），或用第 2 层的 `task:run` 脚本（不受开关限制）。

---

## 2. TaskMeta 字段全解

`TaskMeta` 定义于 `src/engine/task.ts`。除 `key`/`name`/`url` 必填外，其余均可选，未填时使用默认行为（默认值列注明）。

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `key` | `string` | 无（必填） | 全局唯一标识。API 路由（`/api/tasks/:key/trigger`）、数据库 runs 表、调度器都用它 |
| `name` | `string` | 无（必填） | 面板任务页显示名 |
| `url` | `string` | 无（必填，可为 `''`） | 站点入口页 URL，`goto()` 从这里开始。空串 → 调度器跳过，仅可手动触发 |
| `sourceUrl` | `string?` | `undefined` | 信息来源页：记录选择器是从哪个页面确认的，站点改版时回这里重查（排错见第 10 章） |
| `note` | `string?` | `undefined` | 备注，面板任务页直接可见，记录站点的坑与特殊逻辑 |
| `category` | `'checkin' \| 'faucet' \| 'mint' \| 'other'` | `undefined` | 面板显示对应颜色徽章 |
| `lastUpdated` | `string?` | `undefined` | 最后核对站点的日期（文档约定，如 `'2026-08-28'`） |
| `deprecated` | `boolean?` | `false` | `true` → 调度器跳过该任务并告警（仅能手动触发） |
| `enabled` | `boolean?` | `true` | 任务开关的代码默认值：`false` → 调度器跳过、窗口「立即跑」排除、手动触发接口返回 409。面板任务页开关写入云端 `task_states` 表覆盖（立即生效——停用即停 cron、重新启用即重注册 cron，无需重启；跨机器生效、重启保留）。注意：上表的 `true` 只是代码默认值，三个示例任务（`example-checkin.ts`/`faucet-example.ts`/`mint-example.ts`）都显式写了 `enabled: false`（示例不参与日常执行，方便调试） |
| `schedule` | `string \| { stagger: [string, string] }` | `undefined` | cron 字符串或错峰窗口；缺省则不参与调度（见第 7 章） |
| `wallet` | `string?` | `undefined` | 钱包适配器 key（`'metamask'`/`'petra'`），`loginByWallet()` 按此查找适配器（见第 4 章） |
| `timeoutSec` | `number?` | `180` | 单次运行超时秒数；默认取全局 `execution.taskTimeoutMs / 1000`，超时抛 `任务 X 超时` |
| `retry` | `{ max: number; backoffSec: number }?` | `{ max: 2, backoffSec: 600 }` | 失败重试次数与间隔秒数；默认取全局 `execution.retryMax`/`execution.retryBackoffSec` |
| `captcha` | `{ auto?: boolean; maxCost?: number }?` | `{ auto: true }` | 验证码处理（见第 5 章）。`auto` 控制调用 `solveCaptcha()` 时是否实际打码；`maxCost` 是声明性字段——当前代码中费用上限统一由 `config.json` 的 `captcha.maxCostPerTask` 全局控制，任务级 `maxCost` 仅作预算记录，不参与运行时判断 |

示例（省略了部分可选字段，完整字段见上表；摘自 `src/tasks/example-checkin.ts`）：

```ts
meta: TaskMeta = {
  key: 'example-checkin',
  name: '示例签到',
  url: '',
  sourceUrl: '',
  note: '示例任务：url 为空且开关默认关闭；调试时在面板任务页打开开关，或用 task:run 脚本直接跑（不受开关限制）',
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

`TaskContext` 定义于 `src/engine/task-context.ts`，是 `run(ctx)` 的全部操作入口——**任务里能做的所有事，都在 `ctx` 上**。另有三个只读访问器：`ctx.page`（patchright `Page`，底层页面对象）、`ctx.human`（`Humanizer` 拟人操作器，见第 6 章）、`ctx.profile`（当前窗口记录，含熔断计数等）。

下面每个方法按「是什么 / 什么时候用 / 怎么用 / 注意什么」展开。

### goto

```ts
async goto(url?: string): Promise<void>
```

- **是什么**：打开网页。
- **什么时候用**：任务第一步（进入站点入口页）；流程中途要跳到另一个页面时。
- **怎么用**：

```ts
await ctx.goto()                    // 打开 meta.url（最常见）
await ctx.goto('https://a.com/b')   // 打开指定页（适合流程中的跳转）
```

- **注意什么**：页面加载失败**自动重试 3 次**，每次间隔 2-5 秒随机退避，第 3 次仍失败才把错误抛出来（任务进入失败/重试流程）；成功后会拟人停顿 0.8-3 秒再继续。**打开页面 ≠ 签到成功**，goto 只保证页面到达，签到结果要靠后续的断言方法确认。

### clickCheckin

```ts
async clickCheckin(selector: string, opts?: { assert?: string; assertTimeoutMs?: number }): Promise<void>
```

- **是什么**：拟人地点击签到按钮（见第 6 章 `Humanizer.click`），点击后可选地断言「成功标志元素」出现。
- **什么时候用**：站点有一个明确的「签到/领取」按钮时——这是最常用的方法。
- **怎么用**：

```ts
// 只点，不检查结果
await ctx.clickCheckin('#checkin-btn')

// 点了之后必须看到"成功徽章"（宁严勿松）
await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })

// 成功文案出来得慢，把断言等待拉长到 30 秒
await ctx.clickCheckin('#claim-btn', { assert: '.success-toast', assertTimeoutMs: 30000 })
```

| 参数 | 含义 |
| --- | --- |
| `selector` | 点击目标选择器 |
| `opts.assert` | 点击后应出现的成功标志元素；断言失败抛 `断言超时: 元素 X 未出现` |
| `opts.assertTimeoutMs` | 断言等待时长（毫秒），默认 10000 |

- **注意什么**：断言元素选「成功后才会出现」的标志（徽章/文案），不要选「点击前就存在」的元素——否则断言形同虚设。点击后可能弹验证码，这类站点在点之前先调 `solveCaptcha()`（见第 5 章）。

### assertVisible

```ts
async assertVisible(selector: string, timeoutMs = 10000): Promise<void>
```

- **是什么**：蹲点等某个元素出现，等到就正常返回，超时就报错 `断言超时: 元素 X 未出现`。
- **什么时候用**：等待异步结果——点击后要过一会儿才出现的东西（链上交易确认、接口返回后才渲染的提示）。
- **怎么用**：

```ts
await ctx.assertVisible('.tx-success', 30000)   // 等链上交易成功标志，最长 30 秒
```

- **注意什么**：它等的是「出现」，元素「消失」要用 `waitForGone`（见后文对比表）。超时抛错意味着任务失败，会进入重试流程。

### typeInto

```ts
async typeInto(selector: string, text: string): Promise<void>
```

- **是什么**：往输入框里打字。
- **什么时候用**：填表单——邮箱、数量、金额、描述等任何「要输入一串文字」的场景。
- **怎么用**：

```ts
// faker（生成假数据的库：随机邮箱/名字/句子，避免每个窗口都用同一份数据）
await ctx.typeInto('input[name="email"]', faker.internet.email())  // 往邮箱框里打字
await ctx.typeInto('input[name="amount"]', '100')                  // 往数量框里打字
```

- **注意什么**：内部先点击聚焦，再**逐键**输入（每键 40-130ms 随机延迟，约 3% 概率错键回删重输，模拟真人手误）。它和 `pressKey` 的分工：**往框里打字用 typeInto，按一个键（如 Enter 提交）用 pressKey**。

### pressKey

```ts
async pressKey(key: string): Promise<void>
```

- **是什么**：按一下键盘键（按下 + 抬起），单键和**组合键**都支持。
- **什么时候用**：按 Enter 提交表单、按 Escape 关闭浮层、按 Tab 切换焦点等单个按键场景；也可以发组合键——全选 `Control+A`、反向切焦点 `Shift+Tab`、保存 `Control+S` 等。
- **怎么用**：

```ts
await ctx.typeInto('#search-input', 'hello')  // 1. 先往搜索框打字（会自动聚焦输入框）
await ctx.pressKey('Enter')                   // 2. 按回车提交（表单的 keydown 监听收到 Enter）
await ctx.waitForText('提交成功')              // 3. 蹲点等结果文案出现
// 组合键：键名之间用加号连接
await ctx.pressKey('Control+A')               // 全选当前输入框内容
await ctx.pressKey('Shift+Tab')               // 反向切换焦点（回到上一个输入框）
```

- **注意什么**：这是纯键盘操作，焦点在哪它就发给谁——按 Enter 之前要确保焦点在目标输入框里（`typeInto` 已经帮你聚焦了）。**只按键不输入文字**，要输入一串文字请用 `typeInto`。按键名写键盘标准名：`'Enter'`、`'Escape'`、`'Tab'`、`'ArrowDown'`、`'Backspace'` 等，组合键用加号连接（`'Control+A'`、`'Shift+Tab'`）。

### solveCaptcha

```ts
async solveCaptcha(): Promise<'none' | 'solved' | 'failed'>
```

- **是什么**：在**当前页面**检测验证码（CAPTCHA），检测到就交给打码平台解题并回填，详见第 5 章。
- **什么时候用**：验证码可能出现的时刻——通常就在点击提交按钮**之前**（很多站点点击时才弹出验证码）。
- **怎么用**：

```ts
await ctx.typeInto('input[name="email"]', 'my-email@example.com')
await ctx.solveCaptcha()                                   // 此时才检测 + 解题（可能要花钱）
await ctx.clickCheckin('#claim-btn', { assert: '.success-toast' })
```

- **注意什么**：返回值语义——`'none'`：未注入打码服务、`captcha.auto` 为 false、或页面上没检测到验证码（不花钱）；`'solved'`：检测到并解题成功（token 已回填页面）；`'failed'`：类型上存在，但实现中失败一律抛 `CaptchaFailure`（任务进入 `captcha_failed` 终态，见第 5/9 章）。**框架不会在 goto 后自动打码**，打码只发生在你显式调用它的位置。

### screenshot

```ts
async screenshot(name: string): Promise<string>
```

- **是什么**：把当前视口截成 `${name}.png` 存到产物目录，返回文件绝对路径（面板按路径取图）。
- **什么时候用**：流程关键节点留档，方便事后人工核对。
- **怎么用**：

```ts
await ctx.screenshot('faucet-success')   // 存一张名为 faucet-success.png 的截图
```

- **注意什么**：截图目录为 `data/screenshots/<日期>/<比特窗口ID>/<任务key>/`；成功/失败的截图框架会自动补拍（见第 9 章「成功断言写法」），无需在每个任务里手调。

### loginByWallet

```ts
async loginByWallet(): Promise<void>
```

- **是什么**：完成「站点唤起钱包弹窗 → 解锁（若配了密码）→ 点连接确认」全流程，详见第 4 章。
- **什么时候用**：站点要求钱包登录时，一般紧跟 `goto()` 之后。
- **怎么用**：

```ts
await ctx.goto()
await ctx.loginByWallet()   // 等弹窗 → 解锁 → 连接，一气呵成
```

- **注意什么**：需要任务配置 `meta.wallet`（未配置抛 `任务未配置钱包`）；等待弹窗最多 15 秒，超时抛 `钱包弹窗未出现`；只有该窗口配置了解锁密码才会执行解锁。**若站点要先点页面上的「连接钱包」按钮才弹窗**，先点那个按钮，再调 `loginByWallet()`（它会等弹窗出现并完成连接）。

### textPresent

```ts
async textPresent(text: string): Promise<boolean>
```

- **是什么**：**立刻看一眼**页面上有没有某段文字，有就返回 `true`，没有 `false`（包含即命中，不是整句相等）。
- **什么时候用**：状态判断——「已领过」直接返回、「维护中」抛错，页面此时已经加载完。
- **怎么用**：

```ts
if (await ctx.textPresent('已领取')) return              // 已领过 → 直接成功
if (await ctx.textPresent('维护中')) throw new Error('站点维护中')  // 维护 → 抛错进失败流程
```

- **注意什么**：它是**即时判断一次**，不等待。文案要过一会儿才出现的话，用 `waitForText`（蹲点等）。两者分工见后文对比表。

### urlIncludes

```ts
async urlIncludes(part: string): Promise<boolean>
```

- **是什么**：**立刻看一眼**当前网址（URL）是否包含某片段。
- **什么时候用**：判断登录状态/跳转结果——地址栏里有 `/dashboard` 说明已登录。
- **怎么用**：

```ts
if (await ctx.urlIncludes('/dashboard')) { /* 已登录，跳过登录 */ }
```

- **注意什么**：同样是即时判断。**等待**网址变化要用 `waitForUrl`。

### waitForText

```ts
async waitForText(text: string, timeoutMs = 10000): Promise<void>
```

- **是什么**：**蹲点等**某段文字出现在页面上，等到就返回，超时抛 `等待文案超时: <text>`。
- **什么时候用**：等异步渲染的文案——点击提交后接口返回才出现的「已签到成功」、倒计时结束才出现的提示。
- **怎么用**：

```ts
// 点击提交后，等"已签到成功"出现（最长 10 秒）
await ctx.clickCheckin('#submit-btn')
await ctx.waitForText('已签到成功')
```

- **注意什么**：匹配方式与 `textPresent` 一致（包含即命中）。**与 textPresent 的分工**：页面状态已经就绪、只做一次判断用 `textPresent`（如打开页面后检查「已领取」直接返回）；结果要等异步动作完成才出现，用 `waitForText`。

### waitForApi

```ts
async waitForApi(urlPart: string, timeoutMs = 10000): Promise<unknown>
```

- **是什么**：蹲点等「网址包含 `urlPart` 的网络请求」的响应（API 请求），并把响应体 JSON 解析好返回给你。
- **什么时候用**：站点点击后 UI 不更新（或更新滞后），但接口返回体里有明确的业务状态码/字段时，把接口返回当作业务结果。
- **怎么用**：

```ts
// 点击领取后等接口返回，并校验业务字段
await ctx.human.click('#claim-btn')
const body = await ctx.waitForApi('/api/claim', 15000) as { ok: boolean; message?: string }
if (!body.ok) throw new Error(`领取失败: ${body.message}`)
```

- **注意什么**：**它不会自己触发请求**——调用前先执行触发动作（点按钮等）；若担心响应比等待注册还快，可先 `const p = ctx.waitForApi(...)` 再触发点击，最后 `await p`。响应体不是 JSON 时返回 `null`；超时抛 `等待接口超时: <urlPart>（<原始错误>）`。

### waitForUrl

```ts
async waitForUrl(part: string, timeoutMs = 10000): Promise<void>
```

- **是什么**：蹲点等当前网址变成「包含某片段」（跳转等待）。
- **什么时候用**：等动作引发的跳转——登录成功跳到面板、SPA（Single Page Application，单页应用，页面不刷新靠 hash 路由切换）内 hash 路由推进。
- **怎么用**：

```ts
await ctx.human.click('#login-btn')
await ctx.waitForUrl('/dashboard')      // 登录成功后跳转到面板
await ctx.waitForUrl('#/step-2')        // SPA 内 hash 路由推进（地址栏 # 后面的变化也算）
```

- **注意什么**：hash 变化同样有效。超时抛 `等待跳转超时: <part>`。与 `urlIncludes`（即时判断）的关系同 `waitForText`/`textPresent`：先判断后动作用 `urlIncludes`，等待动作引发跳转用 `waitForUrl`。

### js

```ts
async js<T>(fn: () => T): Promise<T>
```

- **是什么**：在页面**主世界**执行一段 JavaScript 并返回结果。
- **什么时候用**：读站点自己注入的全局状态（`window.__APP_STATE__` 之类）、读 `localStorage` 判断登录态/任务状态——这些自动化工具的默认隔离世界（Isolated world，工具自己的平行宇宙）看不到，必须进主世界（Main world，站点的宇宙）读。
- **怎么用**：

```ts
// 读站点全局状态判断登录态
const state = await ctx.js<{ user?: { id: string } }>(() => (window as any).__APP_STATE__)
if (!state?.user) throw new Error('未登录')

// 读 localStorage 判断是否已做过任务
const done = await ctx.js<boolean>(() => localStorage.getItem('claimed_today') === '1')
if (done) return
```

- **注意什么**：函数体必须是**自包含**的——它会被序列化后送进页面执行，函数里引用外面的变量会拿不到值。

### waitForGone

```ts
async waitForGone(selector: string, timeoutMs = 10000): Promise<void>
```

- **是什么**：蹲点等某个元素**从页面消失**（如 loading 遮罩、提交中的转圈动画）。
- **什么时候用**：点击提交后等加载遮罩消失，说明请求完成，再做下一步。
- **怎么用**：

```ts
await ctx.human.click('#submit-btn')
await ctx.waitForGone('.loading-mask', 30000)   // 遮罩消失说明请求完成
await ctx.assertVisible('.success-toast')        // 再断言成功标志
```

- **注意什么**：元素**从未出现过也视为已消失**（立即返回），不会误报；超时抛 `元素未消失: <selector>`。与 `assertVisible` 是反义词：一个等出现，一个等消失。

### closeModal

```ts
async closeModal(opts?: { close?: string[]; mask?: string; gone?: string; timeoutMs?: number }): Promise<void>
```

- **是什么**：关闭挡路的页面弹窗/遮罩（公告、通知、新手引导层），内部按「候选关闭按钮 → 点遮罩空白处 → 按 Esc」的顺序**逐级兜底（Fallback）**尝试。
- **什么时候用**：打开页面先弹一个公告弹窗挡住签到按钮时——很多站点都这样。
- **怎么用**：

```ts
// 签到前清掉公告弹窗：优先点关闭按钮，失败再点遮罩、按 Esc，最后断言弹窗容器消失
await ctx.closeModal({ close: ['.announce-close', '#notice .close'], mask: '.announce-mask', gone: '.announce-modal' })

// 只点关闭按钮，不验证（弹窗是否消失由后续断言负责）
await ctx.closeModal({ close: ['.popup-close'] })
```

| 参数 | 含义 |
| --- | --- |
| `opts.close` | 关闭按钮候选选择器数组，依次尝试，存在才点（`human.click` 拟人点击） |
| `opts.mask` | 遮罩层选择器：点其左上角内侧 (x+12, y+12) 空白处（`human.clickAt` 坐标点击），避开居中弹窗主体 |
| `opts.gone` | 弹窗容器选择器，用于验证关闭成功；不传则只尝试不验证 |
| `opts.timeoutMs` | 最终兜底验证超时（默认 10000） |

- **注意什么**：策略顺序**固定**：候选关闭按钮（依序）→ 点遮罩空白处 → 按 Esc。每尝试一次就用 `gone` 快速验证（600ms）是否已关闭，成功即返回；单个策略失败（按钮存在但不可点等）不阻断回退链，继续下一个。全部策略跑完后若 `gone` 仍在，用完整超时兜底验证（失败抛 `元素未消失: <gone>`）。

### 方法对比速查

这几个方法长得像但职责不同，选错会写出「看起来对、跑起来翻车」的任务：

| 场景 | 用这个 | 别用那个 | 一句话区别 |
| --- | --- | --- | --- |
| 页面已就绪，看**现在**有没有某文字 | `textPresent` | `waitForText` | 即时看一眼 vs 蹲点等 |
| 结果**过一会儿**才出现 | `waitForText` | `textPresent` | 蹲点等 vs 即时看一眼 |
| 往框里输入一串文字 | `typeInto` | `pressKey` | 打字 vs 按一个键 |
| 按 Enter 提交 / Esc 关闭 / Tab 切焦点 | `pressKey` | `typeInto` | 按一个键 vs 打字 |
| 等元素**出现** | `assertVisible` | `waitForGone` | 等出现 vs 等消失 |
| 等元素**消失**（loading 遮罩） | `waitForGone` | `assertVisible` | 等消失 vs 等出现 |
| 看**当前**网址是否包含某片段 | `urlIncludes` | `waitForUrl` | 即时看一眼 vs 蹲点等 |
| 等网址**变成**包含某片段（跳转） | `waitForUrl` | `urlIncludes` | 蹲点等 vs 即时看一眼 |
| 打开页面 | `goto` | — | **打开页面 ≠ 签到成功**，成功与否要后续断言 |

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

钱包解锁密码是**窗口级**的（每个窗口的钱包密码可能不同），通过环境变量 `WALLET_PASSWORDS` 配置（JSON 字符串，映射比特窗口 ID → 密码）：

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
- Petra `unlock`：密码输入框填密码 → 按 Enter（无稳定 testid 时的替代方案）。
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
await ctx.typeInto('input[name="email"]', 'my-email@example.com')
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
- 查询余额：面板「设置」页点「查询余额」→ `GET /api/captcha/balance`（返回 `{ configured, points, yuan }`，1 元 = 1000 点）。

### 失败行为

打码失败（创建任务失败 / 解题超时 / 回填异常）统一抛 `CaptchaFailure`。窗口运行器识别该异常后：

- 运行状态直接进入 `captcha_failed`（**不按 retry 配置重试**——重试大概率再失败，白烧钱）；
- 计入窗口熔断计数（见第 10 章）；
- 每次尝试都记录 `logCaptcha(kind, ok, costPoints)`，看板可见。

---

## 6. 拟人接口（Humanizer）

`Humanizer`（`src/automation/humanize.ts`）负责所有拟人化输入。构造：`new Humanizer(page, { minDelayMs = 800, maxDelayMs = 3000 })`（延迟选项为通用默认值）。

- **是什么**：让鼠标移动、点击、打字、滚动都像真人——随机轨迹 + 随机停顿。
- **什么时候用**：任务代码一般不直接 new 它，用 `ctx.human`（任务上下文已创建好）；需要滚动页面、微动鼠标、拟人等待时直接调它。
- **注意什么**：点击前犹豫的停顿区间由全局配置 `execution.humanize`（`config/config.json`）注入（`src/engine/window-runner.ts` 构造时传入 `cfg.execution.humanize`），默认 `{ "minDelayMs": 800, "maxDelayMs": 3000 }`，可按需调整快慢；未配置时回落构造函数默认值（同样为 800/3000ms）。

### click

```ts
click(selector): Promise<void>
```

- **是什么**：拟人地点击一个元素。
- **什么时候用**：`ctx.clickCheckin` 内部就是它；需要点「非签到」按钮时直接调。
- **怎么用**：`await ctx.human.click('#some-btn')`
- **注意什么**：boundingBox 定位 → 在元素内四周各留 7.5%（合计 15%）边距的区域随机取点 → hover（5s 超时，失败忽略）→ 贝塞尔轨迹移动 → 停顿 800-3000ms → 按下 → 停顿 40-150ms → 释放。找不到元素抛 `点击失败: 找不到元素 X`。

### clickAt

```ts
clickAt(x, y): Promise<void>
```

- **是什么**：在指定坐标拟人点击。
- **什么时候用**：没有选择器的目标——弹窗遮罩空白处、canvas 按钮等。
- **怎么用**：`await ctx.human.clickAt(320, 240)`
- **注意什么**：贝塞尔轨迹移动 → 停顿 60-400ms → 按下 → 40-150ms → 释放。不做 hover 与随机落点。

### type

```ts
type(selector, text): Promise<void>
```

- **是什么**：拟人地往输入框打字（`ctx.typeInto` 内部就是它）。
- **什么时候用**：任务里请直接用 `ctx.typeInto`，只有需要绕开任务上下文的场景才调它。
- **怎么用**：`await ctx.human.type('input[name="email"]', 'a@b.com')`
- **注意什么**：先 click 聚焦，再逐键输入：每键延迟 40-130ms；约 3% 概率按 Backspace、停顿 100-300ms 后重输该键（模拟错键回删）。

### moveTo

```ts
moveTo(x, y): Promise<void>
```

- **是什么**：沿贝塞尔轨迹把鼠标移动到目标点。
- **什么时候用**：需要「先移过去、再决定点不点」的分步操作。
- **怎么用**：`await ctx.human.moveTo(400, 300)`
- **注意什么**：ghost-cursor 生成贝塞尔路径（`spreadOverride: 25`），逐点派发移动事件，每点间隔 8~23ms；记住终点作为鼠标当前位置。

### scroll

```ts
scroll(deltaY): Promise<void>
```

- **是什么**：在鼠标当前位置派发滚轮事件（正数向下滚）。
- **什么时候用**：按钮在首屏外，滚一滚让它露出来。
- **怎么用**：`await ctx.human.scroll(400)`   // 向下滚 400px
- **注意什么**：滚完随机停顿 100-400ms；滚动位置基于「鼠标当前位置」，先把鼠标移到页面中间再滚更符合直觉。

### sleep（静态方法）

```ts
static sleep(minMs, maxMs): Promise<void>
```

- **是什么**：区间内均匀随机停顿。
- **什么时候用**：个别站点节奏特殊，需要在两步之间「喘口气」。
- **怎么用**：`await Humanizer.sleep(1000, 2000)`   // 随机停顿 1-2 秒
- **注意什么**：优先用断言等待（`assertVisible`/`waitForText`）代替固定 sleep——sleep 不能保证「东西真的出现了」。

### randomMicroMove

```ts
randomMicroMove(): Promise<void>
```

- **是什么**：在当前位置 ±60px 内随机微移（模拟真实用户无目的的小动作）。
- **什么时候用**：页面停留较久（等倒计时、等链上确认）时插一个，降低「呆住不动」的机器感。
- **怎么用**：`await ctx.human.randomMicroMove()`
- **注意什么**：纯装饰性动作，不影响逻辑。

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
| 面板看板行级「执行」（失败行显示「重跑」） | `POST /api/tasks/:key/trigger`，body `{ bitbrowserId }` | **单窗口单任务**：只把该窗口的该任务入队（对应矩阵里那一行） |
| 面板看板「全部窗口执行」 | `POST /api/tasks/:key/trigger`（不带 body） | **需先在任务下拉里选中任务**（未选会提示「请先选择一个任务」）：把该任务推给全部启用窗口 |
| 面板窗口页「立即跑」 | `POST /api/profiles/:id/run` | 跑该窗口的**全部启用任务**（停用任务排除，返回实际入队数 `count`） |
| 面板看板「重跑今日失败」 | `POST /api/runs/rerun-failed`，body `{ date }` | 当日 `failed`/`captcha_failed` 行重新入队 |
| 代码内 `Scheduler.fireNow(taskKey)` | — | 对**全部启用窗口**逐窗口入队（与 `POST /api/tasks/:key/trigger` 不带 body 等价） |

几个「执行」按钮的区别（按入队范围记）：

- 看板行级「执行」= **一个窗口 × 一个任务**（矩阵里那一行）；
- 看板「全部窗口执行」= **一个任务 × 全部启用窗口**（先在任务下拉选任务，一次铺开）；
- 窗口页「立即跑」= **一个窗口 × 全部启用任务**（该窗口的任务全跑一遍）。

`重跑今日失败` 会重跑失败记录对应的任务，即使该任务当前已停用（显式恢复操作，语义等同手动触发）。

### fireNow 语义

`fireNow(taskKey)` 遍历 `db.listProfiles(true)`（启用窗口），逐个调用 `CoalescingEnqueuer.enqueue(profile, taskKey)`。入队器保证：同一窗口的任务合并为一次开窗执行；窗口正在执行时新的触发进入 follow-up 队列，窗口跑完再补跑，**不会并发开同一个窗口**。`fireNow` 同样受云端开关守卫：任务停用时告警 `任务已停用，跳过本次触发` 并直接返回——保证已注册的 cron 在关停后到点也不会执行；任务未注册则静默忽略。

---

## 8. 配置与面板

### 8.1 配置文件与环境变量

配置一共三层，**后面的覆盖前面的**（逐键深合并）：代码默认值 ← `config/config.json` ← `config/config.local.json` ← 环境变量（含 `config/.env`，由 dotenv 加载）。本地差异写 `config.local.json`（不进版本库），部署密钥用环境变量注入。**任何配置改动都要重启服务（`npm start`）才生效。**

全部配置段与关键键（以 `src/infrastructure/config.ts` 为准）：

| 配置段 | 关键键 | 说明 |
| --- | --- | --- |
| `cloud` | `url`、`authToken` | 云数据库（Turso/libsql）连接信息。**必须配置，否则启动报错退出**；`npm run task:run` 脚本同样需要，缺了直接退出。环境变量 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` 覆盖配置文件同名字段 |
| `bitbrowser` | `apiBase`、`openTimeoutMs`、`maxRetries`、`retryBackoffMs` | 比特浏览器本地 API：默认地址 `http://127.0.0.1:54345`；单次开窗请求超时 30 秒；开窗失败最多重试 3 次；退避间隔 5 秒/30 秒/120 秒。环境变量 `BITBROWSER_API_BASE` 可覆盖地址 |
| `execution` | `concurrency`、`windowTimeoutMs`、`probeUrl`、`timezone`、`taskTimeoutMs`、`retryMax`、`retryBackoffSec`、`circuitBreakerThreshold`、`humanize` | 执行引擎：窗口并发默认 6；单窗口会话超时默认 15 分钟（到点剩余任务标「窗口超时」跳过）；`probeUrl` 是开窗后的探活地址；`timezone` 是 cron 时区；`taskTimeoutMs`/`retryMax`/`retryBackoffSec` 是单任务超时与重试的全局默认（任务 meta 可逐个覆盖）；`circuitBreakerThreshold` 是窗口熔断阈值（连续失败达到即跳过剩余任务）；`humanize.minDelayMs`/`humanize.maxDelayMs` 是拟人动作的随机停顿区间（默认 800/3000 毫秒） |
| `captcha` | `clientKey`、`apiBase`、`solveTimeoutMs`、`pollIntervalMs`、`maxCostPerTask`、`taskTypes` | 打码服务（yescaptcha）：`clientKey` 用环境变量 `CAPTCHA_CLIENT_KEY` 配置（**不要在 config.json 里明文写密钥**）；`maxCostPerTask` 是单任务打码费用上限（点数，1000 点 = ¥1）；`taskTypes` 是验证码类型 → 平台任务类型的映射 |
| `web` | `host`、`port` | 面板监听地址，默认 `127.0.0.1:3000`（仅本机可访问）。环境变量 `WEB_PORT` 可改端口；非整数或越界（不在 1-65535）时**静默忽略**，保留默认端口 |
| `wallet` | `passwords` | 窗口解锁密码映射（比特窗口 ID → 密码）。环境变量 `WALLET_PASSWORDS` 传 JSON 字符串，解析成功时**覆盖配置文件同名 key**；解析失败不抛错，保留配置文件值并在启动时告警（提醒检查 JSON 格式） |
| `storage` | `logLevel`、`prettyColorize`、`screenshotDir`、`logDir` | `logLevel` 控制日志级别（默认 `info`）；`prettyColorize` 控制终端日志颜色（缺省时按终端能力自动检测）；`screenshotDir`/`logDir` 是截图与日志的存放位置。`dbPath` 是**遗留字段**——数据层已全走云端数据库，云库模式下不生效，无需配置 |

### 8.2 面板使用

面板共五个页面（顶部导航切换），每个页面「在哪 / 能干什么」如下：

- **看板（首页）**：统计卡（成功/失败/验证码失败/跳过/进行中数量与打码花费）＋日期切换 ＋任务筛选下拉 ＋ 状态分段 tab（全部/失败/成功/进行中）＋ 任务执行矩阵表（窗口 × 任务 × 当日结果）。矩阵行级「执行」= 单窗口单任务触发（失败行显示「重跑」）；「重跑今日失败」把当日全部失败记录重新入队；「全部窗口执行」按钮**需先在下拉里选任务**，再把该任务推给全部启用窗口。停留在看板页时每 15 秒自动刷新。
- **窗口页**：搜索框（按名字/窗口 ID 过滤）；「同步比特浏览器」按钮把比特客户端里的窗口列表拉取入库；每行有启用开关；「立即跑」= 跑该窗口的全部启用任务；「详情」打开**弹窗**，展示该窗口今日任务时间线与「重置熔断」按钮。
- **任务页**：每张任务卡片显示分类徽章（签到/领水/铸币/其他）、备注、来源页链接；卡片开关写入云端 `task_states` 表，切换**立即生效**（停用即停 cron、重新启用即重注册 cron，无需重启）；「立即触发」= 该任务在全部启用窗口跑一遍。
- **文档页**：左侧目录树（本手册章节树 ＋ 三个示例任务源码），右侧渲染本手册正文；代码块默认折叠，点头部展开；正文滚动时目录自动高亮当前章节（滚动联动）。
- **设置页**：只读展示运行参数（比特 API 地址、并发、探活地址、时区等）；「测试连接」按钮验证比特浏览器本地 API 是否可达；「查询余额」展示 yescaptcha 剩余点数。

### 8.3 REST 接口总表

面板本身也是普通网页，下面的接口就是它背后的「服务员」，全部以 `/api` 开头、返回 JSON：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/dashboard` | 看板全部数据（统计/矩阵/窗口/打码成本），`?date=YYYY-MM-DD` 切换日期 |
| GET | `/api/tasks` | 任务列表（meta 全字段 ＋ 云端开关状态） |
| PATCH | `/api/tasks/:key` | 任务开关，body `{ "enabled": true \| false }`，写云端立即生效 |
| POST | `/api/tasks/:key/trigger` | 手动触发：body `{ "bitbrowserId" }` 只跑该窗口；不带 body 跑全部启用窗口 |
| GET | `/api/profiles` | 窗口列表（含启用状态与熔断计数） |
| PATCH | `/api/profiles/:id` | 窗口开关，body `{ "enabled": true \| false }` |
| POST | `/api/profiles/:id/run` | 该窗口跑全部**启用**任务（停用排除，返回 `count`） |
| POST | `/api/profiles/:id/breaker/reset` | 重置该窗口熔断计数 |
| POST | `/api/runs/rerun-failed` | 当日失败记录重新入队，body `{ "date": "YYYY-MM-DD" }`（缺省今天） |
| GET | `/api/captcha/balance` | 打码余额（`{ configured, points, yuan }`） |
| POST | `/api/bitbrowser/test` | 比特浏览器连接测试（`{ ok }`） |
| POST | `/api/bitbrowser/sync` | 同步比特窗口列表入库（`{ count }`） |
| GET | `/api/settings` | 公开只读设置（不含任何密钥） |
| GET | `/api/screenshots` | 取截图文件，`?path=` 传截图目录内的相对路径 |
| GET | `/api/docs/guide`、`/api/docs/examples`、`/api/docs/examples/:name` | 本手册 markdown 原文、示例文件清单、单个示例源码（白名单限定三个示例文件） |

---

## 9. 常用模式

### 完整示例：9 点签到的站点（公告弹窗 + 钱包登录 + 签到 + 等文案）

假设站点每天 9 点开放签到：打开页面先弹一个公告弹窗挡住一切，登录要用钱包，签到成功后页面会浮现「签到成功」文案。完整 `run()` 如下：

```ts
async run(ctx: TaskContext): Promise<void> {
  // 1. 打开站点入口（失败自动重试 3 次，每次隔 2-5 秒）
  await ctx.goto()

  // 2. 清掉公告弹窗：依次尝试点关闭按钮 → 点遮罩空白处 → 按 Esc，最后验证弹窗容器消失
  await ctx.closeModal({ close: ['.announce-close'], mask: '.announce-mask', gone: '.announce-modal' })

  // 3. 钱包登录：等站点唤起钱包弹窗 → 按窗口配置的密码解锁 → 点"连接"确认
  await ctx.loginByWallet()

  // 4. 点击签到按钮，并断言成功后出现的徽章（宁严勿松）
  await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })

  // 5. 蹲点等"签到成功"文案出现（最长 10 秒），等不到就抛错 → 进入重试流程
  await ctx.waitForText('签到成功')
}
```

对应的 `meta` 把「每天 9 点」交给错峰窗口（9:00-11:00 之间随机一分钟，多个窗口不扎堆）：

```ts
meta: TaskMeta = {
  key: 'nine-am-checkin',
  name: '九点签到',
  url: 'https://example.com/checkin',
  wallet: 'metamask',
  schedule: { stagger: ['09:00', '11:00'] },   // 每天 9:00-11:00 随机一分钟
  captcha: { auto: true },                      // 站点可能弹验证码（默认开启）
}
```

### 签到成功 / 已签到

```ts
// 成功：点击后断言成功标志（徽章/文案），宁严勿松
await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })

// 已签到：出现"已签到"类文案直接返回（run 正常返回 = 任务 success）
if (await ctx.textPresent('已签到')) return
```

### 签到前关闭公告/引导弹窗

很多站点打开即弹公告/新手引导层，挡住签到按钮。用 `closeModal` 一行清掉（详见第 3 章）：

```ts
await ctx.goto()
await ctx.closeModal({ close: ['.announce-close'], mask: '.announce-mask', gone: '.announce-modal' })
await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
```

遮罩点击原理：`closeModal` 的 `mask` 策略取遮罩 `boundingBox` 左上角内侧 12px 处做坐标点击（`human.clickAt`）——全屏遮罩的左上角必然是空白区域，不会命中居中弹窗主体；站点的 `event.target === mask` 判定（点在遮罩本体而非弹窗内容）因此成立，弹窗随之关闭。

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

### 等待接口返回再断言

有些站点点击后 UI 不更新（或更新滞后），但接口返回体有明确的业务状态。此时用 `waitForApi` 等接口并用返回体做断言：

```ts
await ctx.human.click('#claim-btn')
const body = await ctx.waitForApi('/api/claim', 15000) as { code: number; msg?: string }
if (body.code !== 0) throw new Error(`领取失败: ${body.msg ?? '未知错误'}`) // 抛错 → 失败重试流程
await ctx.assertVisible('.success-toast')                                     // UI 也确认一遍
```

### 读站点全局状态判断登录态 / 任务状态

站点注入的全局变量（`window.__APP_STATE__`、`window.__INITIAL_STATE__` 等）在自动化工具的隔离世界里读不到，用 `ctx.js`（主世界执行）读取：

```ts
const state = await ctx.js<{ user?: { id: string } }>(() => (window as any).__APP_STATE__)
if (!state?.user) throw new Error('登录态丢失')

const done = await ctx.js<boolean>(() => localStorage.getItem('claimed_today') === '1')
if (done) return   // 今日已做 → 直接成功
```

---

## 10. 排错

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
- **运行状态速查**：`pending → running → success | failed | captcha_failed | retry_wait → …`，`skipped` 表示开窗失败/探活失败/窗口超时/熔断跳过。

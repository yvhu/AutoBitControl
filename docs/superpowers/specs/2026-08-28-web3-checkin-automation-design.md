# AutoBitControl — Web3 自动签到任务系统 设计文档

日期：2026-08-28
状态：已与用户逐块确认

## 1. 目标与背景

比特浏览器中已配置好 100 个窗口（真实指纹 + 独立 IP）。系统按"窗口顺序"自动执行 Web3 签到任务：打开窗口 → 顺序跑完该窗口绑定的所有任务 → 关闭窗口 → 下一个窗口。同时最多 5-10 个窗口并发。

任务目标站点类型：项目方官网签到、测试网领水、铸币网站。任务流程以纯页面操作为主：登录（钱包登录）→ 钱包弹窗确认 → 点击签到，无链上交易。

核心要求：

- 尽量避免人机检测，行为拟人化；遇到验证码自动接入 yescaptcha
- 网络层面稳定、结果判定准确
- 开发者本人新增任务：灵活、快速、准确，接受代码方式
- 不需要推送通知；本地 Web 面板查看结果

## 2. 总体架构（方案 A：单进程调度器，已确认）

```
┌────────────────────────── AutoBitControl (Node 单进程) ──────────────────────────┐
│  Scheduler(croner) ─▶ Queue(p-queue, 并发5-10) ─▶ WindowRunner                  │
│       │                                            │ 开窗→CDP接管→顺序跑任务→关窗  │
│       │                              ┌─────────────▼────────────────┐            │
│       │                              │ Task 执行栈（每站点一 TS 模块） │            │
│       │                              │  Humanize │ WalletAdapter │ CaptchaSolver │
│       │                              └──────┬──────────┬────────────┘            │
│  BitBrowser API ◀───────────────────────────┘          │                         │
│  yescaptcha API ◀──────────────────────────────────────┘                         │
│  SQLite (better-sqlite3)  ◀──▶  状态/结果/验证码账单                                │
│  Web 面板 (Express)       ◀──▶  查看结果/手动触发/重跑失败                           │
└───────────────────────────────────────────────────────────────────────────────────┘
```

选择单进程而非多进程的理由：并发仅 5-10 窗口，CDP 为 WebSocket 异步驱动，Node 单进程完全胜任；无 IPC 复杂度，排查问题简单。隔离性由"每窗口独立 try/catch + 超时 + 熔断"保证，进程级由 watchdog 自动重启兜底。

## 3. 技术选型（全部为现成组件，已逐一核实）

| 维度 | 组件 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | Node.js + TypeScript | 20.9.0 | 机器已装 |
| 反检测驱动 | `patchright` (npm) | 1.62.1 | 官方 NodeJS 包，Playwright 补丁版；通过 CDP 接管比特浏览器窗口 |
| 鼠标拟人 | `ghost-cursor` | 1.4.2 | 只取轨迹生成，经 CDP `Input.dispatchMouseEvent` 派发（约 40 行适配） |
| 键盘拟人 | Playwright 原生 `keyboard.type` | 内置 | delay + 逐键；随机错键回删为参数化小工具函数 |
| 钱包弹窗 | `@synthetixio/synpress` | 4.1.2 | 官方 Playwright 支持；复用钱包交互逻辑，跳过其浏览器启动 |
| 钱包插件包 | `@synthetixio/synpress-metamask` / `@synthetixio/synpress-phantom` | 0.0.14 | MetaMask、Phantom 官方适配 |
| 验证码识别 | yescaptcha 官方 REST API | — | 全类型：Turnstile / reCAPTCHA v2/v3 / hCaptcha / 图片类 |
| 随机人设数据 | `@faker-js/faker` | — | 领水注册等场景 |
| 调度 | `croner` | — | cron + 错峰窗口 |
| 并发队列 | `p-queue` | — | 窗口并发上限 5-10 |
| 存储 | `better-sqlite3` | — | 同步 API，单进程无并发问题 |
| 日志 | `pino` | — | 结构化日志 + 文件输出 |
| 面板 | `express` + 静态页 | — | 本地 Web 面板 |
| 指纹/IP | 比特浏览器原生 | 已配好 | 最强的防检测基础，系统不干预 |

### 3.1 已确认的三个边界（避免踩坑）

1. **patchright 补丁分两层**：驱动层补丁（Runtime.enable 泄露、Console.enable 泄露、闭包 Shadow DOM）走 CDP 连接依然生效；浏览器启动 flags 由比特浏览器决定——比特浏览器本身是指纹浏览器，自带反检测，两者互补。
2. **Synpress 仅官方支持 MetaMask/Phantom**。它是"自己启动浏览器+测试"的框架，本项目只复用其钱包页面操作逻辑（选择器/交互流程）。Rabby、OKX 等钱包的确认弹窗适配器需手写（约 100-200 行/个，按需增加）。
3. **验证码检测无现成库**：检测页面出现哪种验证码并提取 sitekey 需自写扫描逻辑（几十行）；打码本身是 yescaptcha 现成服务。

## 4. 任务模型

新增一个站点 = 在 `src/tasks/` 建一个 TS 类继承 `SiteTask`，注册到任务表：

```ts
export default class MySiteTask extends SiteTask {
  meta = {
    id: 'mysite-daily',
    name: 'MySite 每日签到',
    schedule: '0 9 * * *',                 // cron；或 { 错峰: ['9:00','11:00'] }
    wallet: 'metamask',                    // 需要的钱包适配器
    timeoutSec: 180,
    retry: { max: 2, backoffSec: 600 },
    captcha: { provider: 'yescaptcha', auto: true, maxCost: 1.5 }
  }

  async run(ctx: TaskContext) {
    await ctx.goto('https://mysite.io')
    await ctx.loginByWallet()
    await ctx.clickCheckin('button.checkin', { assert: '.checked' })
  }
}
```

- `ctx` 提供：拟人点击/输入/滚动、钱包弹窗确认、验证码自动处理、成功断言、截图、页面状态识别（已签到/频率限制/维护中）
- 复杂任务直接在 `run()` 里写任意代码，框架不限制
- 任务-窗口绑定关系存 SQLite，可分组、可启停

## 5. 拟人化策略

| 维度 | 手段 |
|---|---|
| 指纹/IP | 比特浏览器原生（已配好） |
| 自动化痕迹 | patchright 驱动层补丁 + CDP 接管真实比特浏览器 |
| 鼠标 | ghost-cursor 贝塞尔轨迹 + Fitts 定律速度 + 过冲回正 + 点击前 hover |
| 键盘 | 逐键延迟输入 + 随机错键回删 |
| 节奏 | 步骤间随机延迟；每日执行时间错峰窗口内随机；窗口启动顺序随机 |
| 页面行为 | 点击前 hover、随机小幅滚动、避免固定"打开即点"模式 |
| 状态识别 | 自动识别"已签到/频率限制/维护中/验证码"分支 |

## 6. 验证码处理（yescaptcha）

1. 页面加载后轮询扫描常见验证码形态（Turnstile iframe、reCAPTCHA、hCaptcha、极验等）
2. 检测到 → 提取 sitekey → 调 yescaptcha 创建任务 → 轮询结果 → token 回填 → 继续
3. 超时/余额不足 → 任务标记 `captcha_failed`，截图留证，不无限烧钱（单任务打码费用上限可配）

## 7. 稳定性与准确性

### 7.1 网络与连接

- 开窗失败：指数退避重试 3 次（5s/30s/2min），仍失败则窗口本轮跳过
- CDP 断线：自动重连 2 次；浏览器崩溃：关窗重开跑剩余任务
- 页面加载：超时/断网/白屏 → 同页重试 2 次 → `failed` 带截图
- IP 探活：开窗后先访问探活 URL，代理失效 → 熔断该窗口本轮所有任务
- 窗口熔断器：连续 2 个任务失败 → 跳过剩余任务

### 7.2 结果状态机

```
pending ──▶ running ──▶ success
                 │
                 ├─▶ retry_wait ──▶ running    （指数退避重试）
                 ├─▶ captcha_failed           （打码失败/余额不足，截图）
                 └─▶ failed                   （重试耗尽，截图+HTML 快照）
```

- 每个任务必须显式成功断言（选择器/文本/URL），不靠猜测
- `runs` 表按 `窗口×任务×日期` 唯一，重跑自动覆盖
- 失败自动存档：截图 + 页面 HTML + 日志

### 7.3 SQLite 表

- `profiles`：比特窗口 ID、名称、状态（启用/暂停）、绑定任务、今日熔断计数
- `tasks`：任务元数据（id、name、cron、钱包、重试配置）
- `runs`：窗口×任务×日期 → 状态、时间、重试次数、截图路径
- `captcha_logs`：每次打码的时间、类型、费用、结果

### 7.4 Web 面板

- 看板：今日完成率、窗口×任务矩阵、失败列表（附截图）、验证码消费统计
- 操作：手动触发（指定窗口×任务）、重跑今日全部失败、暂停/恢复窗口

## 8. 目录结构

```
AutoBitControl/
├── src/
│   ├── core/
│   │   ├── scheduler.ts        # croner 调度 + 错峰
│   │   ├── queue.ts            # p-queue 窗口并发队列
│   │   ├── bitbrowser.ts       # 比特浏览器 API 客户端
│   │   ├── windowRunner.ts     # 开窗→CDP接管→顺序跑任务→关窗
│   │   ├── humanize.ts         # ghost-cursor CDP 适配 + 延迟/输入工具
│   │   ├── captcha.ts          # 验证码检测 + yescaptcha 客户端
│   │   ├── wallet/             # 钱包适配器（synpress 复用 + 自定义）
│   │   ├── db.ts               # better-sqlite3
│   │   └── state.ts            # 状态机
│   ├── tasks/
│   │   ├── index.ts            # 任务注册表
│   │   └── example-checkin.ts  # 示例任务
│   ├── web/                    # Express 面板 + 静态页
│   └── index.ts                # 入口
├── config/
│   ├── config.json             # BitBrowser API、并发数、探活 URL
│   └── .env                    # yescaptcha key 等敏感信息
├── data/                       # SQLite、截图、日志（gitignore）
├── package.json
└── tsconfig.json
```

## 9. 实施顺序（MVP 优先）

1. 骨架 + BitBrowser 开窗/CDP 接管 + 关窗
2. 任务基类 + ctx（拟人层、断言、截图）+ 1 个示例任务跑通
3. 验证码检测 + yescaptcha 接入
4. 调度器 + 队列 + 状态机 + SQLite
5. Web 面板
6. 钱包适配器（MetaMask/Phantom 优先，其他按需）

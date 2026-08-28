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
| 钱包弹窗 | 自研薄适配器（`src/core/wallet/`） | 每个钱包约 100-200 行 | Petra、MetaMask 优先；选择器参考 Synpress/Chainwright 开源实现 |
| 验证码识别 | yescaptcha 官方 REST API | — | 全类型：Turnstile / reCAPTCHA v2/v3 / hCaptcha / 图片类 |
| 随机人设数据 | `@faker-js/faker` | — | 铸币网站填写代币信息（名称/符号/描述等）时生成拟人化随机数据 |
| 调度 | `croner` | — | cron + 错峰窗口 |
| 并发队列 | `p-queue` | — | 窗口并发上限 5-10 |
| 存储 | `better-sqlite3` | — | 同步 API，单进程无并发问题 |
| 日志 | `pino` | — | 结构化日志 + 文件输出 |
| 面板 | `express` + 静态页 | — | 本地 Web 面板 |
| 指纹/IP | 比特浏览器原生 | 已配好 | 最强的防检测基础，系统不干预 |

### 3.1 已确认的三个边界（避免踩坑）

1. **patchright 补丁分两层**：驱动层补丁（Runtime.enable 泄露、Console.enable 泄露、闭包 Shadow DOM）走 CDP 连接依然生效；浏览器启动 flags 由比特浏览器决定——比特浏览器本身是指纹浏览器，自带反检测，两者互补。
2. **钱包弹窗无对口的现成库**：Synpress 仅官方支持 MetaMask/Phantom，chainwright 支持 Petra 但两者都是"自己启动浏览器+导入助记词"的测试框架，且写死钱包扩展版本（chainwright 要求 Node ≥ 22.18，与当前 Node 20 不兼容）。本项目的钱包是真实钱包、已装在比特浏览器里，因此钱包弹窗适配器自研（Petra、MetaMask 优先，每个约 100-200 行），写时可参考这两个库的开源选择器。这是唯一绕不开的自研点。
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

- `profiles`：比特窗口 ID、名称、状态（启用/暂停）、钱包解锁密码（按窗口）、今日熔断计数
- `tasks`：任务元数据（id、name、cron、钱包、重试配置）
- `runs`：窗口×任务×日期 → 状态、时间、重试次数、截图路径
- `captcha_logs`：每次打码的时间、类型、费用、结果

### 7.4 错峰窗口（防风控）

同一站点的 100 个窗口不在同一秒集中访问。任务 cron 可配置为错峰窗口（如 `9:00-11:00`），每个窗口在该区间内随机取一个时间点执行，站点看到的是自然分散的访问节奏。

### 7.5 Web 面板

- **调用链路**：页面只请求同源的本服务 API（`http://127.0.0.1:<面板端口>`）；比特浏览器本地 API、yescaptcha、SQLite、开窗跑任务全部由 Node 后端进程执行，页面不直接触碰任何本地 API，不存在跨域/混合内容问题
- 面板仅监听 `127.0.0.1`，不上公网

#### 7.5.1 UI 设计（已确认，深色主题 + 左侧导航 4 页）

结构：左侧固定导航（看板 / 窗口 / 任务 / 设置）+ 顶栏全局状态（比特浏览器连接状态、yescaptcha 余额）+ 内容区。视觉基调：深蓝黑底（#0B0F19）、渐变卡片、紫蓝渐变主按钮、状态徽章（成功绿/失败红/验证码失败天蓝/执行中黄带脉冲/跳过灰）、等宽字体显示配置值。

1. **看板（默认页）**：4 张统计卡——今日完成率（圆环进度 87%+趋势）、结果分布（计数+堆叠条）、验证码（消费金额/次数/类型分布迷你柱状图）、实时运行（当前并发/排队数/进度条）；任务执行矩阵：日期+任务筛选、状态分段 tab（全部/失败/成功/进行中）、搜索框、`▶ 全部窗口执行`/`↻ 重跑今日失败`；矩阵表列：窗口(头像+名+ID)、任务、状态徽章、尝试次数、错误信息（截断+悬浮完整）、截图缩略图（点击弹大图）、操作（执行/重跑）
2. **窗口管理**：搜索 + `同步比特浏览器` 按钮；窗口表列：窗口（头像+名+ID）、今日结果（✓✗ 计数）、熔断计数（进度条）、启用开关、操作（立即跑/详情）；点详情滑出抽屉：该窗口今日任务时间线（成功/失败/执行中节点+截图）+ 本窗口钱包解锁密码设置（修改）
3. **任务列表**：任务卡片——钱包图标（🦊 MetaMask / 🐍 Petra 等按适配器）、任务名+key、meta 徽章（cron/错峰、超时、重试、验证码上限）、启用状态、`立即触发` 按钮；任务定义在代码，此页只读展示与触发
4. **设置**：全部只读——比特浏览器 API 地址+`测试连接`（调 /health）、执行参数（并发/探活 URL/时区）、yescaptcha Key 状态+`查询余额`（显示点数与 ¥）；修改走 config 文件+重启（配置单一来源）

说明：钱包类型是**任务级**配置（TaskMeta.wallet，在任务卡片上展示），不是窗口级；窗口级只保留「该窗口钱包解锁密码」（每窗口账号不同）。后续可按此基调继续打磨视觉细节。

## 8. 配置管理（尽量配置化）

原则：**能配置的不写死**。三层配置 + 环境变量覆盖：

| 层 | 文件 | 内容 |
|---|---|---|
| 通用配置 | `config/config.json` | 非敏感参数，可提交（含示例值） |
| 本地覆盖 | `config/config.local.json` | 本机实际值，gitignore，覆盖 config.json |
| 密钥 | `config/.env` | yescaptcha clientKey 等，gitignore |

主要配置参数：

- **比特浏览器**：API 地址（默认 `http://127.0.0.1:54345`）、开窗参数、超时、重试次数与退避间隔
- **执行**：并发窗口数（5-10）、每窗口任务超时、失败重试次数、窗口熔断阈值、探活 URL、错峰窗口
- **验证码**：yescaptcha API 地址、clientKey、打码超时、单任务费用上限
- **面板**：监听地址/端口
- **存储**：SQLite 路径、截图/日志目录、日志级别
- **钱包解锁密码**：按窗口存在 SQLite（`profiles` 表），不进配置文件

## 9. 目录结构

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
│   │   ├── wallet/             # 钱包适配器（petra.ts / metamask.ts，可扩展）
│   │   ├── config.ts           # 配置加载与合并（config.json + local + .env）
│   │   ├── db.ts               # better-sqlite3
│   │   └── state.ts            # 状态机
│   ├── tasks/
│   │   ├── index.ts            # 任务注册表
│   │   └── example-checkin.ts  # 示例任务
│   ├── web/                    # Express 面板 + 静态页
│   └── index.ts                # 入口
├── config/
│   ├── config.json             # 通用配置模板
│   ├── config.local.json       # 本机覆盖（gitignore）
│   └── .env                    # 敏感密钥（gitignore）
├── data/                       # SQLite、截图、日志（gitignore）
├── package.json
└── tsconfig.json
```

## 10. 实施顺序（MVP 优先）

1. 骨架 + BitBrowser 开窗/CDP 接管 + 关窗
2. 任务基类 + ctx（拟人层、断言、截图）+ 1 个示例任务跑通
3. 验证码检测 + yescaptcha 接入
4. 调度器 + 队列 + 状态机 + SQLite
5. Web 面板
6. 钱包适配器（Petra、MetaMask 优先，其他按需增加）
7. watchdog 自动重启（进程崩溃自愈）

## 11. 运行与部署

- **运行方式**：源码模式。`git pull → npm install → 配置 → npm start` 常驻后台；更新即拉代码重启
- **运行位置**：必须与比特浏览器同一台机器（其 API 仅监听 localhost）
- **开机自启**：pm2 或 Windows 服务/计划任务注册，机器重启后自动拉起（含 watchdog 兜底）
- **不做 exe 打包**：开发者需频繁新增任务代码，源码模式迭代最方便

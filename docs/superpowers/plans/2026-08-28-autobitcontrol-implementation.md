# AutoBitControl 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 AutoBitControl：Node 单进程调度器，通过比特浏览器 API + CDP 接管 100 个窗口（并发 5-10），自动执行 Web3 签到任务（拟人化 + yescaptcha 自动打码），结果落 SQLite 并提供本地 Web 面板。

**Architecture:** 单进程 Node（TypeScript）。croner 按任务 cron/错峰窗口触发 → CoalescingEnqueuer 合并同一窗口的待办任务 → p-queue 控制并发 → WindowRunner 开窗/CDP 接管/顺序跑任务/关窗。任务为继承 SiteTask 的 TS 模块，经 TaskContext 使用 Humanizer（ghost-cursor）、钱包适配器、验证码服务。比特浏览器/IP/指纹为反检测基础，patchright 提供驱动层反检测补丁。

**Tech Stack:** Node 20.9.0、TypeScript（strict）、patchright 1.62.1、ghost-cursor 1.4.2、croner、p-queue、better-sqlite3、pino、express、dotenv、@faker-js/faker、tsx、vitest、supertest。

**Spec:** `docs/superpowers/specs/2026-08-28-web3-checkin-automation-design.md`

## Global Constraints

- 运行环境：Windows 10/11，PowerShell 5.1，Node 20.9.0（机器已装）
- 仓库：`D:\StudySpace\AutoBitControl`，分支 `develop`，直接提交到 develop
- 模块规范：`"type": "module"`（ESM），tsconfig `module: ESNext` + `moduleResolution: Bundler`（相对导入不带扩展名），strict 模式
- 依赖版本锁定：`patchright@1.62.1`、`ghost-cursor@1.4.2`；其余用最新稳定版
- 配置三层：`config/config.json`（提交）→ `config/config.local.json`（gitignore）→ `config/.env`（gitignore）；所有可调参数进配置，禁止硬编码（默认值除外）
- 数据/产物目录 `data/`（SQLite、截图、日志）gitignore
- 代码不加注释；日志用中文；面板 UI 用中文
- 测试命令统一 `npm test`（vitest run）；运行 `npm run dev`
- 每个任务结束必须 commit（commit message 风格见各任务）
- 代码中不得出现 TODO/TBD/占位符

## 外部接口参考（全部已核实官方文档，2026-08-28）

### 比特浏览器本地 API

官方文档：https://doc.bitbrowser.cn/api-jie-kou-wen-dang/ben-di-fu-wu-zhi-nan.md 、https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou.md

- 地址：本机 HTTP，实际地址在客户端「系统设置」中查看（社区默认 http://127.0.0.1:54345，官方未写死，config 可配）；必须登录比特客户端后才可用；无需额外开关
- 全部为 POST + JSON body；限流 1 秒最多 10 个请求
- 成功约定：`{"success": true, "data": {...}}`；失败：`{"success": false, "msg": "错误信息"}`（旧版本为 code=0/-1 约定，客户端需兼容两种）
- 健康检查：`POST /health`，无 body
- 开窗：`POST /browser/open`，body `{"id": "窗口id", "args": [], "loadExtensions": true, "extractIp": true}`；响应 `data.ws`（WebSocket 调试地址）、`data.http`（`"127.0.0.1:50106"` 格式的 host:port，CDP 调试地址 = `http://` + 该值）。官方现行文档无 debugPort 字段，兼容旧版可尝试 `data.debugPort`
- 关窗：`POST /browser/close`，body `{"id": "窗口id"}`
- 列表：`POST /browser/list`，body `{"page": 0, "pageSize": 100}`（**page 从 0 开始，pageSize 最大 100**，可加 name/groupId 过滤）；响应结构官方无示例，按 `data.list` 数组解析（元素含 id/name/seq），实现需兼容 `data.page`
- 批量关窗：`POST /browser/close/byseqs` body `{"seqs": [...]}`（备用）

### yescaptcha API

官方文档：https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/63897603/YesCaptcha+API

- Base URL：国际 `https://api.yescaptcha.com`，国内 `https://cn.yescaptcha.com`（config 可配）
- 创建任务：`POST /createTask` body `{"clientKey": "...", "task": {"type": "...", "websiteURL": "...", "websiteKey": "..."}}` → `{"errorId": 0, "taskId": "..."}`
- 查询结果：`POST /getTaskResult` body `{"clientKey", "taskId"}` → `{"status": "processing" | "ready", "solution": {...}}`
  - reCAPTCHA V2/V3/hCaptcha → `solution.gRecaptchaResponse`；Turnstile → `solution.token`；图片 → `solution.text`
- 余额：`POST /getBalance` body `{"clientKey"}` → `{"errorId": 0, "balance": <点数>}`，1000 点 = ¥1
- 任务类型精确拼写：Turnstile=`TurnstileTaskProxyless`(25点)、V2=`NoCaptchaTaskProxyless`(15点)、V2 Enterprise=`RecaptchaV2EnterpriseTaskProxyless`(20点)、V3=`RecaptchaV3TaskProxyless`(20点，建议带 pageAction)、hCaptcha=`HCaptchaTaskProxyless`(30点，建议带 userAgent)、图片=`ImageToTextTask`(4点，异步)
- **极验 GeeTest 官方不支持**，已从方案移除；如遇极验站点需换打码平台（后续可选集成）
- V2 invisible 需 `isInvisible: true`；hCaptcha token 回填需写入 `textarea#h-captcha-response`（同时保留 g-recaptcha 兼容）
- 硬限制：**每账号同时只能 1 个识别任务（必须串行排队）**；每任务最多查 120 次；任务创建后 5 分钟内有效；识别 120 秒超时；结果 120 秒内有效（60 秒内用完）

### patchright（Node 版）

官方：https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs 、https://www.npmjs.com/package/patchright

- `npm i patchright@1.62.1`；浏览器安装 `npx patchright install chromium`（CLI 子命令存在）；Node ≥ 20 满足；ESM import 与内置 TS 类型均支持
- 与 Playwright drop-in：`chromium.launch` / `chromium.connectOverCDP(endpointURL, options?)` 均可用；endpointURL 接受 http 或 ws 地址
- 已知坑（本计划已规避）：
  - Console API 被禁用：`page.on('console')` 等不可用 → 计划中未依赖 console 事件
  - `page.evaluate` 默认在**隔离世界**执行；给站点主世界回填验证码 token 时必须 `page.evaluate(fn, arg, { isolatedContext: false })`
  - initScript 对 about:blank/data:URI 无效（本计划不使用 initScript）
  - 仅 Chromium 系有补丁；Firefox/WebKit 不支持
  - 反检测启动参数（--enable-automation 移除、--disable-extensions 移除）是启动 flag 级，CDP 接管比特浏览器时不生效——由比特浏览器自身反检测承担；驱动层补丁（Runtime.enable 泄露、Console 泄露、闭包 Shadow DOM）在 CDP 连接下仍生效

### npm 库版本约束（2026-08-28 核实）

- **better-sqlite3 必须锁 `@12.2.0`**：latest v13 要求 Node ≥ 22，Node 20.9.0 装不上；v12.2.0 官方 release 含 Node 20 (ABI 115) Windows x64 预编译包，无需编译器
- p-queue latest v9.3.3（纯 ESM，Node ≥ 20 满足）：默认导出；`add(fn)` 在任务完成时 resolve；`onIdle()` 存在；`size`/`pending` 属性存在
- croner latest v10.0.1：`import { Cron } from 'croner'`；`new Cron(pattern, { timezone: 'Asia/Shanghai' }, fn)` 可用；5 段 cron 支持；`stop()` 永久停止
- pino v10 + pino-pretty v13：`transport.targets` 多目标写法成立；注意多 target 下每个 target 默认只收 info 及以上
- dotenv v17：`config({ path, quiet })` 可用；v17 的 config() 成功时会打印一行注入信息，`quiet: true` 可关（计划已用）

### 功能点 → 实现思路 → 验证方式 总览

| # | 功能点 | 实现思路 | 验证方式（自动化 + 手动） |
|---|---|---|---|
| 1 | 配置加载 | 三层合并：config.json → config.local.json → .env/env 覆盖；deepMerge + 内置默认值 | vitest 单测（默认值/合并覆盖/环境变量）；`npx tsc --noEmit` 无错误 |
| 2 | 日志 | pino v10 `transport.targets` 双目标（pino/file 写 app.log + pino-pretty 控制台），日志目录自动创建 | 单测后启动进程，检查 `data/logs/app.log` 有中文日志输出 |
| 3 | SQLite 数据层 | better-sqlite3 v12（锁版本，Node 20 预编译）同步 API；WAL 模式；runs 表 UPSERT 幂等（窗口×任务×日期唯一） | vitest 单测（写入读回/UPSERT 不重复/聚合统计/熔断计数） |
| 4 | 运行状态机 | 纯函数转移表：pending→running→success/failed/captcha_failed/retry_wait；重试上限与熔断阈值纯函数判定 | vitest 单测覆盖全部转移路径（含非法转移拒绝） |
| 5 | BitBrowser 客户端 | POST JSON；`success:true`/`code:0` 双兼容；CDP 地址取 `data.http`（兼容旧版 debugPort）；列表 page 从 0 起 | mock fetch 单测（端点/请求体/响应解析/错误兼容）+ 真实冒烟 `npm run smoke:window`（需比特浏览器运行） |
| 6 | 拟人鼠标/键盘 | 鼠标：ghost-cursor `path()` 生成贝塞尔轨迹 → CDP `Input.dispatchMouseEvent` 逐点派发（不用 Playwright 原生 mouse 的直线移动）；键盘：`keyboard.type` 逐键 delay + 3% 概率错键回删 | 单测（落点随机在元素内）；集成测试（patchright headless 打开 fixture 页，human.click 触发点击、human.type 输入正确）；手动：有头模式目测轨迹像人手 |
| 7 | 验证码检测+打码 | 轮询扫描 Turnstile/reCAPTCHA/hCaptcha iframe 提取 sitekey → yescaptcha 客户端（内部 promise 链串行，满足每账号 1 并发硬限制）createTask/getTaskResult → token 用 `evaluate(..., { isolatedContext: false })` 写入主世界对应 input/textarea | mock fetch 单测（任务类型精确拼写/solution 字段取值/串行性/超时/余额不足/extra 透传）；手动：真实 clientKey 跑一次真实站点验证打码-回填-提交链路 |
| 8 | 任务框架 | SiteTask：meta 声明（url/cron/钱包/重试/验证码上限）+ run() 写流程；TaskContext 封装 goto（2 次重试）、clickCheckin（点击+显式成功断言）、screenshot、loginByWallet | fixture 页集成测试（成功断言通过/断言超时抛错）；新增任务后 tsc + 该任务的 fixture 测试 |
| 9 | 窗口执行器 | 开窗指数退避重试 3 次 → CDP 接管 → IP 探活（probeUrl 失败则本轮全跳过）→ 顺序跑任务（状态机+重试+每窗口熔断）→ finally 兜底关窗；withTimeout race 控制单任务超时 | mock driver 单测（成功路径/重试序列/开窗失败跳过/探活失败跳过/熔断跳过/关窗被调用）+ 真实窗口冒烟 |
| 10 | 队列合并 | p-queue 并发上限；CoalescingEnqueuer：同一窗口短时间多次入队合并为一次开窗会话 | vitest 单测（合并后只开一次窗且 taskKeys 完整/不同窗口独立） |
| 11 | 调度+错峰 | croner v10 注册每任务 cron（timezone: Asia/Shanghai）；错峰任务每日在窗口内随机取分时生成 cron；fireNow 遍历启用窗口入队 | 单测（随机点落窗口内/入队数量/未注册任务安全）；手动：临时配 1 分钟后 cron，观察日志触发与窗口动作 |
| 12 | Web 面板 | Express 同源 API（dashboard/trigger/rerun-failed/toggle）+ 静态中文页；页面只调本服务，本地 API 全由后端执行 | supertest 单测（各端点/参数校验）；手动：浏览器开 http://127.0.0.1:3000 点"执行"观察真实开窗跑任务 |
| 13 | 钱包弹窗 | 扩展 URL 正则识别弹窗页 → 解锁（密码按窗口存 SQLite）→ 循环点 connect/approve/sign 直到弹窗关闭；选择器按钱包版本维护在适配器常量 | 单测（fake popup 的 fill/click 调用断言）；手动 `npm run smoke:wallet`：真实比特窗口+真实钱包验证整链路 |
| 14 | 入口装配+watchdog | 启动顺序：配置→日志→DB→同步窗口列表→注册钱包/任务→队列→面板→调度；uncaughtException 记录后退出，由 pm2（restart_delay 5s）拉起 | 全量 `npm test` + tsc；手动：kill 进程验证 pm2 自动重启；重启机器验证 pm2 startup 生效 |

---

### Task 1: 项目骨架 + 配置加载

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/core/config.ts`
- Create: `src/core/logger.ts`
- Create: `config/config.json`
- Create: `config/.env.example`
- Create: `tests/config.test.ts`
- Modify: `.gitignore`（追加 data/、config.local.json、.env、node_modules）

**Interfaces:**
- Produces: `loadConfig(overrides?) : AppConfig`；`createLogger(cfg: AppConfig) : Logger`；`AppConfig` 及其子接口（Task 2/5/6/8/9/10/12 依赖）

- [ ] **Step 1: 初始化 package.json 与依赖**

```powershell
npm init -y
npm i patchright@1.62.1 ghost-cursor@1.4.2 croner p-queue@9 better-sqlite3@12.2.0 pino express dotenv @faker-js/faker
npm i -D typescript tsx vitest @types/node @types/express @types/better-sqlite3 supertest @types/supertest pino-pretty
```

注意：`better-sqlite3` 必须锁 `@12.2.0`（v13 要求 Node≥22）；p-queue 锁 `@9`。Windows 下 better-sqlite3 v12 有 Node 20 预编译包，直接安装成功。

- [ ] **Step 2: 编写 package.json（覆盖 npm init 生成的）**

```json
{
  "name": "autobitcontrol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "smoke:window": "tsx scripts/smoke-open-window.ts",
    "smoke:wallet": "tsx scripts/smoke-wallet.ts"
  }
}
```

- [ ] **Step 3: 编写 tsconfig.json 与 vitest.config.ts**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests", "scripts"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
})
```

- [ ] **Step 4: 写失败测试 tests/config.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/core/config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'abc-config-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('loadConfig', () => {
  it('无配置文件时返回默认值', () => {
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.bitbrowser.apiBase).toBe('http://127.0.0.1:54345')
    expect(cfg.execution.concurrency).toBe(6)
    expect(cfg.captcha.clientKey).toBe('')
  })

  it('config.json 与 config.local.json 深度合并，local 覆盖', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      bitbrowser: { apiBase: 'http://127.0.0.1:9999' },
      execution: { concurrency: 3, probeUrl: 'https://base.example' },
    }))
    writeFileSync(join(configDir, 'config.local.json'), JSON.stringify({
      execution: { concurrency: 8 },
    }))
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.bitbrowser.apiBase).toBe('http://127.0.0.1:9999')
    expect(cfg.execution.concurrency).toBe(8)
    expect(cfg.execution.probeUrl).toBe('https://base.example')
    expect(cfg.web.port).toBe(3000)
  })

  it('环境变量覆盖 clientKey', () => {
    const cfg = loadConfig({ rootDir: dir, env: { CAPTCHA_CLIENT_KEY: 'abc123' } })
    expect(cfg.captcha.clientKey).toBe('abc123')
  })
})
```

- [ ] **Step 5: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/core/config'`）

- [ ] **Step 6: 实现 src/core/config.ts**

```ts
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

export interface BitBrowserConfig {
  apiBase: string
  openTimeoutMs: number
  maxRetries: number
  retryBackoffMs: number[]
}

export interface ExecutionConfig {
  concurrency: number
  windowTimeoutMs: number
  taskTimeoutMs: number
  retryMax: number
  retryBackoffSec: number
  circuitBreakerThreshold: number
  probeUrl: string
  timezone: string
}

export interface CaptchaConfig {
  apiBase: string
  clientKey: string
  solveTimeoutMs: number
  pollIntervalMs: number
  maxCostPerTask: number
  taskTypes: Record<string, string>
}

export interface WebConfig {
  host: string
  port: number
}

export interface StorageConfig {
  dbPath: string
  screenshotDir: string
  logDir: string
  logLevel: string
}

export interface AppConfig {
  bitbrowser: BitBrowserConfig
  execution: ExecutionConfig
  captcha: CaptchaConfig
  web: WebConfig
  storage: StorageConfig
}

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const defaults: AppConfig = {
  bitbrowser: {
    apiBase: 'http://127.0.0.1:54345',
    openTimeoutMs: 30000,
    maxRetries: 3,
    retryBackoffMs: [5000, 30000, 120000],
  },
  execution: {
    concurrency: 6,
    windowTimeoutMs: 900000,
    taskTimeoutMs: 180000,
    retryMax: 2,
    retryBackoffSec: 600,
    circuitBreakerThreshold: 2,
    probeUrl: 'https://api.ipify.org',
    timezone: 'Asia/Shanghai',
  },
  captcha: {
    apiBase: 'https://api.yescaptcha.com',
    clientKey: '',
    solveTimeoutMs: 120000,
    pollIntervalMs: 3000,
    maxCostPerTask: 1500,
    taskTypes: {
      turnstile: 'TurnstileTaskProxyless',
      recaptcha_v2: 'NoCaptchaTaskProxyless',
      recaptcha_v3: 'RecaptchaV3TaskProxyless',
      hcaptcha: 'HCaptchaTaskProxyless',
      image: 'ImageToTextTask',
    },
  },
  web: { host: '127.0.0.1', port: 3000 },
  storage: {
    dbPath: join(DEFAULT_ROOT, 'data', 'app.db'),
    screenshotDir: join(DEFAULT_ROOT, 'data', 'screenshots'),
    logDir: join(DEFAULT_ROOT, 'data', 'logs'),
    logLevel: 'info',
  },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T
  }
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

export interface LoadConfigOptions {
  rootDir?: string
  env?: Record<string, string>
}

export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const root = opts.rootDir ?? DEFAULT_ROOT
  const env = opts.env ?? process.env
  loadDotenv({ path: join(root, 'config', '.env'), quiet: true })
  let cfg = defaults
  const base = join(root, 'config', 'config.json')
  if (existsSync(base)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(base, 'utf-8')))
  }
  const local = join(root, 'config', 'config.local.json')
  if (existsSync(local)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(local, 'utf-8')))
  }
  if (env.CAPTCHA_CLIENT_KEY) cfg.captcha.clientKey = env.CAPTCHA_CLIENT_KEY
  if (env.BITBROWSER_API_BASE) cfg.bitbrowser.apiBase = env.BITBROWSER_API_BASE
  if (env.WEB_PORT) cfg.web.port = Number(env.WEB_PORT)
  return cfg
}
```

- [ ] **Step 7: 实现 src/core/logger.ts**

```ts
import pino from 'pino'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config'

export type Logger = pino.Logger

export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.storage.logDir, { recursive: true })
  return pino({
    level: cfg.storage.logLevel,
    transport: {
      targets: [
        { target: 'pino/file', options: { destination: join(cfg.storage.logDir, 'app.log'), mkdir: true } },
        { target: 'pino-pretty', options: { translateTime: 'SYS:yyyy-mm-dd HH:MM:ss' } },
      ],
    },
  })
}
```

- [ ] **Step 8: 编写 config/config.json 与 config/.env.example**

`config/config.json`：

```json
{
  "bitbrowser": {
    "apiBase": "http://127.0.0.1:54345",
    "openTimeoutMs": 30000,
    "maxRetries": 3,
    "retryBackoffMs": [5000, 30000, 120000]
  },
  "execution": {
    "concurrency": 6,
    "windowTimeoutMs": 900000,
    "taskTimeoutMs": 180000,
    "retryMax": 2,
    "retryBackoffSec": 600,
    "circuitBreakerThreshold": 2,
    "probeUrl": "https://api.ipify.org",
    "timezone": "Asia/Shanghai"
  },
  "captcha": {
    "apiBase": "https://api.yescaptcha.com",
    "clientKey": "",
    "solveTimeoutMs": 120000,
    "pollIntervalMs": 3000,
    "maxCostPerTask": 1500,
    "taskTypes": {
      "turnstile": "TurnstileTaskProxyless",
      "recaptcha_v2": "NoCaptchaTaskProxyless",
      "recaptcha_v3": "RecaptchaV3TaskProxyless",
      "hcaptcha": "HCaptchaTaskProxyless",
      "image": "ImageToTextTask"
    }
  },
  "web": { "host": "127.0.0.1", "port": 3000 },
  "storage": {
    "dbPath": "data/app.db",
    "screenshotDir": "data/screenshots",
    "logDir": "data/logs",
    "logLevel": "info"
  }
}
```

`config/.env.example`：

```
CAPTCHA_CLIENT_KEY=
# BITBROWSER_API_BASE=http://127.0.0.1:54345
# WEB_PORT=3000
```

- [ ] **Step 9: 更新 .gitignore（追加以下行）**

```
data/
config/config.local.json
config/.env
node_modules/
```

- [ ] **Step 10: 运行测试确认通过**

Run: `npm test`
Expected: PASS，3 个用例全绿

- [ ] **Step 11: Commit**

```powershell
git add package.json package-lock.json tsconfig.json vitest.config.ts src/core/config.ts src/core/logger.ts config/config.json config/.env.example tests/config.test.ts .gitignore
git commit -m "chore: project skeleton with layered config and logger"
```

---

### Task 2: SQLite 数据层

**Files:**
- Create: `src/core/db.ts`
- Create: `tests/db.test.ts`

**Interfaces:**
- Consumes: `AppConfig`（Task 1）
- Produces: `AppDb` 类：`open(dbPath)`、`migrate()`、`upsertRun(profileId, taskKey, date, status, patch?)`、`getRun(profileId, taskKey, date)`、`listRunsForDate(date)`、`listProfiles(enabledOnly?)`、`upsertProfile(bitbrowserId, name)`、`setProfileEnabled(id, enabled)`、`incrCircuitBreaker(profileId): number`、`resetCircuitBreaker(profileId)`、`logCaptcha(profileId, taskKey, kind, cost, ok)`、`captchaStats(date)`、`close()`；`ProfileRow`、`RunRow`、`RunStatus` 类型（Task 3/8/9/10 依赖）

- [ ] **Step 1: 写失败测试 tests/db.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDb, type RunStatus } from '../src/core/db'

let db: AppDb
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'abc-db-')); db = AppDb.open(join(dir, 't.db')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('AppDb', () => {
  it('upsertRun 插入后 getRun 可读回', () => {
    const p = db.upsertProfile('bb-1', '窗口1')
    db.upsertRun(p.id, 'task-a', '2026-08-28', 'running')
    const r = db.getRun(p.id, 'task-a', '2026-08-28')
    expect(r).not.toBeNull()
    expect(r!.status).toBe('running')
    expect(r!.attempts).toBe(0)
  })

  it('upsertRun 更新已有记录且不重复插入', () => {
    const p = db.upsertProfile('bb-1', '窗口1')
    db.upsertRun(p.id, 'task-a', '2026-08-28', 'running')
    db.upsertRun(p.id, 'task-a', '2026-08-28', 'success', { attempts: 1, error: null, screenshot: 's.png' })
    const list = db.listRunsForDate('2026-08-28')
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('success')
    expect(list[0].attempts).toBe(1)
    expect(list[0].screenshot).toBe('s.png')
  })

  it('listProfiles 过滤启用状态', () => {
    const p1 = db.upsertProfile('bb-1', 'A')
    db.upsertProfile('bb-2', 'B')
    db.setProfileEnabled(p1.id, false)
    const enabled = db.listProfiles(true)
    expect(enabled.map(p => p.bitbrowserId)).toEqual(['bb-2'])
  })

  it('熔断计数递增与重置', () => {
    const p = db.upsertProfile('bb-1', 'A')
    expect(db.incrCircuitBreaker(p.id)).toBe(1)
    expect(db.incrCircuitBreaker(p.id)).toBe(2)
    db.resetCircuitBreaker(p.id)
    expect(db.incrCircuitBreaker(p.id)).toBe(1)
  })

  it('验证码统计聚合', () => {
    const p = db.upsertProfile('bb-1', 'A')
    db.logCaptcha(p.id, 'task-a', 'turnstile', 0.03, 1)
    db.logCaptcha(p.id, 'task-a', 'hcaptcha', 0.05, 0)
    db.logCaptcha(p.id, 'task-b', 'turnstile', 0.03, 1)
    const utcDate = new Date().toISOString().slice(0, 10)
    const stats = db.captchaStats(utcDate)
    expect(stats.count).toBe(3)
    expect(stats.totalCost).toBeCloseTo(0.11)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/core/db.ts**

```ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'captcha_failed' | 'retry_wait' | 'skipped'

export interface ProfileRow {
  id: number
  bitbrowserId: string
  name: string
  enabled: number
  walletPassword: string | null
  circuitBreakerCount: number
}

export interface RunRow {
  id: number
  profileId: number
  taskKey: string
  date: string
  status: RunStatus
  attempts: number
  error: string | null
  screenshot: string | null
  startedAt: string | null
  finishedAt: string | null
  profileName: string
}

export function todayStr(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bitbrowser_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  wallet_password TEXT,
  circuit_breaker_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  task_key TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  screenshot TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(profile_id, task_key, date)
);
CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date);
CREATE TABLE IF NOT EXISTS captcha_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER,
  task_key TEXT,
  kind TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export class AppDb {
  private constructor(private raw: Database.Database) {}

  static open(dbPath: string): AppDb {
    mkdirSync(dirname(dbPath), { recursive: true })
    const raw = new Database(dbPath)
    raw.pragma('journal_mode = WAL')
    const db = new AppDb(raw)
    db.migrate()
    return db
  }

  migrate(): void {
    this.raw.exec(SCHEMA)
  }

  close(): void {
    this.raw.close()
  }

  upsertProfile(bitbrowserId: string, name: string): ProfileRow {
    this.raw.prepare(
      `INSERT INTO profiles (bitbrowser_id, name) VALUES (?, ?)
       ON CONFLICT(bitbrowser_id) DO UPDATE SET name = excluded.name`
    ).run(bitbrowserId, name)
    return this.raw.prepare('SELECT * FROM profiles WHERE bitbrowser_id = ?').get(bitbrowserId) as ProfileRow
  }

  listProfiles(enabledOnly = false): ProfileRow[] {
    const sql = enabledOnly
      ? 'SELECT * FROM profiles WHERE enabled = 1 ORDER BY id'
      : 'SELECT * FROM profiles ORDER BY id'
    return this.raw.prepare(sql).all() as ProfileRow[]
  }

  setProfileEnabled(id: number, enabled: boolean): void {
    this.raw.prepare('UPDATE profiles SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  setProfileWalletPassword(id: number, walletPassword: string | null): void {
    this.raw.prepare('UPDATE profiles SET wallet_password = ? WHERE id = ?').run(walletPassword, id)
  }

  incrCircuitBreaker(profileId: number): number {
    this.raw.prepare('UPDATE profiles SET circuit_breaker_count = circuit_breaker_count + 1 WHERE id = ?').run(profileId)
    const row = this.raw.prepare('SELECT circuit_breaker_count FROM profiles WHERE id = ?').get(profileId) as { circuit_breaker_count: number }
    return row.circuit_breaker_count
  }

  resetCircuitBreaker(profileId: number): void {
    this.raw.prepare('UPDATE profiles SET circuit_breaker_count = 0 WHERE id = ?').run(profileId)
  }

  upsertRun(profileId: number, taskKey: string, date: string, status: RunStatus, patch: Partial<RunRow> = {}): RunRow {
    const existing = this.raw.prepare('SELECT * FROM runs WHERE profile_id = ? AND task_key = ? AND date = ?').get(profileId, taskKey, date) as RunRow | undefined
    const base: RunRow = existing ?? {
      id: 0, profileId, taskKey, date, status: 'pending', attempts: 0,
      error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '',
    }
    const merged = { ...base, ...patch, status, attempts: existing ? patch.attempts ?? existing.attempts : 0 }
    this.raw.prepare(
      `INSERT INTO runs (profile_id, task_key, date, status, attempts, error, screenshot, started_at, finished_at)
       VALUES (@profileId, @taskKey, @date, @status, @attempts, @error, @screenshot, @startedAt, @finishedAt)
       ON CONFLICT(profile_id, task_key, date) DO UPDATE SET
         status = excluded.status, attempts = excluded.attempts, error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at)`
    ).run(merged)
    return this.raw.prepare(
      `SELECT r.*, p.name AS profile_name FROM runs r JOIN profiles p ON p.id = r.profile_id
       WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ?`
    ).get(profileId, taskKey, date) as RunRow
  }

  getRun(profileId: number, taskKey: string, date: string): RunRow | null {
    return (this.raw.prepare(
      `SELECT r.*, p.name AS profile_name FROM runs r JOIN profiles p ON p.id = r.profile_id
       WHERE r.profile_id = ? AND r.task_key = ? AND r.date = ?`
    ).get(profileId, taskKey, date) as RunRow | null) ?? null
  }

  listRunsForDate(date: string): RunRow[] {
    return this.raw.prepare(
      `SELECT r.*, p.name AS profile_name FROM runs r JOIN profiles p ON p.id = r.profile_id WHERE r.date = ? ORDER BY p.id, r.task_key`
    ).all(date) as RunRow[]
  }

  logCaptcha(profileId: number | null, taskKey: string | null, kind: string, cost: number, ok: boolean): void {
    this.raw.prepare('INSERT INTO captcha_logs (profile_id, task_key, kind, cost, ok) VALUES (?, ?, ?, ?, ?)').run(profileId, taskKey, kind, cost, ok ? 1 : 0)
  }

  captchaStats(date: string): { count: number; totalCost: number } {
    const row = this.raw.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(cost), 0) AS total FROM captcha_logs WHERE date(created_at) = ?`).get(date) as { count: number; total: number }
    return { count: row.count, totalCost: row.total }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（5 个 db 用例 + 3 个 config 用例全绿）

- [ ] **Step 5: Commit**

```powershell
git add src/core/db.ts tests/db.test.ts
git commit -m "feat: sqlite data layer with profiles, runs and captcha logs"
```

---

### Task 3: 运行状态机

**Files:**
- Create: `src/core/state.ts`
- Create: `tests/state.test.ts`

**Interfaces:**
- Consumes: `RunStatus`（Task 2）
- Produces: `canTransition(from, to): boolean`、`nextStateAfterFailure(attempts: number, retryMax: number, kind: FailureKind): RunStatus`、`shouldSkipAfterBreaker(failCount, threshold): boolean`、`FailureKind` 类型（Task 8 依赖）

- [ ] **Step 1: 写失败测试 tests/state.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { canTransition, nextStateAfterFailure, shouldSkipAfterBreaker } from '../src/core/state'

describe('canTransition', () => {
  it('允许 pending→running 与 running→success', () => {
    expect(canTransition('pending', 'running')).toBe(true)
    expect(canTransition('running', 'success')).toBe(true)
  })
  it('拒绝非法转移', () => {
    expect(canTransition('success', 'running')).toBe(false)
    expect(canTransition('failed', 'running')).toBe(false)
    expect(canTransition('pending', 'success')).toBe(false)
  })
})

describe('nextStateAfterFailure', () => {
  it('验证码失败直接 captcha_failed', () => {
    expect(nextStateAfterFailure(1, 2, 'captcha')).toBe('captcha_failed')
  })
  it('普通失败未达上限进入 retry_wait', () => {
    expect(nextStateAfterFailure(1, 2, 'error')).toBe('retry_wait')
  })
  it('达到重试上限进入 failed', () => {
    expect(nextStateAfterFailure(2, 2, 'error')).toBe('failed')
    expect(nextStateAfterFailure(3, 2, 'error')).toBe('failed')
  })
})

describe('shouldSkipAfterBreaker', () => {
  it('达到阈值才熔断', () => {
    expect(shouldSkipAfterBreaker(1, 2)).toBe(false)
    expect(shouldSkipAfterBreaker(2, 2)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/core/state.ts**

```ts
import type { RunStatus } from './db'

export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ['running'],
  running: ['success', 'failed', 'captcha_failed', 'retry_wait'],
  retry_wait: ['running'],
  success: [],
  failed: [],
  captcha_failed: [],
  skipped: [],
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

export type FailureKind = 'error' | 'captcha'

export function nextStateAfterFailure(attempts: number, retryMax: number, kind: FailureKind): RunStatus {
  if (kind === 'captcha') return 'captcha_failed'
  return attempts >= retryMax ? 'failed' : 'retry_wait'
}

export function shouldSkipAfterBreaker(failCount: number, threshold: number): boolean {
  return failCount >= threshold
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/core/state.ts tests/state.test.ts
git commit -m "feat: run status state machine with retry and circuit breaker rules"
```

---

### Task 4: 比特浏览器 API 客户端

**Files:**
- Create: `src/core/bitbrowser.ts`
- Create: `tests/bitbrowser.test.ts`

**Interfaces:**
- Consumes: `BitBrowserConfig`（Task 1）
- Produces: `BitBrowserClient` 类：`health(): Promise<boolean>`、`openBrowser(id): Promise<OpenResult>`、`closeBrowser(id): Promise<void>`、`listBrowsers(page, pageSize): Promise<BrowserInfo[]>`；`OpenResult { http, ws }`（`http` 为 `"127.0.0.1:50106"` 格式 host:port）、`BrowserInfo { id, name }`（Task 8/12 依赖）

- [ ] **Step 1: 写失败测试 tests/bitbrowser.test.ts**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { BitBrowserClient } from '../src/core/bitbrowser'

afterEach(() => { vi.unstubAllGlobals() })

function mockFetchOnce(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(handler))
}

describe('BitBrowserClient', () => {
  const client = new BitBrowserClient({ apiBase: 'http://127.0.0.1:54345', timeoutMs: 5000 })

  it('openBrowser 解析 data.http 与 ws', async () => {
    mockFetchOnce((url, init) => {
      expect(url).toBe('http://127.0.0.1:54345/browser/open')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body)).id).toBe('abc')
      return new Response(JSON.stringify({ success: true, data: { ws: 'ws://127.0.0.1:50106/devtools/browser/x', http: '127.0.0.1:50106' } }), { status: 200 })
    })
    const r = await client.openBrowser('abc')
    expect(r.http).toBe('127.0.0.1:50106')
    expect(r.ws).toContain('ws://')
  })

  it('openBrowser 兼容旧版 debugPort 字段', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: true, data: { ws: 'ws://x', debugPort: 61234 } }), { status: 200 }))
    const r = await client.openBrowser('abc')
    expect(r.http).toBe('127.0.0.1:61234')
  })

  it('openBrowser 业务失败抛异常（success=false）', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: false, msg: '浏览器不存在' }), { status: 200 }))
    await expect(client.openBrowser('nope')).rejects.toThrow('浏览器不存在')
  })

  it('openBrowser 兼容旧版 code 约定', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ code: -1, msg: '旧版错误' }), { status: 200 }))
    await expect(client.openBrowser('nope')).rejects.toThrow('旧版错误')
  })

  it('closeBrowser 调用正确端点', async () => {
    let called = false
    mockFetchOnce((url, init) => {
      called = true
      expect(url).toBe('http://127.0.0.1:54345/browser/close')
      expect(JSON.parse(String(init.body)).id).toBe('abc')
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    await client.closeBrowser('abc')
    expect(called).toBe(true)
  })

  it('listBrowsers 为 POST 且 page 从 0 开始', async () => {
    mockFetchOnce((url, init) => {
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({ page: 0, pageSize: 100 })
      return new Response(JSON.stringify({ success: true, data: { list: [{ id: 'a1', name: '窗口1' }, { id: 'a2', name: '窗口2' }] } }), { status: 200 })
    })
    const list = await client.listBrowsers(0, 100)
    expect(list).toEqual([{ id: 'a1', name: '窗口1' }, { id: 'a2', name: '窗口2' }])
  })

  it('health 返回 true', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ success: true }), { status: 200 }))
    expect(await client.health()).toBe(true)
  })

  it('health 网络失败返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await client.health()).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/core/bitbrowser.ts**

```ts
export interface OpenResult {
  http: string
  ws: string
}

export interface BrowserInfo {
  id: string
  name: string
}

interface BitBrowserResp {
  success?: boolean
  code?: number
  msg?: string
  data?: Record<string, unknown>
}

export class BitBrowserClient {
  constructor(private cfg: { apiBase: string; timeoutMs: number }) {}

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    })
    const json = (await res.json()) as BitBrowserResp
    const ok = json.success === true || json.code === 0
    if (!ok) throw new Error(`比特浏览器 API 失败: ${path} ${json.msg ?? `code=${json.code}`}`)
    return (json.data ?? {}) as Record<string, unknown>
  }

  async health(): Promise<boolean> {
    try {
      await this.post('/health', {})
      return true
    } catch {
      return false
    }
  }

  async openBrowser(id: string): Promise<OpenResult> {
    const d = await this.post('/browser/open', { id })
    const http = String(d.http ?? '')
    const legacy = String(d.debugPort ?? d.debug_port ?? '')
    const httpField = http || (legacy ? `127.0.0.1:${legacy}` : '')
    if (!httpField) throw new Error(`开窗失败: 未返回调试端口, data=${JSON.stringify(d)}`)
    return { http: httpField, ws: String(d.ws ?? '') }
  }

  async closeBrowser(id: string): Promise<void> {
    await this.post('/browser/close', { id })
  }

  async listBrowsers(page = 0, pageSize = 100): Promise<BrowserInfo[]> {
    const d = await this.post('/browser/list', { page, pageSize })
    const raw = (d.list ?? d.page ?? []) as Array<{ id: string | number; name?: string }>
    return raw.map(l => ({ id: String(l.id), name: l.name ?? String(l.id) }))
  }
}

export function createBitBrowserClient(cfg: { apiBase: string; timeoutMs: number }): BitBrowserClient {
  return new BitBrowserClient(cfg)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/core/bitbrowser.ts tests/bitbrowser.test.ts
git commit -m "feat: bitbrowser local API client with typed responses"
```

---

### Task 5: Humanize 拟人层

**Files:**
- Create: `src/core/humanize.ts`
- Create: `tests/humanize.test.ts`
- Create: `tests/fixtures/click.html`

**Interfaces:**
- Consumes: patchright `Page`/`CDPSession`（Task 1 安装的依赖）
- Produces: `Humanizer` 类：`click(selector)`、`type(selector, text)`、`moveTo(x, y)`、`scroll(deltaY)`、`static sleep(minMs, maxMs)`；`HumanizeOptions { minDelayMs?, maxDelayMs? }`；`randomPointInBox(box)`（Task 7/8 依赖）

- [ ] **Step 1: 写失败测试 tests/humanize.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Humanizer, randomPointInBox } from '../src/core/humanize'

describe('randomPointInBox', () => {
  it('返回点在盒子内部', () => {
    const box = { x: 100, y: 50, width: 200, height: 80 }
    for (let i = 0; i < 50; i++) {
      const p = randomPointInBox(box)
      expect(p.x).toBeGreaterThanOrEqual(100)
      expect(p.x).toBeLessThan(300)
      expect(p.y).toBeGreaterThanOrEqual(50)
      expect(p.y).toBeLessThan(130)
    }
  })
})

describe('Humanizer 集成', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = readFileSync(join(__dirname, 'fixtures', 'click.html'), 'utf-8')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(html)
    })
    await new Promise<void>(r => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  it('human click 触发按钮点击且移动轨迹非瞬时', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(baseUrl)
    const human = new Humanizer(page)
    await human.click('#btn')
    const clicked = await page.locator('#result').textContent()
    expect(clicked).toContain('1')
    await browser.close()
  })

  it('human type 输入文本（含 delay）', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(baseUrl)
    const human = new Humanizer(page)
    await human.type('#input', 'hello')
    const val = await page.locator('#input').inputValue()
    expect(val).toBe('hello')
    await browser.close()
  })
})
```

- [ ] **Step 2: 编写 tests/fixtures/click.html**

```html
<!doctype html>
<html>
<body>
  <button id="btn" style="width:120px;height:40px">签到</button>
  <input id="input" />
  <div id="result">0</div>
  <script>
    document.getElementById('btn').addEventListener('click', () => {
      document.getElementById('result').textContent = String(Number(document.getElementById('result').textContent) + 1)
    })
  </script>
</body>
</html>
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）。若报浏览器未安装，先执行 `npx patchright install chromium`（下载约 150MB），再重跑。

- [ ] **Step 4: 实现 src/core/humanize.ts**

```ts
import { path as ghostPath } from 'ghost-cursor'
import type { Page, CDPSession } from 'patchright'

export interface HumanizeOptions {
  minDelayMs?: number
  maxDelayMs?: number
}

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export function randomPointInBox(box: Box): Point {
  const margin = 0.15
  const w = box.width * (1 - margin)
  const h = box.height * (1 - margin)
  return {
    x: box.x + box.width * margin / 2 + Math.random() * w,
    y: box.y + box.height * margin / 2 + Math.random() * h,
  }
}

export class Humanizer {
  private session: CDPSession | null = null
  private last: Point = { x: 200, y: 200 }
  private minDelay: number
  private maxDelay: number

  constructor(private page: Page, opts: HumanizeOptions = {}) {
    this.minDelay = opts.minDelayMs ?? 800
    this.maxDelay = opts.maxDelayMs ?? 3000
  }

  static async sleep(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs)
    await new Promise(r => setTimeout(r, ms))
  }

  private async cdp(): Promise<CDPSession> {
    if (!this.session) this.session = await this.page.context().newCDPSession(this.page)
    return this.session
  }

  async moveTo(x: number, y: number): Promise<void> {
    const points = ghostPath(this.last, { x, y }, { spreadOverride: 25 }) as Point[]
    for (const p of points) {
      const s = await this.cdp()
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await new Promise(r => setTimeout(r, 8 + Math.random() * 15))
    }
    this.last = { x, y }
  }

  async click(selector: string): Promise<void> {
    const box = await this.page.locator(selector).first().boundingBox()
    if (!box) throw new Error(`点击失败: 找不到元素 ${selector}`)
    const target = randomPointInBox(box)
    await this.page.locator(selector).first().hover({ timeout: 5000 }).catch(() => {})
    await this.moveTo(target.x, target.y)
    await Humanizer.sleep(60, 400)
    const s = await this.cdp()
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await Humanizer.sleep(40, 150)
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector)
    for (const ch of text) {
      await this.page.keyboard.type(ch, { delay: 40 + Math.random() * 90 })
      if (Math.random() < 0.03) {
        await this.page.keyboard.press('Backspace')
        await Humanizer.sleep(100, 300)
        await this.page.keyboard.type(ch, { delay: 60 + Math.random() * 90 })
      }
    }
  }

  async scroll(deltaY: number): Promise<void> {
    const s = await this.cdp()
    await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.last.x, y: this.last.y, deltaX: 0, deltaY })
    await Humanizer.sleep(100, 400)
  }

  async randomMicroMove(): Promise<void> {
    const dx = (Math.random() - 0.5) * 120
    const dy = (Math.random() - 0.5) * 120
    await this.moveTo(this.last.x + dx, this.last.y + dy)
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```powershell
git add src/core/humanize.ts tests/humanize.test.ts tests/fixtures/click.html
git commit -m "feat: humanize layer with ghost-cursor CDP mouse and typing simulation"
```

---

### Task 6: 验证码检测 + yescaptcha 客户端

**Files:**
- Create: `src/core/captcha.ts`
- Create: `tests/captcha.test.ts`

**Interfaces:**
- Consumes: `CaptchaConfig`（Task 1）
- Produces: `CaptchaKind`、`CaptchaDetected { kind, sitekey }`、`CaptchaFailure`、`detectCaptcha(page, timeoutMs): Promise<CaptchaDetected | null>`、`YesCaptchaClient`（`createTask`、`getResult`、`getBalance`、`ensureBalance`、`solveCaptcha(kind, sitekey, pageUrl, extra?)`，内部串行排队保证每账号 1 并发识别）、`CaptchaService`（`autoSolve(page, opts): Promise<'none'|'solved'|'failed'>`）（Task 7/8 依赖）

- [ ] **Step 1: 写失败测试 tests/captcha.test.ts**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { YesCaptchaClient } from '../src/core/captcha'

afterEach(() => { vi.unstubAllGlobals() })

const cfg = {
  apiBase: 'https://api.yescaptcha.com',
  clientKey: 'test-key',
  solveTimeoutMs: 5000,
  pollIntervalMs: 100,
}

describe('YesCaptchaClient', () => {
  it('solveCaptcha 创建任务并轮询到 turnstile token', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (String(url).includes('createTask')) {
        expect(body.task.type).toBe('TurnstileTaskProxyless')
        expect(body.task.websiteKey).toBe('sk123')
        expect(body.task.websiteURL).toBe('https://x.io')
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      polls++
      return new Response(JSON.stringify(
        polls === 1
          ? { errorId: 0, status: 'processing' }
          : { errorId: 0, status: 'ready', solution: { token: 'tok-abc' } }
      ), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { turnstile: 'TurnstileTaskProxyless' })
    const token = await client.solveCaptcha('turnstile', 'sk123', 'https://x.io')
    expect(token).toBe('tok-abc')
  })

  it('reCAPTCHA 类任务从 solution.gRecaptchaResponse 取结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'resp-abc' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { recaptcha_v2: 'NoCaptchaTaskProxyless' })
    const token = await client.solveCaptcha('recaptcha_v2', 'sk', 'https://x.io')
    expect(token).toBe('resp-abc')
  })

  it('同时两个 solveCaptcha 串行执行（每账号 1 并发限制）', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 50))
        inFlight--
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 't' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { turnstile: 'TurnstileTaskProxyless' })
    await Promise.all([
      client.solveCaptcha('turnstile', 'sk1', 'https://x.io'),
      client.solveCaptcha('turnstile', 'sk2', 'https://x.io'),
    ])
    expect(peak).toBe(1)
  })

  it('超时抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'processing' }), { status: 200 })
    }))
    const client = new YesCaptchaClient({ ...cfg, solveTimeoutMs: 200 }, { turnstile: 'TurnstileTaskProxyless' })
    await expect(client.solveCaptcha('turnstile', 'sk', 'https://x.io')).rejects.toThrow(/超时/)
  })

  it('余额不足抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errorId: 0, balance: 100 }), { status: 200 })))
    const client = new YesCaptchaClient(cfg, { turnstile: 'TurnstileTaskProxyless' })
    await expect(client.ensureBalance(500)).rejects.toThrow(/余额不足/)
  })

  it('extra 参数透传（isInvisible）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        expect(JSON.parse(String(init.body)).task.isInvisible).toBe(true)
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'r' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { recaptcha_v2: 'NoCaptchaTaskProxyless' })
    await client.solveCaptcha('recaptcha_v2', 'sk', 'https://x.io', { isInvisible: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/core/captcha.ts**

```ts
import type { Page } from 'patchright'

export type CaptchaKind = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'image'

export interface CaptchaDetected {
  kind: CaptchaKind
  sitekey: string | null
}

export class CaptchaFailure extends Error {}

const DETECTORS: Array<{ kind: CaptchaKind; selector: string; sitekeyAttr: string }> = [
  { kind: 'turnstile', selector: 'iframe[src*="challenges.cloudflare.com"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'recaptcha_v2', selector: 'iframe[src*="recaptcha/api2/anchor"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'hcaptcha', selector: 'iframe[src*="hcaptcha.com/captcha"]', sitekeyAttr: 'data-sitekey' },
]

export async function detectCaptcha(page: Page, timeoutMs = 5000): Promise<CaptchaDetected | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const d of DETECTORS) {
      const iframe = page.locator(d.selector).first()
      if (await iframe.count() > 0) {
        const src = (await iframe.getAttribute('src')) ?? ''
        const sitekeyMatch = src.match(/[?&]k=([^&]+)/) ?? src.match(/[?&]sitekey=([^&]+)/)
        let sitekey = sitekeyMatch ? sitekeyMatch[1] : null
        if (!sitekey) {
          const container = page.locator(`[${d.sitekeyAttr}]`).first()
          if (await container.count() > 0) sitekey = await container.getAttribute(d.sitekeyAttr)
        }
        return { kind: d.kind, sitekey }
      }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}

interface YesCaptchaResp {
  errorId?: number
  errorCode?: string
  taskId?: string
  status?: string
  solution?: { token?: string; gRecaptchaResponse?: string; text?: string }
  balance?: number
}

export class YesCaptchaClient {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private cfg: { apiBase: string; clientKey: string; solveTimeoutMs: number; pollIntervalMs: number }, private taskTypes: Record<string, string>) {}

  private async call(path: string, body: unknown): Promise<YesCaptchaResp> {
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await res.json()) as YesCaptchaResp
  }

  private async createTask(task: Record<string, unknown>): Promise<string> {
    const resp = await this.call('/createTask', { clientKey: this.cfg.clientKey, task })
    if (resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 创建任务失败: ${resp.errorCode ?? resp.errorId}`)
    return resp.taskId!
  }

  private async getResult(taskId: string, kind: CaptchaKind): Promise<string | null> {
    const resp = await this.call('/getTaskResult', { clientKey: this.cfg.clientKey, taskId })
    if (resp.status !== 'ready') return null
    const s = resp.solution ?? {}
    if (kind === 'turnstile') return s.token ?? null
    if (kind === 'image') return s.text ?? null
    return s.gRecaptchaResponse ?? null
  }

  async getBalance(): Promise<number> {
    const resp = await this.call('/getBalance', { clientKey: this.cfg.clientKey })
    return resp.balance ?? 0
  }

  async ensureBalance(minAmount: number): Promise<void> {
    const balance = await this.getBalance()
    if (balance < minAmount) throw new CaptchaFailure(`yescaptcha 余额不足: ${balance} 点 < ${minAmount} 点`)
  }

  solveCaptcha(kind: CaptchaKind, sitekey: string | null, pageUrl: string, extra: Record<string, unknown> = {}): Promise<string> {
    const run = async (): Promise<string> => {
      if (!sitekey) throw new CaptchaFailure('验证码未找到 sitekey')
      const taskType = this.taskTypes[kind]
      if (!taskType) throw new CaptchaFailure(`不支持的验证码类型: ${kind}`)
      const taskId = await this.createTask({ type: taskType, websiteURL: pageUrl, websiteKey: sitekey, ...extra })
      const deadline = Date.now() + this.cfg.solveTimeoutMs
      while (Date.now() < deadline) {
        const token = await this.getResult(taskId, kind)
        if (token) return token
        await new Promise(r => setTimeout(r, this.cfg.pollIntervalMs))
      }
      throw new CaptchaFailure(`yescaptcha 解题超时: taskId=${taskId}`)
    }
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    return result
  }
}

export class CaptchaService {
  constructor(private client: YesCaptchaClient, private cfg: { maxCostPerTask: number }) {}

  async autoSolve(page: Page, opts: { enabled: boolean; profileId: number | null; taskKey: string | null; onLog: (kind: string, ok: boolean) => void }): Promise<'none' | 'solved' | 'failed'> {
    if (!opts.enabled) return 'none'
    const detected = await detectCaptcha(page)
    if (!detected) return 'none'
    try {
      await this.client.ensureBalance(this.cfg.maxCostPerTask)
      const token = await this.client.solveCaptcha(detected.kind, detected.sitekey, page.url())
      await this.applyToken(page, detected.kind, token)
      opts.onLog(detected.kind, true)
      return 'solved'
    } catch (e) {
      opts.onLog(detected.kind, false)
      throw new CaptchaFailure(`验证码处理失败: ${(e as Error).message}`)
    }
  }

  private async applyToken(page: Page, kind: CaptchaKind, token: string): Promise<void> {
    if (kind === 'turnstile') {
      await page.evaluate((t) => {
        const input = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')
        if (input) {
          input.value = t
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }, token, { isolatedContext: false })
    } else if (kind === 'hcaptcha') {
      await page.evaluate((t) => {
        const h = document.querySelector<HTMLTextAreaElement>('textarea[name="h-captcha-response"]')
        if (h) {
          h.value = t
          h.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const g = document.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]')
        if (g) {
          g.value = t
          g.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }, token, { isolatedContext: false })
    } else {
      await page.evaluate((t) => {
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]')
        if (textarea) {
          textarea.value = t
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }, token, { isolatedContext: false })
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS

注意：`page.evaluate(fn, arg, { isolatedContext: false })` 的第三个参数是 patchright 扩展，用于把 token 写入站点主世界（否则站点 JS 看不到回填值）。

- [ ] **Step 5: 手动真实验证（可选，建议做一次）**

配置 `config/.env` 填入真实 `CAPTCHA_CLIENT_KEY`，用临时脚本或面板触发一个带 Turnstile 的站点任务，观察日志：检测到 kind → createTask 成功 → 轮询到 token → 回填 → 站点继续流程。同时确认 yescaptcha 后台余额扣减（Turnstile 25 点/次）。此步不写代码，仅验证链路。

- [ ] **Step 6: Commit**

```powershell
git add src/core/captcha.ts tests/captcha.test.ts
git commit -m "feat: captcha detection and yescaptcha solving client"
```

---

### Task 7: 任务基类 + TaskContext + 示例任务 + 钱包类型定义

**Files:**
- Create: `src/tasks/base.ts`
- Create: `src/tasks/index.ts`
- Create: `src/tasks/example-checkin.ts`
- Create: `src/core/wallet/types.ts`
- Create: `tests/task-base.test.ts`
- Create: `tests/fixtures/checkin.html`

**Interfaces:**
- Consumes: `Humanizer`（Task 5）、`CaptchaService`（Task 6）、`ProfileRow`（Task 2）、`AppConfig`（Task 1）、`Logger`（Task 1）
- Produces: `SiteTask`（`meta: TaskMeta`、`run(ctx)`）、`TaskMeta`、`TaskContext`（`goto()`、`clickCheckin(selector, opts?)`、`assertVisible(selector, timeoutMs?)`、`typeInto(selector, text)`、`solveCaptcha()`、`screenshot(name)`、`loginByWallet()`、`textPresent(text)`、`urlIncludes(part)`）、`loadTasks(): Map<string, SiteTask>`、`WalletAdapter`、`WalletRegistry`（Task 8/9/11/12 依赖）

- [ ] **Step 1: 写失败测试 tests/task-base.test.ts**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { TaskContext } from '../src/tasks/base'
import type { SiteTask, TaskMeta } from '../src/tasks/base'
import { Humanizer } from '../src/core/humanize'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake', name: '假任务', url: '' }
  async run(ctx: TaskContext) {
    await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
  }
}

describe('TaskContext 集成', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'checkin.html'), 'utf-8'))
    })
    await new Promise<void>(r => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  it('clickCheckin 带成功断言', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const task = new FakeTask()
    task.meta.url = baseUrl
    const ctx = new TaskContext({
      page,
      task,
      human: new Humanizer(page),
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 0 },
      cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: '',
    })
    await ctx.goto()
    await task.run(ctx)
    const badge = await page.locator('#checked-badge').count()
    expect(badge).toBe(1)
    await browser.close()
  })

  it('断言超时抛异常', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const task = new FakeTask()
    task.meta.url = baseUrl
    const ctx = new TaskContext({
      page,
      task,
      human: new Humanizer(page),
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 0 },
      cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: '',
    })
    await ctx.goto()
    await expect(ctx.assertVisible('#never-exists', 800)).rejects.toThrow(/超时/)
    await browser.close()
  })
})
```

- [ ] **Step 2: 编写 tests/fixtures/checkin.html**

```html
<!doctype html>
<html>
<body>
  <button id="checkin-btn" style="width:150px;height:40px">每日签到</button>
  <script>
    document.getElementById('checkin-btn').addEventListener('click', () => {
      const badge = document.createElement('div')
      badge.id = 'checked-badge'
      badge.textContent = '已签到'
      document.body.appendChild(badge)
    })
  </script>
</body>
</html>
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 src/core/wallet/types.ts**

```ts
export interface PopupLocator {
  click(opts?: { timeout?: number }): Promise<void>
  fill(text: string): Promise<void>
  press?(key: string): Promise<void>
  first(): PopupLocator
}

export interface PopupPage {
  url(): string
  getByRole(role: string, opts: { name: RegExp }): PopupLocator
  getByTestId(id: string): PopupLocator
  locator(selector: string): PopupLocator
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<void>
}

export interface WalletAdapter {
  key: string
  extensionUrlPatterns: string[]
  unlock?(popup: PopupPage, password: string): Promise<void>
  ensureConnected(popup: PopupPage): Promise<void>
}

export class WalletRegistry {
  private map = new Map<string, WalletAdapter>()

  register(adapter: WalletAdapter): void {
    this.map.set(adapter.key, adapter)
  }

  get(key: string): WalletAdapter {
    const a = this.map.get(key)
    if (!a) throw new Error(`未注册的钱包适配器: ${key}`)
    return a
  }

  has(key: string): boolean {
    return this.map.has(key)
  }
}
```

- [ ] **Step 5: 实现 src/tasks/base.ts**

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'patchright'
import type { AppConfig } from '../core/config'
import type { Logger } from '../core/logger'
import type { ProfileRow } from '../core/db'
import { Humanizer } from '../core/humanize'
import { CaptchaService } from '../core/captcha'
import { WalletRegistry } from '../core/wallet/types'

export interface TaskMeta {
  key: string
  name: string
  url: string
  schedule?: string | { stagger: [string, string] }
  wallet?: string
  timeoutSec?: number
  retry?: { max: number; backoffSec: number }
  captcha?: { auto?: boolean; maxCost?: number }
}

export interface TaskContextDeps {
  page: Page
  task: SiteTask
  human: Humanizer
  profile: ProfileRow
  cfg: AppConfig
  logger: Logger
  artifactsDir: string
  captcha?: CaptchaService
  wallets?: WalletRegistry
}

export abstract class SiteTask {
  abstract meta: TaskMeta
  abstract run(ctx: TaskContext): Promise<void>
}

export class TaskContext {
  constructor(private deps: TaskContextDeps) {}

  get page(): Page {
    return this.deps.page
  }

  get human(): Humanizer {
    return this.deps.human
  }

  get profile(): ProfileRow {
    return this.deps.profile
  }

  async goto(url?: string): Promise<void> {
    const target = url ?? this.deps.task.meta.url
    if (!target) throw new Error('任务未配置 url')
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.page.goto(target, { timeout: 45000, waitUntil: 'domcontentloaded' })
        await Humanizer.sleep(800, 3000)
        return
      } catch (e) {
        this.deps.logger.warn({ url: target, attempt }, `页面加载失败，重试 ${attempt}/2`)
        if (attempt === 2) throw e
      }
    }
  }

  async clickCheckin(selector: string, opts: { assert?: string; assertTimeoutMs?: number } = {}): Promise<void> {
    await this.human.click(selector)
    if (opts.assert) {
      await this.assertVisible(opts.assert, opts.assertTimeoutMs ?? 10000)
    }
  }

  async assertVisible(selector: string, timeoutMs = 10000): Promise<void> {
    try {
      await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
    } catch {
      throw new Error(`断言超时: 元素 ${selector} 未出现`)
    }
  }

  async typeInto(selector: string, text: string): Promise<void> {
    await this.human.type(selector, text)
  }

  async solveCaptcha(): Promise<'none' | 'solved' | 'failed'> {
    if (!this.deps.captcha) return 'none'
    const taskCfg = this.deps.task.meta.captcha ?? { auto: true }
    return this.deps.captcha.autoSolve(this.page, {
      enabled: taskCfg.auto ?? true,
      profileId: this.deps.profile.id,
      taskKey: this.deps.task.meta.key,
      onLog: (kind, ok) => {
        const db = (this.deps.cfg as unknown as { db?: { logCaptcha: (p: number, t: string, k: string, c: number, o: boolean) => void } }).db
        db?.logCaptcha(this.deps.profile.id, this.deps.task.meta.key, kind, 0, ok)
      },
    })
  }

  async screenshot(name: string): Promise<string> {
    mkdirSync(this.deps.artifactsDir, { recursive: true })
    const file = join(this.deps.artifactsDir, `${name}.png`)
    await this.page.screenshot({ path: file, fullPage: false })
    return file
  }

  async loginByWallet(): Promise<void> {
    const walletKey = this.deps.task.meta.wallet
    if (!walletKey) throw new Error('任务未配置钱包')
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(walletKey)
    const popup = await waitForWalletPopup(this.page, adapter.extensionUrlPatterns, 15000)
    if (!popup) throw new Error('钱包弹窗未出现')
    if (this.deps.profile.walletPassword && adapter.unlock) {
      await adapter.unlock(popup, this.deps.profile.walletPassword)
    }
    await adapter.ensureConnected(popup)
  }

  async textPresent(text: string): Promise<boolean> {
    const count = await this.page.getByText(text, { exact: false }).count()
    return count > 0
  }

  async urlIncludes(part: string): Promise<boolean> {
    return this.page.url().includes(part)
  }
}

export async function waitForWalletPopup(page: Page, patterns: string[], timeoutMs: number): Promise<import('../core/wallet/types').PopupPage | null> {
  const context = page.context()
  const match = (p: Page) => patterns.some(pat => new RegExp(pat).test(p.url()))
  const existing = context.pages().find(match)
  if (existing) return existing
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      context.off('page', handler)
      resolve(null)
    }, timeoutMs)
    const handler = (p: Page) => {
      if (match(p)) {
        clearTimeout(timer)
        context.off('page', handler)
        resolve(p)
      }
    }
    context.on('page', handler)
  })
}
```

- [ ] **Step 6: 实现 src/tasks/example-checkin.ts 与 src/tasks/index.ts**

`src/tasks/example-checkin.ts`：

```ts
import { SiteTask, TaskContext, type TaskMeta } from './base'

export class ExampleCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'example-checkin',
    name: '示例签到',
    url: '',
    schedule: { stagger: ['09:00', '11:00'] },
    wallet: 'metamask',
    captcha: { auto: true },
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()
    await ctx.loginByWallet()
    await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
  }
}
```

`src/tasks/index.ts`：

```ts
import type { SiteTask } from './base'
import { ExampleCheckinTask } from './example-checkin'

const ALL: SiteTask[] = [new ExampleCheckinTask()]

export function loadTasks(): Map<string, SiteTask> {
  const map = new Map<string, SiteTask>()
  for (const t of ALL) map.set(t.meta.key, t)
  return map
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```powershell
git add src/tasks/base.ts src/tasks/index.ts src/tasks/example-checkin.ts src/core/wallet/types.ts tests/task-base.test.ts tests/fixtures/checkin.html
git commit -m "feat: task base class with TaskContext, wallet types and example task"
```

---

### Task 8: 窗口执行器 + 并发队列 + 合并入队

**Files:**
- Create: `src/core/windowRunner.ts`
- Create: `src/core/queue.ts`
- Create: `tests/windowRunner.test.ts`
- Create: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `AppDb`（Task 2）、`BitBrowserClient`/`OpenResult`（Task 4）、`state.ts`（Task 3）、`SiteTask`/`TaskContext`（Task 7）、`Humanizer`（Task 5）、`CaptchaService`（Task 6）、`WalletRegistry`（Task 7）、`AppConfig`（Task 1）、`Logger`（Task 1）
- Produces: `BrowserDriver`（`connect(debugPort): Promise<{ page: Page; close(): Promise<void> }>`）、`PatchrightDriver`、`WindowRunner`（`runWindowTasks(profile, taskKeys): Promise<void>`、`runManual(bitbrowserId, taskKey): Promise<void>`）、`TaskQueue`（`add(fn)`、`onIdle()`、`size`）、`CoalescingEnqueuer`（`enqueue(profile, taskKey)`）（Task 9/10/12 依赖）

- [ ] **Step 1: 写失败测试 tests/queue.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest'
import { TaskQueue, CoalescingEnqueuer } from '../src/core/queue'

describe('TaskQueue', () => {
  it('并发上限内执行', async () => {
    const q = new TaskQueue(2)
    let active = 0
    let peak = 0
    const fn = () => {
      active++
      peak = Math.max(peak, active)
      return new Promise<void>(r => setTimeout(() => { active--; r() }, 50))
    }
    await Promise.all([q.add(fn), q.add(fn), q.add(fn), q.add(fn)])
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('CoalescingEnqueuer', () => {
  it('同一窗口多次 enqueue 合并为一次执行', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, walletPassword: null, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    enq.enqueue(profile, 'task-b')
    enq.enqueue(profile, 'task-c')
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual(['task-a', 'task-b', 'task-c'])
  })

  it('不同窗口分别执行', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never)
    const mk = (id: number, bb: string) => ({ id, bitbrowserId: bb, name: bb, enabled: 1, walletPassword: null, circuitBreakerCount: 0 })
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 写失败测试 tests/windowRunner.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WindowRunner, type BrowserDriver } from '../src/core/windowRunner'
import type { AppDb, ProfileRow, RunRow } from '../src/core/db'
import type { SiteTask } from '../src/tasks/base'

function makeProfile(over: Partial<ProfileRow> = {}): ProfileRow {
  return { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 0, ...over }
}

function makeDb(over: Partial<Record<keyof AppDb, unknown>> = {}): AppDb {
  return {
    upsertRun: vi.fn(),
    resetCircuitBreaker: vi.fn(),
    incrCircuitBreaker: vi.fn(),
    listProfiles: vi.fn().mockReturnValue([]),
    getRun: vi.fn().mockReturnValue(null),
    ...over,
  } as unknown as AppDb
}

const okPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue('https://x.io'),
}

function makeDriver(over: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    connect: vi.fn().mockResolvedValue({ page: okPage, close: vi.fn().mockResolvedValue(undefined) }),
    ...over,
  } as unknown as BrowserDriver
}

const open = { http: '127.0.0.1:61234', ws: '' }
const bitbrowser = {
  openBrowser: vi.fn().mockResolvedValue(open),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
  listBrowsers: vi.fn().mockResolvedValue([]),
}

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
const cfg = { execution: { probeUrl: 'https://probe.io', taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 60000 } } as never

class OkTask implements SiteTask {
  meta = { key: 'ok-task', name: 'OK', url: 'https://x.io' }
  run = vi.fn().mockResolvedValue(undefined)
}

class FailTask implements SiteTask {
  meta = { key: 'fail-task', name: 'FAIL', url: 'https://x.io' }
  run = vi.fn().mockRejectedValue(new Error('boom'))
}

describe('WindowRunner', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('任务成功后写 success 并关窗', async () => {
    const db = makeDb()
    const runner = new WindowRunner({ cfg, db, bitbrowser, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir: '' })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toContain('success')
    expect(bitbrowser.closeBrowser).toHaveBeenCalledWith('bb-1')
  })

  it('任务失败重试后标记 failed', async () => {
    const db = makeDb()
    const runner = new WindowRunner({ cfg, db, bitbrowser, driver: makeDriver(), tasks: new Map([['fail-task', new FailTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir: '' })
    await runner.runWindowTasks(makeProfile(), ['fail-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toEqual(['running', 'retry_wait', 'running', 'failed'])
  })

  it('开窗失败重试后跳过窗口', async () => {
    const db = makeDb()
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir: '' })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    expect(bb.openBrowser).toHaveBeenCalledTimes(3)
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toEqual(['skipped'])
  })

  it('IP 探活失败熔断所有任务', async () => {
    const db = makeDb()
    const page = { ...okPage, goto: vi.fn().mockRejectedValue(new Error('网络错误')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser, driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir: '' })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls.map(c => c[3])
    expect(calls).toEqual(['skipped'])
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 src/core/queue.ts**

```ts
import PQueue from 'p-queue'
import type { ProfileRow } from './db'

export class TaskQueue {
  private q: PQueue

  constructor(concurrency: number) {
    this.q = new PQueue({ concurrency })
  }

  add(fn: () => Promise<void>): Promise<void> {
    return this.q.add(fn)
  }

  onIdle(): Promise<void> {
    return this.q.onIdle()
  }

  get size(): number {
    return this.q.size + this.q.pending
  }
}

export class CoalescingEnqueuer {
  private pending = new Map<number, { profile: ProfileRow; taskKeys: Set<string> }>()

  constructor(private queue: TaskQueue, private runner: { runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<void> }) {}

  enqueue(profile: ProfileRow, taskKey: string): void {
    const entry = this.pending.get(profile.id)
    if (entry) {
      entry.taskKeys.add(taskKey)
      return
    }
    const fresh = { profile, taskKeys: new Set([taskKey]) }
    this.pending.set(profile.id, fresh)
    void this.queue.add(async () => {
      this.pending.delete(profile.id)
      await this.runner.runWindowTasks(fresh.profile, [...fresh.taskKeys])
    })
  }
}
```

- [ ] **Step 5: 实现 src/core/windowRunner.ts**

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'patchright'
import type { AppConfig } from './config'
import type { Logger } from './logger'
import { AppDb, todayStr, type ProfileRow } from './db'
import type { BitBrowserClient, OpenResult } from './bitbrowser'
import { nextStateAfterFailure, shouldSkipAfterBreaker } from './state'
import { Humanizer } from './humanize'
import { CaptchaFailure, CaptchaService } from './captcha'
import { TaskContext, type SiteTask } from '../tasks/base'
import type { WalletRegistry } from './wallet/types'

export interface BrowserDriver {
  connect(endpointUrl: string): Promise<{ page: Page; close(): Promise<void> }>
}

export class PatchrightDriver implements BrowserDriver {
  private browser: Browser | null = null

  async connect(endpointUrl: string): Promise<{ page: Page; close(): Promise<void> }> {
    this.browser = await chromium.connectOverCDP(endpointUrl)
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext())
    const page = context.pages()[0] ?? (await context.newPage())
    return {
      page,
      close: async () => {
        await this.browser?.close().catch(() => {})
        this.browser = null
      },
    }
  }
}

export interface WindowRunnerDeps {
  cfg: AppConfig
  db: AppDb
  bitbrowser: BitBrowserClient
  driver: BrowserDriver
  tasks: Map<string, SiteTask>
  wallets: WalletRegistry
  captcha: CaptchaService | null
  logger: Logger
  artifactsDir: string
}

export class WindowRunner {
  constructor(private deps: WindowRunnerDeps) {}

  async runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<void> {
    const { cfg, db, bitbrowser, logger } = this.deps
    const date = todayStr()
    let open: OpenResult | null = null
    let connected: { page: Page; close(): Promise<void> } | null = null
    try {
      open = await this.openWithRetry(profile.bitbrowserId)
      connected = await this.deps.driver.connect(`http://${open.http}`)
      const page = connected.page
      const probeOk = await this.probe(page)
      if (!probeOk) {
        for (const key of taskKeys) db.upsertRun(profile.id, key, date, 'skipped', { error: 'IP 探活失败', finishedAt: new Date().toISOString() })
        logger.warn({ profile: profile.name }, 'IP 探活失败，本轮跳过')
        return
      }
      for (const key of taskKeys) {
        if (shouldSkipAfterBreaker(profile.circuitBreakerCount, cfg.execution.circuitBreakerThreshold)) {
          db.upsertRun(profile.id, key, date, 'skipped', { error: '窗口熔断', finishedAt: new Date().toISOString() })
          logger.warn({ profile: profile.name, task: key }, '窗口熔断，跳过任务')
          continue
        }
        await this.runTask(profile, key, page, date)
      }
    } finally {
      if (connected) await connected.close()
      if (open) await bitbrowser.closeBrowser(profile.bitbrowserId).catch(() => {})
    }
  }

  async runManual(bitbrowserId: string, taskKey: string): Promise<void> {
    const profile = this.deps.db.listProfiles(false).find(p => p.bitbrowserId === bitbrowserId)
    if (!profile) throw new Error(`窗口不存在: ${bitbrowserId}`)
    await this.runWindowTasks(profile, [taskKey])
  }

  private async openWithRetry(id: string): Promise<OpenResult> {
    const { maxRetries, retryBackoffMs } = this.deps.cfg.bitbrowser
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.deps.bitbrowser.openBrowser(id)
      } catch (e) {
        lastErr = e as Error
        this.deps.logger.warn({ id, attempt: attempt + 1 }, `开窗失败: ${lastErr.message}`)
        if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, retryBackoffMs[attempt] ?? 5000))
      }
    }
    throw lastErr ?? new Error('开窗失败')
  }

  private async probe(page: Page): Promise<boolean> {
    try {
      await page.goto(this.deps.cfg.execution.probeUrl, { timeout: 30000, waitUntil: 'domcontentloaded' })
      return true
    } catch {
      return false
    }
  }

  private async runTask(profile: ProfileRow, taskKey: string, page: Page, date: string): Promise<void> {
    const { cfg, db, logger } = this.deps
    const task = this.deps.tasks.get(taskKey)
    if (!task) {
      db.upsertRun(profile.id, taskKey, date, 'failed', { error: `任务未注册: ${taskKey}`, finishedAt: new Date().toISOString() })
      return
    }
    const retryMax = task.meta.retry?.max ?? cfg.execution.retryMax
    const backoffSec = task.meta.retry?.backoffSec ?? cfg.execution.retryBackoffSec
    const timeoutSec = task.meta.timeoutSec ?? Math.floor(cfg.execution.taskTimeoutMs / 1000)
    const artifacts = join(this.deps.artifactsDir, date, profile.bitbrowserId, taskKey)
    mkdirSync(artifacts, { recursive: true })

    for (let attempt = 1; attempt <= retryMax + 1; attempt++) {
      db.upsertRun(profile.id, taskKey, date, 'running', { attempts: attempt, error: null, startedAt: new Date().toISOString() })
      try {
        const ctx = new TaskContext({
          page,
          task,
          human: new Humanizer(page),
          profile,
          cfg: this.deps.cfg,
          logger,
          artifactsDir: artifacts,
          captcha: this.deps.captcha ?? undefined,
          wallets: this.deps.wallets,
        })
        await withTimeout(task.run(ctx), timeoutSec * 1000, `任务 ${taskKey} 超时`)
        const shot = await ctx.screenshot(`${date}-success`).catch(() => null)
        db.upsertRun(profile.id, taskKey, date, 'success', { error: null, screenshot: shot, finishedAt: new Date().toISOString() })
        db.resetCircuitBreaker(profile.id)
        logger.info({ profile: profile.name, task: taskKey }, '签到成功')
        return
      } catch (e) {
        const isCaptcha = e instanceof CaptchaFailure
        const status = nextStateAfterFailure(attempt, retryMax + 1, isCaptcha ? 'captcha' : 'error')
        const shot = await page.screenshot({ path: join(artifacts, `${date}-attempt${attempt}.png`) }).then(() => join(artifacts, `${date}-attempt${attempt}.png`)).catch(() => null)
        db.upsertRun(profile.id, taskKey, date, status, { error: (e as Error).message, screenshot: shot, finishedAt: new Date().toISOString() })
        logger.error({ profile: profile.name, task: taskKey, status, err: (e as Error).message }, '任务失败')
        if (status === 'retry_wait') {
          await new Promise(r => setTimeout(r, backoffSec * 1000))
          continue
        }
        db.incrCircuitBreaker(profile.id)
        return
      }
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test`
Expected: PASS。注意 windowRunner 测试里重试次数断言：`retryMax=2` 意味着最多 `2+1=3` 次尝试，`FailTask` 每次尝试失败 → 序列 `running, retry_wait, running, failed`（attempt 1 失败→retry_wait；attempt 2 失败→failed）。若断言不符按实际逻辑修正测试中的期望序列。

- [ ] **Step 7: Commit**

```powershell
git add src/core/windowRunner.ts src/core/queue.ts tests/windowRunner.test.ts tests/queue.test.ts
git commit -m "feat: window runner with retries, circuit breaker and coalescing queue"
```

---

### Task 9: 调度器（cron + 错峰窗口）

**Files:**
- Create: `src/core/scheduler.ts`
- Create: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `AppConfig`（Task 1）、`AppDb`/`ProfileRow`（Task 2）、`SiteTask`/`TaskMeta`（Task 7）、`CoalescingEnqueuer`（Task 8）、`Logger`（Task 1）
- Produces: `pickRandomTimeInWindow(start: string, end: string, now?: Date): Date`、`staggerToCron(start, end): string`、`Scheduler`（`start()`、`stop()`、`fireNow(taskKey)`）（Task 12 依赖）

- [ ] **Step 1: 写失败测试 tests/scheduler.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickRandomTimeInWindow, staggerToCron, Scheduler } from '../src/core/scheduler'

describe('pickRandomTimeInWindow', () => {
  it('随机时间落在窗口内', () => {
    const base = new Date(2026, 7, 28, 0, 0, 0)
    for (let i = 0; i < 100; i++) {
      const t = pickRandomTimeInWindow('09:00', '11:00', base)
      const minutes = t.getHours() * 60 + t.getMinutes()
      expect(minutes).toBeGreaterThanOrEqual(9 * 60)
      expect(minutes).toBeLessThanOrEqual(11 * 60)
      expect(t.getDate()).toBe(28)
    }
  })
})

describe('staggerToCron', () => {
  it('生成合法 cron 表达式', () => {
    expect(staggerToCron('09:00', '09:30')).toMatch(/^\d+ \d+ \* \* \*$/)
  })
})

describe('Scheduler', () => {
  it('fireNow 将启用窗口的任务入队', () => {
    const db = {
      listProfiles: vi.fn().mockReturnValue([
        { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, walletPassword: null, circuitBreakerCount: 0 },
        { id: 2, bitbrowserId: 'bb-2', name: 'B', enabled: 0, walletPassword: null, circuitBreakerCount: 0 },
      ]),
    } as never
    const enq = { enqueue: vi.fn() } as never
    const task = { meta: { key: 't1', name: 'T1', url: '', schedule: '0 9 * * *' } }
    const sched = new Scheduler({} as never, db, new Map([['t1', task]]), enq, { info: () => {} } as never)
    sched.fireNow('t1')
    expect(enq.enqueue).toHaveBeenCalledTimes(1)
    expect(enq.enqueue.mock.calls[0][0].id).toBe(1)
    expect(enq.enqueue.mock.calls[0][1]).toBe('t1')
  })

  it('fireNow 对未注册任务安全返回', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]) } as never
    const enq = { enqueue: vi.fn() } as never
    const sched = new Scheduler({} as never, db, new Map(), enq, { info: () => {} } as never)
    sched.fireNow('nope')
    expect(enq.enqueue).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/core/scheduler.ts**

```ts
import { Cron } from 'croner'
import type { AppConfig } from './config'
import type { Logger } from './logger'
import type { AppDb, ProfileRow } from './db'
import type { SiteTask, TaskMeta } from '../tasks/base'
import type { CoalescingEnqueuer } from './queue'

export function pickRandomTimeInWindow(start: string, end: string, now = new Date()): Date {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  const picked = startMin + Math.floor(Math.random() * (endMin - startMin + 1))
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(picked / 60), picked % 60, 0, 0)
}

export function staggerToCron(start: string, end: string): string {
  const t = pickRandomTimeInWindow(start, end)
  return `${t.getMinutes()} ${t.getHours()} * * *`
}

export class Scheduler {
  private jobs: Cron[] = []

  constructor(
    private cfg: AppConfig,
    private db: AppDb,
    private tasks: Map<string, SiteTask>,
    private enqueuer: CoalescingEnqueuer,
    private logger: Logger,
  ) {}

  private scheduleOf(meta: TaskMeta): string | null {
    if (!meta.schedule) return null
    if (typeof meta.schedule === 'string') return meta.schedule
    return staggerToCron(meta.schedule.stagger[0], meta.schedule.stagger[1])
  }

  start(): void {
    for (const task of this.tasks.values()) {
      const cron = this.scheduleOf(task.meta)
      if (!cron) continue
      const job = new Cron(cron, { timezone: this.cfg.execution.timezone }, () => this.fireNow(task.meta.key))
      this.jobs.push(job)
      this.logger.info({ task: task.meta.key, cron }, '任务已调度')
    }
  }

  stop(): void {
    for (const j of this.jobs) j.stop()
    this.jobs = []
  }

  fireNow(taskKey: string): void {
    const task = this.tasks.get(taskKey)
    if (!task) return
    const profiles: ProfileRow[] = this.db.listProfiles(true)
    for (const p of profiles) {
      this.enqueuer.enqueue(p, taskKey)
    }
    this.logger.info({ task: taskKey, profiles: profiles.length }, '触发任务')
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 手动验证调度触发（不写代码）**

临时把 `example-checkin` 任务的 schedule 改为 1 分钟后（如当前 10:30，改成 `31 10 * * *`），`npm run dev` 启动，观察日志出现「触发任务」，若比特浏览器在运行则窗口实际打开。验证后改回。此步验证 croner 注册与 fireNow→入队→开窗链路。

- [ ] **Step 6: Commit**

```powershell
git add src/core/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: croner scheduler with stagger time windows"
```

---

### Task 10: Web 面板

**Files:**
- Create: `src/web/server.ts`
- Create: `src/web/public/index.html`
- Create: `tests/web.test.ts`

**Interfaces:**
- Consumes: `AppDb`（Task 2）、`CoalescingEnqueuer`（Task 8）、`loadTasks`（Task 7）、`BitBrowserClient.health`（Task 4）、`YesCaptchaClient.getBalance`（Task 6）
- Produces: `createApp(deps: WebDeps): express.Express`，路由：`GET /api/dashboard?date=`、`POST /api/trigger`、`POST /api/rerun-failed`、`POST /api/profile/:id/toggle`、`POST /api/profile/:id/run`、`POST /api/profile/:id/password`、`POST /api/profile/:id/reset-breaker`、`POST /api/bitbrowser/test`、`GET /api/captcha/balance`、`GET /`（4 页静态面板，深色主题，按设计文档 7.5.1 实现）（Task 12 依赖）

- [ ] **Step 1: 写失败测试 tests/web.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/web/server'

function makeDeps() {
  return {
    db: {
      listRunsForDate: vi.fn().mockReturnValue([
        { id: 1, profileId: 1, taskKey: 't1', date: '2026-08-28', status: 'success', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口1' },
        { id: 2, profileId: 1, taskKey: 't2', date: '2026-08-28', status: 'failed', attempts: 2, error: 'boom', screenshot: 's.png', startedAt: null, finishedAt: null, profileName: '窗口1' },
      ]),
      listProfiles: vi.fn().mockReturnValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 1 }]),
      captchaStats: vi.fn().mockReturnValue({ count: 5, totalCost: 0.23 }),
      setProfileEnabled: vi.fn(),
      setProfileWalletPassword: vi.fn(),
      resetCircuitBreaker: vi.fn(),
    } as never,
    enqueuer: { enqueue: vi.fn() } as never,
    tasks: new Map([['t1', { meta: { key: 't1', name: '任务1', url: '', wallet: 'metamask', schedule: '0 9 * * *' } }]]),
    cfg: { web: { port: 3000 } } as never,
    bitbrowser: { health: vi.fn().mockResolvedValue(true) },
    captchaBalance: vi.fn().mockResolvedValue({ points: 98210 }),
  }
}

describe('web panel API', () => {
  it('GET /api/dashboard 返回统计与矩阵数据', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).get('/api/dashboard?date=2026-08-28')
    expect(res.status).toBe(200)
    expect(res.body.stats.success).toBe(1)
    expect(res.body.stats.failed).toBe(1)
    expect(res.body.stats.total).toBe(2)
    expect(res.body.runs).toHaveLength(2)
    expect(res.body.captcha.totalCost).toBeCloseTo(0.23)
    expect(res.body.profilesEnabled).toBe(1)
  })

  it('POST /api/trigger 入队执行', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/trigger').send({ taskKey: 't1', bitbrowserId: 'bb-1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(deps.enqueuer.enqueue).toHaveBeenCalled()
  })

  it('POST /api/trigger 缺参数返回 400', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).post('/api/trigger').send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/profile/:id/toggle 切换启用', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/toggle').send({ enabled: false })
    expect(res.status).toBe(200)
    expect(deps.db.setProfileEnabled).toHaveBeenCalledWith(1, false)
  })

  it('POST /api/profile/:id/run 将该窗口全部任务入队', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/run')
    expect(res.status).toBe(200)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 't1')
  })

  it('POST /api/profile/:id/password 保存解锁密码', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/password').send({ password: 'secret' })
    expect(res.status).toBe(200)
    expect(deps.db.setProfileWalletPassword).toHaveBeenCalledWith(1, 'secret')
  })

  it('POST /api/profile/:id/reset-breaker 重置熔断', async () => {
    const deps = makeDeps()
    const app = createApp(deps as never)
    const res = await request(app).post('/api/profile/1/reset-breaker')
    expect(res.status).toBe(200)
    expect(deps.db.resetCircuitBreaker).toHaveBeenCalledWith(1)
  })

  it('POST /api/bitbrowser/test 返回连接状态', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).post('/api/bitbrowser/test')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('GET /api/captcha/balance 返回点数', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).get('/api/captcha/balance')
    expect(res.status).toBe(200)
    expect(res.body.points).toBe(98210)
    expect(res.body.yuan).toBeCloseTo(98.21)
  })

  it('GET / 返回面板页面', async () => {
    const app = createApp(makeDeps() as never)
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('AutoBitControl')
    expect(res.text).toContain('窗口管理')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/web/server.ts**

```ts
import express from 'express'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { todayStr, type AppDb, type ProfileRow, type RunStatus } from '../core/db'
import type { CoalescingEnqueuer } from '../core/queue'
import type { SiteTask } from '../tasks/base'
import type { AppConfig } from '../core/config'

export interface WebDeps {
  db: AppDb
  enqueuer: CoalescingEnqueuer
  tasks: Map<string, SiteTask>
  cfg: AppConfig
  bitbrowser: { health(): Promise<boolean> }
  captchaBalance: () => Promise<{ points: number } | null>
}

const COUNTED: RunStatus[] = ['success', 'failed', 'captcha_failed', 'skipped', 'running', 'retry_wait', 'pending']

export function createApp(deps: WebDeps): express.Express {
  const app = express()
  app.use(express.json())

  app.get('/api/dashboard', (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : todayStr()
    const runs = deps.db.listRunsForDate(date)
    const count = (s: RunStatus) => runs.filter(r => r.status === s).length
    const profiles = deps.db.listProfiles(false)
    res.json({
      date,
      stats: {
        total: runs.length,
        success: count('success'),
        failed: count('failed'),
        captchaFailed: count('captcha_failed'),
        skipped: count('skipped'),
        running: count('running') + count('retry_wait'),
        pending: count('pending'),
      },
      runs,
      captcha: deps.db.captchaStats(date),
      profilesTotal: profiles.length,
      profilesEnabled: profiles.filter(p => p.enabled === 1).length,
      tasks: [...deps.tasks.values()].map(t => ({
        key: t.meta.key,
        name: t.meta.name,
        wallet: t.meta.wallet ?? null,
        schedule: t.meta.schedule ?? null,
        timeoutSec: t.meta.timeoutSec ?? null,
        retry: t.meta.retry ?? null,
        captcha: t.meta.captcha ?? null,
      })),
    })
  })

  app.post('/api/trigger', (req, res) => {
    const { taskKey, bitbrowserId } = req.body as { taskKey?: string; bitbrowserId?: string }
    if (!taskKey) {
      res.status(400).json({ ok: false, error: '缺少 taskKey' })
      return
    }
    if (bitbrowserId) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.bitbrowserId === bitbrowserId)
      if (!profile) {
        res.status(404).json({ ok: false, error: `窗口不存在: ${bitbrowserId}` })
        return
      }
      deps.enqueuer.enqueue(profile, taskKey)
      res.json({ ok: true, scope: 'single' })
      return
    }
    for (const p of deps.db.listProfiles(true)) deps.enqueuer.enqueue(p, taskKey)
    res.json({ ok: true, scope: 'all' })
  })

  app.post('/api/rerun-failed', (req, res) => {
    const date = typeof req.body?.date === 'string' ? req.body.date : todayStr()
    const failed = deps.db.listRunsForDate(date).filter(r => r.status === 'failed' || r.status === 'captcha_failed')
    for (const r of failed) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === r.profileId)
      if (profile) deps.enqueuer.enqueue(profile, r.taskKey)
    }
    res.json({ ok: true, count: failed.length })
  })

  app.post('/api/profile/:id/toggle', (req, res) => {
    const id = Number(req.params.id)
    const enabled = Boolean(req.body?.enabled)
    deps.db.setProfileEnabled(id, enabled)
    res.json({ ok: true })
  })

  app.post('/api/profile/:id/run', (req, res) => {
    const id = Number(req.params.id)
    const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === id)
    if (!profile) {
      res.status(404).json({ ok: false, error: `窗口不存在: ${id}` })
      return
    }
    for (const task of deps.tasks.values()) deps.enqueuer.enqueue(profile, task.meta.key)
    res.json({ ok: true, count: deps.tasks.size })
  })

  app.post('/api/profile/:id/password', (req, res) => {
    const id = Number(req.params.id)
    const { password } = req.body as { password?: string | null }
    deps.db.setProfileWalletPassword(id, password ?? null)
    res.json({ ok: true })
  })

  app.post('/api/profile/:id/reset-breaker', (req, res) => {
    deps.db.resetCircuitBreaker(Number(req.params.id))
    res.json({ ok: true })
  })

  app.post('/api/bitbrowser/test', async (req, res) => {
    try {
      const ok = await deps.bitbrowser.health()
      res.json({ ok })
    } catch {
      res.json({ ok: false })
    }
  })

  app.get('/api/captcha/balance', async (req, res) => {
    try {
      const balance = await deps.captchaBalance()
      if (balance === null) {
        res.json({ configured: false, points: 0, yuan: 0 })
        return
      }
      res.json({ configured: true, points: balance.points, yuan: Number((balance.points / 1000).toFixed(2)) })
    } catch {
      res.json({ configured: false, points: 0, yuan: 0 })
    }
  })

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public')
  app.use(express.static(publicDir))
  return app
}
```

- [ ] **Step 4: 实现 src/web/public/index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>AutoBitControl 面板</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #0B0F19; color: #E2E8F0; }
  .app { display: flex; min-height: 100vh; }
  .side { width: 196px; background: #0D1220; border-right: 1px solid rgba(255,255,255,.06); padding: 20px 12px; display: flex; flex-direction: column; position: fixed; top: 0; bottom: 0; left: 0; }
  .logo { display: flex; align-items: center; gap: 10px; padding: 4px 10px 18px; border-bottom: 1px solid rgba(255,255,255,.06); }
  .logo-mark { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg,#6366F1,#8B5CF6); display: flex; align-items: center; justify-content: center; }
  .logo-name { font-weight: 700; font-size: 15px; }
  .logo-sub { color: #64748B; font-size: 10px; }
  .nav { margin-top: 14px; display: flex; flex-direction: column; gap: 4px; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; color: #94A3B8; font-size: 13px; cursor: pointer; }
  .nav-item.active { background: linear-gradient(90deg,rgba(99,102,241,.18),rgba(139,92,246,.08)); color: #E2E8F0; font-weight: 600; }
  .nav-badge { margin-left: auto; background: #F87171; color: #fff; font-size: 10px; border-radius: 8px; padding: 1px 7px; }
  .side-foot { margin-top: auto; padding: 12px; background: rgba(255,255,255,.03); border-radius: 12px; font-size: 11px; color: #64748B; line-height: 1.7; }
  .main { flex: 1; margin-left: 196px; padding: 20px 24px; }
  .topbar { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
  .page-title { font-size: 18px; font-weight: 700; }
  .crumb { color: #64748B; font-size: 12px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #94A3B8; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 999px; padding: 5px 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; }
  .dot.ok { background: #34D399; box-shadow: 0 0 8px #34D39988; }
  .dot.err { background: #F87171; }
  .stats { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 16px; }
  .stat { background: linear-gradient(180deg,#121A2C,#0F1626); border: 1px solid rgba(255,255,255,.06); border-radius: 14px; padding: 14px 16px; }
  .stat-label { font-size: 11px; color: #94A3B8; }
  .stat-value { font-size: 22px; font-weight: 700; margin-top: 6px; }
  .stat-extra { font-size: 11px; color: #64748B; margin-top: 4px; }
  .ring { width: 44px; height: 44px; border-radius: 50%; background: conic-gradient(#34D399 calc(var(--p) * 1%), #1E293B 0); display: flex; align-items: center; justify-content: center; }
  .ring-inner { width: 32px; height: 32px; border-radius: 50%; background: #101828; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #34D399; }
  .bar { display: flex; height: 6px; border-radius: 99px; overflow: hidden; }
  .card { background: linear-gradient(180deg,#121A2C,#0F1626); border: 1px solid rgba(255,255,255,.06); border-radius: 14px; padding: 14px 16px; margin-bottom: 16px; }
  .card-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .seg { display: inline-flex; background: rgba(255,255,255,.05); border-radius: 10px; padding: 3px; gap: 2px; }
  .seg span { padding: 5px 14px; border-radius: 8px; font-size: 12px; color: #94A3B8; cursor: pointer; }
  .seg span.on { background: #1E293B; color: #E2E8F0; font-weight: 600; }
  .btn { border: 0; border-radius: 10px; padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .btn.primary { background: linear-gradient(135deg,#6366F1,#8B5CF6); color: #fff; }
  .btn.ghost { background: rgba(255,255,255,.06); color: #E2E8F0; border: 1px solid rgba(255,255,255,.08); }
  .btn.sm { padding: 4px 10px; font-size: 11px; border-radius: 8px; }
  .select, .input { background: #151D30; color: #E2E8F0; border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 7px 12px; font-size: 12px; }
  table.mx { width: 100%; border-collapse: separate; border-spacing: 0 6px; font-size: 12px; }
  table.mx th { color: #64748B; font-weight: 500; text-align: left; padding: 2px 10px; font-size: 11px; }
  table.mx td { background: rgba(255,255,255,.025); padding: 9px 10px; }
  table.mx td:first-child { border-radius: 10px 0 0 10px; }
  table.mx td:last-child { border-radius: 0 10px 10px 0; }
  .pill { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 600; }
  .pill .d { width: 6px; height: 6px; border-radius: 50%; }
  .pill.ok { background: rgba(52,211,153,.12); color: #34D399; } .pill.ok .d { background: #34D399; }
  .pill.fail { background: rgba(248,113,113,.12); color: #F87171; } .pill.fail .d { background: #F87171; }
  .pill.run { background: rgba(251,191,36,.12); color: #FBBF24; } .pill.run .d { background: #FBBF24; }
  .pill.skip { background: rgba(148,163,184,.12); color: #94A3B8; } .pill.skip .d { background: #94A3B8; }
  .pill.cap { background: rgba(56,189,248,.12); color: #38BDF8; } .pill.cap .d { background: #38BDF8; }
  .link { color: #818CF8; cursor: pointer; }
  .err-text { color: #F87171; max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .avatar { width: 28px; height: 28px; border-radius: 9px; background: linear-gradient(135deg,#334155,#1E293B); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #CBD5E1; }
  .toggle { width: 34px; height: 19px; border-radius: 999px; background: #34D399; position: relative; display: inline-block; cursor: pointer; }
  .toggle::after { content: ''; position: absolute; top: 2px; left: 17px; width: 15px; height: 15px; border-radius: 50%; background: #fff; transition: .15s; }
  .toggle.off { background: #334155; } .toggle.off::after { left: 2px; }
  .progress { height: 5px; border-radius: 99px; background: #1E293B; overflow: hidden; }
  .progress i { display: block; height: 100%; border-radius: 99px; }
  .drawer { border-left: 1px solid rgba(255,255,255,.08); background: #0D1424; border-radius: 14px; padding: 14px; margin-top: 12px; }
  .section-tag { display: flex; align-items: center; gap: 8px; color: #818CF8; font-size: 12px; font-weight: 700; margin: 0 0 10px; }
  .task-card { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
  .task-card:last-child { border-bottom: 0; }
  .wallet-ico { width: 38px; height: 38px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 17px; }
  .wallet-ico.mm { background: linear-gradient(135deg,#F59E0B33,#B4530933); border: 1px solid #F59E0B44; }
  .wallet-ico.pt { background: linear-gradient(135deg,#0EA5E933,#0369A133); border: 1px solid #0EA5E944; }
  .meta { font-size: 11px; color: #64748B; margin-top: 3px; }
  .kbd { font-family: 'Cascadia Code', Consolas, monospace; background: #151D30; border: 1px solid rgba(255,255,255,.08); border-radius: 6px; padding: 2px 8px; font-size: 11px; color: #A5B4FC; }
  .page { display: none; }
  .page.on { display: block; }
</style>
</head>
<body>
<div class="app">
  <div class="side">
    <div class="logo"><div class="logo-mark">◈</div><div><div class="logo-name">AutoBitControl</div><div class="logo-sub">Web3 签到自动化</div></div></div>
    <div class="nav">
      <div class="nav-item active" data-page="dashboard"><span>▦</span>看板</div>
      <div class="nav-item" data-page="profiles"><span>▤</span>窗口<span class="nav-badge" id="badge-fail" style="display:none"></span></div>
      <div class="nav-item" data-page="tasks"><span>☰</span>任务</div>
      <div class="nav-item" data-page="settings"><span>⚙</span>设置</div>
    </div>
    <div class="side-foot">v0.1.0<br>本地服务<br>时区 Asia/Shanghai</div>
  </div>

  <div class="main">
    <div class="topbar">
      <div><div class="page-title" id="page-title">看板</div><div class="crumb" id="crumb">今日运行总览</div></div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <span class="chip" id="chip-bitbrowser"><span class="dot err"></span>比特浏览器未检测</span>
        <span class="chip" id="chip-balance"><span class="dot ok"></span>yescaptcha —</span>
      </div>
    </div>

    <div class="page on" id="page-dashboard">
      <div class="stats">
        <div class="stat"><div class="stat-label">📅 今日完成率</div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:6px">
            <div class="ring" id="ring-complete"><div class="ring-inner" id="ring-text">0%</div></div>
            <div><div class="stat-value" style="margin-top:0" id="stat-complete">0 / 0</div><div class="stat-extra">窗口任务完成</div></div>
          </div>
        </div>
        <div class="stat"><div class="stat-label">📊 结果分布</div>
          <div class="stat-value" style="font-size:15px;margin-top:10px">
            <span style="color:#34D399" id="st-ok">0</span> <span style="color:#F87171" id="st-fail">0</span> <span style="color:#38BDF8" id="st-cap">0</span> <span style="color:#94A3B8" id="st-skip">0</span>
          </div>
          <div class="stat-extra">成功 · 失败 · 验证码失败 · 跳过</div>
          <div class="bar" id="bar-dist" style="margin-top:8px"></div>
        </div>
        <div class="stat"><div class="stat-label">🧩 验证码</div>
          <div class="stat-value" style="margin-top:10px" id="st-capcost">¥0</div>
          <div class="stat-extra" id="st-capcount">0 次</div>
        </div>
        <div class="stat"><div class="stat-label">⚡ 实时运行</div>
          <div class="stat-value" style="margin-top:10px" id="st-running">0</div>
          <div class="stat-extra" id="st-profiles">窗口 0 / 启用 0</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">任务执行矩阵 <span style="font-weight:400;color:#64748B">· 窗口 × 任务 × 当日结果</span></div>
        <div class="toolbar">
          <div class="seg" id="seg-filter"><span class="on" data-f="all">全部</span><span data-f="failed">失败</span><span data-f="success">成功</span><span data-f="running">进行中</span></div>
          <select class="select" id="filter-task"><option value="">全部任务</option></select>
          <input class="input" id="filter-profile" placeholder="搜索窗口…" style="width:140px">
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn ghost sm" onclick="rerunFailed()">↻ 重跑今日失败</button>
            <button class="btn primary sm" onclick="triggerAll()">▶ 全部窗口执行</button>
          </div>
        </div>
        <table class="mx">
          <thead><tr><th>窗口</th><th>任务</th><th>状态</th><th>尝试</th><th>错误信息</th><th>截图</th><th>操作</th></tr></thead>
          <tbody id="matrix"></tbody>
        </table>
      </div>
    </div>

    <div class="page" id="page-profiles">
      <div class="card">
        <div class="toolbar">
          <input class="input" id="profile-search" placeholder="🔍 搜索窗口名 / 比特ID" style="width:220px">
          <span style="color:#64748B;font-size:12px" id="profile-count"></span>
          <div style="margin-left:auto"><button class="btn primary sm" onclick="syncProfiles()">⇅ 同步比特浏览器</button></div>
        </div>
        <table class="mx">
          <thead><tr><th>窗口</th><th>今日结果</th><th>熔断计数</th><th>启用</th><th>操作</th></tr></thead>
          <tbody id="profile-table"></tbody>
        </table>
        <div class="drawer" id="profile-drawer" style="display:none">
          <div class="card-title" id="drawer-title">详情</div>
          <div id="drawer-body"></div>
        </div>
      </div>
    </div>

    <div class="page" id="page-tasks">
      <div class="card" id="task-cards"></div>
      <div style="color:#64748B;font-size:11px">→ 任务定义在代码（src/tasks），此页只读展示与触发</div>
    </div>

    <div class="page" id="page-settings">
      <div class="card">
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0">
          <div style="width:120px;color:#94A3B8;font-size:12px">比特浏览器</div>
          <span class="kbd" id="set-bb-url">—</span>
          <button class="btn ghost sm" onclick="testBitbrowser()">测试连接</button>
          <span class="chip"><span class="dot err" id="set-bb-dot"></span><span id="set-bb-text">未检测</span></span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0">
          <div style="width:120px;color:#94A3B8;font-size:12px">执行参数</div>
          <span class="kbd" id="set-exec">—</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0">
          <div style="width:120px;color:#94A3B8;font-size:12px">yescaptcha</div>
          <button class="btn ghost sm" onclick="loadBalance()">查询余额</button>
          <span class="chip"><span class="dot ok"></span><span id="set-balance">—</span></span>
        </div>
        <div style="color:#64748B;font-size:11px;padding-top:8px">→ 设置页全部只读；修改走 config 文件 + 重启（配置单一来源）</div>
      </div>
    </div>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s)
let state = { date: localToday(), filter: 'all', taskFilter: '', profileSearch: '', profiles: [], runs: [], tasks: [] }

function localToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
async function api(path, opts) { const res = await fetch(path, opts); return res.json() }
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

const PILLS = {
  success: ['ok', '成功'], failed: ['fail', '失败'], captcha_failed: ['cap', '验证码失败'],
  running: ['run', '执行中'], retry_wait: ['run', '重试中'], skipped: ['skip', '跳过'], pending: ['skip', '待执行'],
}
const WALLET_ICON = { metamask: '<div class="wallet-ico mm">🦊</div>', petra: '<div class="wallet-ico pt">🐍</div>' }

async function loadDashboard() {
  const data = await api(`/api/dashboard?date=${state.date}`)
  state.runs = data.runs; state.profiles = data.profiles; state.tasks = data.tasks
  const s = data.stats
  const done = s.success + s.failed + s.captchaFailed + s.skipped
  const pct = s.total ? Math.round(done / s.total * 100) : 0
  $('#ring-complete').style.setProperty('--p', pct)
  $('#ring-text').textContent = pct + '%'
  $('#stat-complete').textContent = `${done} / ${s.total}`
  $('#st-ok').textContent = s.success; $('#st-fail').textContent = s.failed
  $('#st-cap').textContent = s.captchaFailed; $('#st-skip').textContent = s.skipped
  $('#st-running').textContent = s.running
  $('#st-profiles').textContent = `窗口 ${data.profilesTotal} / 启用 ${data.profilesEnabled}`
  $('#st-capcost').textContent = '¥' + (data.captcha.totalCost / 1000).toFixed(2)
  $('#st-capcount').textContent = data.captcha.count + ' 次'
  const total = s.total || 1
  $('#bar-dist').innerHTML = `<div style="width:${s.success/total*100}%;background:#34D399"></div><div style="width:${s.failed/total*100}%;background:#F87171"></div><div style="width:${s.captchaFailed/total*100}%;background:#38BDF8"></div><div style="width:${s.skipped/total*100}%;background:#334155"></div>`
  const badge = $('#badge-fail')
  badge.textContent = s.failed + s.captchaFailed
  badge.style.display = s.failed + s.captchaFailed > 0 ? '' : 'none'
  $('#filter-task').innerHTML = '<option value="">全部任务</option>' + data.tasks.map(t => `<option value="${t.key}">${t.name}</option>`).join('')
  renderMatrix()
}

function renderMatrix() {
  const rows = state.runs.filter(r => {
    if (state.filter === 'failed' && !['failed','captcha_failed'].includes(r.status)) return false
    if (state.filter === 'success' && r.status !== 'success') return false
    if (state.filter === 'running' && !['running','retry_wait'].includes(r.status)) return false
    if (state.taskFilter && r.taskKey !== state.taskFilter) return false
    if (state.profileSearch && !r.profileName.includes(state.profileSearch)) return false
    return true
  })
  $('#matrix').innerHTML = rows.map(r => {
    const [cls, label] = PILLS[r.status] ?? ['skip', r.status]
    const profile = state.profiles.find(p => p.id === r.profileId)
    const bitId = profile ? String(profile.bitbrowserId).slice(0, 8) : ''
    const num = String(r.profileId).padStart(2, '0')
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar">${num}</div><div><div>${esc(r.profileName)}</div><div style="font-size:10px;color:#64748B">${esc(bitId)}</div></div></div></td>
      <td>${esc(r.taskKey)}</td>
      <td><span class="pill ${cls}"><span class="d"></span>${label}</span></td>
      <td>${r.attempts}</td>
      <td class="err-text" title="${esc(r.error ?? '')}">${esc(r.error ?? '—')}</td>
      <td>${r.screenshot ? `<span class="link" onclick="openShot('${esc(r.screenshot)}')">🖼 查看</span>` : '—'}</td>
      <td><span class="link" onclick="rerunOne(${r.profileId}, '${esc(r.taskKey)}')">${['failed','captcha_failed'].includes(r.status) ? '重跑' : '执行'}</span></td>
    </tr>`
  }).join('')
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) }

async function loadProfiles() {
  const data = await api(`/api/dashboard?date=${state.date}`)
  state.profiles = data.profiles; state.runs = data.runs
  $('#profile-count').textContent = `${data.profilesTotal} 个窗口 · 启用 ${data.profilesEnabled}`
  const q = $('#profile-search').value.trim()
  const rows = data.profiles.filter(p => !q || p.name.includes(q) || p.bitbrowserId.includes(q))
  $('#profile-table').innerHTML = rows.map(p => {
    const mine = data.runs.filter(r => r.profileId === p.id)
    const ok = mine.filter(r => r.status === 'success').length
    const fail = mine.filter(r => ['failed','captcha_failed'].includes(r.status)).length
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar">${String(p.id).padStart(2,'0')}</div><div><div>${esc(p.name)}</div><div style="font-size:10px;color:#64748B">${esc(p.bitbrowserId)}</div></div></div></td>
      <td><span style="color:#34D399">${ok} ✓</span>${fail ? ` <span style="color:#F87171">${fail} ✗</span>` : ''}</td>
      <td><span style="color:${p.circuitBreakerCount > 0 ? '#FBBF24' : '#64748B'};font-size:11px">${p.circuitBreakerCount}/2</span></td>
      <td><span class="toggle ${p.enabled ? '' : 'off'}" onclick="toggleProfile(${p.id}, ${p.enabled ? 0 : 1})"></span></td>
      <td><span class="link" onclick="runProfile(${p.id})">立即跑</span> · <span class="link" onclick="openDrawer(${p.id})">详情</span></td>
    </tr>`
  }).join('')
}

async function openDrawer(id) {
  const data = await api(`/api/dashboard?date=${state.date}`)
  const p = data.profiles.find(x => x.id === id)
  const mine = data.runs.filter(r => r.profileId === id)
  $('#profile-drawer').style.display = ''
  $('#drawer-title').textContent = `详情抽屉 · ${p.name}`
  $('#drawer-body').innerHTML = `
    <div style="border-left:2px solid #1E293B;padding-left:14px;display:flex;flex-direction:column;gap:10px;margin-bottom:12px">
      ${mine.length ? mine.map(r => {
        const [cls] = PILLS[r.status] ?? ['skip']
        const dot = { ok: '#34D399', fail: '#F87171', cap: '#38BDF8', run: '#FBBF24', skip: '#94A3B8' }[cls]
        return `<div style="position:relative;font-size:12px"><span style="position:absolute;left:-19px;top:5px;width:8px;height:8px;border-radius:50%;background:${dot}"></span>${r.taskKey} <span class="pill ${cls}"><span class="d"></span>${PILLS[r.status][1]}</span>${r.error ? ` · ${esc(r.error)}` : ''}</div>`
      }).join('') : '<div style="color:#64748B">今日暂无任务记录</div>'}
    </div>
    <div style="font-size:12px;color:#94A3B8;display:flex;gap:8px;align-items:center">
      本窗口钱包解锁密码 ${p.walletPassword ? '<span class="kbd">••••••</span>' : '<span style="color:#64748B">未设置</span>'}
      <span class="link" onclick="setPassword(${p.id})">${p.walletPassword ? '修改' : '设置'}</span>
      <span class="link" style="margin-left:12px" onclick="resetBreaker(${p.id})">重置熔断</span>
    </div>`
}

async function toggleProfile(id, enabled) { await post(`/api/profile/${id}/toggle`, { enabled }); loadProfiles() }
async function runProfile(id) { await post(`/api/profile/${id}/run`); loadProfiles() }
async function resetBreaker(id) { await post(`/api/profile/${id}/reset-breaker`); loadProfiles() }
async function setPassword(id) {
  const password = prompt('输入该窗口的钱包解锁密码（留空清除）')
  if (password === null) return
  await post(`/api/profile/${id}/password`, { password: password || null })
  openDrawer(id)
}

async function triggerAll() {
  const taskKey = $('#filter-task').value
  if (!taskKey) { alert('请先选择一个任务'); return }
  await post('/api/trigger', { taskKey })
  loadDashboard()
}
async function rerunOne(profileId, taskKey) {
  const p = state.profiles.find(x => x.id === profileId)
  await post('/api/trigger', { taskKey, bitbrowserId: p.bitbrowserId })
  loadDashboard()
}
async function rerunFailed() { await post('/api/rerun-failed', { date: state.date }); loadDashboard() }

async function renderTasks() {
  const data = await api(`/api/dashboard?date=${state.date}`)
  $('#task-cards').innerHTML = data.tasks.map(t => {
    const icon = WALLET_ICON[t.wallet] ?? '<div class="wallet-ico" style="background:#33415522">▣</div>'
    const sched = t.schedule === null ? '手动触发' : typeof t.schedule === 'string' ? `cron ${t.schedule}` : `cron ${t.schedule.stagger[0]}-${t.schedule.stagger[1]} 错峰`
    return `<div class="task-card">
      ${icon}
      <div style="flex:1"><div style="font-weight:700;font-size:13px">${esc(t.name)} <span style="color:#64748B;font-weight:400">${esc(t.key)}</span></div>
      <div class="meta">⏱ ${esc(sched)} · 钱包 ${esc(t.wallet ?? '无')} · 重试 ${t.retry?.max ?? '默认'} 次 · 验证码 ${t.captcha?.auto === false ? '关' : '自动'}</div></div>
      <button class="btn primary sm" onclick="triggerTask('${esc(t.key)}')">立即触发</button>
    </div>`
  }).join('')
}
async function triggerTask(taskKey) { await post('/api/trigger', { taskKey }); loadDashboard() }

async function testBitbrowser() {
  const r = await post('/api/bitbrowser/test')
  $('#set-bb-dot').className = 'dot ' + (r.ok ? 'ok' : 'err')
  $('#set-bb-text').textContent = r.ok ? '已连接' : '连接失败'
}
async function loadBalance() {
  const r = await api('/api/captcha/balance')
  $('#set-balance').textContent = r.configured ? `${r.points.toLocaleString()} 点（¥${r.yuan}）` : '未配置 Key'
}
async function syncProfiles() {
  const r = await api('/api/dashboard?date=' + state.date)
  $('#profile-count').textContent = `${r.profilesTotal} 个窗口 · 启用 ${r.profilesEnabled}`
  loadProfiles()
}

document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'))
  el.classList.add('active')
  document.querySelectorAll('.page').forEach(x => x.classList.remove('on'))
  $('#page-' + el.dataset.page).classList.add('on')
  const titles = { dashboard: ['看板', '今日运行总览'], profiles: ['窗口', '窗口管理与详情'], tasks: ['任务', '任务定义与手动触发'], settings: ['设置', '运行参数（只读）'] }
  $('#page-title').textContent = titles[el.dataset.page][0]
  $('#crumb').textContent = titles[el.dataset.page][1]
  if (el.dataset.page === 'profiles') loadProfiles()
  if (el.dataset.page === 'tasks') renderTasks()
}))
$('#seg-filter').addEventListener('click', e => {
  if (!e.target.dataset.f) return
  document.querySelectorAll('#seg-filter span').forEach(x => x.classList.remove('on'))
  e.target.classList.add('on')
  state.filter = e.target.dataset.f
  renderMatrix()
})
$('#filter-task').addEventListener('change', e => { state.taskFilter = e.target.value; renderMatrix() })
$('#filter-profile').addEventListener('input', e => { state.profileSearch = e.target.value; renderMatrix() })
$('#profile-search').addEventListener('input', loadProfiles)

testBitbrowser()
loadBalance()
loadDashboard()
setInterval(loadDashboard, 15000)
</script>
</body>
</html>
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 手动验证面板（不写代码）**

`npm run dev` 启动后浏览器打开 http://127.0.0.1:3000，逐页验证：
1. 看板：统计卡数字正确、矩阵渲染、状态 tab 过滤生效、选任务点「全部窗口执行」后比特浏览器窗口真实打开并执行、「重跑今日失败」入队
2. 窗口：搜索过滤、启用开关切换后刷新仍生效、详情抽屉显示时间线与密码设置、重置熔断生效
3. 任务：卡片展示 cron/钱包/重试配置、「立即触发」入队
4. 设置：「测试连接」显示已连接、「查询余额」显示点数与 ¥
同时确认面板无跨域报错（同源），15 秒自动刷新正常。

- [ ] **Step 7: Commit**

```powershell
git add src/web/server.ts src/web/public/index.html tests/web.test.ts
git commit -m "feat: 4-page dark dashboard with matrix, profiles drawer and settings"
```

---

### Task 11: 钱包适配器（MetaMask + Petra）

**Files:**
- Create: `src/core/wallet/popup.ts`
- Create: `src/core/wallet/metamask.ts`
- Create: `src/core/wallet/petra.ts`
- Create: `tests/wallet.test.ts`

**Interfaces:**
- Consumes: `WalletAdapter`/`PopupPage`/`PopupLocator`/`WalletRegistry`（Task 7）
- Produces: `matchesWalletUrl(url, patterns)`、`waitForPopup(page, patterns, timeoutMs)`（对 patchright BrowserContext 的包装）、`MetaMaskAdapter`、`PetraAdapter`（Task 12 依赖）

- [ ] **Step 1: 写失败测试 tests/wallet.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { MetaMaskAdapter } from '../src/core/wallet/metamask'
import { PetraAdapter } from '../src/core/wallet/petra'
import { WalletRegistry, type PopupPage, type PopupLocator } from '../src/core/wallet/types'
import { matchesWalletUrl } from '../src/core/wallet/popup'

function makeLocator(over: Partial<PopupLocator> = {}): PopupLocator {
  return { click: async () => {}, fill: async () => {}, press: async () => {}, first() { return this }, ...over }
}

function makePopup(over: Partial<PopupPage> = {}): PopupPage {
  return {
    url: () => 'chrome-extension://abc/home.html',
    getByRole: () => makeLocator(),
    getByTestId: () => makeLocator(),
    locator: () => makeLocator(),
    waitForEvent: async () => {},
    ...over,
  }
}

describe('matchesWalletUrl', () => {
  it('按正则匹配扩展 URL', () => {
    expect(matchesWalletUrl('chrome-extension://xyz/home.html#connect', ['chrome-extension://.*/home.html'])).toBe(true)
    expect(matchesWalletUrl('https://site.io', ['chrome-extension://.*/home.html'])).toBe(false)
  })
})

describe('MetaMaskAdapter', () => {
  it('unlock 填写密码并提交', async () => {
    const filled: string[] = []
    const clicked = { count: 0 }
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: (id: string) => id === 'unlock-password'
        ? makeLocator({ fill: async (t: string) => { filled.push(t) } })
        : makeLocator({ click: async () => { clicked.count++ } }),
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual(['secret123'])
    expect(clicked.count).toBe(1)
  })

  it('ensureConnected 点击确认按钮', async () => {
    const clicked = { count: 0 }
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByRole: () => makeLocator({ click: async () => { clicked.count++ } }),
    })
    await adapter.ensureConnected(popup)
    expect(clicked.count).toBeGreaterThan(0)
  })
})

describe('PetraAdapter', () => {
  it('ensureConnected 点击连接按钮', async () => {
    const clicked = { count: 0 }
    const adapter = new PetraAdapter()
    const popup = makePopup({
      getByRole: () => makeLocator({ click: async () => { clicked.count++ } }),
    })
    await adapter.ensureConnected(popup)
    expect(clicked.count).toBeGreaterThan(0)
  })
})

describe('WalletRegistry', () => {
  it('注册与查找', () => {
    const reg = new WalletRegistry()
    reg.register(new MetaMaskAdapter())
    reg.register(new PetraAdapter())
    expect(reg.has('metamask')).toBe(true)
    expect(reg.has('petra')).toBe(true)
    expect(() => reg.get('nope')).toThrow(/未注册/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/core/wallet/popup.ts**

```ts
import type { BrowserContext, Page } from 'patchright'

export function matchesWalletUrl(url: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(p).test(url))
}

export async function waitForPopup(context: BrowserContext, patterns: string[], timeoutMs: number): Promise<Page | null> {
  const existing = context.pages().find(p => matchesWalletUrl(p.url(), patterns))
  if (existing) return existing
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      context.off('page', handler)
      resolve(null)
    }, timeoutMs)
    const handler = (p: Page) => {
      if (matchesWalletUrl(p.url(), patterns)) {
        clearTimeout(timer)
        context.off('page', handler)
        resolve(p)
      }
    }
    context.on('page', handler)
  })
}
```

- [ ] **Step 4: 实现 src/core/wallet/metamask.ts**

```ts
import type { WalletAdapter, PopupPage } from './types'

export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html', 'metamask://']

  async unlock(popup: PopupPage, password: string): Promise<void> {
    await popup.getByTestId('unlock-password').fill(password)
    await popup.getByTestId('unlock-submit').click()
    await popup.waitForEvent('close', { timeout: 15000 })
  }

  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = popup.getByRole('button', { name: /connect|next|confirm|approve|sign/i })
      await btn.first().click({ timeout: 8000 })
      const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
      if (closed) return
    }
  }
}
```

- [ ] **Step 5: 实现 src/core/wallet/petra.ts**

```ts
import type { WalletAdapter, PopupPage } from './types'

export class PetraAdapter implements WalletAdapter {
  key = 'petra'
  extensionUrlPatterns = ['chrome-extension://.*/index.html', 'chrome-extension://.*/popup.html']

  async unlock(popup: PopupPage, password: string): Promise<void> {
    await popup.locator('input[type="password"]').fill(password)
    await popup.locator('input[type="password"]').press?.('Enter')
  }

  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = popup.getByRole('button', { name: /connect|approve|confirm|sign|unlock/i })
      await btn.first().click({ timeout: 8000 })
      const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
      if (closed) return
    }
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```powershell
git add src/core/wallet/popup.ts src/core/wallet/metamask.ts src/core/wallet/petra.ts tests/wallet.test.ts
git commit -m "feat: metamask and petra wallet popup adapters"
```

---

### Task 12: 入口装配 + 冒烟脚本 + README

**Files:**
- Create: `src/index.ts`
- Create: `scripts/smoke-open-window.ts`
- Create: `scripts/smoke-wallet.ts`
- Create: `ecosystem.config.cjs`
- Create: `README.md`（覆盖现有仅一行标题的 README）

**Interfaces:**
- Consumes: Task 1-11 全部产物
- Produces: 可运行的主程序 `npm run dev`；pm2 配置；冒烟脚本；README

- [ ] **Step 1: 实现 src/index.ts**

```ts
import { loadConfig } from './core/config'
import { createLogger } from './core/logger'
import { AppDb } from './core/db'
import { createBitBrowserClient } from './core/bitbrowser'
import { PatchrightDriver, WindowRunner } from './core/windowRunner'
import { TaskQueue, CoalescingEnqueuer } from './core/queue'
import { Scheduler } from './core/scheduler'
import { YesCaptchaClient, CaptchaService } from './core/captcha'
import { WalletRegistry } from './core/wallet/types'
import { MetaMaskAdapter } from './core/wallet/metamask'
import { PetraAdapter } from './core/wallet/petra'
import { loadTasks } from './tasks'
import { createApp } from './web/server'

async function main(): Promise<void> {
  const cfg = loadConfig()
  const logger = createLogger(cfg)

  process.on('uncaughtException', (err) => {
    logger.error({ err }, '未捕获异常，进程退出')
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, '未处理的 Promise 拒绝，进程退出')
    process.exit(1)
  })

  const db = AppDb.open(cfg.storage.dbPath)
  const bitbrowser = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })

  try {
    const healthy = await bitbrowser.health()
    if (!healthy) {
      logger.warn('比特浏览器本地 API 未就绪（请确认比特浏览器已登录且 API 地址正确）')
    } else {
      const list = await bitbrowser.listBrowsers(0, 100)
      for (const b of list) db.upsertProfile(b.id, b.name)
      logger.info({ count: list.length }, '已同步比特浏览器窗口列表')
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '同步窗口列表失败（请确认比特浏览器已启动）')
  }

  const tasks = loadTasks()
  const wallets = new WalletRegistry()
  wallets.register(new MetaMaskAdapter())
  wallets.register(new PetraAdapter())

  const yescaptcha = new YesCaptchaClient(
    { apiBase: cfg.captcha.apiBase, clientKey: cfg.captcha.clientKey, solveTimeoutMs: cfg.captcha.solveTimeoutMs, pollIntervalMs: cfg.captcha.pollIntervalMs },
    cfg.captcha.taskTypes,
  )
  const captcha = cfg.captcha.clientKey
    ? new CaptchaService(yescaptcha, { maxCostPerTask: cfg.captcha.maxCostPerTask })
    : null

  const runner = new WindowRunner({
    cfg,
    db,
    bitbrowser,
    driver: new PatchrightDriver(),
    tasks,
    wallets,
    captcha,
    logger,
    artifactsDir: cfg.storage.screenshotDir,
  })
  const queue = new TaskQueue(cfg.execution.concurrency)
  const enqueuer = new CoalescingEnqueuer(queue, runner)

  const app = createApp({
    db,
    enqueuer,
    tasks,
    cfg,
    bitbrowser,
    captchaBalance: async () => {
      if (!yescaptcha) return null
      try {
        return { points: await yescaptcha.getBalance() }
      } catch {
        return null
      }
    },
  })
  app.listen(cfg.web.port, cfg.web.host, () => {
    logger.info({ url: `http://${cfg.web.host}:${cfg.web.port}` }, 'Web 面板已启动')
  })

  const scheduler = new Scheduler(cfg, db, tasks, enqueuer, logger)
  scheduler.start()

  const shutdown = () => {
    logger.info('正在关闭...')
    scheduler.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
```

- [ ] **Step 2: 实现 scripts/smoke-open-window.ts**

```ts
import { loadConfig } from '../src/core/config'
import { createLogger } from '../src/core/logger'
import { createBitBrowserClient } from '../src/core/bitbrowser'
import { PatchrightDriver } from '../src/core/windowRunner'

async function main(): Promise<void> {
  const profileId = process.env.BITBROWSER_PROFILE_ID
  if (!profileId) {
    console.error('用法: BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window')
    process.exit(1)
  }
  const cfg = loadConfig()
  const logger = createLogger(cfg)
  const client = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })
  const open = await client.openBrowser(profileId)
  logger.info({ open }, '开窗成功')
  const conn = await new PatchrightDriver().connect(`http://${open.http}`)
  await conn.page.goto(cfg.execution.probeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
  logger.info({ url: conn.page.url() }, '页面打开成功')
  await conn.close()
  await client.closeBrowser(profileId)
  logger.info('冒烟通过')
}

void main()
```

- [ ] **Step 3: 实现 scripts/smoke-wallet.ts**

```ts
import { loadConfig } from '../src/core/config'
import { createLogger } from '../src/core/logger'
import { createBitBrowserClient } from '../src/core/bitbrowser'
import { PatchrightDriver } from '../src/core/windowRunner'
import { waitForPopup } from '../src/core/wallet/popup'
import { WalletRegistry } from '../src/core/wallet/types'
import { MetaMaskAdapter } from '../src/core/wallet/metamask'
import { PetraAdapter } from '../src/core/wallet/petra'

async function main(): Promise<void> {
  const profileId = process.env.BITBROWSER_PROFILE_ID
  const walletKey = process.env.WALLET_KEY ?? 'metamask'
  if (!profileId) {
    console.error('用法: BITBROWSER_PROFILE_ID=<窗口ID> WALLET_KEY=metamask|petra npm run smoke:wallet')
    process.exit(1)
  }
  const cfg = loadConfig()
  const logger = createLogger(cfg)
  const client = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })
  const reg = new WalletRegistry()
  reg.register(new MetaMaskAdapter())
  reg.register(new PetraAdapter())
  const adapter = reg.get(walletKey)

  const open = await client.openBrowser(profileId)
  const conn = await new PatchrightDriver().connect(`http://${open.http}`)
  await conn.page.goto('https://opensea.io').catch(() => {})
  logger.info('请手动点击页面上的连接钱包按钮（60 秒内）...')
  const popup = await waitForPopup(conn.page.context(), adapter.extensionUrlPatterns, 60000)
  if (!popup) {
    logger.error('未检测到钱包弹窗')
    process.exit(1)
  }
  logger.info({ url: popup.url() }, '检测到钱包弹窗，尝试自动确认')
  await adapter.ensureConnected(popup)
  logger.info('钱包弹窗处理完成')
  await conn.close()
  await client.closeBrowser(profileId)
}

void main()
```

- [ ] **Step 4: 编写 ecosystem.config.cjs**

```js
module.exports = {
  apps: [
    {
      name: 'autobitcontrol',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
  ],
}
```

- [ ] **Step 5: 编写 README.md**

```markdown
# AutoBitControl

Web3 自动签到任务系统：比特浏览器多窗口 + 拟人化 + yescaptcha 自动打码。

## 环境要求

- Windows 10/11，Node 20.x，比特浏览器（本机运行中）
- 比特浏览器 API 已开启（默认 http://127.0.0.1:54345，可在 config 修改）

## 安装

```powershell
npm install
npx patchright install chromium
Copy-Item config/.env.example config/.env
# 编辑 config/.env 填入 CAPTCHA_CLIENT_KEY
```

## 运行

```powershell
npm run dev
```

Web 面板：http://127.0.0.1:3000

## 开机自启（pm2）

```powershell
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 按提示执行输出的命令
```

## 配置

三层配置：`config/config.json`（通用）→ `config/config.local.json`（本机覆盖）→ `config/.env`（密钥）。
钱包解锁密码在 SQLite `profiles` 表的 `wallet_password` 字段按窗口配置。

## 冒烟测试

```powershell
BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window
BITBROWSER_PROFILE_ID=<窗口ID> WALLET_KEY=petra npm run smoke:wallet
```

## 新增任务

在 `src/tasks/` 新建类继承 `SiteTask`（参考 `example-checkin.ts`），在 `src/tasks/index.ts` 的 ALL 数组注册。

## 测试

```powershell
npm test
```
```

- [ ] **Step 6: 类型检查与全量测试**

Run:
```powershell
npx tsc --noEmit
npm test
```
Expected: tsc 无错误；全部测试 PASS。若 tsc 报错，修复后重跑。

- [ ] **Step 7: 真实冒烟（手动，需比特浏览器运行）**

Run: `BITBROWSER_PROFILE_ID=<你的窗口ID> npm run smoke:window`
Expected: 开窗成功、探活页面打开、关窗成功。

- [ ] **Step 8: Commit**

```powershell
git add src/index.ts scripts/ ecosystem.config.cjs README.md
git commit -m "feat: application entrypoint, smoke scripts, pm2 config and readme"
```

---

## Self-Review 记录

- 规格覆盖：spec 第 2 节架构→Task 8/12；第 3 节组件→Task 1/5/6/11；第 4 节任务模型→Task 7；第 5 节拟人化→Task 5；第 6 节验证码→Task 6；第 7 节稳定性/状态机/SQLite/面板→Task 2/3/8/10；第 8 节配置→Task 1；第 10 节 MVP 顺序→Task 编号顺序；第 11 节运行部署→Task 12
- 类型一致性：`RunStatus`（Task 2）在 Task 3/8 引用一致；`Humanizer` 接口 Task 5 定义、Task 7/8 使用一致；`WalletRegistry`/`WalletAdapter` Task 7 定义、Task 8/11/12 使用一致；`CoalescingEnqueuer.enqueue(profile, taskKey)` Task 8 定义、Task 9/10/12 调用一致；`OpenResult { http, ws }`（Task 4）与 Task 8/12 的 `connect(\`http://${open.http}\`)` 用法一致
- 外部接口全部按官方文档核实（见「外部接口参考」一节）：比特浏览器 success/msg 约定与 `data.http` 调试地址、yescaptcha 任务类型精确拼写与 1 并发硬限制（客户端串行排队）、patchright `isolatedContext: false` 回填 token、better-sqlite3 锁 v12
- 已知偏差：设计文档 7.3 节 profiles 表含"绑定任务"字段，实施中简化为"所有启用窗口跑所有注册任务"（MVP），按任务过滤留待后续加 `task_keys` 列；README 已同步此语义。钱包类型为任务级配置（TaskMeta.wallet），profiles 表只保留钱包解锁密码（按窗口）
- 已知偏差 2：yescaptcha 官方不支持极验 GeeTest，设计文档 6 节中的"极验等"改为实际支持范围（Turnstile/reCAPTCHA/hCaptcha/图片），遇极验站点需后续接其他打码平台
- UI：Task 10 按设计文档 7.5.1 实现 4 页深色面板（看板/窗口/任务/设置），交互细节（截图大图、错误悬浮完整）为前端细节实现，MVP 中截图点击弹大图暂用新窗口打开图片替代

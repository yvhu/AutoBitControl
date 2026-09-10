# Arc 领水人机验证 rev3 实施计划（打码平台抽象 + 九宫格求解器对齐官方 DEMO）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构打码架构（多平台可插拔 + 人机验证模块独立封装），重写 reCAPTCHA 九宫格求解器严格对齐 yescaptcha 官方 DEMO，修复 arc 领水真机 0 通过问题。

**Architecture:** 新增 `integrations/captcha/`（CaptchaProvider 接口 + yescaptcha 适配器，未来平台照此扩展）与 `automation/captcha/`（detect/token-solve/grid/turnstile/question-map 自研模块，只依赖 provider 接口）；TaskContext API 不变；旧 `integrations/yescaptcha.ts`、`automation/recaptcha-grid.ts`、`automation/turnstile.ts` 删除。

**Tech Stack:** Node/TS 严格模式、patchright、Jimp、vitest、libsql（SQLite）。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-09-10-arc-faucet-rev3-design.md`（本计划逐条实现它）
- 代码风格：无分号、单引号、2 空格缩进、camelCase、文件 kebab-case、TS 严格模式、中文日志 `logger.info({...}, '消息')`、文件头中文注释块
- 注释一律中文；commit 用 conventional 中文：`feat:`/`fix:`/`refactor:`/`docs:`
- 依赖方向不可反向：tasks → engine → {automation, integrations} → infrastructure；`src/app.ts` 是唯一组装点
- 每个任务完成必须 `npm run typecheck` 通过；测试命令 `npm test`
- 真机验证遵守窗口规范：想清楚再跑、复用会话、禁止频繁开关窗口

## 关键接口契约（跨任务一致，实施者不得偏离）

```ts
// integrations/captcha/provider.ts
export type TokenCaptchaKind = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha'
export type CaptchaKind = TokenCaptchaKind | 'recaptcha_v2_grid'
export interface CaptchaDetected { kind: TokenCaptchaKind; sitekey: string | null }
export class CaptchaFailure extends Error {}
export type GridResult = { type: 'multi'; objects: number[] } | { type: 'single'; hasObject: boolean }
export const ESTIMATED_COST_POINTS: Record<CaptchaKind, number>
export type CaptchaLogFn = (platform: string, kind: string, ok: boolean, costPoints: number) => void
export interface CaptchaProvider {
  readonly platform: string
  solveToken(kind: TokenCaptchaKind, sitekey: string | null, pageUrl: string, extra?: Record<string, unknown>): Promise<string>
  classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult>
  getBalance(): Promise<number>
}

// integrations/captcha/index.ts
export function createCaptchaProvider(cfg: CaptchaConfig): CaptchaProvider | null
// 无对应平台 clientKey 时返回 null（无 Key 也能跑，任务侧返回 'none'）

// config.ts
export interface YesCaptchaConfig { apiBase: string; clientKey: string }
export interface CaptchaConfig {
  provider: string
  solveTimeoutMs: number
  pollIntervalMs: number
  maxCostPerTask: number
  yescaptcha: YesCaptchaConfig
}

// automation/captcha/detect.ts
export async function detectCaptcha(page: Page, timeoutMs?: number): Promise<CaptchaDetected | null>

// automation/captcha/token-solve.ts
export async function autoSolve(page: Page, provider: CaptchaProvider, opts: {
  enabled: boolean
  maxCostPerTask: number
  onLog: CaptchaLogFn
}): Promise<'none' | 'solved' | 'failed'>

// automation/captcha/grid.ts
export const MAX_ROUNDS_DEFAULT = 3
export function findAnchorFrame(page: Page, excludeSiteKey?: string): Frame | null
export function findChallengeFrame(page: Page, excludeSiteKey?: string): Frame | null
export async function solveRecaptchaGrid(
  deps: { page: Page; provider: CaptchaProvider; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer },
  opts: { maxRounds?: number; siteKeyExclude?: string; maxCostPerTask?: number; onLog?: CaptchaLogFn },
): Promise<'solved' | 'none' | 'failed'>

// db.ts
async logCaptcha(profileId: number | null, taskKey: string | null, platform: string, kind: string, cost: number, ok: boolean): Promise<void>

// window-runner.ts deps
captcha: CaptchaProvider | null
onCaptchaLog: (platform: string, kind: string, ok: boolean, costPoints: number) => void
```

## yescaptcha 官方文档核对总表（硬性约束）

**原则：凡写入 yescaptcha 适配器的每一行，必须能指向下表官方出处；核对不到的类型/参数一律不写。**

| 代码元素 | 官方出处（wiki 页面） | 官方原文要点 |
|---|---|---|
| POST /createTask，body `{clientKey, task:{type,...}}`，响应 `errorId/errorCode/errorDescription/taskId` | 33351 createTask | 「task 验证码类型」「errorId: 0 - 没有错误，1 - 有错误」 |
| POST /getTaskResult，body `{clientKey, taskId}`，响应 `status: processing/ready` + `solution` | 196857 getTaskResult | 「**间隔3秒一次**请求 getTaskResult 接口轮询获取结果」「直到获取结果，或者报错，或者 **120秒任务超时**」「每个任务创建以后只计费一次」 |
| POST /getBalance，body `{clientKey}`，响应 `balance`（Decimal） | 229767 getBalance | 「balance：帐户余额（点数）1元1000点」 |
| turnstile → type `TurnstileTaskProxyless`，参数 `websiteURL/websiteKey`，响应 `solution.token` | 61734913 | 「25 POINTS」「token 一次性使用，有效期120s，建议在60s内使用」 |
| recaptcha_v2 → type `NoCaptchaTaskProxyless`，参数 `websiteURL/websiteKey/isInvisible(否)`，响应 `solution.gRecaptchaResponse` | 229796 | 「15 POINTS」「遇到isInvisible类型的reCaptchaV2需要添加此参数」 |
| recaptcha_v3 → type `RecaptchaV3TaskProxyless`，参数 `websiteURL/websiteKey/pageAction`，响应 `solution.gRecaptchaResponse` | 655381 | 「20 POINTS」「pageAction 此值必须正确，否则识别的结果无效」 |
| hcaptcha → type `HCaptchaTaskProxyless`，参数 `websiteURL/websiteKey/userAgent(否)/isInvisible(否)/rqdata(否)`，响应 `solution.gRecaptchaResponse` | 7929858 | 「30 点数」「通过率不是100%，通过率只有10%~90%不等」 |
| recaptcha_v2_grid → type `ReCaptchaV2Classification`，参数 `image/question/confidence`，响应 `objects`(multi)/`hasObject`(single) | 18055169 | 「image：Base64 编码的图片，不要包含 data: 前缀」「必须将图片缩放至标准大小 (100x100, 300x300, 450x450)」「question：以 /m/ 开头」「confidence 非必填；3x3 指定分值（建议0.5）返回所有大于该分值的结果，不指定返回前三；**4x4和1x1指定此值无意义**」「300x300 450x450 **6 POINTS**、100x100 **2 点数**」「1x1：按下3x3后刷出来的小图，缩放到100x100，返回 hasObject 是否需要点击」 |
| 模拟点击流程（点锚点→提示语→整图→点格→1x1确认→verify→aria-checked） | 29786113 官方 Python DEMO + GitHub RecaptchaResolver | 见 spec rev3 第 4 节流程骨架 |
| **不迁移**：image（ImageToTextTask） | 164300 | 官方参数为 `body`（非 image），且分同步（OcrBase/Muggle 2点）与异步（4/15点）双形态——与现 token 轮询模型不同；项目无任何任务使用 image 类型，**本次不写**（未来有需求时按 164300 单独实现） |

**官方要点对实现的三个强制约束：**

1. 轮询节奏：`pollIntervalMs` 默认 3000（官方「间隔3秒一次」）、`solveTimeoutMs` 默认 120000（官方「120秒任务超时」）——config 默认值不变即对齐
2. 九宫格记账分两档：主网格（300x300/450x450）**6 点**、单格 1x1（100x100）**2 点**——rev2 统一记 6 点是错的，必须分档
3. 主网格分类**不传 confidence**（官方：不指定时返回前三；4x4 指定无意义）；1x1 单格分类也不传（官方：1x1 指定无意义）

---

### Task 1: `integrations/captcha/provider.ts` 平台接口与共享类型

**Files:**
- Create: `src/integrations/captcha/provider.ts`
- Test: `tests/captcha-provider.test.ts`

**Interfaces:**
- Produces: `TokenCaptchaKind`/`CaptchaKind`/`CaptchaDetected`/`CaptchaFailure`/`GridResult`/`ESTIMATED_COST_POINTS`/`CaptchaLogFn`/`CaptchaProvider`（后续所有任务依赖）

- [ ] **Step 1: 写失败测试**

创建 `tests/captcha-provider.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { CaptchaFailure, ESTIMATED_COST_POINTS } from '../src/integrations/captcha/provider'

describe('provider 共享类型', () => {
  it('CaptchaFailure 是 Error 子类（window-runner 用它判 captcha_failed 终态）', () => {
    const e = new CaptchaFailure('余额不足')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('余额不足')
  })

  it('成本估算表覆盖全部验证码类型（不含 image：官方 ImageToTextTask 本次不迁移）', () => {
    expect(Object.keys(ESTIMATED_COST_POINTS).sort()).toEqual(
      ['turnstile', 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'recaptcha_v2_grid'].sort(),
    )
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/captcha-provider.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/integrations/captcha/provider.ts`：

```ts
/**
 * 打码平台抽象接口（integrations 层）：平台无关契约，automation 层只依赖此文件
 * 依赖方向：不依赖任何项目模块，被 integrations/captcha 各平台实现与 automation/captcha 依赖
 * 设计思路：各打码平台 API 差异（任务类型名/认证/返回结构）由平台子目录自行消化，
 * 对外统一实现 CaptchaProvider；未来接入 capsolver/2captcha 等 = 新增平台子目录 + config 切换
 */
/** token 类验证码类型（solveToken 支持；image 类型官方为 body 参数且同步/异步双形态，本次不迁移，见计划核对总表） */
export type TokenCaptchaKind = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha'
/** 全部验证码类型（含九宫格图片分类，仅用于记账/日志） */
export type CaptchaKind = TokenCaptchaKind | 'recaptcha_v2_grid'

/** 页面验证码检测结果 */
export interface CaptchaDetected {
  kind: TokenCaptchaKind
  sitekey: string | null
}

/** 打码业务失败（余额不足/解题超时/无 sitekey 等）；window-runner 以此区分 captcha_failed 终态 */
export class CaptchaFailure extends Error {}

/** 九宫格分类结果：multi = 需要点击的格子序号（3x3 为 0-8，4x4 为 0-15）；single = 单图是否含目标 */
export type GridResult = { type: 'multi'; objects: number[] } | { type: 'single'; hasObject: boolean }

/** 各类型单次解题估算点数（1 点 = ¥0.001；点数按 yescaptcha 官方价格表，见计划核对总表） */
export const ESTIMATED_COST_POINTS: Record<CaptchaKind, number> = {
  turnstile: 25,
  recaptcha_v2: 15,
  recaptcha_v3: 20,
  hcaptcha: 30,
  recaptcha_v2_grid: 6,
}

/** 打码成本记账回调（platform 用于多平台记账区分） */
export type CaptchaLogFn = (platform: string, kind: string, ok: boolean, costPoints: number) => void

/** 打码平台统一接口 */
export interface CaptchaProvider {
  /** 平台标识（如 'yescaptcha'），记账与日志区分用 */
  readonly platform: string
  /**
   * token 类解题：创建任务 → 轮询结果 → 返回 token
   * @param kind 验证码类型（决定平台任务类型与 solution 取值字段）
   * @param sitekey 站点 sitekey（缺失由实现抛 CaptchaFailure）
   * @param pageUrl 触发验证码的页面地址
   * @param extra 透传给平台任务体的附加参数（官方可选参数原样透传：recaptcha_v2 的 isInvisible、
   *   recaptcha_v3 的 pageAction、hcaptcha 的 userAgent/isInvisible/rqdata）
   */
  solveToken(kind: TokenCaptchaKind, sitekey: string | null, pageUrl: string, extra?: Record<string, unknown>): Promise<string>
  /**
   * 九宫格图片分类：提交网格/单格图（已缩放到官方标准尺寸的 Base64，无 data: 前缀）与问题 ID
   * @param image 图片 Base64（无 data: 前缀；官方要求标准大小 100x100/300x300/450x450）
   * @param questionId 问题 ID（官方要求以 /m/ 开头）
   * @param confidence 置信度阈值（官方 int 非必填；3x3 指定后返回所有大于分值的结果；4x4/1x1 指定无意义）
   */
  classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult>
  /** 查询账户余额（点） */
  getBalance(): Promise<number>
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/captcha-provider.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
Expected: 通过

```powershell
git add src/integrations/captcha/provider.ts tests/captcha-provider.test.ts
git commit -m "feat: 打码平台抽象接口 CaptchaProvider（多平台可插拔地基）"
```

---

### Task 2: config 重写（provider 可切换 + 平台专属段）

**Files:**
- Modify: `src/infrastructure/config.ts`（`YesCaptchaConfig`/`CaptchaConfig` 类型 + defaults + env 覆盖）
- Modify: `config/config.json`（captcha 段重写，删 taskTypes）
- Test: `tests/config.test.ts`（更新断言）

**Interfaces:**
- Produces: `CaptchaConfig { provider, solveTimeoutMs, pollIntervalMs, maxCostPerTask, yescaptcha: { apiBase, clientKey } }`；`cfg.captcha.yescaptcha.clientKey` 承接环境变量 `CAPTCHA_CLIENT_KEY`

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 中把现有 captcha 断言（第 17、38 行 `cfg.captcha.clientKey`）替换为：

```ts
expect(cfg.captcha.provider).toBe('yescaptcha')
expect(cfg.captcha.yescaptcha.clientKey).toBe('')
expect((cfg.captcha as never).taskTypes).toBeUndefined()
```

环境变量覆盖断言改为：

```ts
expect(cfg.captcha.yescaptcha.clientKey).toBe('abc123')
```

（注意：`tests/config.test.ts` 顶部若 mock 了 `process.env.CAPTCHA_CLIENT_KEY` 写入方式，保持原样，只改读取路径。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL（captcha.clientKey 为 undefined）

- [ ] **Step 3: 实现 config.ts**

将 `src/infrastructure/config.ts` 第 40-47 行的 `CaptchaConfig` 替换为：

```ts
/** yescaptcha 平台专属配置 */
export interface YesCaptchaConfig {
  apiBase: string
  clientKey: string
}

/** 打码配置：provider 选平台，平台专属参数放同名字段（未来接入 capsolver 时并列新增） */
export interface CaptchaConfig {
  /** 打码平台标识（当前支持 yescaptcha；无对应 clientKey 时打码能力整体禁用） */
  provider: string
  /** 平台约束：识别 120 秒超时、结果 120 秒内有效 */
  solveTimeoutMs: number
  /** 轮询解题结果的间隔（太频繁触发平台限流，太慢拉长任务耗时） */
  pollIntervalMs: number
  /** 单任务打码费用上限（点，1000 点 = ¥1） */
  maxCostPerTask: number
  yescaptcha: YesCaptchaConfig
}
```

将第 164-181 行的 defaults 中 `captcha: {...}` 替换为：

```ts
  captcha: {
    provider: 'yescaptcha',
    solveTimeoutMs: 120000,
    pollIntervalMs: 3000,
    maxCostPerTask: 1500,
    yescaptcha: {
      apiBase: 'https://api.yescaptcha.com',
      clientKey: '',
    },
  },
```

将第 271 行 `if (env.CAPTCHA_CLIENT_KEY) cfg.captcha.clientKey = env.CAPTCHA_CLIENT_KEY` 替换为：

```ts
  if (env.CAPTCHA_CLIENT_KEY) cfg.captcha.yescaptcha.clientKey = env.CAPTCHA_CLIENT_KEY
```

- [ ] **Step 4: 更新 config.json**

将 `config/config.json` 第 25-39 行的 captcha 段整体替换为：

```json
  "captcha": {
    "provider": "yescaptcha",
    "solveTimeoutMs": 120000,
    "pollIntervalMs": 3000,
    "maxCostPerTask": 1500,
    "yescaptcha": {
      "apiBase": "https://api.yescaptcha.com",
      "clientKey": ""
    }
  },
```

（`config.local.json` 若存在且含旧 captcha 段，同构更新为 `"captcha": { "yescaptcha": { "clientKey": "..." } }`。）

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```powershell
git add src/infrastructure/config.ts config/config.json tests/config.test.ts
git commit -m "feat: captcha 配置重写为 provider 可切换结构（yescaptcha 专属段，taskTypes 移入代码）"
```

---

### Task 3: `integrations/captcha/yescaptcha/` 平台适配器 + 工厂

**Files:**
- Create: `src/integrations/captcha/yescaptcha/task-types.ts`
- Create: `src/integrations/captcha/yescaptcha/client.ts`
- Create: `src/integrations/captcha/yescaptcha/provider.ts`
- Create: `src/integrations/captcha/index.ts`
- Test: `tests/yescaptcha-provider.test.ts`（基于旧 `tests/captcha.test.ts` 的 fetch stub 模式重写；旧文件本任务暂保留，Task 8 删除）

**Interfaces:**
- Consumes: Task 1 的 `CaptchaProvider`/`CaptchaFailure`/`GridResult`/`TokenCaptchaKind`；Task 2 的 `CaptchaConfig`
- Produces: `YesCaptchaApiClient`、`YesCaptchaProvider`、`createCaptchaProvider(cfg)`

- [ ] **Step 1: 写失败测试**

创建 `tests/yescaptcha-provider.test.ts`：

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { YesCaptchaApiClient } from '../src/integrations/captcha/yescaptcha/client'
import { YesCaptchaProvider } from '../src/integrations/captcha/yescaptcha/provider'
import { CaptchaFailure } from '../src/integrations/captcha/provider'
import { createCaptchaProvider } from '../src/integrations/captcha'

afterEach(() => { vi.unstubAllGlobals() })

const provider = () => new YesCaptchaProvider(
  new YesCaptchaApiClient({ apiBase: 'https://api.yescaptcha.com', clientKey: 'test-key' }),
  { solveTimeoutMs: 5000, pollIntervalMs: 100 },
)

describe('YesCaptchaProvider.solveToken', () => {
  it('创建任务并轮询到 turnstile token（透传类型名与 websiteURL/websiteKey）', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (String(url).includes('createTask')) {
        expect(body.clientKey).toBe('test-key')
        expect(body.task.type).toBe('TurnstileTaskProxyless')
        expect(body.task.websiteKey).toBe('sk123')
        expect(body.task.websiteURL).toBe('https://x.io')
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      polls++
      return new Response(JSON.stringify(
        polls === 1 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution: { token: 'tok-abc' } },
      ), { status: 200 })
    }))
    await expect(provider().solveToken('turnstile', 'sk123', 'https://x.io')).resolves.toBe('tok-abc')
  })

  it('reCAPTCHA 类任务从 solution.gRecaptchaResponse 取结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'resp-abc' } }), { status: 200 })
    }))
    await expect(provider().solveToken('recaptcha_v2', 'sk', 'https://x.io')).resolves.toBe('resp-abc')
  })

  it('无 sitekey 直接抛 CaptchaFailure', async () => {
    await expect(provider().solveToken('turnstile', null, 'https://x.io')).rejects.toBeInstanceOf(CaptchaFailure)
  })

  it('extra 参数透传（isInvisible）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        expect(JSON.parse(String(init.body)).task.isInvisible).toBe(true)
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'r' } }), { status: 200 })
    }))
    await provider().solveToken('recaptcha_v2', 'sk', 'https://x.io', { isInvisible: true })
  })

  it('超时抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'processing' }), { status: 200 })
    }))
    const fast = new YesCaptchaProvider(new YesCaptchaApiClient({ apiBase: 'https://api.yescaptcha.com', clientKey: 'k' }), { solveTimeoutMs: 200, pollIntervalMs: 50 })
    await expect(fast.solveToken('turnstile', 'sk', 'https://x.io')).rejects.toThrow(/超时/)
  })

  it('轮询返回 errorId!==0 立即失败（fail fast）', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      polls++
      return new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST' }), { status: 200 })
    }))
    await expect(provider().solveToken('turnstile', 'sk', 'https://x.io')).rejects.toThrow(/ERROR_KEY_DOES_NOT_EXIST/)
    expect(polls).toBe(1)
  })

  it('平台省略 errorId 字段时按成功处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ status: 'ready', solution: { gRecaptchaResponse: 'resp-ok' } }), { status: 200 })
    }))
    await expect(provider().solveToken('recaptcha_v2', 'sk', 'https://x.io')).resolves.toBe('resp-ok')
  })

  it('两个 solveToken 串行执行（平台每账号 1 并发硬限制）', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 50))
        inFlight--
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 't' } }), { status: 200 })
    }))
    const p = provider()
    await Promise.all([p.solveToken('turnstile', 'sk1', 'https://x.io'), p.solveToken('turnstile', 'sk2', 'https://x.io')])
    expect(peak).toBe(1)
  })
})

describe('YesCaptchaProvider.classifyGrid 九宫格分类', () => {
  it('multi：请求体含 image/question，返回 objects', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        const body = JSON.parse(String(init.body))
        expect(body.task.type).toBe('ReCaptchaV2Classification')
        expect(body.task.image).toBe('b64-img')
        expect(body.task.question).toBe('/m/015qbp')
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { type: 'multi', objects: [1, 5, 8] } }), { status: 200 })
    }))
    await expect(provider().classifyGrid('b64-img', '/m/015qbp')).resolves.toEqual({ type: 'multi', objects: [1, 5, 8] })
  })

  it('single：hasObject 解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { type: 'single', hasObject: true } }), { status: 200 })
    }))
    await expect(provider().classifyGrid('b64', '/m/0k4j')).resolves.toEqual({ type: 'single', hasObject: true })
  })

  it('confidence 可选透传', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        expect(JSON.parse(String(init.body)).task.confidence).toBe(0.3)
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { objects: [1] } }), { status: 200 })
    }))
    await provider().classifyGrid('b64', '/m/0k4j', 0.3)
  })

  it('创建失败抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_ILLEGAL_IMAGE' }), { status: 200 })))
    await expect(provider().classifyGrid('b64', '/m/0k4j')).rejects.toThrow(/ERROR_ILLEGAL_IMAGE/)
  })

  it('分类超时抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'processing' }), { status: 200 })
    }))
    const fast = new YesCaptchaProvider(new YesCaptchaApiClient({ apiBase: 'https://api.yescaptcha.com', clientKey: 'k' }), { solveTimeoutMs: 200, pollIntervalMs: 50 })
    await expect(fast.classifyGrid('b64', '/m/0k4j')).rejects.toThrow(/超时/)
  })
})

describe('createCaptchaProvider 工厂', () => {
  it('未配置 clientKey 返回 null（无 Key 也能跑）', () => {
    expect(createCaptchaProvider({ provider: 'yescaptcha', yescaptcha: { apiBase: 'https://api.yescaptcha.com', clientKey: '' } } as never)).toBeNull()
  })

  it('yescaptcha + clientKey 返回 provider（platform 为 yescaptcha）', () => {
    const p = createCaptchaProvider({ provider: 'yescaptcha', solveTimeoutMs: 120000, pollIntervalMs: 3000, maxCostPerTask: 1500, yescaptcha: { apiBase: 'https://api.yescaptcha.com', clientKey: 'k' } } as never)
    expect(p?.platform).toBe('yescaptcha')
  })

  it('未知 provider 返回 null', () => {
    expect(createCaptchaProvider({ provider: 'capsolver', yescaptcha: { apiBase: '', clientKey: 'k' } } as never)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/yescaptcha-provider.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 task-types.ts**

创建 `src/integrations/captcha/yescaptcha/task-types.ts`：

```ts
/**
 * yescaptcha 平台任务类型映射（平台私有实现细节，不进用户配置）
 * 类型名按 yescaptcha 官方文档精确拼写，出处见计划核对总表（wiki 页面 164286 价格表 + 各类型页）：
 *   turnstile → TurnstileTaskProxyless（61734913）；recaptcha_v2 → NoCaptchaTaskProxyless（229796）
 *   recaptcha_v3 → RecaptchaV3TaskProxyless（655381）；hcaptcha → HCaptchaTaskProxyless（7929858）
 *   recaptcha_v2_grid → ReCaptchaV2Classification（18055169）
 * 注意：官方 image 类型（ImageToTextTask，164300）参数为 body 且分同步/异步双形态，本次不迁移
 */
import type { TokenCaptchaKind, CaptchaKind } from '../provider'

/** token 类验证码 → yescaptcha 任务类型 */
export const YESCAPTCHA_TOKEN_TASK_TYPES: Record<TokenCaptchaKind, string> = {
  turnstile: 'TurnstileTaskProxyless',
  recaptcha_v2: 'NoCaptchaTaskProxyless',
  recaptcha_v3: 'RecaptchaV3TaskProxyless',
  hcaptcha: 'HCaptchaTaskProxyless',
}

/** 九宫格图片分类任务类型（官方：返回图片坐标需要模拟点击，不返回 RESPONSE） */
export const YESCAPTCHA_GRID_TASK_TYPE = 'ReCaptchaV2Classification'

/** 记账/日志全类型（含九宫格） */
export const ALL_CAPTCHA_KINDS: CaptchaKind[] = [
  'turnstile', 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'recaptcha_v2_grid',
]
```

- [ ] **Step 4: 实现 client.ts**

创建 `src/integrations/captcha/yescaptcha/client.ts`：

```ts
/**
 * yescaptcha 原始 API 客户端（integrations/captcha/yescaptcha 层）：createTask/getTaskResult/getBalance
 * 依赖方向：依赖 infrastructure/http 与 provider 的 CaptchaFailure，被本平台 provider 使用
 * 设计思路：只做协议封装不做编排（串行排队/轮询超时在 provider 层）
 * 官方出处（计划核对总表）：createTask=wiki 33351、getTaskResult=wiki 196857、getBalance=wiki 229767
 */
import { httpJson } from '../../../infrastructure/http'
import { CaptchaFailure } from '../provider'

/** 平台响应包（官方字段：errorId 0=无错误 1=有错误；status processing/ready；solution 随任务类型不同） */
export interface YesCaptchaResp {
  errorId?: number
  errorCode?: string
  errorDescription?: string
  taskId?: string
  status?: string
  solution?: { token?: string; gRecaptchaResponse?: string; text?: string; objects?: number[]; hasObject?: boolean; type?: string }
  balance?: number
}

export interface YesCaptchaApiCfg {
  apiBase: string
  clientKey: string
}

export class YesCaptchaApiClient {
  constructor(private cfg: YesCaptchaApiCfg) {}

  /** 平台接口统一调用（官方未限定 createTask/getBalance 耗时；30s 固定超时覆盖慢响应） */
  private async call(path: string, body: unknown): Promise<YesCaptchaResp> {
    return httpJson<YesCaptchaResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: 30000 })
  }

  /** 创建识别任务（官方 33351：body={clientKey, task}；返回 taskId 供 getTaskResult 轮询） */
  async createTask(task: Record<string, unknown>): Promise<string> {
    const resp = await this.call('/createTask', { clientKey: this.cfg.clientKey, task })
    if (resp.errorId != null && resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 创建任务失败: ${resp.errorCode ?? resp.errorId}`)
    if (!resp.taskId) throw new CaptchaFailure('yescaptcha 创建任务失败: 未返回 taskId')
    return resp.taskId
  }

  /** 查询任务结果（官方 196857：body={clientKey, taskId}；errorId!=0 快速失败；status 非 ready 由调用方继续轮询） */
  async getTaskResult(taskId: string): Promise<YesCaptchaResp> {
    const resp = await this.call('/getTaskResult', { clientKey: this.cfg.clientKey, taskId })
    if (resp.errorId != null && resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 查询结果失败: ${resp.errorCode ?? resp.errorId}`)
    return resp
  }

  /** 查询账户余额（官方 229767：body={clientKey}；balance 为点数 Decimal） */
  async getBalance(): Promise<number> {
    const resp = await this.call('/getBalance', { clientKey: this.cfg.clientKey })
    return resp.balance ?? 0
  }
}
```

- [ ] **Step 5: 实现 provider.ts**

创建 `src/integrations/captcha/yescaptcha/provider.ts`：

```ts
/**
 * yescaptcha 平台实现（integrations/captcha/yescaptcha 层）：实现 CaptchaProvider
 * 依赖方向：依赖本目录 client 与 task-types，对外只暴露 CaptchaProvider 契约
 * 设计思路：所有解题调用挂在串行 promise 链上（平台每账号 1 并发硬限制，超限直接报错），
 * 即使调度器并发触发多个任务，平台侧也永远只有 1 个识别任务在跑
 * 官方依据（计划核对总表）：请求/响应字段逐字对齐 33351/196857/229767 与各任务类型页；
 * 轮询节奏对齐官方「间隔3秒一次」「120秒任务超时」（由 cfg.solveTimeoutMs/pollIntervalMs 承接）
 */
import type { CaptchaProvider, TokenCaptchaKind, GridResult } from '../provider'
import { CaptchaFailure } from '../provider'
import { YesCaptchaApiClient } from './client'
import { YESCAPTCHA_TOKEN_TASK_TYPES, YESCAPTCHA_GRID_TASK_TYPE } from './task-types'

export interface YesCaptchaProviderCfg {
  solveTimeoutMs: number
  pollIntervalMs: number
}

export class YesCaptchaProvider implements CaptchaProvider {
  readonly platform = 'yescaptcha'
  /** 串行 promise 链：链尾；新请求挂在其后，失败不中断链（catch 兜底） */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private client: YesCaptchaApiClient, private cfg: YesCaptchaProviderCfg) {}

  solveToken(kind: TokenCaptchaKind, sitekey: string | null, pageUrl: string, extra: Record<string, unknown> = {}): Promise<string> {
    const run = async (): Promise<string> => {
      if (!sitekey) throw new CaptchaFailure('验证码未找到 sitekey')
      const taskType = YESCAPTCHA_TOKEN_TASK_TYPES[kind]
      if (!taskType) throw new CaptchaFailure(`不支持的验证码类型: ${kind}`)
      // 官方任务体：type + websiteURL/websiteKey + 各类型可选参数（extra 原样透传）
      const taskId = await this.client.createTask({ type: taskType, websiteURL: pageUrl, websiteKey: sitekey, ...extra })
      const deadline = Date.now() + this.cfg.solveTimeoutMs
      while (Date.now() < deadline) {
        const resp = await this.client.getTaskResult(taskId)
        if (resp.status === 'ready') {
          const s = resp.solution ?? {}
          // 官方：turnstile 取 solution.token；其余取 solution.gRecaptchaResponse
          if (kind === 'turnstile') return s.token ?? ''
          return s.gRecaptchaResponse ?? ''
        }
        await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs))
      }
      throw new CaptchaFailure(`yescaptcha 解题超时: taskId=${taskId}`)
    }
    return this.enqueue(run)
  }

  classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult> {
    const run = async (): Promise<GridResult> => {
      // 官方任务体（wiki 18055169）：type=ReCaptchaV2Classification + image（无 data: 前缀）+ question（/m/ 开头）+ confidence（可选）
      const taskId = await this.client.createTask({
        type: YESCAPTCHA_GRID_TASK_TYPE,
        image,
        question: questionId,
        ...(confidence === undefined ? {} : { confidence }),
      })
      const deadline = Date.now() + this.cfg.solveTimeoutMs
      while (Date.now() < deadline) {
        const resp = await this.client.getTaskResult(taskId)
        if (resp.status === 'ready') {
          const s = resp.solution ?? {}
          // 官方：multi → objects（需要点击的格子序号）；single（1x1 小图）→ hasObject（是否需要点击）
          if (s.type === 'multi' && Array.isArray(s.objects)) return { type: 'multi', objects: s.objects }
          if (s.type === 'single' && typeof s.hasObject === 'boolean') return { type: 'single', hasObject: s.hasObject }
          if (Array.isArray(s.objects)) return { type: 'multi', objects: s.objects }
          if (typeof s.hasObject === 'boolean') return { type: 'single', hasObject: s.hasObject }
          throw new CaptchaFailure('yescaptcha 分类结果格式异常')
        }
        await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs))
      }
      throw new CaptchaFailure(`yescaptcha 分类超时: taskId=${taskId}`)
    }
    return this.enqueue(run)
  }

  async getBalance(): Promise<number> {
    return this.client.getBalance()
  }

  /** 挂串行链执行：链尾后再跑本次任务；失败不中断链，后续任务继续排队 */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    return result
  }
}
```

- [ ] **Step 6: 实现工厂 index.ts**

创建 `src/integrations/captcha/index.ts`：

```ts
/**
 * 打码平台装配工厂（integrations 层）：按 config.captcha.provider 装配具体平台实现
 * 依赖方向：依赖 provider 接口与 infrastructure/config，仅被 app.ts 使用
 */
import type { CaptchaProvider } from './provider'
import type { CaptchaConfig } from '../../infrastructure/config'
import { YesCaptchaApiClient } from './yescaptcha/client'
import { YesCaptchaProvider } from './yescaptcha/provider'

/** 按配置创建打码平台实例；无 clientKey / 未知平台返回 null（无 Key 也能跑，任务侧 solveCaptcha 返回 none） */
export function createCaptchaProvider(cfg: CaptchaConfig): CaptchaProvider | null {
  if (cfg.provider === 'yescaptcha' && cfg.yescaptcha.clientKey) {
    const client = new YesCaptchaApiClient({ apiBase: cfg.yescaptcha.apiBase, clientKey: cfg.yescaptcha.clientKey })
    return new YesCaptchaProvider(client, { solveTimeoutMs: cfg.solveTimeoutMs, pollIntervalMs: cfg.pollIntervalMs })
  }
  return null
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/yescaptcha-provider.test.ts`
Expected: PASS（全部）

- [ ] **Step 8: typecheck + 提交**

Run: `npm run typecheck`
Expected: 通过（旧 `integrations/yescaptcha.ts` 仍在但无引用冲突）

```powershell
git add src/integrations/captcha tests/yescaptcha-provider.test.ts
git commit -m "feat: yescaptcha 平台适配器（client/provider/工厂）实现 CaptchaProvider"
```

---

### Task 4: `automation/captcha/` 基础模块（detect / question-map / turnstile 迁移）

**Files:**
- Create: `src/automation/captcha/detect.ts`
- Create: `src/automation/captcha/question-map.ts`
- Create: `src/automation/captcha/turnstile.ts`（从 `src/automation/turnstile.ts` 原样迁移，仅改 import 相对路径）
- Test: `tests/detect.test.ts`（新）、`tests/turnstile.test.ts`（改 import 路径）

**Interfaces:**
- Consumes: Task 1 的 `CaptchaDetected`/`TokenCaptchaKind`
- Produces: `detectCaptcha(page, timeoutMs?)`、`QUESTION_ID_MAP`/`mapQuestionId(text)`、`clickTurnstileBox`/`autoClickTurnstile`/`turnstileVisible`（迁移后路径 `src/automation/captcha/turnstile`）

- [ ] **Step 1: 写失败测试**

创建 `tests/detect.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { detectCaptcha } from '../src/automation/captcha/detect'

/** 最小 fake page：locator(selector) 返回 count/getAttribute */
function makePage(selectors: Record<string, { count: number; attrs?: Record<string, string | null> }>) {
  return {
    locator: (sel: string) => ({
      first: () => ({
        count: async () => selectors[sel]?.count ?? 0,
        getAttribute: async (name: string) => selectors[sel]?.attrs?.[name] ?? null,
      }),
    }),
  }
}

describe('detectCaptcha', () => {
  it('普通版 v2 anchor（recaptcha/api2/anchor）识别为 recaptcha_v2，sitekey 从 k= 提取', async () => {
    const page = makePage({
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api2/anchor?k=6LcAAA&co=xxx' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v2', sitekey: '6LcAAA' })
  })

  it('Enterprise v2 anchor（recaptcha/enterprise/anchor）同样识别为 recaptcha_v2（rev2 修复点：此前从未命中）', async () => {
    const page = makePage({
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcENT&co=xxx' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v2', sitekey: '6LcENT' })
  })

  it('turnstile 优先于 recaptcha（DETECTORS 顺序）', async () => {
    const page = makePage({
      'iframe[src*="challenges.cloudflare.com"]': { count: 1, attrs: { src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv0/0/x/0x4AAAA?sitekey=cf-sk' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'turnstile', sitekey: 'cf-sk' })
  })

  it('iframe 无 sitekey 时回退 data-sitekey 属性', async () => {
    const page = makePage({
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api2/anchor' } },
      '[data-sitekey]': { count: 1, attrs: { 'data-sitekey': '6LcFALLBACK' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v2', sitekey: '6LcFALLBACK' })
  })

  it('v3：api.js render 参数提取 sitekey（render=explicit 不视为 v3）', async () => {
    const page = makePage({
      'script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api.js?render=6LcV3' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v3', sitekey: '6LcV3' })
  })

  it('Enterprise v3（enterprise.js）识别为 recaptcha_v3', async () => {
    const page = makePage({
      'script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/enterprise.js?render=6LcEV3' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v3', sitekey: '6LcEV3' })
  })

  it('超时无验证码返回 null', async () => {
    const page = makePage({})
    await expect(detectCaptcha(page as never, 100)).resolves.toBeNull()
  })
})
```

创建 `tests/question-map.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mapQuestionId } from '../src/automation/captcha/question-map'

describe('mapQuestionId 提示语映射', () => {
  it('中文提示语命中官方问题 ID', () => {
    expect(mapQuestionId('停车计时器')).toBe('/m/015qbp')
    expect(mapQuestionId('消防栓')).toBe('/m/01pns0')
  })

  it('英文提示语命中（官方 DEMO 表）', () => {
    expect(mapQuestionId('traffic lights')).toBe('/m/015qff')
  })

  it('未覆盖提示语返回 null', () => {
    expect(mapQuestionId('潜水艇')).toBeNull()
  })

  it('空串返回 null', () => {
    expect(mapQuestionId('  ')).toBeNull()
  })
})
```

修改 `tests/turnstile.test.ts` 第 2 行 import 路径：

```ts
import { clickTurnstileBox, autoClickTurnstile, turnstileBox, turnstileVisible } from '../src/automation/captcha/turnstile'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/detect.test.ts tests/question-map.test.ts`
Expected: FAIL（模块不存在）；`tests/turnstile.test.ts` 暂不跑（源文件未迁移会失败）

- [ ] **Step 3: 实现 detect.ts**

创建 `src/automation/captcha/detect.ts`：

```ts
/**
 * 验证码自动检测（automation/captcha 层）：轮询页面 iframe/脚本识别验证码类型与 sitekey
 * 依赖方向：依赖 provider 的类型与 patchright，被 token-solve 与任务层使用
 * 设计思路：rev2 教训——enterprise 版 reCAPTCHA 的 anchor/bframe URL 含 recaptcha/enterprise 段，
 * 检测必须同时匹配 api2 与 enterprise，否则 enterprise 站点检测永不命中
 */
import type { Page } from 'patchright'
import type { TokenCaptchaKind, CaptchaDetected } from '../../integrations/captcha/provider'

/** iframe 型验证码识别选择器（按出现频率排序：Turnstile 最常用） */
const DETECTORS: Array<{ kind: TokenCaptchaKind; selector: string; sitekeyAttr: string }> = [
  { kind: 'turnstile', selector: 'iframe[src*="challenges.cloudflare.com"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'recaptcha_v2', selector: 'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'hcaptcha', selector: 'iframe[src*="hcaptcha.com/captcha"]', sitekeyAttr: 'data-sitekey' },
]

/**
 * 轮询检测页面上的验证码 iframe（直到超时）
 * @param timeoutMs 检测窗口时长，默认 5 秒
 * @returns 检测到返回类型与 sitekey；未检测到返回 null
 * 设计权衡：sitekey 优先从 iframe src 的 k=/sitekey= 参数提取（最可靠），失败再查 data-sitekey 属性
 */
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
    // v3 无可见 iframe：靠 api.js / enterprise.js 脚本的 render 参数识别 sitekey
    // render=explicit 是 v2 显式渲染模式（非 v3），不视为 v3 检测结果
    const script = page.locator('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]').first()
    if (await script.count() > 0) {
      const src = (await script.getAttribute('src')) ?? ''
      const sitekey = src.match(/[?&]render=([^&]+)/)?.[1] ?? null
      if (sitekey && sitekey !== 'explicit') {
        return { kind: 'recaptcha_v3', sitekey }
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}
```

- [ ] **Step 4: 实现 question-map.ts**

创建 `src/automation/captcha/question-map.ts`（映射表从旧 `src/automation/recaptcha-grid.ts` 第 94-113 行原样搬入）：

```ts
/**
 * reCAPTCHA 九宫格提示语 → 问题 ID 映射（automation/captcha 层）
 * 中英双语：官方中文表 + 官方 Python DEMO 英文表合并；未覆盖的提示语任务会失败，按日志扩充
 */
export const QUESTION_ID_MAP: Record<string, string> = {
  '出租车': '/m/0pg52', '巴士': '/m/01bjv', '公交车': '/m/01bjv', '校车': '/m/02yvhj',
  '摩托车': '/m/04_sv', '拖拉机': '/m/013xlm', '烟囱': '/m/01jk_4', '人行横道': '/m/014xcs',
  '红绿灯': '/m/015qff', '自行车': '/m/0199g', '停车计价表': '/m/015qbp', '停车计时器': '/m/015qbp',
  '汽车': '/m/0k4j', '车辆': '/m/0k4j', '桥': '/m/015kr', '船': '/m/019jd', '棕榈树': '/m/0cdl1',
  '山': '/m/09d_r', '山丘': '/m/09d_r', '消防栓': '/m/01pns0', '楼梯': '/m/01lynh',
  '过街人行道': '/m/014xcs', '人行道': '/m/014xcs', '小轿车': '/m/0k4j', '轿车': '/m/0k4j', '大巴': '/m/01bjv',
  '摩托': '/m/04_sv', '火车': '/m/07jdr', '卡车': '/m/07r04', '飞机': '/m/0cmf2', '商店': '/m/02y_9m3',
  '店面': '/m/02y_9m3', '店面门脸': '/m/02y_9m3', '邮箱': '/m/04w5f', '交通信号灯': '/m/015qff',
  'taxis': '/m/0pg52', 'taxi': '/m/0pg52', 'bus': '/m/01bjv', 'buses': '/m/01bjv', 'school bus': '/m/02yvhj',
  'motorcycles': '/m/04_sv', 'motorcycle': '/m/04_sv', 'tractors': '/m/013xlm', 'tractor': '/m/013xlm',
  'chimneys': '/m/01jk_4', 'chimney': '/m/01jk_4', 'crosswalks': '/m/014xcs', 'crosswalk': '/m/014xcs',
  'pedestrian crossings': '/m/014xcs', 'traffic lights': '/m/015qff', 'traffic light': '/m/015qff',
  'bicycles': '/m/0199g', 'bicycle': '/m/0199g', 'parking meters': '/m/015qbp', 'parking meter': '/m/015qbp',
  'cars': '/m/0k4j', 'car': '/m/0k4j', 'vehicles': '/m/0k4j', 'vehicle': '/m/0k4j',
  'bridges': '/m/015kr', 'bridge': '/m/015kr', 'boats': '/m/019jd', 'boat': '/m/019jd',
  'palm trees': '/m/0cdl1', 'palm tree': '/m/0cdl1', 'mountains or hills': '/m/09d_r', 'mountains': '/m/09d_r',
  'hills': '/m/09d_r', 'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0', 'stairs': '/m/01lynh',
  'trucks': '/m/07r04', 'trains': '/m/07jdr', 'airplanes': '/m/0cmf2', 'mailboxes': '/m/04w5f', 'storefronts': '/m/02y_9m3',
}

/** 提示文字 → 问题 ID（先精确匹配，再子串包含；未覆盖返回 null） */
export function mapQuestionId(promptText: string): string | null {
  const t = promptText.trim()
  if (!t) return null
  if (QUESTION_ID_MAP[t]) return QUESTION_ID_MAP[t]
  for (const [key, id] of Object.entries(QUESTION_ID_MAP)) {
    if (t.includes(key)) return id
  }
  return null
}
```

- [ ] **Step 5: 迁移 turnstile.ts**

把 `src/automation/turnstile.ts` 完整内容复制到 `src/automation/captcha/turnstile.ts`，仅改两处相对路径：

```ts
import type { Logger } from '../../infrastructure/logger'
import { CDP_TRANSIENT_PATTERN } from '../../infrastructure/constants'
import type { Humanizer } from '../humanize'
```

其余内容（TURNSTILE_FRAME_SEL/TURNSTILE_CLICK_MAX/turnstileBox/turnstileVisible/clickTurnstileBox/autoClickTurnstile）一字不改。旧文件 `src/automation/turnstile.ts` 本任务暂不删除（task-context 还在引用），Task 8 删除。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/detect.test.ts tests/question-map.test.ts tests/turnstile.test.ts`
Expected: PASS

- [ ] **Step 7: typecheck + 提交**

Run: `npm run typecheck`
Expected: 通过

```powershell
git add src/automation/captcha/detect.ts src/automation/captcha/question-map.ts src/automation/captcha/turnstile.ts tests/detect.test.ts tests/question-map.test.ts tests/turnstile.test.ts
git commit -m "feat: automation/captcha 基础模块（enterprise 检测/提示语映射/turnstile 迁移）"
```

---

### Task 5: `automation/captcha/token-solve.ts`（token 类解题编排）

**Files:**
- Create: `src/automation/captcha/token-solve.ts`
- Test: `tests/token-solve.test.ts`

**Interfaces:**
- Consumes: Task 1/3/4（`CaptchaProvider`、`detectCaptcha`、`ESTIMATED_COST_POINTS`）
- Produces: `autoSolve(page, provider, opts)`，供 Task 8 的 task-context 调用

- [ ] **Step 1: 写失败测试**

创建 `tests/token-solve.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { autoSolve } from '../src/automation/captcha/token-solve'
import { CaptchaFailure } from '../src/integrations/captcha/provider'

/** 假 provider：记录调用；detectCaptcha 通过 vi.mock 控制 */
const makeProvider = () => ({
  platform: 'test',
  solveToken: vi.fn().mockResolvedValue('tok-1'),
  classifyGrid: vi.fn(),
  getBalance: vi.fn().mockResolvedValue(100000),
})

vi.mock('../src/automation/captcha/detect', () => ({ detectCaptcha: vi.fn() }))
import { detectCaptcha } from '../src/automation/captcha/detect'

const makePage = (writes: Array<Record<string, unknown>> = []) => ({
  url: () => 'https://x.io',
  locator: () => ({ first: () => ({ count: async () => 1 }) }),
  // evaluate(fn, arg, {}, false)：回填目标存在返回 'INPUT'；写入值记录到 writes
  evaluate: vi.fn(async (fn: (v: unknown) => unknown, v: unknown) => {
    if (v !== undefined && typeof v === 'object' && v !== null) writes.push(v as Record<string, unknown>)
    return 'INPUT'
  }),
})

describe('autoSolve', () => {
  it('enabled=false 返回 none 且不检测不打码', async () => {
    const provider = makeProvider()
    await expect(autoSolve(makePage() as never, provider as never, {
      enabled: false, maxCostPerTask: 1500, onLog: vi.fn(),
    })).resolves.toBe('none')
    expect(detectCaptcha).not.toHaveBeenCalled()
    expect(provider.solveToken).not.toHaveBeenCalled()
  })

  it('未检测到验证码返回 none', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce(null)
    await expect(autoSolve(makePage() as never, makeProvider() as never, {
      enabled: true, maxCostPerTask: 1500, onLog: vi.fn(),
    })).resolves.toBe('none')
  })

  it('检测到 turnstile：余额校验 → solveToken → 回填 token → 成功记账', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce({ kind: 'turnstile', sitekey: 'sk' })
    const provider = makeProvider()
    const writes: Array<Record<string, unknown>> = []
    const page = makePage(writes)
    const onLog = vi.fn()
    await expect(autoSolve(page as never, provider as never, {
      enabled: true, maxCostPerTask: 1500, onLog,
    })).resolves.toBe('solved')
    expect(provider.solveToken).toHaveBeenCalledWith('turnstile', 'sk', 'https://x.io', undefined)
    expect(onLog).toHaveBeenCalledWith('test', 'turnstile', true, 25)
    expect((writes[writes.length - 1] as { t: string }).t).toBe('tok-1')
  })

  it('余额低于上限抛 CaptchaFailure 并记失败账', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce({ kind: 'turnstile', sitekey: 'sk' })
    const provider = makeProvider()
    provider.getBalance.mockResolvedValue(10)
    const onLog = vi.fn()
    await expect(autoSolve(makePage() as never, provider as never, {
      enabled: true, maxCostPerTask: 1500, onLog,
    })).rejects.toBeInstanceOf(CaptchaFailure)
    expect(provider.solveToken).not.toHaveBeenCalled()
    expect(onLog).toHaveBeenCalledWith('test', 'turnstile', false, 25)
  })

  it('解题失败抛 CaptchaFailure 并记失败账', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce({ kind: 'turnstile', sitekey: 'sk' })
    const provider = makeProvider()
    provider.solveToken.mockRejectedValue(new CaptchaFailure('超时'))
    const onLog = vi.fn()
    await expect(autoSolve(makePage() as never, provider as never, {
      enabled: true, maxCostPerTask: 1500, onLog,
    })).rejects.toBeInstanceOf(CaptchaFailure)
    expect(onLog).toHaveBeenCalledWith('test', 'turnstile', false, 25)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/token-solve.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 token-solve.ts**

创建 `src/automation/captcha/token-solve.ts`：

```ts
/**
 * token 类验证码自动求解编排（automation/captcha 层）：检测 → 余额校验 → 平台解题 → 回填 → 记账
 * 依赖方向：依赖 provider 接口与 detect 模块，被 engine/task-context 委托
 * 设计思路：语义对齐旧 CaptchaService.autoSolve——失败抛 CaptchaFailure（归 captcha_failed 终态不重试）
 */
import type { Page } from 'patchright'
import { CaptchaFailure, ESTIMATED_COST_POINTS, type CaptchaProvider, type CaptchaLogFn } from '../../integrations/captcha/provider'
import { detectCaptcha } from './detect'

export interface AutoSolveOpts {
  /** 是否启用（任务 meta.captcha.auto） */
  enabled: boolean
  /** 单任务打码费用上限（点）；余额低于它视为余额不足直接失败 */
  maxCostPerTask: number
  onLog: CaptchaLogFn
}

/**
 * 自动打码主入口
 * @returns 'none' 未启用或未检测到；'solved' 解题并回填成功；'failed' 检测到但回填目标缺失
 * @throws CaptchaFailure 余额不足/解题失败（先记失败日志再抛出）
 */
export async function autoSolve(page: Page, provider: CaptchaProvider, opts: AutoSolveOpts): Promise<'none' | 'solved' | 'failed'> {
  if (!opts.enabled) return 'none'
  const detected = await detectCaptcha(page)
  if (!detected) return 'none'
  try {
    const balance = await provider.getBalance()
    if (balance < opts.maxCostPerTask) throw new CaptchaFailure(`打码余额不足: ${balance} 点 < ${opts.maxCostPerTask} 点`)
    const token = await provider.solveToken(detected.kind, detected.sitekey, page.url())
    const applied = await applyToken(page, detected.kind, token)
    if (!applied) {
      opts.onLog(provider.platform, detected.kind, false, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
      return 'failed'
    }
    opts.onLog(provider.platform, detected.kind, true, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
    return 'solved'
  } catch (e) {
    opts.onLog(provider.platform, detected.kind, false, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
    if (e instanceof CaptchaFailure) throw e
    throw new CaptchaFailure(`验证码处理失败: ${(e as Error).message}`)
  }
}

/**
 * 把 token 回填到站点表单并派发 input 事件（触发站点 JS 校验）
 * 关键设计：evaluate 第三参 {}、第四参 false（isolatedContext: false）是 patchright 扩展，
 * 把值写进站点主世界——默认隔离世界写的值站点 JS 读不到
 * @returns 回填目标存在并写入 true / 目标元素缺失 false
 */
async function applyToken(page: Page, kind: string, token: string): Promise<boolean> {
  const selectors = kind === 'turnstile'
    ? ['[name="cf-turnstile-response"]']
    : kind === 'hcaptcha'
      ? ['textarea[name="h-captcha-response"]', 'textarea[name="g-recaptcha-response"]']
      : ['textarea[name="g-recaptcha-response"]']
  const found = await page.evaluate((sels) => {
    const el = sels.map((s: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(s)).find(Boolean)
    return el ? el.tagName : null
  }, selectors, {}, false)
  if (!found) return false
  await page.evaluate(({ t, sels }) => {
    for (const s of sels) {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(s)
      if (el) {
        el.value = t
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }, { t: token, sels: selectors }, {}, false)
  return true
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/token-solve.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
Expected: 通过

```powershell
git add src/automation/captcha/token-solve.ts tests/token-solve.test.ts
git commit -m "feat: token 类验证码自动求解编排迁移至 automation/captcha（主世界回填）"
```

---

### Task 6: `automation/captcha/grid.ts` 九宫格求解器重写（对齐官方 DEMO）

**Files:**
- Create: `src/automation/captcha/grid.ts`（全新实现，~300 行）
- Test: `tests/grid.test.ts`（重写；旧的 `tests/recaptcha-grid.test.ts` 本任务删除）

**Interfaces:**
- Consumes: Task 1（provider/GridResult/CaptchaLogFn）、Task 4（mapQuestionId）
- Produces: `MAX_ROUNDS_DEFAULT`、`findAnchorFrame`、`findChallengeFrame`、`solveRecaptchaGrid`（Task 8/9 依赖）

- [ ] **Step 1: 删除旧测试，写新失败测试**

删除 `tests/recaptcha-grid.test.ts`。

创建 `tests/grid.test.ts`（fake page/frame 模式，参考旧 recaptcha-grid.test.ts 的假 frame 构造方式）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_ROUNDS_DEFAULT, solveRecaptchaGrid, findAnchorFrame, findChallengeFrame } from '../src/automation/captcha/grid'
import { CaptchaFailure } from '../src/integrations/captcha/provider'

// mock node:fs 写盘（grid-debug 诊断落盘只在真机有意义）
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: vi.fn(() => false), readdirSync: vi.fn(() => []), unlinkSync: vi.fn(),
}))
// mock jimp 读取：真实图片解码在单测用不到（单格确认走假图）
vi.mock('jimp', () => ({ default: { read: vi.fn(async () => ({ getWidth: () => 300, getHeight: () => 300, crop: function () { return this }, resize: async function () {}, getBufferAsync: async () => Buffer.from('png') })) } }))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface FakeTile { cls: string; src: string }
interface FakeFrameState {
  anchorChecked: boolean
  anchorClicked: boolean
  prompt: string
  tiles: FakeTile[]
  verifyClicked: boolean
  /** verify 点击后是否让 anchor 变绿（模拟「选对才过」；多轮失败用例设 false） */
  verifySolves: boolean
  wrapperImg: { src: string; naturalWidth: number } | null
}

/** 构造 fake frame 世界：anchor frame + challenge bframe */
function makePage(state: FakeFrameState) {
  const anchorLoc = {
    first: () => ({
      click: vi.fn(async () => { state.anchorClicked = true }),
      getAttribute: vi.fn(async (n: string) => (n === 'aria-checked' ? String(state.anchorChecked) : null)),
    }),
  }
  const chLocator = (sel: string) => {
    const first = () => {
      if (sel.includes('.rc-imageselect-desc-wrapper')) {
        return { textContent: vi.fn(async () => state.prompt), count: async () => 0 }
      }
      if (sel === '#recaptcha-verify-button') {
        return { click: vi.fn(async () => { state.verifyClicked = true; if (state.verifySolves) state.anchorChecked = true }), count: async () => 0 }
      }
      if (sel === 'div.rc-image-tile-wrapper > img') {
        return { evaluate: vi.fn(async () => state.wrapperImg), count: async () => 0 }
      }
      if (sel.includes('table td')) {
        return {
          nth: (i: number) => ({
            click: vi.fn(async () => { state.tiles[i].cls = (state.tiles[i].cls + ' selected').trim() }),
            getAttribute: vi.fn(async (n: string) => (n === 'class' ? state.tiles[i].cls : null)),
            locator: () => ({ first: () => ({ getAttribute: vi.fn(async (n: string) => (n === 'src' ? state.tiles[i].src : null)), screenshot: vi.fn(async () => Buffer.from('png')) }) }),
          }),
        }
      }
      return { first: () => ({ textContent: vi.fn(async () => ''), click: vi.fn(async () => {}), count: async () => 0 }) }
    }
    return { first: () => ({ ...first() }) }
  }
  const anchorFrame = { url: () => 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcV2', locator: () => anchorLoc }
  const chFrame = { url: () => 'https://www.google.com/recaptcha/enterprise/bframe?hl=zh-CN', locator: chLocator }
  return {
    page: {
      frames: () => [anchorFrame, chFrame],
      waitForTimeout: async (ms: number) => { await sleep(Math.min(ms, 10)) },
      locator: () => anchorLoc,
    },
    anchorFrame,
    chFrame,
  }
}

const makeDeps = (state: FakeFrameState, classify: ReturnType<typeof vi.fn>) => ({
  page: makePage(state).page as never,
  provider: { platform: 'test', solveToken: vi.fn(), classifyGrid: classify, getBalance: vi.fn().mockResolvedValue(100000) } as never,
  logger: { info: vi.fn(), warn: vi.fn() } as never,
  human: { clickAt: vi.fn() } as never,
})

const baseState = (): FakeFrameState => ({
  anchorChecked: false, anchorClicked: false, prompt: '停车计时器',
  tiles: Array.from({ length: 9 }, () => ({ cls: '', src: 'img-0' })),
  verifyClicked: false, verifySolves: true,
  wrapperImg: { src: 'data:image/png;base64,QUJD', naturalWidth: 300 },
})

describe('findAnchorFrame / findChallengeFrame', () => {
  it('siteKeyExclude 排除常驻 v3 锚点', () => {
    const page = { frames: () => [
      { url: () => 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcV3' },
      { url: () => 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcV2' },
    ] }
    const f = findAnchorFrame(page as never, '6LcV3')
    expect(f?.url().includes('6LcV2')).toBe(true)
  })

  it('api2 与 enterprise 都识别', () => {
    const page = { frames: () => [{ url: () => 'https://www.google.com/recaptcha/api2/bframe?k=6LcV2' }] }
    expect(findChallengeFrame(page as never)).not.toBeNull()
  })
})

describe('solveRecaptchaGrid 求解循环', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('无锚点 frame 返回 none', async () => {
    const deps = { ...makeDeps(baseState(), vi.fn()), page: { frames: () => [], waitForTimeout: async () => {}, locator: () => ({ first: () => ({ click: vi.fn(), getAttribute: vi.fn() }) }) } as never }
    await expect(solveRecaptchaGrid(deps as never)).resolves.toBe('none')
  })

  it('点锚点后一键通过（未出图）返回 solved 且不分类', async () => {
    const state = baseState()
    state.anchorChecked = true
    const classify = vi.fn()
    // 一键通过场景没有 bframe：frames 只含 anchor frame
    const { anchorFrame } = makePage(state)
    const deps = {
      page: { frames: () => [anchorFrame], waitForTimeout: async () => {}, locator: () => anchorFrame.locator() } as never,
      provider: { platform: 'test', solveToken: vi.fn(), classifyGrid: classify, getBalance: vi.fn().mockResolvedValue(100000) } as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      human: { clickAt: vi.fn() } as never,
    }
    await expect(solveRecaptchaGrid(deps as never)).resolves.toBe('solved')
    expect(classify).not.toHaveBeenCalled()
  })

  it('官方全流程：原生整图分类 → 点格 → 验证 → aria-checked 变绿 → solved', async () => {
    const state = baseState()
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(1)
    const [b64, qid] = classify.mock.calls[0]
    expect(qid).toBe('/m/015qbp')
    expect(typeof b64).toBe('string')
    expect(state.tiles[0].cls).toContain('selected')
    expect(state.tiles[2].cls).toContain('selected')
    expect(state.verifyClicked).toBe(true)
  })

  it('分类不传 confidence（官方 DEMO 默认阈值）', async () => {
    const state = baseState()
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
    await solveRecaptchaGrid(makeDeps(state, classify) as never)
    expect(classify.mock.calls[0][2]).toBeUndefined()
  })

  it('主分类返回空数组：记 warn 跳过本轮，下一轮重分类', async () => {
    const state = baseState()
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [] })
      .mockResolvedValue({ type: 'multi', objects: [0] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('提示语未覆盖映射抛错', async () => {
    const state = baseState()
    state.prompt = '潜水艇'
    await expect(solveRecaptchaGrid(makeDeps(state, vi.fn()) as never)).rejects.toThrow(/未覆盖/)
  })

  it('多轮未通过（verifySolves=false，aria-checked 恒 false）达到 maxRounds=3 返回 failed', async () => {
    const state = baseState()
    state.verifySolves = false
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('failed')
    expect(classify.mock.calls.length).toBe(MAX_ROUNDS_DEFAULT)
  })

  it('maxRounds 透传生效（1 轮不过即 failed）', async () => {
    const state = baseState()
    state.verifySolves = false
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never, { maxRounds: 1 })).resolves.toBe('failed')
  })

  it('余额低于上限抛 CaptchaFailure（不烧点数）', async () => {
    const state = baseState()
    const deps = makeDeps(state, vi.fn().mockResolvedValue({ type: 'multi', objects: [0] }))
    ;(deps.provider as never as { getBalance: ReturnType<typeof vi.fn> }).getBalance.mockResolvedValue(10)
    await expect(solveRecaptchaGrid(deps as never, { maxCostPerTask: 1500 })).rejects.toBeInstanceOf(CaptchaFailure)
  })
})
```

注意：若上方案例执行中「点锚点后未出图」分支依赖 anchor click 后等待，`anchorChecked=true` 的状态在点击前即存在，需保证实现里「点 anchor 后先查 aria-checked」路径正确。实施时以测试通过为准，实现需包含该分支。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/grid.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 grid.ts（完整代码）**

创建 `src/automation/captcha/grid.ts`：

```ts
/**
 * reCAPTCHA 九宫格模拟点击求解（automation/captcha 层）：严格对齐 yescaptcha 官方 Python DEMO
 * （RecaptchaResolver 的 verify_entire_captcha / verify_single_captcha 流程）
 * 与 rev2 实现的三处关键差异（对应真机 0 通过的三个根因）：
 *   1. 网格图取 div.rc-image-tile-wrapper > img 的原生整图（naturalWidth 300/450 定尺寸），
 *      不再容器元素截图（CSS 缩放裁剪污染导致分类乱跳/空数组，窗口 93/100）
 *   2. 格子点击用原生元素点击（selenium click 等价，trusted 且自动居中），
 *      不再页面坐标拟人点击为主（坐标漂移导致点击从未注册，窗口 92）；未注册才坐标兜底重试一次
 *   3. 同窗口验证轮数上限 maxRounds（默认 3）：连续多轮不过 = 同会话已风控（用户真机经验：
 *      死磕即使选对也过不去），返回 failed 交由任务重试换新窗口
 * 保留的真机验证资产：提示语中英映射（question-map）、siteKeyExclude、grid-debug 诊断截图、
 * grid-round-state/grid-click-diag 结构化日志、frame 失效防护（每轮重取 frame）
 * 依赖方向：依赖 integrations/captcha/provider 接口与 infrastructure/logger，被 engine/task-context 委托
 */
import type { Page, Frame } from 'patchright'
import Jimp from 'jimp'
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CaptchaFailure, type CaptchaProvider, type CaptchaLogFn, type GridResult } from '../../integrations/captcha/provider'
import type { Logger } from '../../infrastructure/logger'
import type { Humanizer } from '../humanize'
import { mapQuestionId } from './question-map'

/** 锚点复选框元素（anchor frame 内） */
export const ANCHOR_SELECTOR = '#recaptcha-anchor'
/** 提示文字（目标物体名，bframe 内） */
export const PROMPT_SELECTOR = '.rc-imageselect-desc-wrapper strong'
/** 网格格子（td 顺序即序号：3x3 为 0-8，4x4 为 0-15） */
export const TILE_SELECTOR = '#rc-imageselect-target table td'
/** 验证按钮（bframe 内） */
export const VERIFY_SELECTOR = '#recaptcha-verify-button'
/** 整图 img（官方 DEMO：每格 wrapper 内是同一张整图，naturalWidth 300/450 判 3x3/4x4） */
export const GRID_IMG_SELECTOR = 'div.rc-image-tile-wrapper > img'
/** 同窗口验证轮数上限（默认 3） */
export const MAX_ROUNDS_DEFAULT = 3
/** 单格确认循环上限（官方递归上界） */
const CONFIRM_MAX = 3
/** 点格后查 class 的等待（官方 time.sleep(3)） */
const CONFIRM_WAIT_MS = 3000
/** 主网格分类点数（官方价格表：300x300/450x450 6 POINTS） */
const GRID_COST_POINTS = 6
/** 单格 1x1 分类点数（官方价格表：100x100 2 点数） */
const TILE_COST_POINTS = 2
/** grid-debug 诊断目录文件数上限 */
const GRID_DEBUG_MAX_FILES = 40

/** 从 frame URL 提取 reCAPTCHA sitekey（k 参数；无则 null） */
function extractSiteKey(url: string): string | null {
  const m = url.match(/[?&]k=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

/** 找锚点 frame（兼容 enterprise/api2 两种 URL；excludeSiteKey 跳过常驻 sitekey 如页面常驻 v3） */
export function findAnchorFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    const u = f.url()
    if (!u.includes('recaptcha/enterprise/anchor') && !u.includes('recaptcha/api2/anchor')) return false
    return !excludeSiteKey || extractSiteKey(u) !== excludeSiteKey
  }) ?? null
}

/** 找挑战（九宫格）frame；excludeSiteKey 语义同 findAnchorFrame */
export function findChallengeFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    const u = f.url()
    if (!u.includes('recaptcha/enterprise/bframe') && !u.includes('recaptcha/api2/bframe')) return false
    return !excludeSiteKey || extractSiteKey(u) !== excludeSiteKey
  }) ?? null
}

/** PNG buffer 等比缩放（官方 resize 语义：保持纵横比，定宽缩到 size） */
async function toStandardImage(buf: Buffer, size: number): Promise<Jimp> {
  const img = await Jimp.read(buf)
  if ((img.getWidth() !== size || img.getHeight() !== size) && img.getWidth() > 0) {
    await img.resize(size, size)
  }
  return img
}

/** 容器元素截图回退（整图 img 缺失时）：中心裁剪正方形 + 等比缩放；Google 改版兜底，warn 可见不静默 */
async function fallbackCaptureGrid(ch: Frame, size: number): Promise<string> {
  const shot = await ch.locator('#rc-imageselect-target').first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
  if (!shot) throw new Error('九宫格网格截图失败（整图 img 缺失且容器截图失败）')
  saveDebugImage('grid-raw-fallback', shot)
  const img = await Jimp.read(shot)
  const w = img.getWidth()
  const h = img.getHeight()
  const side = Math.min(w, h)
  if (w !== side || h !== side) img.crop(Math.floor((w - side) / 2), Math.floor((h - side) / 2), side, side)
  if (side !== size) await img.resize(size, size)
  const std = await img.getBufferAsync(Jimp.MIME_PNG)
  saveDebugImage('grid-std-fallback', std)
  return std.toString('base64')
}

/** grid-debug 诊断目录防膨胀：文件数超过上限则清空目录（清理失败静默） */
function pruneDebugDir(debugDir: string, maxFiles: number): void {
  try {
    if (!existsSync(debugDir)) return
    if (readdirSync(debugDir).length <= maxFiles) return
    for (const f of readdirSync(debugDir)) unlinkSync(join(debugDir, f))
  } catch { /* 清理失败静默 */ }
}

/** 诊断截图落盘（raw + std 双图，失败静默） */
function saveDebugImage(name: string, buf: Buffer): void {
  try {
    const debugDir = join(process.cwd(), 'data', 'screenshots', 'grid-debug')
    mkdirSync(debugDir, { recursive: true })
    pruneDebugDir(debugDir, GRID_DEBUG_MAX_FILES)
    writeFileSync(join(debugDir, `${name}-${Date.now()}.png`), buf)
  } catch { /* 诊断写盘失败静默 */ }
}

/**
 * 官方整图获取：读 div.rc-image-tile-wrapper > img 的 src + naturalWidth
 * src 为 data: 直接解码；blob: 在 frame 内 fetch；http(s) 用 Node fetch
 * 缩放目标 = naturalWidth（450=4x4，否则 300）；img 缺失回退容器截图（warn）
 */
async function readGridImage(deps: GridDeps, ch: Frame): Promise<{ b64: string } | null> {
  const info = await ch.locator(GRID_IMG_SELECTOR).first().evaluate((el) => {
    const img = el as HTMLImageElement
    return { src: img.src, naturalWidth: img.naturalWidth }
  }).catch(() => null)
  if (!info || !info.src) {
    deps.logger.warn('九宫格整图 img 未找到，回退容器元素截图（Google 结构可能已变化）')
    return { b64: await fallbackCaptureGrid(ch, 300) }
  }
  let buf: Buffer
  try {
    if (info.src.startsWith('data:')) {
      buf = Buffer.from(info.src.split(',')[1] ?? '', 'base64')
    } else if (info.src.startsWith('blob:')) {
      const bytes = await ch.locator(GRID_IMG_SELECTOR).first().evaluate(async (el) => {
        const r = await fetch((el as HTMLImageElement).src)
        const ab = await r.arrayBuffer()
        return Array.from(new Uint8Array(ab))
      }).catch(() => null)
      if (!bytes) return { b64: await fallbackCaptureGrid(ch, 300) }
      buf = Buffer.from(bytes as number[])
    } else {
      const res = await fetch(info.src)
      if (!res.ok) return { b64: await fallbackCaptureGrid(ch, 300) }
      buf = Buffer.from(await res.arrayBuffer())
    }
  } catch {
    return { b64: await fallbackCaptureGrid(ch, 300) }
  }
  const size = info.naturalWidth >= 400 ? 450 : 300
  saveDebugImage('grid-raw', buf)
  const std = await (await toStandardImage(buf, size)).getBufferAsync(Jimp.MIME_PNG)
  saveDebugImage('grid-std', std)
  return { b64: std.toString('base64') }
}

/** 读该格 img 的 src（1s 短超时防死等默认 30s） */
async function readTileImgSrc(ch: Frame, idx: number): Promise<string> {
  return (await ch.locator(TILE_SELECTOR).nth(idx).locator('img').first().getAttribute('src', { timeout: 1000 }).catch(() => null)) ?? ''
}

/** 读格子 td class（1s 短超时） */
async function readTileClass(ch: Frame, idx: number): Promise<string> {
  return (await ch.locator(TILE_SELECTOR).nth(idx).getAttribute('class', { timeout: 1000 }).catch(() => null)) ?? ''
}

/** frame 内元素中心在页面坐标系的位置（frame 内坐标 + frame 元素页面偏移）；拿不到返回 null */
async function framePoint(page: Page, ch: Frame, selector: string, nth = 0): Promise<{ x: number; y: number } | null> {
  const inner = await ch.locator(selector).nth(nth).evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }).catch(() => null)
  if (!inner) return null
  const frameHandle = await ch.frameElement().catch(() => null)
  if (!frameHandle) return null
  const outer = await frameHandle.evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect()
    return { x: r.x, y: r.y }
  }).catch(() => null)
  if (!outer) return null
  return { x: outer.x + inner.x, y: outer.y + inner.y }
}

/** 拟人坐标点击 frame 内元素（原生点击未注册时的兜底；失败返回 false） */
async function humanClickInFrame(page: Page, human: Humanizer, ch: Frame, selector: string, nth = 0): Promise<boolean> {
  const p = await framePoint(page, ch, selector, nth)
  if (!p) return false
  try {
    await human.clickAt(p.x, p.y)
    return true
  } catch {
    return false
  }
}

/** 原生点击（官方 selenium click 等价：trusted、自动滚动居中） */
async function nativeClick(ch: Frame, selector: string, nth = 0): Promise<boolean> {
  try {
    await ch.locator(selector).nth(nth).click({ timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** 错误提示读取（诊断用）：select-more = 选择不完整；incorrect = 选错已刷题 */
async function readErrorHint(ch: Frame): Promise<'select-more' | 'incorrect' | null> {
  const probes: Array<[string, 'select-more' | 'incorrect']> = [
    ['.rc-imageselect-error-select-more', 'select-more'],
    ['.rc-imageselect-error-select-something', 'select-more'],
    ['.rc-imageselect-incorrect-response', 'incorrect'],
  ]
  for (const [sel, kind] of probes) {
    const first = ch.locator(sel).first()
    if ((await first.count().catch(() => 0)) === 0) continue
    const t = ((await first.textContent().catch(() => '')) ?? '').trim()
    if (t) return kind
  }
  return null
}

export interface GridDeps {
  page: Page
  provider: CaptchaProvider
  logger: Pick<Logger, 'info' | 'warn'>
  human: Humanizer
}

export interface GridOpts {
  maxRounds?: number
  siteKeyExclude?: string
  maxCostPerTask?: number
  onLog?: CaptchaLogFn
}

/** 单轮求解上下文（每轮重取 frame，防 Google 换图后 frame 失效） */
interface RoundCtx {
  ch: Frame
  qid: string
  prompt: string
  /** 分类封装：costPoints 按官方价格分档（主网格 6 点 / 1x1 单格 2 点），记账与余额校验内聚在此 */
  classify: (image: string, questionId: string, costPoints: number, confidence?: number) => Promise<GridResult>
}

/** 打码前余额校验（不烧点数原则：余额低于上限直接 CaptchaFailure） */
async function ensureBalance(deps: GridDeps, maxCostPerTask?: number): Promise<void> {
  if (maxCostPerTask === undefined) return
  const balance = await deps.provider.getBalance()
  if (balance < maxCostPerTask) throw new CaptchaFailure(`打码余额不足: ${balance} 点 < ${maxCostPerTask} 点`)
}

/**
 * 单格点选流程（官方 verify_single_captcha）：原生点击 → 等 3s → 查 class：
 * - class 含 selected → 完成
 * - class 无 selected 且 src 未变 → 点击未注册 → 坐标拟人点击兜底重试一次，再查
 * - src 变化（图片刷新新图）→ 等新图稳定 → 截图该格 → 100x100 → 1x1 分类：
 *   hasObject=true 再点该格（可能又刷新，循环最多 CONFIRM_MAX 轮）；false 完成
 */
async function clickTile(deps: GridDeps, rc: RoundCtx, idx: number): Promise<void> {
  const src0 = await readTileImgSrc(rc.ch, idx)
  const diag = { idx, beforeClass: await readTileClass(rc.ch, idx), hit: false }
  if (!(await nativeClick(rc.ch, TILE_SELECTOR, idx))) {
    deps.logger.warn({ idx }, '九宫格格子原生点击失败，尝试坐标拟人兜底')
    await humanClickInFrame(deps.page, deps.human, rc.ch, TILE_SELECTOR, idx)
  }
  let rounds = 0
  while (rounds < CONFIRM_MAX) {
    rounds++
    await deps.page.waitForTimeout(CONFIRM_WAIT_MS)
    const cls = await readTileClass(rc.ch, idx)
    if (cls.includes('selected')) { diag.hit = true; break }
    const src = await readTileImgSrc(rc.ch, idx)
    if (src && src === src0) {
      if (rounds === 1) {
        deps.logger.warn({ idx }, '九宫格该格点击未注册，坐标拟人点击兜底重试一次')
        await humanClickInFrame(deps.page, deps.human, rc.ch, TILE_SELECTOR, idx)
        continue
      }
      deps.logger.warn({ idx }, '九宫格该格点击仍未注册（放弃该格，交由下一轮兜底）')
      break
    }
    // 图片已刷新：等新图稳定（1.5-2.5s 随机）后截图该格做 1x1 分类（官方：100x100，2 点）
    await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    const shot = await rc.ch.locator(TILE_SELECTOR).nth(idx).locator('img').first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
    if (!shot) { deps.logger.warn({ idx }, '九宫格该格新图截图失败，放弃确认'); break }
    let hasObject = false
    try {
      const singleB64 = (await (await toStandardImage(shot, 100)).getBufferAsync(Jimp.MIME_PNG)).toString('base64')
      const r = await rc.classify(singleB64, rc.qid, TILE_COST_POINTS)
      hasObject = r.type === 'single' && r.hasObject
    } catch (e) {
      deps.logger.warn({ idx, err: (e as Error).message }, '九宫格该格新图分类失败，放弃确认')
      break
    }
    deps.logger.info({ step: 'grid-tile-confirm', idx, hasObject }, '九宫格格子刷新确认')
    if (!hasObject) break
    await nativeClick(rc.ch, TILE_SELECTOR, idx)
  }
  deps.logger.info({ step: 'grid-click-diag', ...diag, afterClass: await readTileClass(rc.ch, idx) }, '九宫格点击诊断')
}

/** 单轮：读提示语 → 官方整图分类 → 逐格点选 → 等动画收尾 → 点验证 → 返回是否通过 */
async function solveOneRound(deps: GridDeps, rc: RoundCtx): Promise<boolean> {
  const prompt = ((await rc.ch.locator(PROMPT_SELECTOR).first().textContent().catch(() => '')) ?? '').trim()
  if (!prompt) throw new Error('九宫格提示文字未找到')
  const qid = mapQuestionId(prompt)
  if (!qid) throw new Error(`未覆盖的九宫格提示语: ${prompt}`)
  deps.logger.info({ prompt, qid }, '九宫格识别目标')
  rc.prompt = prompt
  rc.qid = qid
  const grid = await readGridImage(deps, rc.ch)
  if (!grid) throw new Error('九宫格网格图获取失败')
  const result = await rc.classify(grid.b64, qid, GRID_COST_POINTS)
  if (result.type !== 'multi') throw new Error('九宫格分类未返回 multi 结果')
  if (result.objects.length === 0) {
    deps.logger.warn('九宫格分类返回空数组，跳过本轮（不点验证，等下一轮）')
    return false
  }
  deps.logger.info({ objects: result.objects }, '九宫格识别完成，开始点选')
  for (const idx of result.objects) await clickTile(deps, rc, idx)
  // 官方点 verify 前 sleep 3：等全部格子动画收尾（图片还在变化时点 verify 会被 Google 判选择未完成）
  await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1000))
  if (!(await nativeClick(rc.ch, VERIFY_SELECTOR))) {
    deps.logger.warn('九宫格验证按钮点击失败')
    return false
  }
  await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
  const hint = await readErrorHint(rc.ch)
  deps.logger.info({ step: 'grid-round-state', prompt, qid, objects: result.objects, hint }, '九宫格轮次状态')
  return true
}

/**
 * 九宫格模拟点击求解主入口：
 * 找锚点 → 点复选框 → 等挑战 frame → 循环（每轮重取 frame → 官方流程一轮 → 查 aria-checked）
 * @param opts.maxRounds 同窗口验证轮数上限（默认 3）：耗尽返回 'failed' 交任务重试换新窗口（同会话风控保护）
 * @param opts.siteKeyExclude 跳过的常驻 sitekey（页面常驻 v3 锚点，避免误点无效果的复选框）
 * @param opts.maxCostPerTask 余额下限（undefined 不校验）
 * @param opts.onLog 分类成本记账（platform 取自 provider.platform）
 * @returns 'none' 无锚点 frame；'solved' 通过；'failed' 轮数耗尽
 */
export async function solveRecaptchaGrid(deps: GridDeps, opts: GridOpts = {}): Promise<'solved' | 'none' | 'failed'> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS_DEFAULT
  const onLog = opts.onLog ?? (() => {})
  /** 分类封装：余额校验 + 官方价格分档记账（主网格 6 点 / 1x1 单格 2 点）；不传 confidence（官方默认前三） */
  const classify = async (image: string, questionId: string, costPoints: number, confidence?: number) => {
    await ensureBalance(deps, opts.maxCostPerTask)
    try {
      const r = await deps.provider.classifyGrid(image, questionId, confidence)
      onLog(deps.provider.platform, 'recaptcha_v2_grid', true, costPoints)
      return r
    } catch (e) {
      onLog(deps.provider.platform, 'recaptcha_v2_grid', false, costPoints)
      throw e
    }
  }
  // iframe 元素已插入 DOM 但 CDP frame 可能未附着：轮询等附着
  let anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !anchor; i++) {
    await deps.page.waitForTimeout(500)
    anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  }
  if (!anchor) return 'none'
  const anchorChecked = async (): Promise<boolean> =>
    (await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)) === 'true'
  // 点复选框触发挑战；点击失败不中断（后续轮次自纠）
  if (!(await nativeClick(anchor, ANCHOR_SELECTOR))) {
    deps.logger.warn('锚点复选框点击失败（继续流程，后续轮次自纠）')
  }
  // 等挑战 frame 出现；期间锚点直接变绿 = 一键通过（v3 直过等价）
  let challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !challenge; i++) {
    await deps.page.waitForTimeout(500)
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    if (!challenge && await anchorChecked()) { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
  }
  for (let round = 0; round < maxRounds; round++) {
    // 每轮重取 frame：Google 换图后旧 Frame 引用可能失效（真机窗口 92 教训）；
    // DOM 里能找到就用新的，找不到回退上一轮引用
    const ch = findChallengeFrame(deps.page, opts.siteKeyExclude) ?? challenge
    if (!ch) {
      if (await anchorChecked()) { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
      deps.logger.warn({ round: round + 1 }, '挑战 frame 未出现且未变绿，跳过本轮')
      challenge = null
      continue
    }
    challenge = ch
    const rc: RoundCtx = { ch, qid: '', prompt: '', classify }
    try {
      await solveOneRound(deps, rc)
    } catch (e) {
      // 提示语未覆盖/整图缺失等结构性错误：重试大概率同错，直接抛出由任务层决定
      throw e
    }
    if (await anchorChecked()) return 'solved'
    deps.logger.warn({ round: round + 1 }, '九宫格本轮未通过，继续下一轮')
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    // 轮间随机等待：Google 对同会话连续验证有风控
    await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1500))
  }
  return 'failed'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/grid.test.ts`
Expected: PASS（如遇时序问题按测试意图微调实现：一键通过分支、空数组跳轮、maxRounds 语义必须保持）

- [ ] **Step 5: 全量测试 + typecheck**

Run: `npm test; npm run typecheck`
Expected: 全绿（旧 `tests/recaptcha-grid.test.ts` 已删除；`arc-faucet.test.ts` 仍引用旧模块会失败——Task 9 修复，若本任务跑全量则临时跳过 `tests/arc-faucet.test.ts`，Task 8/9 后恢复）

- [ ] **Step 6: 提交**

```powershell
git add src/automation/captcha/grid.ts tests/grid.test.ts
git rm tests/recaptcha-grid.test.ts
git commit -m "feat: 九宫格求解器重写（官方DEMO原生整图/原生点击/同窗口风控上限）"
```

---

### Task 7: DB `captcha_logs` 增加 platform 列

**Files:**
- Modify: `src/infrastructure/db.ts`（建表语句 + migrate 补列 + `logCaptcha` 签名）
- Test: `tests/db.test.ts`（更新 logCaptcha 相关断言）

**Interfaces:**
- Consumes: 无
- Produces: `logCaptcha(profileId, taskKey, platform, kind, cost, ok)`

- [ ] **Step 1: 写失败测试**

在 `tests/db.test.ts` 中，把现有 4 处旧 5 参 `logCaptcha` 调用（第 76-78 行 3 处、第 349 行 1 处）改为新 6 参签名（插入 platform 参数）：

```ts
await db.logCaptcha(p.id, 'task-a', 'yescaptcha', 'turnstile', 0.03, true)
await db.logCaptcha(p.id, 'task-a', 'yescaptcha', 'hcaptcha', 0.05, false)
await db.logCaptcha(p.id, 'task-b', 'yescaptcha', 'turnstile', 0.03, true)
```

```ts
await db.logCaptcha(p.id, 't', 'yescaptcha', 'turnstile', 0.01, true)
```

并新增：

```ts
it('captcha_logs 含 platform 列（新库建表 + 老库补列）', async () => {
  await db.logCaptcha(null, null, 'capsolver', 'turnstile', 25, false)
  const row = await db.exec('SELECT platform FROM captcha_logs ORDER BY id DESC LIMIT 1')
  expect(String(row[0].platform)).toBe('capsolver')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL（platform 列不存在 / logCaptcha 参数不匹配）

- [ ] **Step 3: 实现 db.ts**

`SCHEMA` 中 captcha_logs 建表（第 161-169 行）改为：

```ts
  `CREATE TABLE IF NOT EXISTS captcha_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER,
    task_key TEXT,
    platform TEXT NOT NULL DEFAULT 'yescaptcha',
    kind TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
```

`migrate()` 中（profiles 补列逻辑之后）增加 captcha_logs 老库补列：

```ts
    // 老库补列：captcha_logs 的 platform 列（多平台记账）后加；缺则补，幂等
    const clInfo = await this.client.execute(`PRAGMA table_info(captcha_logs)`)
    if (!clInfo.rows.some((r) => String(r.name) === 'platform')) {
      await this.client.execute(`ALTER TABLE captcha_logs ADD COLUMN platform TEXT NOT NULL DEFAULT 'yescaptcha'`)
    }
```

`logCaptcha`（第 518-522 行）改为：

```ts
  /** 记录一次打码事件（成功/失败都记，供成本统计与面板展示）；platform 区分打码平台；created_at 存本地墙钟时间字符串（与 runs.date 同口径），毫秒精度，与日期前缀过滤兼容 */
  async logCaptcha(profileId: number | null, taskKey: string | null, platform: string, kind: string, cost: number, ok: boolean): Promise<void> {
    const now = new Date()
    const localWall = localWallNow()
    await this.exec('INSERT INTO captcha_logs (profile_id, task_key, platform, kind, cost, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [profileId, taskKey, platform, kind, cost, ok ? 1 : 0, localWall])
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
Expected: 通过（window-runner 的 logCaptcha 调用参数暂时不匹配 → 会报错，先记下，Task 8 一并修；若 typecheck 失败则本任务与 Task 8 合并提交）

```powershell
git add src/infrastructure/db.ts tests/db.test.ts
git commit -m "feat: captcha_logs 增加 platform 列（多平台记账）"
```

注意：`logCaptcha` 签名变更会让 `src/engine/window-runner.ts` 立即编译失败。若不便分步提交，可本任务只改 db.ts 与测试并在 Task 8 一起提交；计划默认分开提交，失败时合并。

---

### Task 8: engine 接线（window-runner / task-context / app.ts / server）+ 删除旧文件

**Files:**
- Modify: `src/engine/window-runner.ts`（类型切换 + onCaptchaLog 带 platform）
- Modify: `src/engine/task-context.ts`（deps 类型、solveCaptcha、solveRecaptchaGrid）
- Modify: `src/app.ts`（createCaptchaProvider 组装、captchaBalance 带 platform）
- Modify: `src/server/app.ts`（captchaBalance 类型）、`src/server/routes/captcha.ts`（响应带 platform）
- Modify: `web/src/api/schema.d.ts`（手补 platform 字段）、`web/src/layouts/AppLayout.tsx`（平台名动态显示）
- Modify: `tests/task-context-generic.test.ts`、`tests/task-context-scenarios.test.ts`（captcha fake 形态更新）
- Delete: `src/integrations/yescaptcha.ts`、`src/automation/recaptcha-grid.ts`、`src/automation/turnstile.ts`、`tests/captcha.test.ts`

**Interfaces:**
- Consumes: Task 1-7 全部
- Produces: 运行时可用的完整链路（`ctx.solveCaptcha()` / `ctx.solveRecaptchaGrid()` 走新架构）

- [ ] **Step 1: window-runner.ts**

第 18 行替换为：

```ts
import { CaptchaFailure, type CaptchaProvider } from '../integrations/captcha/provider'
```

第 58 行 `captcha: CaptchaService | null` 替换为 `captcha: CaptchaProvider | null`。

第 316-318 行替换为：

```ts
          onCaptchaLog: (platform, kind, ok, costPoints) => {
            void this.safeDb(() => db.logCaptcha(profile.id, taskKey, platform, kind, costPoints, ok), undefined)
          },
```

- [ ] **Step 2: task-context.ts**

第 15 行 `import type { CaptchaService } from '../integrations/yescaptcha'` 替换为：

```ts
import type { CaptchaProvider, CaptchaLogFn } from '../integrations/captcha/provider'
```

第 19-20 行替换为：

```ts
import { clickTurnstileBox as runTurnstileClick, autoClickTurnstile as runTurnstileAutoClick, turnstileVisible as isTurnstileVisible } from '../automation/captcha/turnstile'
import { solveRecaptchaGrid as runRecaptchaGrid } from '../automation/captcha/grid'
import { autoSolve as runAutoSolve } from '../automation/captcha/token-solve'
```

第 36-38 行替换为：

```ts
  captcha?: CaptchaProvider
  onCaptchaLog?: CaptchaLogFn
```

`solveCaptcha()`（第 173-184 行）替换为：

```ts
  async solveCaptcha(): Promise<'none' | 'solved' | 'failed'> {
    if (!this.deps.captcha) return 'none'
    const taskCfg = this.deps.task.meta.captcha ?? { auto: true }
    return runAutoSolve(this.page, this.deps.captcha, {
      enabled: taskCfg.auto ?? true,
      maxCostPerTask: this.deps.cfg.captcha.maxCostPerTask,
      onLog: (platform, kind, ok, costPoints) => {
        this.deps.onCaptchaLog?.(platform, kind, ok, costPoints)
      },
    })
  }
```

`solveRecaptchaGrid()`（第 453-469 行）替换为：

```ts
  /**
   * reCAPTCHA 九宫格模拟点击求解：点复选框 → 官方整图分类 → 点选 → 验证，多轮循环直至 aria-checked=true
   * （与 solveCaptcha 口径统一：读 meta.captcha.auto；未注入打码服务或 auto=false 返回 'none'）
   * @param opts.siteKeyExclude 跳过的常驻 sitekey（如页面常驻 v3 锚点，避免误点无效果的复选框）
   * @param opts.maxRounds 同窗口验证轮数上限（默认 3，见自动化模块 MAX_ROUNDS_DEFAULT）
   * @returns 'none' 无服务/自动处理关闭/无锚点 frame；'solved' 通过；'failed' 轮数耗尽
   * @throws 提示语未覆盖映射 / 平台分类异常（CaptchaFailure）
   */
  async solveRecaptchaGrid(opts?: { maxRounds?: number; siteKeyExclude?: string }): Promise<'none' | 'solved' | 'failed'> {
    if (!this.deps.captcha) return 'none'
    const taskCfg = this.deps.task.meta.captcha ?? { auto: true }
    if ((taskCfg.auto ?? true) === false) return 'none'
    return runRecaptchaGrid(
      { page: this.page, provider: this.deps.captcha, logger: this.turnstileLogger(), human: this.human },
      {
        maxRounds: opts?.maxRounds,
        siteKeyExclude: opts?.siteKeyExclude,
        maxCostPerTask: this.deps.cfg.captcha.maxCostPerTask,
        onLog: (platform, kind, ok, costPoints) => {
          this.deps.onCaptchaLog?.(platform, kind, ok, costPoints)
        },
      },
    )
  }
```

- [ ] **Step 3: app.ts**

第 19 行替换为：

```ts
import { createCaptchaProvider } from './integrations/captcha'
```

第 157-164 行替换为：

```ts
  // clientKey 未配置时 captcha 为 null：任务侧 solveCaptcha 直接返回 none，无 Key 也能跑
  const captcha = createCaptchaProvider(cfg.captcha)
```

第 258-264 行替换为：

```ts
    captchaBalance: async () => {
      if (!captcha) return null
      try {
        return { points: await captcha.getBalance(), platform: captcha.platform }
      } catch {
        return null
      }
    },
```

- [ ] **Step 4: server 路由**

`src/server/app.ts` 第 52 行替换为：

```ts
  captchaBalance: () => Promise<{ points: number; platform: string } | null>
```

`src/server/routes/captcha.ts` 中 `captchaRouter` 签名与响应更新：

```ts
export function captchaRouter(deps: { captchaBalance: () => Promise<{ points: number; platform: string } | null> }): Router {
  const router = Router()
  router.get('/captcha/balance', asyncHandler(async (req, res) => {
    const balance = await deps.captchaBalance()
    if (balance === null) {
      ok(res, { configured: false, points: 0, yuan: 0, platform: '' })
      return
    }
    ok(res, { configured: true, points: balance.points, yuan: Number((balance.points / 1000).toFixed(2)), platform: balance.platform })
  }))
  return router
}
```

同步更新该文件 swagger 注释：data.properties 增加 `platform: { type: string, description: '打码平台标识（如 yescaptcha）' }`。

- [ ] **Step 5: 前端**

`web/src/api/schema.d.ts` 的 `/api/captcha/balance` data 类型手补 `platform?: string`；`web/src/layouts/AppLayout.tsx` 第 44-48 行把硬编码 "yescaptcha" 改为动态平台名：

```tsx
    if (captchaBalance.isError || !captchaBalance.data) return <Tag>状态未知</Tag>
    return captchaBalance.data.configured ? (
      <Tag color="green">{captchaBalance.data.platform || '打码平台'} ¥{captchaBalance.data.yuan.toFixed(2)}</Tag>
    ) : (
      <Tag>打码平台未配置</Tag>
    )
```

- [ ] **Step 6: 更新 task-context 测试 fake**

`tests/task-context-generic.test.ts` 第 129 行的 captcha fake 替换为 provider 形态：

```ts
    const deps = { ...baseDeps(makeFakePage({})), captcha: { platform: 'test', solveToken: vi.fn(), classifyGrid: vi.fn().mockResolvedValue({ type: 'multi', objects: [0] }), getBalance: vi.fn().mockResolvedValue(100000) } }
```

`tests/task-context-scenarios.test.ts` 第 24 行的 cfg fake 替换为：

```ts
    cfg: { captcha: { maxCostPerTask: 1500 } } as never,
```

（如两文件还有其他 captcha 引用一并按同形态改。）

- [ ] **Step 7: 删除旧文件**

```powershell
git rm src/integrations/yescaptcha.ts src/automation/recaptcha-grid.ts src/automation/turnstile.ts tests/captcha.test.ts
```

- [ ] **Step 8: 全量测试 + typecheck（arc 测试除外）**

Run: `npx vitest run --exclude tests/arc-faucet.test.ts; npm run typecheck`
Expected: 除 arc-faucet 外全绿（windowRunner.test.ts 全部传 `captcha: null`，新类型 `CaptchaProvider | null` 无需改动；arc-faucet.test.ts 引用旧 solveGrid fake，Task 9 修复）

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "refactor: engine 接线打码平台抽象（删除旧 yescaptcha/recaptcha-grid 模块）"
```

---

### Task 9: arc 任务重写

**Files:**
- Modify: `src/tasks/arc-faucet.ts`（detectV2Challenge 改走 automation/captcha、solveRecaptchaGrid 带 maxRounds、meta.note 重写）
- Modify: `tests/arc-faucet.test.ts`（captcha fake 改 provider 形态、BFRAME_HTML 补官方整图 img、断言更新）
- Modify: `tests/fixtures/arc-faucet.html`（如需要）

**Interfaces:**
- Consumes: Task 6 的 `findAnchorFrame`/`findChallengeFrame`、Task 8 的 TaskContext 新签名

- [ ] **Step 1: arc-faucet.ts**

import 区增加：

```ts
import { findAnchorFrame, findChallengeFrame } from '../automation/captcha/grid'
```

第 90-104 行 `detectV2Challenge` 整体替换为（删除 ctx.js 内联 sitekey）：

```ts
/**
 * 检测 v2 挑战是否已渲染：主文档存在 anchor iframe 且 sitekey ≠ 常驻 v3，或已出现网格 bframe
 * （复用 automation/captcha 的 frame 查找，sitekey 排除逻辑单点维护，不在任务层内联）
 */
export async function detectV2Challenge(ctx: TaskContext): Promise<boolean> {
  return findAnchorFrame(ctx.page, V3_SITEKEY) !== null || findChallengeFrame(ctx.page, V3_SITEKEY) !== null
}
```

第 150-158 行挑战分支替换为：

```ts
  if (outcome === 'captcha') {
    ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '检测到 v2 挑战，走九宫格模拟点击')
    const grid = await ctx.solveRecaptchaGrid({ siteKeyExclude: V3_SITEKEY, maxRounds: 3 })
    if (grid === 'none') throw new Error('未检测到验证码锚点 frame')
    if (grid === 'failed') throw new Error('九宫格多轮未通过（同窗口风控上限，交由重试换新窗口）')
    // widget 完成后站点恢复提交按钮；再提交一次
    await ensureSubmitEnabled(ctx)
    outcome = await submitAndWait(ctx)
  }
```

meta.note（第 176 行）替换为：

```ts
    note: '真机核实（2026-09-10 rev3）：挑战为 reCAPTCHA Enterprise v2 复选框（sitekey 6LcCqC8s，页面另常驻 v3 6LcNs_0p）；挑战出现后提交按钮禁用直到 widget 完成——token 注入路线不可行，走官方 DEMO 对齐的九宫格模拟点击（原生整图分类/原生点击/单格刷新确认）；同窗口最多 3 轮（同会话风控：死磕即使选对也过不去），未过交重试换新窗口碰 v3 直过；不连钱包，地址取自数据源「metamask钱包地址」列；限频每资产×网络 1-2 小时（不做判定）',
```

- [ ] **Step 2: 更新 tests/arc-faucet.test.ts**

`makeBrowserCtx`（第 434-451 行）的 captcha fake 改为 provider 形态：

```ts
  function makeBrowserCtx(page: Page, task: ArcFaucetTask, captcha: { classifyGrid?: ReturnType<typeof vi.fn> } = {}) {
    return new TaskContext({
      page,
      task,
      human: new Humanizer(page),
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: { captcha: { maxCostPerTask: 1500 } } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: join(tmpdir(), 'arc-faucet-test-artifacts'),
      walletPasswords: {},
      accountRow: { metamask钱包地址: '0x835e' },
      captcha: {
        platform: 'test',
        solveToken: vi.fn(),
        classifyGrid: captcha.classifyGrid ?? vi.fn().mockResolvedValue({ type: 'multi', objects: [] }),
        getBalance: vi.fn().mockResolvedValue(100000),
      } as never,
    })
  }
```

各用例中 `solveGrid` 改名 `classifyGrid`；`expect(solveGrid).not.toHaveBeenCalled()` → `expect(classifyGrid).not.toHaveBeenCalled()`。

challenge 用例（第 487-503 行）：

```ts
  it('challenge 模式：v2 挑战 → 九宫格求解（假分类）→ 按钮恢复 → 再提交成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const task = new ArcFaucetTask()
      task.meta.url = baseUrl + '/?mode=challenge'
      const classifyGrid = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
      const ctx = makeBrowserCtx(page, task, { classifyGrid })
      await task.run(ctx)
      expect(classifyGrid).toHaveBeenCalledTimes(1)
      expect(classifyGrid.mock.calls[0][1]).toBe('/m/015qbp')
      expect(await detectV2Challenge(ctx)).toBe(true)
      expect(await page.getByText('on its way').count()).toBe(1)
    } finally {
      await browser.close()
    }
  }, 90000)
```

BFRAME_HTML（第 395-410 行）第一个 td 内补官方整图 img：

```ts
  const BFRAME_HTML = `<!doctype html><html><body>
<div class="rc-imageselect-desc-wrapper"><strong>停车计时器</strong></div>
<div id="rc-imageselect-target"><table>
<tr><td style="width:96px;height:96px"><div class="rc-image-tile-wrapper"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="></div></td><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td></tr>
<tr><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td></tr>
<tr><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td><td style="width:96px;height:96px"></td></tr>
</table></div>
<button id="recaptcha-verify-button">验证</button>
<script>
document.querySelectorAll('#rc-imageselect-target table td').forEach(function (td) { td.addEventListener('click', function () { td.classList.add('selected') }) })
document.getElementById('recaptcha-verify-button').addEventListener('click', function () {
  const anchorFrame = window.parent.document.querySelector('iframe[src*="anchor"]')
  if (anchorFrame) anchorFrame.contentWindow.postMessage('grid-solved', '*')
})
</script></body></html>`
```

（1x1 PNG 的 naturalWidth=1 → grid.ts 按 300 缩放，fake 分类不看图，无影响。）

- [ ] **Step 3: 运行 arc 测试**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: PASS（注意真实浏览器用例 90s 超时，本地需能跑 headless chromium）

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck; npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```powershell
git add src/tasks/arc-faucet.ts tests/arc-faucet.test.ts tests/fixtures/arc-faucet.html
git commit -m "feat: arc 领水接入新九宫格求解（同窗口 3 轮上限，检测复用 automation 层）"
```

---

### Task 10: 文档同步（硬性要求）

**Files:**
- Modify: `docs/API-GUIDE.md`
- Modify: `docs/TASK-DEVELOPMENT-LESSONS.md`

- [ ] **Step 1: API-GUIDE**

- 第 3 章 TaskContext：`solveRecaptchaGrid` 增加 `maxRounds` 参数说明与「读 meta.captcha.auto，与 solveCaptcha 口径统一」；`solveCaptcha` 说明改为「内部走打码平台适配层（CaptchaProvider）」
- 第 5 章验证码整章重写：
  - 架构：打码平台抽象（integrations/captcha）+ 自研人机验证模块（automation/captcha），列出目录结构与 provider 接口
  - 支持类型：4 种 token 类（turnstile/recaptcha_v2/recaptcha_v3/hcaptcha）+ 九宫格 recaptcha_v2_grid；**明确写明 image（ImageToTextTask）未接入**（官方 body 参数、同步/异步双形态，无使用方）
  - 检测：enterprise 支持说明（enterprise/anchor、enterprise.js）
  - 九宫格：官方 DEMO 对齐说明（原生整图/naturalWidth/原生点击/单格刷新确认/同窗口 maxRounds 风控上限/记账分档：主网格 6 点、1x1 单格 2 点）
  - 错误分类语义：CaptchaFailure → captcha_failed 终态不重试；九宫格多轮未过（普通 Error）→ retry_wait
- 9.1 配置表：captcha 段重写为 provider/solveTimeoutMs/pollIntervalMs/maxCostPerTask/yescaptcha（删 taskTypes 说明，注明已移入代码）
- 9.3 REST 接口总表：`/api/captcha/balance` 响应增加 platform 字段说明

- [ ] **Step 2: TASK-DEVELOPMENT-LESSONS**

追加真机经验（第 8 节扩充或新增第 9 节）：

```markdown
## 9. reCAPTCHA 九宫格（rev3 教训，2026-09-10）

- 同窗口死磕验证必挂：同一窗口连续多轮验证失败后即使选对 Google 也不给过（同会话风控）；maxRounds 上限（默认 3）后必须交任务重试换新窗口
- 点击未注册根因是坐标漂移：页面坐标拟人点击（frame 偏移计算）在真机窗口 92 连续 5 轮未注册；官方 DEMO 用元素原生点击（selenium click 等价）为主，坐标点击只做未注册兜底
- 网格图必须用原生整图：div.rc-image-tile-wrapper > img 的 src + naturalWidth（300/450 定尺寸）；容器元素截图经 CSS 缩放裁剪后分类乱跳/空数组（窗口 93/100）
- 提示语映射未覆盖直接抛错快速失败（扩充映射表优先于猜测）
- frame 失效防护：Google 换图后旧 Frame 引用可能失效，每轮必须重取 challenge frame
```

- [ ] **Step 3: 提交**

```powershell
git add docs/API-GUIDE.md docs/TASK-DEVELOPMENT-LESSONS.md
git commit -m "docs: 打码平台抽象与九宫格 rev3 文档同步（API-GUIDE/LESSONS）"
```

---

### Task 11: 真机验证清单（遵守窗口规范，人工执行）

- [ ] **Step 1: 验证前确认**

- `npm run typecheck` 与 `npm test` 全绿
- 比特浏览器已启动且 API 就绪；`config/.env` 的 `CAPTCHA_CLIENT_KEY` 有效；余额 ≥ 1500 点
- 选定一个当日未请求过 faucet.circle.com 的窗口（冷却 1-2h 之外）

- [ ] **Step 2: 单窗口跑一次（不反复开关窗）**

Run: `$env:BITBROWSER_PROFILE_ID="<窗口ID>"; $env:TASK_KEY="faucet-arc"; npm run task:run`
Expected: 一次会话内观察完整流程；窗口保持打开直到观察结束再关

- [ ] **Step 3: 观察点（读 `data/logs/app.log` 与 `data/screenshots/grid-debug/`）**

- `检测到 v2 挑战` 出现 → `九宫格识别目标` 提示语与 qid 正确
- grid-raw/grid-std 截图确认整图质量（非容器截图）
- `grid-click-diag` 的 hit=true（原生点击注册）
- `aria-checked` 变绿 → `九宫格一键通过` 或 solved → 按钮恢复 → 再点 Send → 成功文案 `is on its way`
- 若挑战未出现（v3 直过）：同样算流程可用，但九宫格路径未验证 → 等冷却换窗口再验一次

- [ ] **Step 4: 失败处置**

- 连续 2 次失败或 10 分钟无进展：立即停止自动化重试，带日志 + grid-debug 截图请求人工介入
- 分类乱跳/空数组 → 核对 grid-std 截图图像质量（怀疑原生整图读取问题）
- 点击未注册 → 核对 grid-click-diag 与拟人兜底日志

---

## 实施后总验收

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿（无排除项）
- [ ] 旧模块已删除：`integrations/yescaptcha.ts`、`automation/recaptcha-grid.ts`、`automation/turnstile.ts`（根目录版）
- [ ] `docs/API-GUIDE.md` 与 `docs/TASK-DEVELOPMENT-LESSONS.md` 已同步
- [ ] 真机验证一次有结论（成功或带证据的人工介入）

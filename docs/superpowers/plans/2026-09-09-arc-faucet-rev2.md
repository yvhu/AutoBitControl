# Arc 领水任务 rev2 实施计划（九宫格模拟点击路线）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 rev1（faucet-arc 已注册，Task 1-4 完成）基础上，把验证码处理改为真机验证过的九宫格模拟点击路线：yescaptcha 新增 `ReCaptchaV2Classification` 分类任务 → 新模块自动点复选框、截图网格、按分类坐标点选、验证、循环至变绿 → 任务接入新流程。

**Architecture:** `integrations/yescaptcha.ts` 加分类任务类型与 `classifyGrid`/`solveGrid`（复用串行链与记账模式）；新 `automation/recaptcha-grid.ts` 封装九宫格求解循环（frame 交互 + jimp 图片缩放 + 提示语→问题 ID 映射）；`TaskContext` 加 `solveRecaptchaGrid()` 包装（仿 turnstile 模式）；`arc-faucet` 任务以「检测 v2 挑战 → 求解网格 → 按钮恢复 → 再提交」替换 rev1 的 token 注入路径。

**Tech Stack:** TypeScript 严格模式、patchright（跨源 iframe 可用）、jimp（新增，纯 JS）、vitest、yescaptcha 分类接口。

**规格来源:** `docs/superpowers/specs/2026-09-09-arc-faucet-rev2-design.md`

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、camelCase、kebab-case 文件名；文件头中文注释块；日志中文（`logger.info({step:'faucet'...}, '消息')`）；commit conventional + 中文
- 测试：`npx vitest run tests/<file>`（单文件）；`npm test`（全量）；`npm run typecheck` 必须通过
- yescaptcha 分类接口：type `ReCaptchaV2Classification`；入参 image（Base64 无 data: 前缀，3x3=300x300 / 4x4=450x450 / 单格=100x100）+ question（/m/ ID）+ confidence（0.5 时 3x3 返回全部命中）；返回 `solution.objects`（multi 点击序号 0-8/0-15）或 `solution.hasObject`（single）
- 站点 sitekey 常量：v3 `6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2`（挑战检测时排除）；v2 `6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve`
- 挑战 frame URL 特征（真机抓取）：anchor `recaptcha/enterprise/anchor`、网格 `recaptcha/enterprise/bframe`（同时兼容普通版 `recaptcha/api2/anchor`/`recaptcha/api2/bframe`）
- 限频不做判定（用户隔天执行一次）；任务 meta timeoutSec 240 → **420**（网格多轮解题耗时，真机驱动）
- 真机验证：窗口 100 当日请求额度已耗尽（1-2h 冷却），验证时若撞限频换窗口；**不频繁重启浏览器**，一次 task:run 跑通

---

## Task 6: yescaptcha 分类任务支持（TDD）

**Files:**
- Modify: `src/integrations/yescaptcha.ts`
- Modify: `tests/captcha.test.ts`（追加分类测试）

**Interfaces:**
- Consumes: 现有 `YesCaptchaClient` 串行链/`httpJson` 封装
- Produces:
  - `CaptchaKind` 增加 `'recaptcha_v2_grid'`；`ESTIMATED_COST_POINTS['recaptcha_v2_grid'] = 6`
  - `YesCaptchaClient.classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult>`，`GridResult = { type: 'multi'; objects: number[] } | { type: 'single'; hasObject: boolean }`
  - `CaptchaService.solveGrid(image: string, questionId: string, opts: { confidence?: number; profileId: number | null; taskKey: string | null; onLog: (kind: string, ok: boolean, costPoints: number) => void }): Promise<GridResult>`

- [ ] **Step 1: 写失败的测试**

在 `tests/captcha.test.ts` 末尾追加（import 顶部已含所需符号，追加 `ESTIMATED_COST_POINTS` 到 import 行）：

```ts
describe('YesCaptchaClient.classifyGrid 九宫格分类', () => {
  it('创建分类任务并轮询到 multi 结果（objects 数组）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        const body = JSON.parse(String(init.body))
        expect(body.task.type).toBe('ReCaptchaV2Classification')
        expect(body.task.image).toBe('b64-img')
        expect(body.task.question).toBe('/m/015qbp')
        expect(body.task.confidence).toBe(0.5)
        return new Response(JSON.stringify({ errorId: 0, taskId: 'g-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { objects: [1, 5, 8], type: 'multi' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, {})
    const r = await client.classifyGrid('b64-img', '/m/015qbp', 0.5)
    expect(r).toEqual({ type: 'multi', objects: [1, 5, 8] })
  })

  it('single 结果解析 hasObject', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 'g-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { hasObject: true, type: 'single' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, {})
    await expect(client.classifyGrid('b64', '/m/0k4j')).resolves.toEqual({ type: 'single', hasObject: true })
  })

  it('错误码快速失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 'g-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_ILLEGAL_IMAGE' }), { status: 200 })
    }))
    const client = new YesCaptchaClient({ ...cfg, solveTimeoutMs: 1000 }, {})
    await expect(client.classifyGrid('b64', '/m/0k4j')).rejects.toThrow(/ERROR_ILLEGAL_IMAGE/)
  })

  it('挂串行链（并发只有 1 个在飞）', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 50))
        inFlight--
        return new Response(JSON.stringify({ errorId: 0, taskId: 'g-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { hasObject: false, type: 'single' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, {})
    await Promise.all([client.classifyGrid('a', '/m/0k4j'), client.classifyGrid('b', '/m/0k4j')])
    expect(peak).toBe(1)
  })
})

describe('CaptchaService.solveGrid 记账', () => {
  it('成功记 recaptcha_v2_grid 成本；失败抛 CaptchaFailure 记失败', async () => {
    const client = { ensureBalance: vi.fn().mockResolvedValue(undefined), classifyGrid: vi.fn().mockResolvedValue({ type: 'multi', objects: [0] }) }
    const onLog = vi.fn()
    const service = new CaptchaService(client as never, { maxCostPerTask: 1500 })
    const r = await service.solveGrid('b64', '/m/0k4j', { profileId: null, taskKey: null, onLog, confidence: 0.5 })
    expect(r).toEqual({ type: 'multi', objects: [0] })
    expect(client.classifyGrid).toHaveBeenCalledWith('b64', '/m/0k4j', 0.5)
    expect(onLog).toHaveBeenCalledWith('recaptcha_v2_grid', true, 6)
    client.classifyGrid.mockRejectedValueOnce(new CaptchaFailure('余额不足'))
    await expect(service.solveGrid('b64', '/m/0k4j', { profileId: null, taskKey: null, onLog })).rejects.toThrow(CaptchaFailure)
    expect(onLog).toHaveBeenCalledWith('recaptcha_v2_grid', false, 6)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/captcha.test.ts`
Expected: FAIL（`classifyGrid`/`solveGrid`/`ESTIMATED_COST_POINTS.recaptcha_v2_grid` 不存在）

- [ ] **Step 3: 实现**

修改 `src/integrations/yescaptcha.ts`：

1. `CaptchaKind` 联合类型加 `'recaptcha_v2_grid'`；`ESTIMATED_COST_POINTS` 加 `recaptcha_v2_grid: 6`
2. `YesCaptchaResp.solution` 类型加 `objects?: number[]`、`hasObject?: boolean`、`type?: string`
3. 新增导出类型与客户端方法（放在 `solveCaptcha` 之后）：

```ts
/** 九宫格分类结果：multi = 需要点击的格子序号（3x3 为 0-8，4x4 为 0-15）；single = 小图是否含目标 */
export type GridResult = { type: 'multi'; objects: number[] } | { type: 'single'; hasObject: boolean }

  /**
   * 九宫格图片分类：提交网格截图（已缩放到标准尺寸的 Base64，无 data: 前缀）与问题 ID，
   * 平台返回需要点击的格子序号（multi）或单图是否命中（single）
   * @throws CaptchaFailure 创建失败 / 查询失败 / 超时（solveTimeoutMs）
   */
  classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult> {
    const run = async (): Promise<GridResult> => {
      const taskId = await this.createTask({ type: 'ReCaptchaV2Classification', image, question: questionId, ...(confidence === undefined ? {} : { confidence }) })
      const deadline = Date.now() + this.cfg.solveTimeoutMs
      while (Date.now() < deadline) {
        const resp = await this.call('/getTaskResult', { clientKey: this.cfg.clientKey, taskId })
        if (resp.errorId != null && resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 查询结果失败: ${resp.errorCode ?? resp.errorId}`)
        if (resp.status === 'ready') {
          const s = resp.solution ?? {}
          if (s.type === 'multi' && Array.isArray(s.objects)) return { type: 'multi', objects: s.objects }
          if (s.type === 'single' && typeof s.hasObject === 'boolean') return { type: 'single', hasObject: s.hasObject }
          if (Array.isArray(s.objects)) return { type: 'multi', objects: s.objects }
          if (typeof s.hasObject === 'boolean') return { type: 'single', hasObject: s.hasObject }
          throw new CaptchaFailure('yescaptcha 分类结果格式异常')
        }
        await new Promise(r => setTimeout(r, this.cfg.pollIntervalMs))
      }
      throw new CaptchaFailure(`yescaptcha 分类超时: taskId=${taskId}`)
    }
    // 串行排队：与 solveCaptcha 共享同一条链（平台每账号 1 并发限制）
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    return result
  }
```

4. `CaptchaService` 新增方法（放在 `autoSolve` 之后）：

```ts
  /**
   * 九宫格分类解题（模拟点击路线的识别步骤）：余额校验 → classifyGrid → 成本记账
   * 语义同 autoSolve：失败抛 CaptchaFailure（调用方归 captcha_failed 终态）
   */
  async solveGrid(image: string, questionId: string, opts: { confidence?: number; profileId: number | null; taskKey: string | null; onLog: (kind: string, ok: boolean, costPoints: number) => void }): Promise<GridResult> {
    try {
      await this.client.ensureBalance(this.cfg.maxCostPerTask)
      const r = await this.client.classifyGrid(image, questionId, opts.confidence)
      opts.onLog('recaptcha_v2_grid', true, ESTIMATED_COST_POINTS.recaptcha_v2_grid ?? 0)
      return r
    } catch (e) {
      opts.onLog('recaptcha_v2_grid', false, ESTIMATED_COST_POINTS.recaptcha_v2_grid ?? 0)
      throw new CaptchaFailure(`九宫格分类失败: ${(e as Error).message}`)
    }
  }
```

注意 `classifyGrid` 的 createTask 复用现有私有方法（其 task 体不校验类型，直接透传）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/captcha.test.ts`
Expected: PASS（原有 17 + 新 5 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/integrations/yescaptcha.ts tests/captcha.test.ts
git commit -m "feat: yescaptcha 新增九宫格分类任务（ReCaptchaV2Classification）"
```

---

## Task 7: recaptcha-grid 自动化模块（TDD）

**Files:**
- Create: `src/automation/recaptcha-grid.ts`
- Create: `tests/recaptcha-grid.test.ts`
- Modify: `package.json`（新增 jimp 依赖）

**Interfaces:**
- Consumes: Task 6 的 `CaptchaService.solveGrid` / `GridResult`；`Logger` 类型；`Humanizer`（仅传引用，本模块内不使用点击拟人——验证码网格点击走 locator 直点）
- Produces:
  - `mapQuestionId(promptText: string): string | null`（中英映射）
  - `solveRecaptchaGrid(deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer }, opts?: { maxRounds?: number }): Promise<'solved' | 'none' | 'failed'>`
  - 导出常量：`ANCHOR_FRAME_PART`、`CHALLENGE_FRAME_PART`、`ANCHOR_SELECTOR`、`PROMPT_SELECTOR`、`TILE_SELECTOR`、`VERIFY_SELECTOR`、`MAX_ROUNDS`

- [ ] **Step 1: 写失败的测试**

创建 `tests/recaptcha-grid.test.ts`：

```ts
/**
 * 九宫格模拟点击模块单测：提示语映射纯函数 + 注入假 frame 的求解循环分支
 * 假 frame 用最小 locator 模拟器（按选择器分派行为），网格截图用 jimp 生成真实 PNG
 */
import { describe, it, expect, vi } from 'vitest'
import Jimp from 'jimp'
import { mapQuestionId, solveRecaptchaGrid, ANCHOR_FRAME_PART, CHALLENGE_FRAME_PART, ANCHOR_SELECTOR, PROMPT_SELECTOR, TILE_SELECTOR, VERIFY_SELECTOR } from '../src/automation/recaptcha-grid'

describe('mapQuestionId 提示语映射', () => {
  it('中文常见提示语', () => {
    expect(mapQuestionId('停车计时器')).toBe('/m/015qbp')
    expect(mapQuestionId('停车计价表')).toBe('/m/015qbp')
    expect(mapQuestionId('红绿灯')).toBe('/m/015qff')
    expect(mapQuestionId('人行横道')).toBe('/m/014xcs')
  })

  it('英文常见提示语', () => {
    expect(mapQuestionId('traffic lights')).toBe('/m/015qff')
    expect(mapQuestionId('parking meters')).toBe('/m/015qbp')
    expect(mapQuestionId('bicycles')).toBe('/m/0199g')
  })

  it('长句包含目标词也能命中', () => {
    expect(mapQuestionId('请选择包含停车计时器的所有图片')).toBe('/m/015qbp')
  })

  it('未覆盖提示语返回 null', () => {
    expect(mapQuestionId('storefronts')).toBeNull()
    expect(mapQuestionId('')).toBeNull()
  })
})

/** 最小假 locator：元素行为表；count/getAttribute/textContent/click/screenshot 均按选择器分派 */
interface ElemBehavior {
  count?: number
  attrs?: Record<string, string>
  text?: string | null
  click?: ReturnType<typeof vi.fn>
  screenshotBuf?: Buffer
}

function makeFrame(behaviors: Record<string, ElemBehavior>) {
  const clicks: ReturnType<typeof vi.fn>[] = []
  const locator = (selector: string) => {
    const b = behaviors[selector] ?? {}
    const click = b.click ?? vi.fn().mockResolvedValue(undefined)
    clicks.push(click)
    const fake = {
      first: () => fake,
      nth: () => fake,
      count: vi.fn().mockResolvedValue(b.count ?? 0),
      getAttribute: vi.fn().mockImplementation(async (name: string) => (b.attrs ?? {})[name] ?? null),
      textContent: vi.fn().mockResolvedValue(b.text ?? null),
      click: click,
      screenshot: vi.fn().mockResolvedValue(b.screenshotBuf ?? null),
    }
    return fake
  }
  return { locator, clicks }
}

/** 造一张纯色 PNG（供 jimp 缩放链路） */
async function makePngBuffer(size: number): Promise<Buffer> {
  const img = new Jimp(size, size, 0x22aaffff)
  return img.getBufferAsync(Jimp.MIME_PNG)
}

describe('solveRecaptchaGrid 求解循环', () => {
  function makeDeps(overrides: { anchorChecked?: string; anchorPresent?: boolean; challengePresent?: boolean; prompt?: string | null; tileCount?: number; gridResult?: unknown }) {
    const o = { anchorChecked: 'false', anchorPresent: true, challengePresent: true, prompt: '停车计时器', tileCount: 9, gridResult: { type: 'multi', objects: [0, 2] }, ...overrides }
    const anchor = makeFrame({
      [ANCHOR_SELECTOR]: { attrs: { 'aria-checked': o.anchorChecked }, click: vi.fn().mockResolvedValue(undefined) },
    })
    const challenge = makeFrame({
      [PROMPT_SELECTOR]: { text: o.prompt },
      [TILE_SELECTOR]: { count: o.tileCount, attrs: { class: 'rc-imageselect-tile' }, click: vi.fn().mockResolvedValue(undefined), screenshotBuf: o.tileCount > 0 ? undefined : undefined },
      ['#rc-imageselect-target']: { screenshotBuf: undefined },
      [VERIFY_SELECTOR]: { click: vi.fn().mockResolvedValue(undefined) },
    })
    // 网格截图：异步生成真实 PNG（screenshotBuf 为 Promise 前无法在 makeFrame 内 await，改为直接给 Buffer 引用）
    // 此处简化：在测试主体里预生成 buffer 后传入
    const page = {
      frames: () => [...(o.anchorPresent ? [{ url: () => `https://www.google.com/${ANCHOR_FRAME_PART}?k=6LcCqC8s`, locator: anchor.locator }] : []), ...(o.challengePresent ? [{ url: () => `https://www.google.com/${CHALLENGE_FRAME_PART}?hl=zh-CN`, locator: challenge.locator }] : [])],
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const captcha = { solveGrid: vi.fn().mockResolvedValue(o.gridResult) }
    const logger = { info: vi.fn(), warn: vi.fn() }
    return { page, captcha, logger, anchor, challenge }
  }

  it('无锚点 frame → none', async () => {
    const { page, captcha, logger } = makeDeps({ anchorPresent: false, challengePresent: false })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('none')
  })

  it('点复选框后 aria-checked=true（一键通过）→ solved，不进网格', async () => {
    const { page, captcha, logger } = makeDeps({ anchorChecked: 'true', challengePresent: false })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(captcha.solveGrid).not.toHaveBeenCalled()
  })

  it('完整一轮：读提示语 → 分类 → 点格子 → 验证 → aria-checked=true → solved', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridResult: { type: 'multi', objects: [0, 2] } })
    const challengeFrame = (page as { frames: () => Array<{ url: () => string; locator: (s: string) => unknown }> }).frames().find((f) => f.url().includes(CHALLENGE_FRAME_PART))!
    // 替换网格容器的截图行为返回真实 PNG
    ;(challengeFrame as unknown as { locator: ReturnType<typeof makeFrame>['locator'] }).locator('#rc-imageselect-target').screenshot = vi.fn().mockResolvedValue(gridBuf)
    await solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
    const [imageArg, questionArg] = (captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(questionArg).toBe('/m/015qbp')
    expect(imageArg).toMatch(/^[A-Za-z0-9+/=]+$/)
  }, 30000)
})
```

注意：以上测试骨架的假 frame 结构需实现者按实际情况微调（如截图行为的注入方式），但断言语义不变：① 无锚点 → none；② 一键通过 → solved 且不调分类；③ 完整一轮 → 分类收到问题 ID `/m/015qbp` 与 Base64 图片、按 objects 点击格子、验证后变绿 → solved。实现者自检假 frame 是否贴合模块代码。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/recaptcha-grid.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 安装 jimp**

Run: `npm install jimp`
Expected: 安装成功，package.json dependencies 增加 jimp

- [ ] **Step 4: 实现模块**

创建 `src/automation/recaptcha-grid.ts`：

```ts
/**
 * reCAPTCHA 九宫格模拟点击求解（automation 层）：点复选框 → 截图网格 → yescaptcha 分类 →
 * 按坐标点选 → 验证 → 查 aria-checked → 未通过则下一轮，直到变绿
 * 真机核实（2026-09-09，faucet.circle.com）：挑战为 reCAPTCHA Enterprise
 * （anchor iframe: recaptcha/enterprise/anchor；网格 iframe: recaptcha/enterprise/bframe），
 * 兼容普通版（recaptcha/api2/anchor / api2/bframe）；官方 DEMO 流程
 * （yescaptcha 文档页 29786113）为协议来源
 * 依赖方向：依赖 integrations/yescaptcha 类型，被 engine/task-context 包装调用
 */
import type { Page, Frame } from 'patchright'
import Jimp from 'jimp'
import type { CaptchaService } from '../integrations/yescaptcha'
import type { Logger } from '../infrastructure/logger'
import type { Humanizer } from './humanize'

// —— 站点/Google 元素常量（真机核实）——
/** 锚点（复选框）frame URL 片段 */
export const ANCHOR_FRAME_PART = 'recaptcha/enterprise/anchor'
/** 挑战（九宫格）frame URL 片段 */
export const CHALLENGE_FRAME_PART = 'recaptcha/enterprise/bframe'
/** 锚点复选框元素 */
export const ANCHOR_SELECTOR = '#recaptcha-anchor'
/** 提示文字（目标物体名） */
export const PROMPT_SELECTOR = '.rc-imageselect-desc-wrapper strong'
/** 网格格子（td 顺序即序号：3x3 为 0-8，4x4 为 0-15） */
export const TILE_SELECTOR = '#rc-imageselect-target table td'
/** 验证按钮 */
export const VERIFY_SELECTOR = '#recaptcha-verify-button'
/** 网格容器（截图用） */
export const GRID_SELECTOR = '#rc-imageselect-target'
/** 最大求解轮数 */
export const MAX_ROUNDS = 5
/** 单格小图二次识别最大次数 */
export const SINGLE_RECHECK_MAX = 2

/** 提示语 → 问题 ID 映射（中英双语；官方中文表 + DEMO 英文表合并；未覆盖的提示语任务会失败，按日志扩充） */
export const QUESTION_ID_MAP: Record<string, string> = {
  '出租车': '/m/0pg52', '巴士': '/m/01bjv', '公交车': '/m/01bjv', '校车': '/m/02yvhj',
  '摩托车': '/m/04_sv', '拖拉机': '/m/013xlm', '烟囱': '/m/01jk_4', '人行横道': '/m/014xcs',
  '红绿灯': '/m/015qff', '自行车': '/m/0199g', '停车计价表': '/m/015qbp', '停车计时器': '/m/015qbp',
  '汽车': '/m/0k4j', '车辆': '/m/0k4j', '桥': '/m/015kr', '船': '/m/019jd', '棕榈树': '/m/0cdl1',
  '山': '/m/09d_r', '山丘': '/m/09d_r', '消防栓': '/m/01pns0', '楼梯': '/m/01lynh',
  'taxis': '/m/0pg52', 'taxi': '/m/0pg52', 'bus': '/m/01bjv', 'buses': '/m/01bjv', 'school bus': '/m/02yvhj',
  'motorcycles': '/m/04_sv', 'motorcycle': '/m/04_sv', 'tractors': '/m/013xlm', 'tractor': '/m/013xlm',
  'chimneys': '/m/01jk_4', 'chimney': '/m/01jk_4', 'crosswalks': '/m/014xcs', 'crosswalk': '/m/014xcs',
  'pedestrian crossings': '/m/014xcs', 'traffic lights': '/m/015qff', 'traffic light': '/m/015qff',
  'bicycles': '/m/0199g', 'bicycle': '/m/0199g', 'parking meters': '/m/015qbp', 'parking meter': '/m/015qbp',
  'cars': '/m/0k4j', 'car': '/m/0k4j', 'vehicles': '/m/0k4j', 'vehicle': '/m/0k4j',
  'bridges': '/m/015kr', 'bridge': '/m/015kr', 'boats': '/m/019jd', 'boat': '/m/019jd',
  'palm trees': '/m/0cdl1', 'palm tree': '/m/0cdl1', 'mountains or hills': '/m/09d_r', 'mountains': '/m/09d_r',
  'hills': '/m/09d_r', 'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0', 'stairs': '/m/01lynh',
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

/** 找锚点 frame（兼容 enterprise/api2 两种 URL） */
export function findAnchorFrame(page: Page): Frame | null {
  return page.frames().find((f) => f.url().includes('recaptcha/enterprise/anchor') || f.url().includes('recaptcha/api2/anchor')) ?? null
}

/** 找挑战（九宫格）frame */
export function findChallengeFrame(page: Page): Frame | null {
  return page.frames().find((f) => f.url().includes('recaptcha/enterprise/bframe') || f.url().includes('recaptcha/api2/bframe')) ?? null
}

/** PNG buffer 缩放至标准尺寸并转 Base64（无 data: 前缀） */
async function toStandardBase64(buf: Buffer, size: number): Promise<string> {
  const img = await Jimp.read(buf)
  await img.resize(size, size)
  return (await img.getBase64Async(Jimp.MIME_PNG)).replace(/^data:image\/\w+;base64,/, '')
}

/** 单轮：读提示语 → 截图网格 → 分类 → 点格子（含小图刷新二次识别）→ 点验证 */
async function solveOneRound(deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer }, ch: Frame): Promise<void> {
  const prompt = ((await ch.locator(PROMPT_SELECTOR).first().textContent().catch(() => '')) ?? '').trim()
  if (!prompt) throw new Error('九宫格提示文字未找到')
  const qid = mapQuestionId(prompt)
  if (!qid) throw new Error(`未覆盖的九宫格提示语: ${prompt}`)
  deps.logger.info({ prompt, qid }, '九宫格识别目标')
  const tiles = ch.locator(TILE_SELECTOR)
  const tileCount = await tiles.count()
  const size = tileCount === 16 ? 450 : 300
  const shot = await ch.locator(GRID_SELECTOR).first().screenshot({ type: 'png' })
  const b64 = await toStandardBase64(shot, size)
  const result = await deps.captcha.solveGrid(b64, qid, { confidence: 0.5 })
  if (result.type !== 'multi') throw new Error('九宫格分类未返回 multi 结果')
  deps.logger.info({ count: result.objects.length, round: 'multi' }, '九宫格识别完成，开始点选')
  for (const idx of result.objects) {
    await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
    await deps.page.waitForTimeout(2000)
    // 点击后格子可能刷新新小图（class 无 selected 即刷新）：小图二次识别决定是否再点
    for (let k = 0; k < SINGLE_RECHECK_MAX; k++) {
      const cls = (await tiles.nth(idx).getAttribute('class').catch(() => '')) ?? ''
      if (cls.includes('selected')) break
      const singleShot = await tiles.nth(idx).locator('img').first().screenshot({ type: 'png' }).catch(() => null)
      if (!singleShot) break
      const singleB64 = await toStandardBase64(singleShot, 100)
      const single = await deps.captcha.solveGrid(singleB64, qid, {})
      if (single.type === 'single' && single.hasObject) {
        await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
        await deps.page.waitForTimeout(2000)
        continue
      }
      break
    }
  }
  await ch.locator(VERIFY_SELECTOR).first().click({ timeout: 5000 }).catch(() => {})
  await deps.page.waitForTimeout(3000)
}

/**
 * 九宫格模拟点击求解主入口：
 * 点复选框 → 等挑战 → 循环（读提示语 → 分类 → 点选 → 验证 → 查 aria-checked）→ 变绿返回 solved
 * @returns 'none' 无锚点 frame；'solved' 通过；'failed' 轮数耗尽（提示语未覆盖等异常直接抛错）
 */
export async function solveRecaptchaGrid(
  deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer },
  opts: { maxRounds?: number } = {},
): Promise<'solved' | 'none' | 'failed'> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS
  const anchor = findAnchorFrame(deps.page)
  if (!anchor) return 'none'
  await anchor.locator(ANCHOR_SELECTOR).first().click({ timeout: 10000 }).catch(() => {})
  // 等挑战 frame 出现；期间锚点直接变绿即一键通过
  let challenge: Frame | null = null
  for (let i = 0; i < 30 && !challenge; i++) {
    await deps.page.waitForTimeout(500)
    challenge = findChallengeFrame(deps.page)
    if (!challenge) {
      const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
      if (checked === 'true') { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
    }
  }
  for (let round = 0; round < maxRounds; round++) {
    const ch = challenge ?? findChallengeFrame(deps.page)
    if (!ch) {
      const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
      return checked === 'true' ? 'solved' : 'failed'
    }
    await solveOneRound(deps, ch)
    const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
    if (checked === 'true') return 'solved'
    deps.logger.warn({ round: round + 1 }, '九宫格本轮未通过，继续下一轮')
    challenge = findChallengeFrame(deps.page)
    await deps.page.waitForTimeout(2000)
  }
  return 'failed'
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/recaptcha-grid.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/automation/recaptcha-grid.ts tests/recaptcha-grid.test.ts package.json package-lock.json
git commit -m "feat: reCAPTCHA 九宫格模拟点击求解模块（分类坐标点选）"
```

---

## Task 8: TaskContext 包装 + config 任务类型

**Files:**
- Modify: `src/engine/task-context.ts`
- Modify: `config/config.json`（taskTypes 增加 recaptcha_v2_grid）
- Modify: `tests/task-context-generic.test.ts`（追加包装方法测试）

**Interfaces:**
- Consumes: Task 7 的 `solveRecaptchaGrid`
- Produces: `TaskContext.solveRecaptchaGrid(opts?: { maxRounds?: number }): Promise<'none' | 'solved' | 'failed'>`（无 captcha 服务返回 'none'；注入 page/logger/human）

- [ ] **Step 1: 写失败的测试**

在 `tests/task-context-generic.test.ts` 追加：

```ts
it('solveRecaptchaGrid 无 captcha 服务 → none', async () => {
  const ctx = new TaskContext({ ...baseDeps() })
  await expect(ctx.solveRecaptchaGrid()).resolves.toBe('none')
})

it('solveRecaptchaGrid 注入 captcha 与页面并透传 maxRounds', async () => {
  const deps = baseDeps()
  deps.captcha = { solveGrid: vi.fn().mockResolvedValue({ type: 'multi', objects: [0] }) } as never
  const ctx = new TaskContext(deps)
  // fake page.frames 返回空 → 模块返回 none（验证包装传参链路）
  await expect(ctx.solveRecaptchaGrid({ maxRounds: 2 })).resolves.toBe('none')
})
```

（`baseDeps()` 按该文件既有 makeDeps 模式取用；page 需含 `frames: () => []` 与 `waitForTimeout`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/task-context-generic.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**

修改 `src/engine/task-context.ts`：

1. 顶部 import 追加（放在 turnstile import 之后）：

```ts
import { solveRecaptchaGrid as runRecaptchaGrid } from '../automation/recaptcha-grid'
```

2. 在 `autoClickTurnstile` 方法之后追加：

```ts
  /**
   * reCAPTCHA 九宫格模拟点击求解：点复选框 → 截图网格 → yescaptcha 分类 → 按坐标点选 → 验证，
   * 多轮循环直至 aria-checked=true（未注入打码服务返回 'none'，语义同 solveCaptcha）
   * @returns 'none' 无服务/无锚点 frame；'solved' 通过；'failed' 轮数耗尽
   * @throws 提示语未覆盖映射 / 分类失败（CaptchaFailure）
   */
  async solveRecaptchaGrid(opts?: { maxRounds?: number }): Promise<'none' | 'solved' | 'failed'> {
    if (!this.deps.captcha) return 'none'
    return runRecaptchaGrid({ page: this.page, captcha: this.deps.captcha, logger: this.turnstileLogger(), human: this.human }, opts)
  }
```

3. 修改 `config/config.json` 的 `captcha.taskTypes`，追加 `"recaptcha_v2_grid": "ReCaptchaV2Classification"`

- [ ] **Step 4: 运行确认通过 + 类型检查**

Run: `npx vitest run tests/task-context-generic.test.ts; npm run typecheck`
Expected: PASS + typecheck 退出码 0

- [ ] **Step 5: 提交**

```bash
git add src/engine/task-context.ts config/config.json tests/task-context-generic.test.ts
git commit -m "feat: TaskContext 包装九宫格求解 + 配置分类任务类型"
```

---

## Task 9: arc-faucet 接入新流程（TDD）

**Files:**
- Modify: `src/tasks/arc-faucet.ts`
- Modify: `tests/arc-faucet.test.ts`（单测 + 集成 fixture 挑战模式）

**Interfaces:**
- Consumes: Task 8 的 `ctx.solveRecaptchaGrid`
- Produces:
  - `V3_SITEKEY = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'`
  - `detectV2Challenge(ctx: TaskContext): Promise<boolean>`（主文档存在 anchor iframe 且 k ≠ V3_SITEKEY，或存在 bframe iframe）
  - `waitForOutcome` 扩展：轮询中并入挑战检测（每 2s 一次）
  - meta：timeoutSec `240` → `420`（网格多轮解题耗时）；note 更新

- [ ] **Step 1: 写失败的测试**

修改 `tests/arc-faucet.test.ts`：

1. import 追加 `detectV2Challenge, V3_SITEKEY`
2. makeCtx 的 page 增加 `evaluate` 假实现（`js` 通道）——`ctx.js` 调用 `page.evaluate(fn, undefined, {}, false)`，假实现直接执行 fn 并返回结果：

```ts
  const page = {
    locator: (sel: string) => ({ first: () => elems[sel] ?? blank }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getByText: (t: string) => ({ count: async () => (state.texts[t] ? 1 : 0) }),
    evaluate: (fn: () => unknown) => Promise.resolve(fn()),
  }
```

3. `FakeState` 增加 `v2Challenge?: boolean`；baseState 加 `v2Challenge: false`。新增单测：

```ts
describe('detectV2Challenge 挑战检测', () => {
  it('无挑战 → false', async () => {
    const { ctx } = makeCtx({ ...baseState(), v2Challenge: false })
    expect(await detectV2Challenge(ctx)).toBe(false)
  })

  it('存在 v2 anchor（k≠v3 sitekey）→ true', async () => {
    const { ctx } = makeCtx({ ...baseState(), v2Challenge: true })
    expect(await detectV2Challenge(ctx)).toBe(true)
  })
})
```

（detectV2Challenge 实现里把检测逻辑写成可注入形式：直接从 state.v2Challenge 读取——即 `ctx.js` 内的函数体在测试中不被执行，测试通过 evaluate 假实现直接控制返回。实现时用 `ctx.js` 包装 DOM 检测，测试里 evaluate 返回 state.v2Challenge。）

4. meta 契约测试更新：`expect(t.meta.timeoutSec).toBe(420)`

5. 集成 fixture（tests/fixtures/arc-faucet.html）增加 `mode=challenge` 分支：首次点击提交按钮后，追加 v2 文案 div + 插入 `<iframe src="/recaptcha/enterprise/anchor?k=6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve"></iframe>`（同源本地 server，由 server 返回空页面），保持按钮禁用；fixture 的 JS 监听 `window` message 事件，收到 `'grid-solved'` 后启用按钮。server 侧（tests/arc-faucet.test.ts beforeAll 的 createServer）对 `/recaptcha/enterprise/anchor` 路径返回：

```html
<!doctype html><html><body><div id="recaptcha-anchor" role="checkbox" aria-checked="false"></div>
<script>window.addEventListener('message', function (e) { if (e.data === 'grid-solved') { document.getElementById('recaptcha-anchor').setAttribute('aria-checked', 'true'); window.parent.postMessage('anchor-solved', '*') } })</script></body></html>
```

6. 新增集成用例（假 captcha：solveGrid 返回 `{ type: 'multi', objects: [0] }` 且记录调用；ctx 注入该 fake captcha）：

```ts
it('challenge 模式：v2 挑战 → 九宫格求解（假分类）→ 按钮恢复 → 再提交成功', async () => {
  // task.meta.url = baseUrl + '/?mode=challenge'
  // 断言：solveGrid 被调用 ≥1 次且 question 为映射后的 /m/ ID（fixture 提示语用「停车计时器」需 fixture bframe——为控制复杂度，本集成用例对 solveRecaptchaGrid 的 frame 交互不做真实模拟，改在 ctx 层注入可控制行为……）
}, 90000)
```

**实现者注意（控制器裁决）**：完整模拟 Google bframe 的跨源交互集成测试成本过高（需双 iframe fixture + 消息协议）。Task 9 集成测试的范围裁定为：**challenge 模式下，fake captcha.solveGrid 被调用、run 最终成功**。为此 fixture 的 challenge 模式再加一个 `<iframe src="/recaptcha/enterprise/bframe?hl=zh-CN">`，bframe fixture 页含提示语「停车计时器」+ 9 格 table + 验证按钮，验证按钮点击后向 anchor iframe postMessage('grid-solved')（两 iframe 同源，`window.parent.document.querySelector('iframe[src*="anchor"]').contentWindow.postMessage(...)`）；anchor 页收到后置 aria-checked=true 并 postMessage('anchor-solved') 给顶层，fixture 主页面监听后启用提交按钮。网格截图为本地 bframe 内容真实截图，经 jimp 缩放送 fake captcha（不校验图片内容）。这样全链路（点锚点 → 读提示语 → 截图分类 → 点格 → 验证 → aria-checked → 按钮恢复 → 再提交 → 成功文案）在集成层真实走通。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: FAIL（detectV2Challenge/V3_SITEKEY 未导出、meta timeoutSec 不符）

- [ ] **Step 3: 实现任务文件修改**

修改 `src/tasks/arc-faucet.ts`：

1. 常量区追加：

```ts
/** 常驻 v3 sitekey（页面加载即有，挑战检测时排除） */
export const V3_SITEKEY = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'
```

2. 追加挑战检测函数（waitForOutcome 之前）：

```ts
/** 检测 v2 挑战是否已渲染：主文档存在 anchor iframe 且 sitekey ≠ 常驻 v3，或已出现网格 bframe */
export async function detectV2Challenge(ctx: TaskContext): Promise<boolean> {
  return ctx.js(() => {
    const anchors = Array.from(document.querySelectorAll('iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="recaptcha/api2/anchor"]'))
    for (const el of anchors) {
      const m = (el.getAttribute('src') ?? '').match(/[?&]k=([^&]+)/)
      if (m && m[1] !== V3_SITEKEY) return true
    }
    return document.querySelector('iframe[src*="recaptcha/enterprise/bframe"], iframe[src*="recaptcha/api2/bframe"]') !== null
  })
}
```

3. `waitForOutcome` 轮询中并入挑战检测（每 2s 一次，避免每轮查 DOM）：

```ts
export async function waitForOutcome(ctx: TaskContext, timeoutMs: number): Promise<'success' | 'captcha' | null> {
  const end = Date.now() + timeoutMs
  let lastCheck = 0
  while (Date.now() < end) {
    if (await ctx.textPresent(SUCCESS_TEXT)) return 'success'
    if (await ctx.textPresent(CAPTCHA_V2_TEXT)) return 'captcha'
    if (Date.now() - lastCheck >= 2000 && (await detectV2Challenge(ctx))) return 'captcha'
    lastCheck = Date.now()
    await ctx.page.waitForTimeout(1000)
  }
  return null
}
```

4. `runArcFaucet` 的挑战分支改为九宫格路线：

```ts
  let outcome = await submitAndWait(ctx)
  if (outcome === 'captcha') {
    ctx.log.info({ step: 'faucet', window: ctx.profile.name }, '检测到 v2 挑战，走九宫格模拟点击')
    const grid = await ctx.solveRecaptchaGrid()
    if (grid === 'failed') throw new Error('九宫格模拟点击失败（多轮未通过）')
    // widget 完成后站点恢复提交按钮；再提交一次
    await ensureSubmitEnabled(ctx)
    outcome = await submitAndWait(ctx)
  }
  if (outcome !== 'success') throw new Error(`提交后 ${SUBMIT_RACE_MS}ms 内未出现成功文案（v2 挑战也未出现）`)
```

5. meta：timeoutSec 改为 `420`（注释「网格多轮解题 + 页面流程耗时」）；note 改为：

```
'真机核实（2026-09-09 rev2）：挑战为 reCAPTCHA Enterprise v2 复选框（sitekey 6LcCqC8s，页面另常驻 v3 6LcNs_0p）；挑战出现后提交按钮禁用直到 widget 完成——token 注入路线不可行（yescaptcha 官方：协议接口非 100% 通过），改走 ReCaptchaV2Classification 九宫格模拟点击（点复选框 → 截图网格 → 分类坐标 → 点选 → 验证 → aria-checked 循环，图片点完 100% 通过）；提示语映射覆盖常见 16+ 类（中英），未覆盖提示语任务失败；限频每资产×网络 1-2 小时一次且失败请求也计数（不做判定，用户隔天执行）；不连钱包，地址取自数据源「metamask钱包地址」列'
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/arc-faucet.test.ts`
Expected: PASS（全部单测 + 3 个集成用例）

- [ ] **Step 5: 提交**

```bash
git add src/tasks/arc-faucet.ts tests/arc-faucet.test.ts tests/fixtures/arc-faucet.html
git commit -m "feat: Arc 领水接入九宫格模拟点击验证码路线（rev2）"
```

---

## Task 10: 全量验证 + 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md`
- Modify: `docs/TASK-DEVELOPMENT-LESSONS.md`

**Interfaces:**
- Consumes: Task 6-9 全部产物

- [ ] **Step 1: 全量验证**

Run: `npm test; npm run typecheck`
Expected: 全量通过（预计 525+，新增 captcha 5 + grid 8 + task-context 2 + arc-faucet 若干）、typecheck 干净

- [ ] **Step 2: API-GUIDE 同步**

1. 第 3 章 TaskContext 方法表追加一行（放 solveCaptcha 之后）：

```markdown
| `solveRecaptchaGrid(opts?)` | `Promise<'none' \| 'solved' \| 'failed'>` | reCAPTCHA 九宫格模拟点击求解（点复选框 → 截图网格 → yescaptcha 分类 → 按坐标点选 → 验证 → 多轮循环至 aria-checked=true）；无打码服务返回 `none`；提示语未覆盖映射抛错。`opts.maxRounds` 最大轮数（默认 5） |
```

2. 9.1 配置表 captcha 段补充：`taskTypes` 支持键增加 `recaptcha_v2_grid`（`ReCaptchaV2Classification`，九宫格分类识别，6 点/次；图片需缩放至 300x300/450x450/100x100）

3. 第 2 章若提到验证码类型说明，同步提及新增类型（如无专门小节则跳过，仅上述两处）

- [ ] **Step 3: LESSONS 追加**

`docs/TASK-DEVELOPMENT-LESSONS.md` 追加「Arc 领水（faucet-arc，2026-09-09）」条目，内容：
- 挑战是 reCAPTCHA Enterprise（`recaptcha/enterprise/anchor`），项目检测器只认 `api2/anchor` → 检测失败的排查路径（captcha_logs 空表 + 页面 iframe 抓取）
- 站点挑战期禁用提交按钮、等 widget 回调才恢复 → token 注入 + 强制提交不可靠（官方 FAQ：协议接口非 100% 通过；分类模拟点击 100%）
- 九宫格路线要点：锚点 `#recaptcha-anchor`、提示语 `.rc-imageselect-desc-wrapper strong`、格子 `#rc-imageselect-target table td`、验证 `#recaptcha-verify-button`、通过判定 anchor `aria-checked="true"`；跨源 iframe 用 frame.locator 可正常操作（patchright/CDP 无同源限制）
- 提示语→问题 ID 映射仅覆盖常见 16+ 类，未覆盖时任务失败——扩充映射的方法（失败日志会带提示语原文）
- 限频计数含失败请求（探针反复点 Send 耗尽窗口 100 当日额度）——验证前注意请求次数

- [ ] **Step 4: 提交**

```bash
git add docs/API-GUIDE.md docs/TASK-DEVELOPMENT-LESSONS.md
git commit -m "docs: 九宫格求解 TaskContext 方法与 Arc 领水真机经验"
```

---

## Task 11: 真机验证（一次 task:run）

**Files:**
- 无代码改动（失败则回 Task 9 修，验证结论写 LESSONS 补充提交）

- [ ] **Step 1: 查窗口当日请求状态**

Run（PowerShell）:
```powershell
node -e "const {createClient}=require('@libsql/client');(async()=>{const db=createClient({url:'file:data/app.db'});const r=await db.execute(\"select profile_id,status,started_at from runs where task_key='faucet-arc' order by id desc limit 5\");console.log(JSON.stringify(r.rows))})().catch(e=>console.error(e.message))"
```
Expected: 确认窗口 100（profile 内部 id 与其 bitbrowser id 对应关系从 profiles 表查）距上次请求是否已过 2 小时；若未冷却，向用户报告并请用户指定替换窗口（**不擅自换窗口**）

- [ ] **Step 2: 一次 task:run 验证**

Run（PowerShell）:
```powershell
$env:BITBROWSER_PROFILE_ID="<窗口ID>"
$env:TASK_KEY="faucet-arc"
npm run task:run
```
Expected（观察点）：
1. 日志出现「检测到 v2 挑战，走九宫格模拟点击」
2. 日志出现「九宫格识别目标」带提示语与 qid；「九宫格识别完成，开始点选」
3. 任务终态 success + 成功截图（`data/screenshots/<日期>/<窗口>/faucet-arc/arc-faucet-success.png`）
4. 若提示语未覆盖 → 失败日志带原文，回 Task 9 补映射（追加 QUESTION_ID_MAP + 单测）后重跑一次
5. 若连续 2 次失败或 10 分钟无进展 → 停止，带日志+截图请求用户人工介入

- [ ] **Step 3: 提交验证结论**

验证成功：LESSONS 条目更新为「真机通过（窗口 X）」，提交 `docs: Arc 领水真机验证通过`；失败则如实记录并修复。

---

## Self-Review 记录

1. **Spec coverage**：rev2 spec 七节改动清单全部有对应任务——yescaptcha（Task 6）、grid 模块（Task 7）、TaskContext+config（Task 8）、任务接入（Task 9）、测试（Task 6-9）、文档（Task 10）、真机（Task 11）。
2. **Placeholder scan**：Task 7 测试骨架注明了实现者可微调假 frame 结构但断言语义固定（防呆）；Task 9 集成 fixture 的跨 iframe 消息协议给出完整设计；无 TBD。
3. **Type consistency**：`GridResult` 定义于 Task 6、使用于 Task 7/8；`solveRecaptchaGrid` 返回三态在 Task 7 定义、Task 8/9 使用一致；`V3_SITEKEY` 值在 Global Constraints、Task 9 实现与集成 fixture 中一致（6LcCqC8s 为 v2）。

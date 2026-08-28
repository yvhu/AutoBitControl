# AutoBitControl 文档化与标准化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已交付的 AutoBitControl 上完成四件事：D 全项目分层重构（模块化+统一封装+RESTful+前后端分离）、B 任务元信息扩展、C API 手册+文档型示例并上线面板「文档」页、A 全代码中文注释。

**Architecture:** 六层单向依赖 `tasks → engine → {integrations, automation} → infrastructure`，`server → {engine, infrastructure}`，`app.ts` 组装根。统一 http 封装（infrastructure/http.ts）、统一 API 响应 envelope、前端模块化（api.js/app.js/views/*）。

**Tech Stack:** 既有栈不变（Node 20 / TS strict / patchright / ghost-cursor / express / better-sqlite3 / vitest）；新增 `marked`（仅用于面板渲染手册，vendored 本地文件，无运行时 npm 依赖）。

**Spec:** `docs/superpowers/specs/2026-08-28-docs-examples-standardization-design.md`

## Global Constraints

- 仓库 `D:\StudySpace\AutoBitControl`，分支 develop，Windows PowerShell 5.1
- 每步结束必须 `npm test` 全绿 + `npm run typecheck` 干净（typecheck 脚本已存在）
- 依赖方向规则：`tasks → engine → {integrations, automation} → infrastructure`；`server → {engine, infrastructure}`；禁止下层 import 上层。tasks 层允许对下层做 **type-only import**（`import type`），运行时依赖仅来自 engine 注入
- 从现在起**代码中文注释是要求**（用户明确要求，推翻旧的"不加注释"约束）：文件头/类/方法/关键变量（详细规范见 Task 6）
- 现有行为不变原则：重构只改结构与路径，不改变任何运行时行为（Bug 修复除外，需在报告注明）
- 每个 Task 一个或多个 commit，commit message 见各任务
- 日志/文案/UI 中文

## 文件移动总表（Task 1 使用）

| 原路径 | 新路径 |
|---|---|
| src/core/config.ts | src/infrastructure/config.ts |
| src/core/logger.ts | src/infrastructure/logger.ts |
| src/core/db.ts | src/infrastructure/db.ts |
| src/core/bitbrowser.ts | src/integrations/bitbrowser.ts |
| src/core/captcha.ts | src/integrations/yescaptcha.ts |
| src/core/humanize.ts | src/automation/humanize.ts |
| src/core/wallet/types.ts | src/automation/wallet/types.ts |
| src/core/wallet/popup.ts | src/automation/wallet/popup.ts |
| src/core/wallet/metamask.ts | src/automation/wallet/metamask.ts |
| src/core/wallet/petra.ts | src/automation/wallet/petra.ts |
| src/core/state.ts | src/engine/state.ts |
| src/core/queue.ts | src/engine/queue.ts |
| src/core/scheduler.ts | src/engine/scheduler.ts |
| src/core/windowRunner.ts | src/engine/window-runner.ts |
| src/tasks/*（不动目录） | src/tasks/* |
| src/web/server.ts | src/server/app.ts（拆解重写，见 Task 2） |
| src/web/public/* | src/server/public/*（前端拆分重写，见 Task 3） |
| src/index.ts | 拆为 src/app.ts（组装根）+ src/index.ts（入口） |

**import 更新规则**（相对路径，无扩展名）：
- 任何文件 import 原 `./core/*` 或 `../core/*` 的目标：按新层级重写相对路径（engine 内文件 import infrastructure 用 `../infrastructure/x`，import 同层用 `./x`）
- `import { chromium, type Browser, type Page } from 'patchright'` 保持
- tests/ 下所有 import 前缀改为新路径（如 `../src/core/config` → `../src/infrastructure/config`）
- scripts/ 同改
- 机械路径错误由 `npm run typecheck` 兜底发现，实现者修到干净为止

---

### Task 1: 分层移动（infrastructure/integrations/automation/engine）

**Files:**
- Move: 按上表移动 15 个文件（`git mv`，git 保留历史）
- Create: `src/infrastructure/http.ts`、`tests/http.test.ts`
- Modify: `src/integrations/bitbrowser.ts`、`src/integrations/yescaptcha.ts`（改用统一 http）、全部受影响文件的 import、tests/ 与 scripts/ 的 import

**Interfaces:**
- Produces: `httpJson<T>(opts: { baseUrl: string; path: string; method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; timeoutMs?: number }): Promise<T>`、`HttpError`（含 status、message）；`src/infrastructure/http.ts`（Task 2 的 server 层不直接用，但 Task 1 的集成层用它）

- [ ] **Step 1: git mv 15 个文件 + 修复全部 import**

```powershell
git mv src/core/config.ts src/infrastructure/config.ts
git mv src/core/logger.ts src/infrastructure/logger.ts
git mv src/core/db.ts src/infrastructure/db.ts
git mv src/core/bitbrowser.ts src/integrations/bitbrowser.ts
git mv src/core/captcha.ts src/integrations/yescaptcha.ts
git mv src/core/humanize.ts src/automation/humanize.ts
git mv src/core/state.ts src/engine/state.ts
git mv src/core/queue.ts src/engine/queue.ts
git mv src/core/scheduler.ts src/engine/scheduler.ts
git mv src/core/windowRunner.ts src/engine/window-runner.ts
git mv src/core/wallet src/automation/wallet
```

按 import 更新规则逐一改（engine/scheduler.ts、engine/window-runner.ts、tasks/base.ts、tasks/index.ts、tests/*、scripts/*）。验证：`npm run typecheck` 干净、`npm test` 全绿。此时不新增任何功能。

- [ ] **Step 2: 写失败测试 tests/http.test.ts**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { httpJson, HttpError } from '../src/infrastructure/http'

afterEach(() => { vi.unstubAllGlobals() })

describe('httpJson', () => {
  it('POST JSON 并解析响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://x.io/api/ping')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
      expect(JSON.parse(String(init.body))).toEqual({ a: 1 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))
    const r = await httpJson<{ ok: boolean }>({ baseUrl: 'http://x.io', path: '/api/ping', method: 'POST', body: { a: 1 } })
    expect(r.ok).toBe(true)
  })

  it('非 2xx 抛 HttpError 含状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 502 })))
    await expect(httpJson({ baseUrl: 'http://x.io', path: '/x' })).rejects.toSatisfy((e: Error) => e instanceof HttpError && (e as HttpError).status === 502)
  })

  it('JSON 解析失败抛 HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>err</html>', { status: 200 })))
    await expect(httpJson({ baseUrl: 'http://x.io', path: '/x' })).rejects.toBeInstanceOf(HttpError)
  })

  it('GET 不带 body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
      return new Response(JSON.stringify({}), { status: 200 })
    }))
    await httpJson({ baseUrl: 'http://x.io', path: '/x' })
  })
})
```

- [ ] **Step 3: 实现 src/infrastructure/http.ts**

```ts
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface HttpJsonOptions {
  baseUrl: string
  path: string
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  timeoutMs?: number
  headers?: Record<string, string>
}

export async function httpJson<T>(opts: HttpJsonOptions): Promise<T> {
  const method = opts.method ?? 'GET'
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  if (opts.timeoutMs !== undefined) init.signal = AbortSignal.timeout(opts.timeoutMs)
  let res: Response
  try {
    res = await fetch(`${opts.baseUrl}${opts.path}`, init)
  } catch (e) {
    throw new HttpError(0, `请求失败: ${(e as Error).message}`)
  }
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`)
  try {
    return (await res.json()) as T
  } catch (e) {
    throw new HttpError(res.status, `响应解析失败: ${(e as Error).message}`)
  }
}
```

- [ ] **Step 4: 改造 bitbrowser.ts 与 yescaptcha.ts 使用 httpJson**

`src/integrations/bitbrowser.ts`：`private post` 改为：

```ts
  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const json = await httpJson<BitBrowserResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: this.cfg.timeoutMs })
    const ok = json.success === true || json.code === 0
    if (!ok) throw new Error(`比特浏览器 API 失败: ${path} ${json.msg ?? `code=${json.code}`}`)
    return (json.data ?? {}) as Record<string, unknown>
  }
```

其余方法（health/openBrowser/closeBrowser/listBrowsers）逻辑不变。`health()` 捕 HttpError 返回 false 的行为保持不变（其 catch 已捕获 Error）。

`src/integrations/yescaptcha.ts`：`private async call` 改为：

```ts
  private async call(path: string, body: unknown): Promise<YesCaptchaResp> {
    return httpJson<YesCaptchaResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: 30000 })
  }
```

其余（创建任务/轮询/串行队列/检测器/CaptchaService）不变。

- [ ] **Step 5: 全量验证 + Commit**

```powershell
npm test
npm run typecheck
git add -A
git commit -m "refactor: layer project into infrastructure/integrations/automation/engine with unified http client"
```

---

### Task 2: Server API 层重构（envelope + RESTful 路由分模块）

**Files:**
- Create: `src/server/http/response.ts`、`src/server/http/error.ts`、`src/server/routes/dashboard.ts`、`src/server/routes/tasks.ts`、`src/server/routes/profiles.ts`、`src/server/routes/runs.ts`、`src/server/routes/captcha.ts`、`src/server/routes/bitbrowser.ts`、`src/server/routes/screenshots.ts`、`src/server/app.ts`
- Delete: `src/web/server.ts`
- Modify: `tests/web.test.ts`（全面改写为新路由与 envelope）、`src/app.ts` 与 `src/index.ts` 的 createApp 装配（Task 1 已拆出的 app.ts 中调用处同步）

**Interfaces:**
- Consumes: `httpJson`/`HttpError` 不需要；db/engine/tasks 类型从新路径 import
- Produces: `createApp(deps: ServerDeps): express.Express`；`ok(res, data)`、`fail(res, status, code, message)`、`asyncHandler(fn)`、`HttpError`(server 版)与错误中间件（Task 3/4/5 依赖）

- [ ] **Step 1: 写失败测试 tests/web.test.ts（全面改写）**

```ts
import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server/app'

function makeDeps() {
  return {
    db: {
      listRunsForDate: vi.fn().mockReturnValue([
        { id: 1, profileId: 1, taskKey: 't1', date: '2026-08-28', status: 'success', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口1' },
        { id: 2, profileId: 1, taskKey: 't2', date: '2026-08-28', status: 'failed', attempts: 2, error: 'boom', screenshot: 's.png', startedAt: null, finishedAt: null, profileName: '窗口1' },
      ]),
      listProfiles: vi.fn().mockReturnValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 1 }]),
      captchaStats: vi.fn().mockReturnValue({ count: 5, totalCost: 230 }),
      setProfileEnabled: vi.fn(),
      setProfileWalletPassword: vi.fn(),
      resetCircuitBreaker: vi.fn(),
    } as never,
    enqueuer: { enqueue: vi.fn() } as never,
    tasks: new Map([['t1', { meta: { key: 't1', name: '任务1', url: '', wallet: 'metamask', schedule: '0 9 * * *' } }]]),
    cfg: { web: { port: 3000 }, storage: { screenshotDir: 'D:/StudySpace/AutoBitControl/data/screenshots' } } as never,
    bitbrowser: { health: vi.fn().mockResolvedValue(true) },
    captchaBalance: vi.fn().mockResolvedValue({ points: 98210 }),
  }
}

describe('server API（RESTful + envelope）', () => {
  it('GET /api/dashboard 返回 {code:0,data:{stats,runs,profiles,...}}', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/dashboard?date=2026-08-28')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.stats.success).toBe(1)
    expect(res.body.data.stats.failed).toBe(1)
    expect(res.body.data.runs).toHaveLength(2)
    expect(res.body.data.captcha.totalCost).toBe(230)
  })

  it('GET /api/tasks 返回任务元信息列表', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    expect(res.body.data[0].key).toBe('t1')
    expect(res.body.data[0].wallet).toBe('metamask')
  })

  it('POST /api/tasks/:key/trigger 入队', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ bitbrowserId: 'bb-1' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(deps.enqueuer.enqueue).toHaveBeenCalled()
  })

  it('POST /api/tasks/:key/trigger 缺参数 404 或 400', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/tasks/nope/trigger').send({})
    expect([400, 404]).toContain(res.status)
    expect(res.body.code).not.toBe(0)
  })

  it('PATCH /api/profiles/:id 修改启用状态', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/profiles/1').send({ enabled: false })
    expect(res.body.code).toBe(0)
    expect(deps.db.setProfileEnabled).toHaveBeenCalledWith(1, false)
  })

  it('PATCH /api/profiles/:id 保存钱包密码', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).patch('/api/profiles/1').send({ password: 'secret' })
    expect(res.body.code).toBe(0)
    expect(deps.db.setProfileWalletPassword).toHaveBeenCalledWith(1, 'secret')
  })

  it('POST /api/profiles/:id/run 入队全部任务', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/1/run')
    expect(res.body.code).toBe(0)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 't1')
  })

  it('POST /api/profiles/:id/breaker/reset 重置熔断', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/profiles/1/breaker/reset')
    expect(res.body.code).toBe(0)
    expect(deps.db.resetCircuitBreaker).toHaveBeenCalledWith(1)
  })

  it('POST /api/runs/rerun-failed 重跑失败', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/runs/rerun-failed').send({ date: '2026-08-28' })
    expect(res.body.code).toBe(0)
    expect(res.body.data.count).toBe(1)
    expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
  })

  it('POST /api/bitbrowser/test 返回连接状态', async () => {
    const res = await request(createApp(makeDeps() as never)).post('/api/bitbrowser/test')
    expect(res.body.code).toBe(0)
    expect(res.body.data.ok).toBe(true)
  })

  it('GET /api/captcha/balance 返回点数', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/captcha/balance')
    expect(res.body.code).toBe(0)
    expect(res.body.data.points).toBe(98210)
    expect(res.body.data.yuan).toBeCloseTo(98.21)
  })

  it('GET /api/screenshots 拒绝目录穿越', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/screenshots').query({ path: 'C:/windows/win.ini' })
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
  })

  it('GET / 返回面板页面', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('AutoBitControl')
  })

  it('未知路由 404 统一 envelope', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/no-such')
    expect(res.status).toBe(404)
    expect(res.body.code).not.toBe(0)
    expect(res.body.message).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（`../src/server/app` 不存在）

- [ ] **Step 3: 实现 src/server/http/response.ts 与 error.ts**

`response.ts`：

```ts
import type { RequestHandler, Response } from 'express'

export function ok(res: Response, data: unknown = null): void {
  res.json({ code: 0, message: 'ok', data })
}

export function fail(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ code, message, data: null })
}

export function asyncHandler(fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}
```

`error.ts`：

```ts
import type { ErrorRequestHandler, RequestHandler } from 'express'
import type { Logger } from '../../infrastructure/logger'
import { fail } from './response'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    fail(res, 404, 404, `接口不存在: ${req.method} ${req.path}`)
  }
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : 500
    if (status >= 500) logger.error({ err: err.message, path: req.path }, '接口异常')
    fail(res, status, status, err instanceof HttpError ? err.message : '服务器内部错误')
  }
}
```

- [ ] **Step 4: 实现 7 个路由文件**

`routes/dashboard.ts`：

```ts
import { Router } from 'express'
import { todayStr, type AppDb, type RunStatus } from '../../infrastructure/db'
import type { SiteTask } from '../../tasks/base'
import { ok, asyncHandler } from '../http/response'

const COUNTED: RunStatus[] = ['success', 'failed', 'captcha_failed', 'skipped', 'running', 'retry_wait', 'pending']

export function dashboardRouter(deps: { db: AppDb; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  router.get('/dashboard', asyncHandler(async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : todayStr()
    const runs = deps.db.listRunsForDate(date)
    const count = (s: RunStatus) => runs.filter(r => r.status === s).length
    const profiles = deps.db.listProfiles(false)
    ok(res, {
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
      profiles,
      captcha: deps.db.captchaStats(date),
      profilesTotal: profiles.length,
      profilesEnabled: profiles.filter(p => p.enabled === 1).length,
    })
  }))
  return router
}
```

`routes/tasks.ts`：

```ts
import { Router } from 'express'
import { ok, fail, asyncHandler } from '../http/response'
import { HttpError } from '../http/error'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

export function tasksRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  router.get('/tasks', (req, res) => {
    ok(res, [...deps.tasks.values()].map(t => ({
      key: t.meta.key,
      name: t.meta.name,
      url: t.meta.url,
      sourceUrl: t.meta.sourceUrl ?? null,
      note: t.meta.note ?? null,
      category: t.meta.category ?? null,
      lastUpdated: t.meta.lastUpdated ?? null,
      deprecated: t.meta.deprecated ?? false,
      wallet: t.meta.wallet ?? null,
      schedule: t.meta.schedule ?? null,
      timeoutSec: t.meta.timeoutSec ?? null,
      retry: t.meta.retry ?? null,
      captcha: t.meta.captcha ?? null,
    })))
  })
  router.post('/tasks/:key/trigger', asyncHandler(async (req, res) => {
    const key = req.params.key
    if (!deps.tasks.has(key)) throw new HttpError(404, `任务不存在: ${key}`)
    const { bitbrowserId } = req.body as { bitbrowserId?: string } ?? {}
    if (bitbrowserId) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.bitbrowserId === bitbrowserId)
      if (!profile) throw new HttpError(404, `窗口不存在: ${bitbrowserId}`)
      deps.enqueuer.enqueue(profile, key)
      ok(res, { scope: 'single' })
      return
    }
    for (const p of deps.db.listProfiles(true)) deps.enqueuer.enqueue(p, key)
    ok(res, { scope: 'all' })
  }))
  return router
}
```

`routes/profiles.ts`：

```ts
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError } from '../http/error'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'

export function profilesRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  const find = (id: number): ProfileRow => {
    const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === id)
    if (!profile) throw new HttpError(404, `窗口不存在: ${id}`)
    return profile
  }
  router.get('/profiles', (req, res) => {
    ok(res, deps.db.listProfiles(false))
  })
  router.patch('/profiles/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const profile = find(id)
    const body = req.body as { enabled?: boolean; password?: string | null } ?? {}
    if (typeof body.enabled === 'boolean') deps.db.setProfileEnabled(id, body.enabled)
    if (body.password !== undefined) deps.db.setProfileWalletPassword(id, body.password)
    ok(res, profile)
  }))
  router.post('/profiles/:id/run', asyncHandler(async (req, res) => {
    const profile = find(Number(req.params.id))
    for (const task of deps.tasks.values()) deps.enqueuer.enqueue(profile, task.meta.key)
    ok(res, { count: deps.tasks.size })
  }))
  router.post('/profiles/:id/breaker/reset', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    find(id)
    deps.db.resetCircuitBreaker(id)
    ok(res)
  }))
  return router
}
```

`routes/runs.ts`：

```ts
import { Router } from 'express'
import { todayStr, type AppDb, type ProfileRow } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import { ok, asyncHandler } from '../http/response'

export function runsRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer }): Router {
  const router = Router()
  router.post('/runs/rerun-failed', asyncHandler(async (req, res) => {
    const date = typeof req.body?.date === 'string' ? req.body.date : todayStr()
    const failed = deps.db.listRunsForDate(date).filter(r => r.status === 'failed' || r.status === 'captcha_failed')
    for (const r of failed) {
      const profile = deps.db.listProfiles(false).find((p: ProfileRow) => p.id === r.profileId)
      if (profile) deps.enqueuer.enqueue(profile, r.taskKey)
    }
    ok(res, { count: failed.length })
  }))
  return router
}
```

`routes/captcha.ts`：

```ts
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'

export function captchaRouter(deps: { captchaBalance: () => Promise<{ points: number } | null> }): Router {
  const router = Router()
  router.get('/captcha/balance', asyncHandler(async (req, res) => {
    const balance = await deps.captchaBalance()
    if (balance === null) {
      ok(res, { configured: false, points: 0, yuan: 0 })
      return
    }
    ok(res, { configured: true, points: balance.points, yuan: Number((balance.points / 1000).toFixed(2)) })
  }))
  return router
}
```

`routes/bitbrowser.ts`：

```ts
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'

export function bitbrowserRouter(deps: { health: () => Promise<boolean> }): Router {
  const router = Router()
  router.post('/bitbrowser/test', asyncHandler(async (req, res) => {
    ok(res, { ok: await deps.health() })
  }))
  return router
}
```

`routes/screenshots.ts`：

```ts
import { Router } from 'express'
import { resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import type { AppConfig } from '../../infrastructure/config'
import { fail, asyncHandler } from '../http/response'

export function screenshotsRouter(deps: { cfg: AppConfig }): Router {
  const router = Router()
  router.get('/screenshots', asyncHandler(async (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : ''
    const root = resolve(deps.cfg.storage.screenshotDir)
    const target = resolve(p)
    if (!target.startsWith(root + sep) || !existsSync(target)) {
      fail(res, 404, 404, '截图不存在')
      return
    }
    res.sendFile(target)
  }))
  return router
}
```

- [ ] **Step 5: 实现 src/server/app.ts**

```ts
import express from 'express'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppDb } from '../infrastructure/db'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { CoalescingEnqueuer } from '../engine/queue'
import type { SiteTask } from '../tasks/base'
import { dashboardRouter } from './routes/dashboard'
import { tasksRouter } from './routes/tasks'
import { profilesRouter } from './routes/profiles'
import { runsRouter } from './routes/runs'
import { captchaRouter } from './routes/captcha'
import { bitbrowserRouter } from './routes/bitbrowser'
import { screenshotsRouter } from './routes/screenshots'
import { notFoundHandler, errorHandler } from './http/error'

export interface ServerDeps {
  db: AppDb
  enqueuer: CoalescingEnqueuer
  tasks: Map<string, SiteTask>
  cfg: AppConfig
  logger: Logger
  bitbrowser: { health(): Promise<boolean> }
  captchaBalance: () => Promise<{ points: number } | null>
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express()
  app.use(express.json())

  const api = express.Router()
  api.use(dashboardRouter({ db: deps.db, tasks: deps.tasks }))
  api.use(tasksRouter(deps))
  api.use(profilesRouter(deps))
  api.use(runsRouter(deps))
  api.use(captchaRouter(deps))
  api.use(bitbrowserRouter(deps))
  api.use(screenshotsRouter(deps))
  app.use('/api', api)

  app.use(notFoundHandler())
  app.use(errorHandler(deps.logger))

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public')
  app.use(express.static(publicDir))
  return app
}
```

注意：`notFoundHandler` 必须放在 `express.static` 之前（静态资源匹配不中才 404），但静态目录需在 404 处理之前挂载——调整为：先 `app.use(express.static(publicDir))`，再 `/api` 的 404 处理 `app.use('/api', notFoundHandler())`，最后 `app.use(errorHandler(logger))`。实现时按此顺序。

- [ ] **Step 6: 更新 src/app.ts 装配调用**

`createApp({ db, enqueuer, tasks, cfg, logger, bitbrowser, captchaBalance })`（logger 为新增必传项；import 路径改为 `./server/app`）。

- [ ] **Step 7: 删除 src/web/server.ts、全量验证 + Commit**

```powershell
Remove-Item src/web/server.ts
npm test
npm run typecheck
git add -A
git commit -m "refactor: RESTful modular server routes with unified response envelope"
```

（src/web/public 的拆分在 Task 3 处理，本步可保留原位让静态托管继续工作。）

---

### Task 3: 前端模块化拆分（index.html 零内联 + api.js/app.js/views + docs 骨架）

**Files:**
- Create: `src/server/public/css/app.css`、`src/server/public/js/api.js`、`src/server/public/js/app.js`、`src/server/public/js/views/dashboard.js`、`src/server/public/js/views/profiles.js`、`src/server/public/js/views/tasks.js`、`src/server/public/js/views/settings.js`
- Modify: `src/server/public/index.html`（改为纯结构 + module 入口）
- （docs.js 视图与 vendor/marked 在 Task 5）

**Interfaces:**
- Produces: `api.js` 导出 `get(path)`、`post(path, body)`、`patch(path, body)`（返回 envelope 的 data，code!==0 抛错并 alert）；`app.js` 导出 `state` 与 `navigate(page)`；各 view 模块导出 `render(deps)`（Task 5 的 docs 视图同模式）

- [ ] **Step 1: 写 src/server/public/css/app.css**

将现有 index.html 中 `<style>...</style>` 的**全部内容原样**移入，并追加 docs 页样式（后续 Task 5 用到，可先行）：

```css
  .doc-layout { display: flex; gap: 16px; }
  .doc-side { width: 220px; flex-shrink: 0; }
  .doc-content { flex: 1; min-width: 0; }
  .doc-tab { padding: 8px 14px; border-radius: 10px; cursor: pointer; color: #94A3B8; font-size: 13px; margin-bottom: 4px; }
  .doc-tab.on { background: linear-gradient(90deg,rgba(99,102,241,.18),rgba(139,92,246,.08)); color: #E2E8F0; font-weight: 600; }
  .doc-md { font-size: 13px; line-height: 1.9; }
  .doc-md h1 { font-size: 20px; margin: 14px 0 8px; }
  .doc-md h2 { font-size: 17px; margin: 18px 0 8px; border-bottom: 1px solid rgba(255,255,255,.08); padding-bottom: 6px; }
  .doc-md h3 { font-size: 14px; margin: 12px 0 6px; }
  .doc-md code { background: #151D30; border: 1px solid rgba(255,255,255,.08); border-radius: 5px; padding: 1px 6px; font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; color: #A5B4FC; }
  .doc-md pre { background: #0D1424; border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 12px; overflow-x: auto; margin: 8px 0; }
  .doc-md pre code { background: none; border: 0; padding: 0; color: #E2E8F0; }
  .doc-md table { border-collapse: collapse; margin: 8px 0; }
  .doc-md th, .doc-md td { border: 1px solid #334155; padding: 4px 10px; font-size: 12px; }
  .doc-md blockquote { border-left: 3px solid #6366F1; margin: 8px 0; padding: 2px 12px; color: #94A3B8; }
  .code-view { background: #0D1424; border: 1px solid rgba(255,255,255,.08); border-radius: 10px; overflow: hidden; }
  .code-line { display: flex; font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; line-height: 1.7; }
  .code-line:hover { background: rgba(255,255,255,.03); }
  .code-num { width: 44px; text-align: right; padding-right: 12px; color: #475569; user-select: none; flex-shrink: 0; }
  .code-text { white-space: pre; color: #E2E8F0; }
```

- [ ] **Step 2: 实现 js/api.js**

```js
async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const json = await res.json().catch(() => ({ code: res.status, message: '响应解析失败', data: null }))
  if (json.code !== 0) {
    console.error(`API 错误 [${json.code}] ${json.message}`)
    throw new Error(json.message)
  }
  return json.data
}

export function get(path) { return request(path) }
export function post(path, body) { return request(path, { method: 'POST', body }) }
export function patch(path, body) { return request(path, { method: 'PATCH', body }) }
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) }
```

- [ ] **Step 3: 实现 js/views/dashboard.js**

（将现有 index.html 中 dashboard 相关函数迁移并适配新 api.js：`loadDashboard`/`renderMatrix`/`triggerAll`/`rerunOne`/`rerunFailed` 保留原逻辑；`data.tasks` 改由 `get('/api/tasks')` 获取——GET /api/dashboard 不再返回 tasks；`openImage` 路径改为 `/api/screenshots?path=`）

```js
import { get, post, esc } from '../api.js'

export const state = { filter: 'all', taskFilter: '', profileSearch: '' }

const PILLS = {
  success: ['ok', '成功'], failed: ['fail', '失败'], captcha_failed: ['cap', '验证码失败'],
  running: ['run', '执行中'], retry_wait: ['run', '重试中'], skipped: ['skip', '跳过'], pending: ['skip', '待执行'],
}

function openImage(path) { window.open('/api/screenshots?path=' + encodeURIComponent(path), '_blank') }

export async function render({ date, setTasks }) {
  const data = await get('/api/dashboard?date=' + date)
  if (setTasks) setTasks(await get('/api/tasks'))
  const s = data.stats
  const done = s.success + s.failed + s.captchaFailed + s.skipped
  const pct = s.total ? Math.round(done / s.total * 100) : 0
  document.querySelector('#ring-complete').style.setProperty('--p', pct)
  document.querySelector('#ring-text').textContent = pct + '%'
  document.querySelector('#stat-complete').textContent = `${done} / ${s.total}`
  document.querySelector('#st-ok').textContent = s.success
  document.querySelector('#st-fail').textContent = s.failed
  document.querySelector('#st-cap').textContent = s.captchaFailed
  document.querySelector('#st-skip').textContent = s.skipped
  document.querySelector('#st-running').textContent = s.running
  document.querySelector('#st-profiles').textContent = `窗口 ${data.profilesTotal} / 启用 ${data.profilesEnabled}`
  document.querySelector('#st-capcost').textContent = '¥' + (data.captcha.totalCost / 1000).toFixed(2)
  document.querySelector('#st-capcount').textContent = data.captcha.count + ' 次'
  const total = s.total || 1
  document.querySelector('#bar-dist').innerHTML = `<div style="width:${s.success/total*100}%;background:#34D399"></div><div style="width:${s.failed/total*100}%;background:#F87171"></div><div style="width:${s.captchaFailed/total*100}%;background:#38BDF8"></div><div style="width:${s.skipped/total*100}%;background:#334155"></div>`
  const badge = document.querySelector('#badge-fail')
  badge.textContent = s.failed + s.captchaFailed
  badge.style.display = s.failed + s.captchaFailed > 0 ? '' : 'none'
  const sel = document.querySelector('#filter-task')
  const tasks = sel.dataset.tasks ? JSON.parse(sel.dataset.tasks) : []
  sel.innerHTML = '<option value="">全部任务</option>' + tasks.map(t => `<option value="${t.key}">${esc(t.name)}</option>`).join('')
  renderMatrix(data)
}

function renderMatrix(data) {
  const rows = data.runs.filter(r => {
    if (state.filter === 'failed' && !['failed','captcha_failed'].includes(r.status)) return false
    if (state.filter === 'success' && r.status !== 'success') return false
    if (state.filter === 'running' && !['running','retry_wait'].includes(r.status)) return false
    if (state.taskFilter && r.taskKey !== state.taskFilter) return false
    if (state.profileSearch && !r.profileName.includes(state.profileSearch)) return false
    return true
  })
  document.querySelector('#matrix').innerHTML = rows.map(r => {
    const [cls, label] = PILLS[r.status] ?? ['skip', r.status]
    const profile = data.profiles.find(p => p.id === r.profileId)
    const bitId = profile ? String(profile.bitbrowserId).slice(0, 8) : ''
    const num = String(r.profileId).padStart(2, '0')
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar">${num}</div><div><div>${esc(r.profileName)}</div><div style="font-size:10px;color:#64748B">${esc(bitId)}</div></div></div></td>
      <td>${esc(r.taskKey)}</td>
      <td><span class="pill ${cls}"><span class="d"></span>${label}</span></td>
      <td>${r.attempts}</td>
      <td class="err-text" title="${esc(r.error ?? '')}">${esc(r.error ?? '—')}</td>
      <td>${r.screenshot ? `<span class="link" onclick="window.open('/api/screenshots?path=${encodeURIComponent(r.screenshot)}')">🖼 查看</span>` : '—'}</td>
      <td><span class="link" onclick="window.abcRerun(${r.profileId}, '${esc(r.taskKey)}')">${['failed','captcha_failed'].includes(r.status) ? '重跑' : '执行'}</span></td>
    </tr>`
  }).join('')
}

export async function triggerAll() {
  const taskKey = document.querySelector('#filter-task').value
  if (!taskKey) { alert('请先选择一个任务'); return }
  await post(`/api/tasks/${encodeURIComponent(taskKey)}/trigger`, {})
}

export async function rerunFailed(date) {
  await post('/api/runs/rerun-failed', { date })
}
```

（`window.abcRerun` 与 `window.abcOpenImage` 由 app.js 桥接，见 Step 5 说明。）

- [ ] **Step 4: 实现 js/views/profiles.js、tasks.js、settings.js**

`profiles.js`：

```js
import { get, post, patch, esc } from '../api.js'

export async function render() {
  const profiles = await get('/api/profiles')
  const data = await get('/api/dashboard')
  const q = document.querySelector('#profile-search').value.trim()
  document.querySelector('#profile-count').textContent = `${profiles.length} 个窗口 · 启用 ${profiles.filter(p => p.enabled).length}`
  const rows = profiles.filter(p => !q || p.name.includes(q) || p.bitbrowserId.includes(q))
  document.querySelector('#profile-table').innerHTML = rows.map(p => {
    const mine = data.runs.filter(r => r.profileId === p.id)
    const okCount = mine.filter(r => r.status === 'success').length
    const fail = mine.filter(r => ['failed','captcha_failed'].includes(r.status)).length
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar">${String(p.id).padStart(2,'0')}</div><div><div>${esc(p.name)}</div><div style="font-size:10px;color:#64748B">${esc(p.bitbrowserId)}</div></div></div></td>
      <td><span style="color:#34D399">${okCount} ✓</span>${fail ? ` <span style="color:#F87171">${fail} ✗</span>` : ''}</td>
      <td><span style="color:${p.circuitBreakerCount > 0 ? '#FBBF24' : '#64748B'};font-size:11px">${p.circuitBreakerCount}/2</span></td>
      <td><span class="toggle ${p.enabled ? '' : 'off'}" onclick="window.abcToggle(${p.id}, ${p.enabled ? 0 : 1})"></span></td>
      <td><span class="link" onclick="window.abcRunProfile(${p.id})">立即跑</span> · <span class="link" onclick="window.abcDrawer(${p.id})">详情</span></td>
    </tr>`
  }).join('')
}

export async function openDrawer(id) {
  const profiles = await get('/api/profiles')
  const data = await get('/api/dashboard')
  const p = profiles.find(x => x.id === id)
  const mine = data.runs.filter(r => r.profileId === id)
  document.querySelector('#profile-drawer').style.display = ''
  document.querySelector('#drawer-title').textContent = `详情抽屉 · ${p.name}`
  const PILLS = { success: ['ok', '成功'], failed: ['fail', '失败'], captcha_failed: ['cap', '验证码失败'], running: ['run', '执行中'], retry_wait: ['run', '重试中'], skipped: ['skip', '跳过'], pending: ['skip', '待执行'] }
  document.querySelector('#drawer-body').innerHTML = `
    <div style="border-left:2px solid #1E293B;padding-left:14px;display:flex;flex-direction:column;gap:10px;margin-bottom:12px">
      ${mine.length ? mine.map(r => {
        const [cls] = PILLS[r.status] ?? ['skip']
        const dot = { ok: '#34D399', fail: '#F87171', cap: '#38BDF8', run: '#FBBF24', skip: '#94A3B8' }[cls]
        return `<div style="position:relative;font-size:12px"><span style="position:absolute;left:-19px;top:5px;width:8px;height:8px;border-radius:50%;background:${dot}"></span>${esc(r.taskKey)} <span class="pill ${cls}"><span class="d"></span>${PILLS[r.status][1]}</span>${r.error ? ` · ${esc(r.error)}` : ''}</div>`
      }).join('') : '<div style="color:#64748B">今日暂无任务记录</div>'}
    </div>
    <div style="font-size:12px;color:#94A3B8;display:flex;gap:8px;align-items:center">
      本窗口钱包解锁密码 ${p.walletPassword ? '<span class="kbd">••••••</span>' : '<span style="color:#64748B">未设置</span>'}
      <span class="link" onclick="window.abcPassword(${p.id})">${p.walletPassword ? '修改' : '设置'}</span>
      <span class="link" style="margin-left:12px" onclick="window.abcResetBreaker(${p.id})">重置熔断</span>
    </div>`
}

export async function toggle(id, enabled) { await patch(`/api/profiles/${id}`, { enabled: Boolean(enabled) }); await render() }
export async function runProfile(id) { await post(`/api/profiles/${id}/run`, {}); await render() }
export async function resetBreaker(id) { await post(`/api/profiles/${id}/breaker/reset`, {}); await render() }
export async function setPassword(id) {
  const password = prompt('输入该窗口的钱包解锁密码（留空清除）')
  if (password === null) return
  await patch(`/api/profiles/${id}`, { password: password || null })
  await openDrawer(id)
}
```

`tasks.js`：

```js
import { get, post, esc } from '../api.js'

const WALLET_ICON = { metamask: '<div class="wallet-ico mm">🦊</div>', petra: '<div class="wallet-ico pt">🐍</div>' }
const CATEGORY_BADGE = { checkin: ['签到', '#34D399'], faucet: ['领水', '#38BDF8'], mint: ['铸币', '#FBBF24'], other: ['其他', '#94A3B8'] }

export async function render() {
  const tasks = await get('/api/tasks')
  document.querySelector('#task-cards').innerHTML = tasks.map(t => {
    const icon = WALLET_ICON[t.wallet] ?? '<div class="wallet-ico" style="background:#33415522">▣</div>'
    const sched = t.schedule === null ? '手动触发' : typeof t.schedule === 'string' ? `cron ${t.schedule}` : `cron ${t.schedule.stagger[0]}-${t.schedule.stagger[1]} 错峰`
    const cat = CATEGORY_BADGE[t.category] ?? ['其他', '#94A3B8']
    return `<div class="task-card" style="${t.deprecated ? 'opacity:.45' : ''}">
      ${icon}
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${esc(t.name)} <span style="color:#64748B;font-weight:400">${esc(t.key)}</span>
          <span class="pill skip" style="margin-left:6px"><span class="d" style="background:${cat[1]}"></span>${cat[0]}</span>
          ${t.deprecated ? '<span class="pill skip" style="margin-left:6px"><span class="d"></span>已失效</span>' : ''}
        </div>
        <div class="meta">⏱ ${esc(sched)} · 钱包 ${esc(t.wallet ?? '无')} · 重试 ${t.retry?.max ?? '默认'} 次 · 验证码 ${t.captcha?.auto === false ? '关' : '自动'}${t.lastUpdated ? ` · 更新于 ${esc(t.lastUpdated)}` : ''}</div>
        ${t.note ? `<div class="meta" style="color:#94A3B8">📝 ${esc(t.note)}</div>` : ''}
        ${t.sourceUrl ? `<div class="meta"><span class="link" onclick="window.open('${esc(t.sourceUrl)}')">🔗 来源页</span></div>` : ''}
      </div>
      <button class="btn primary sm" onclick="window.abcTriggerTask('${esc(t.key)}')">立即触发</button>
    </div>`
  }).join('')
}

export async function triggerTask(key) { await post(`/api/tasks/${encodeURIComponent(key)}/trigger`, {}) }
```

`settings.js`：

```js
import { get, post } from '../api.js'

export async function testBitbrowser() {
  const data = await post('/api/bitbrowser/test', {})
  document.querySelector('#set-bb-dot').className = 'dot ' + (data.ok ? 'ok' : 'err')
  document.querySelector('#set-bb-text').textContent = data.ok ? '已连接' : '连接失败'
}

export async function loadBalance() {
  const data = await get('/api/captcha/balance')
  document.querySelector('#set-balance').textContent = data.configured ? `${data.points.toLocaleString()} 点（¥${data.yuan}）` : '未配置 Key'
}
```

- [ ] **Step 5: 实现 js/app.js（导航/桥接/轮询）**

```js
import { get } from './api.js'
import * as dashboard from './views/dashboard.js'
import * as profiles from './views/profiles.js'
import * as tasks from './views/tasks.js'
import * as settings from './views/settings.js'

const state = { date: localToday(), tasks: [] }
let currentPage = 'dashboard'
const TITLES = {
  dashboard: ['看板', '今日运行总览'],
  profiles: ['窗口', '窗口管理与详情'],
  tasks: ['任务', '任务定义与手动触发'],
  settings: ['设置', '运行参数（只读）'],
  docs: ['文档', 'API 手册与任务示例'],
}

function localToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }

// 行级操作：单窗口单任务触发（RESTful 语义，非整日重跑）
window.abcRerun = async (profileId, taskKey) => {
  const profiles = await get('/api/profiles')
  const p = profiles.find(x => x.id === profileId)
  if (!p) return
  await post(`/api/tasks/${encodeURIComponent(taskKey)}/trigger`, { bitbrowserId: p.bitbrowserId })
  navigate('dashboard')
}
window.abcToggle = (id, enabled) => profiles.toggle(id, enabled)
window.abcRunProfile = (id) => profiles.runProfile(id)
window.abcDrawer = (id) => profiles.openDrawer(id)
window.abcPassword = (id) => profiles.setPassword(id)
window.abcResetBreaker = (id) => profiles.resetBreaker(id)
window.abcTriggerTask = (key) => tasks.triggerTask(key).then(() => navigate('tasks'))
window.abcRerunFailed = () => dashboard.rerunFailed(state.date).then(() => navigate('dashboard'))
window.abcTriggerAll = () => dashboard.triggerAll().then(() => navigate('dashboard'))
window.abcTestBitbrowser = () => settings.testBitbrowser()
window.abcBalance = () => settings.loadBalance()

export async function navigate(page) {
  currentPage = page
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.page === page))
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('on', x.id === 'page-' + page))
  document.querySelector('#page-title').textContent = TITLES[page][0]
  document.querySelector('#crumb').textContent = TITLES[page][1]
  try {
    if (page === 'dashboard') {
      await dashboard.render({ date: state.date, setTasks: (t) => { state.tasks = t; document.querySelector('#filter-task').dataset.tasks = JSON.stringify(t) } })
    } else if (page === 'profiles') await profiles.render()
    else if (page === 'tasks') await tasks.render()
    else if (page === 'settings') { await settings.testBitbrowser(); await settings.loadBalance() }
    else if (page === 'docs') await docsRender()
  } catch (e) {
    console.error('页面渲染失败:', e)
  }
}

async function docsRender() {
  const mod = await import('./views/docs.js')
  await mod.render()
}

document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)))
document.querySelector('#seg-filter').addEventListener('click', e => {
  if (!e.target.dataset.f) return
  document.querySelectorAll('#seg-filter span').forEach(x => x.classList.remove('on'))
  e.target.classList.add('on')
  dashboard.state.filter = e.target.dataset.f
  navigate('dashboard')
})
document.querySelector('#filter-task').addEventListener('change', e => { dashboard.state.taskFilter = e.target.value; navigate('dashboard') })
document.querySelector('#filter-profile').addEventListener('input', e => { dashboard.state.profileSearch = e.target.value; navigate('dashboard') })
document.querySelector('#profile-search').addEventListener('input', () => profiles.render())

navigate('dashboard')
// 15 秒轮询：仅当停留在看板页时刷新数据，不劫持其他页面的导航
setInterval(() => {
  if (currentPage === 'dashboard') navigate('dashboard')
}, 15000)
```

- [ ] **Step 6: 重写 index.html（纯结构）**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>AutoBitControl 面板</title>
<link rel="stylesheet" href="/css/app.css" />
</head>
<body>
<div class="app">
  <div class="side">
    <div class="logo"><div class="logo-mark">◈</div><div><div class="logo-name">AutoBitControl</div><div class="logo-sub">Web3 签到自动化</div></div></div>
    <div class="nav">
      <div class="nav-item active" data-page="dashboard"><span>▦</span>看板</div>
      <div class="nav-item" data-page="profiles"><span>▤</span>窗口<span class="nav-badge" id="badge-fail" style="display:none"></span></div>
      <div class="nav-item" data-page="tasks"><span>☰</span>任务</div>
      <div class="nav-item" data-page="docs"><span>📖</span>文档</div>
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
          <select class="select" id="filter-task" data-tasks="[]"><option value="">全部任务</option></select>
          <input class="input" id="filter-profile" placeholder="搜索窗口…" style="width:140px">
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn ghost sm" onclick="window.abcRerunFailed()">↻ 重跑今日失败</button>
            <button class="btn primary sm" onclick="window.abcTriggerAll()">▶ 全部窗口执行</button>
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

    <div class="page" id="page-docs">
      <div class="card">
        <div class="doc-layout">
          <div class="doc-side" id="doc-side"></div>
          <div class="doc-content" id="doc-content"></div>
        </div>
      </div>
    </div>

    <div class="page" id="page-settings">
      <div class="card">
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0">
          <div style="width:120px;color:#94A3B8;font-size:12px">比特浏览器</div>
          <span class="kbd" id="set-bb-url">http://127.0.0.1:54345</span>
          <button class="btn ghost sm" onclick="window.abcTestBitbrowser()">测试连接</button>
          <span class="chip"><span class="dot err" id="set-bb-dot"></span><span id="set-bb-text">未检测</span></span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0">
          <div style="width:120px;color:#94A3B8;font-size:12px">执行参数</div>
          <span class="kbd" id="set-exec">并发见 config.json</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0">
          <div style="width:120px;color:#94A3B8;font-size:12px">yescaptcha</div>
          <button class="btn ghost sm" onclick="window.abcBalance()">查询余额</button>
          <span class="chip"><span class="dot ok"></span><span id="set-balance">—</span></span>
        </div>
        <div style="color:#64748B;font-size:11px;padding-top:8px">→ 设置页全部只读；修改走 config 文件 + 重启（配置单一来源）</div>
      </div>
    </div>
  </div>
</div>
<script type="module" src="/js/app.js"></script>
</body>
</html>
```

app.js 需补充桥接：`window.abcRerunFailed = () => dashboard.rerunFailed(state.date).then(() => navigate('dashboard'))`、`window.abcTriggerAll = () => dashboard.triggerAll().then(() => navigate('dashboard'))`、`window.abcTestBitbrowser = () => settings.testBitbrowser()`、`window.abcBalance = () => settings.loadBalance()`。docs 页面 Task 5 接数据，本步先由 app.js 动态 import 的 docs.js 兜底渲染占位（Task 5 实现）。

- [ ] **Step 7: 验证 + Commit**

浏览器手测 4 页功能与旧版一致（手测说明写入报告）；`npm test`、`npm run typecheck` 全绿后：

```powershell
git add -A
git commit -m "refactor: modular frontend with unified api client and zero-inline html"
```

---

### Task 4: B TaskMeta 扩展 + 调度器跳过 deprecated + 面板展示

**Files:**
- Modify: `src/tasks/base.ts`（TaskMeta 新字段）、`src/engine/scheduler.ts`（跳过 deprecated，与空 url 跳过合并）、`src/server/routes/tasks.ts`（已含新字段，确认）、`src/server/public/js/views/tasks.js`（已在 Task 3 写好展示）
- Modify: `tests/scheduler.test.ts`（新跳过逻辑测试）

**Interfaces:**
- Consumes: TaskMeta（Task 3 的 tasks 路由已在读取新字段，本步补类型定义）
- Produces: `TaskMeta` 新字段（sourceUrl/note/category/lastUpdated/deprecated）（Task 5 依赖）

- [ ] **Step 1: 写失败测试 tests/scheduler.test.ts 追加**

```ts
  it('deprecated 任务不调度', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([]) } as never
    const enq = { enqueue: vi.fn() } as never
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    const deprecated = { meta: { key: 'old', name: '旧任务', url: 'https://x.io', schedule: '0 9 * * *', deprecated: true } }
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['old', deprecated]]), enq, logger)
    sched.start()
    expect(logger.warn).toHaveBeenCalled()
    expect(enq.enqueue).not.toHaveBeenCalled()
    sched.stop()
  })

  it('fireNow 对 deprecated 任务仍可手动触发', () => {
    const db = { listProfiles: vi.fn().mockReturnValue([{ id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, walletPassword: null, circuitBreakerCount: 0 }]) } as never
    const enq = { enqueue: vi.fn() } as never
    const sched = new Scheduler({ execution: { timezone: 'Asia/Shanghai' } } as never, db, new Map([['old', { meta: { key: 'old', name: '旧任务', url: 'https://x.io', deprecated: true } }]]), enq, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    sched.fireNow('old')
    expect(enq.enqueue).toHaveBeenCalledTimes(1)
  })
```

（注意 croner 实例在测试里可能触发定时器：deprecated 任务不注册 cron 所以无定时器；`start()` 对普通任务用未来 cron。若测试环境残留 cron 定时器导致 vitest 挂起，测试结束必须 `sched.stop()`——已在用例中处理。）

- [ ] **Step 2: 实现 TaskMeta 扩展（src/tasks/base.ts）**

```ts
export interface TaskMeta {
  key: string
  name: string
  url: string
  sourceUrl?: string
  note?: string
  category?: 'checkin' | 'faucet' | 'mint' | 'other'
  lastUpdated?: string
  deprecated?: boolean
  schedule?: string | { stagger: [string, string] }
  wallet?: string
  timeoutSec?: number
  retry?: { max: number; backoffSec: number }
  captcha?: { auto?: boolean; maxCost?: number }
}
```

- [ ] **Step 3: 实现调度器跳过（src/engine/scheduler.ts）**

`start()` 内改为：

```ts
  start(): void {
    for (const task of this.tasks.values()) {
      if (task.meta.deprecated) {
        this.logger.warn({ task: task.meta.key }, '任务已标记失效，跳过调度')
        continue
      }
      if (!task.meta.url) {
        this.logger.warn({ task: task.meta.key }, '任务未配置 url，跳过调度')
        continue
      }
      const cron = this.scheduleOf(task.meta)
      if (!cron) continue
      const job = new Cron(cron, { timezone: this.cfg.execution.timezone }, () => this.fireNow(task.meta.key))
      this.jobs.push(job)
      this.logger.info({ task: task.meta.key, cron }, '任务已调度')
    }
  }
```

（原有"空 url 跳过"逻辑在之前 final review 已实现，此步合并 deprecated 判断，保持 fireNow 可手动触发 deprecated 任务。）

- [ ] **Step 4: 验证 + Commit**

```powershell
npm test
npm run typecheck
git add -A
git commit -m "feat: task meta management fields with deprecated skip in scheduler"
```

---

### Task 5: C API 手册 + 文档型示例 + 面板文档页

**Files:**
- Create: `docs/API-GUIDE.md`（九章完整手册，中文）
- Create: `src/server/routes/docs.ts`、`src/server/public/js/views/docs.js`、`src/server/public/js/vendor/marked.min.js`（vendored）
- Rewrite: `src/tasks/example-checkin.ts`（逐行注释参考实现）
- Create: `src/tasks/faucet-example.ts`、`src/tasks/mint-example.ts`（逐行注释文档型示例）
- Modify: `src/tasks/index.ts`（注册示例）、`src/server/app.ts`（挂 docs 路由）、`tests/web.test.ts`（docs 路由测试）

**Interfaces:**
- Produces: `GET /api/docs/guide`（API-GUIDE.md 原文）、`GET /api/docs/examples`（示例文件清单）、`GET /api/docs/examples/:name`（白名单源文件内容）

- [ ] **Step 1: 写失败测试 tests/web.test.ts 追加 docs 测试**

```ts
  it('GET /api/docs/guide 返回手册 markdown', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/guide')
    expect(res.body.code).toBe(0)
    expect(res.body.data.content).toContain('# AutoBitControl API 使用手册')
  })

  it('GET /api/docs/examples 返回示例清单', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/examples')
    expect(res.body.code).toBe(0)
    expect(res.body.data.length).toBeGreaterThanOrEqual(3)
  })

  it('GET /api/docs/examples/:name 返回源码', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/examples/example-checkin.ts')
    expect(res.body.code).toBe(0)
    expect(res.body.data.content).toContain('class')
  })

  it('GET /api/docs/examples/:name 白名单拒绝穿越', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/docs/examples/..%2F..%2Fpackage.json')
    expect([400, 404]).toContain(res.status)
    expect(res.body.code).not.toBe(0)
  })
```

- [ ] **Step 2: 实现 src/server/routes/docs.ts**

```ts
import { Router } from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ok, fail, asyncHandler } from '../http/response'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GUIDE_PATH = join(ROOT, 'docs', 'API-GUIDE.md')
const TASKS_DIR = join(ROOT, 'src', 'tasks')

const EXAMPLE_WHITELIST = ['example-checkin.ts', 'faucet-example.ts', 'mint-example.ts']

export function docsRouter(): Router {
  const router = Router()
  router.get('/docs/guide', asyncHandler(async (req, res) => {
    ok(res, { content: readFileSync(GUIDE_PATH, 'utf-8') })
  }))
  router.get('/docs/examples', asyncHandler(async (req, res) => {
    const files = readdirSync(TASKS_DIR).filter(f => EXAMPLE_WHITELIST.includes(f))
    ok(res, files.map(f => ({ name: f, label: f.replace('.ts', '') })))
  }))
  router.get('/docs/examples/:name', asyncHandler(async (req, res) => {
    const name = req.params.name
    if (!EXAMPLE_WHITELIST.includes(name)) {
      fail(res, 404, 404, `示例不存在: ${name}`)
      return
    }
    ok(res, { content: readFileSync(join(TASKS_DIR, name), 'utf-8') })
  }))
  return router
}
```

app.ts 挂载：`api.use(docsRouter())`。

- [ ] **Step 3: vendor marked**

```powershell
npm i -D marked
Copy-Item node_modules/marked/marked.min.js src/server/public/js/vendor/marked.min.js
```

若 `marked.min.js` 不存在则用 `node_modules/marked/lib/marked.umd.js`（重命名为 marked.min.js）。HTML 引用方式：docs.js 里动态注入 `<script src="/js/vendor/marked.min.js">` 并在加载后调用 `window.marked.parse(md)`；若 `window.marked` 缺失，回退纯文本显示（`<pre>` 包裹原文）。

- [ ] **Step 4: 实现 src/server/public/js/views/docs.js**

```js
import { get } from '../api.js'

let markedLoaded = null

function ensureMarked() {
  if (markedLoaded) return markedLoaded
  markedLoaded = new Promise(resolve => {
    if (window.marked) { resolve(); return }
    const s = document.createElement('script')
    s.src = '/js/vendor/marked.min.js'
    s.onload = () => resolve()
    s.onerror = () => resolve()
    document.head.appendChild(s)
  })
  return markedLoaded
}

function renderMarkdown(content) {
  if (window.marked) {
    return window.marked.parse(content)
  }
  return '<pre>' + content.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) + '</pre>'
}

function renderSource(content) {
  const lines = content.split('\n')
  return '<div class="code-view">' + lines.map((l, i) =>
    `<div class="code-line"><span class="code-num">${i + 1}</span><span class="code-text">${l.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) || ' '}</span></div>`
  ).join('') + '</div>'
}

export async function render() {
  const side = document.querySelector('#doc-side')
  const content = document.querySelector('#doc-content')
  side.innerHTML = `
    <div class="doc-tab on" data-doc="guide">📖 使用手册</div>
    <div class="doc-tab" data-doc="examples">🧩 任务示例</div>
    <div class="doc-tab" data-doc="source-example-checkin.ts" data-kind="source">例：每日签到</div>
    <div class="doc-tab" data-doc="source-faucet-example.ts" data-kind="source">例：领水水龙头</div>
    <div class="doc-tab" data-doc="source-mint-example.ts" data-kind="source">例：铸币 Mint</div>
  `
  side.querySelectorAll('.doc-tab').forEach(tab => tab.addEventListener('click', async () => {
    side.querySelectorAll('.doc-tab').forEach(t => t.classList.remove('on'))
    tab.classList.add('on')
    const kind = tab.dataset.kind
    if (kind === 'source') {
      const r = await get('/api/docs/examples/' + tab.dataset.doc)
      content.innerHTML = `<h2 style="margin-bottom:10px">${tab.dataset.doc}</h2><div class="doc-md">${renderSource(r.content)}</div>`
    } else if (tab.dataset.doc === 'examples') {
      const list = await get('/api/docs/examples')
      content.innerHTML = `<h2 style="margin-bottom:10px">任务示例</h2><div class="doc-md"><p>左侧选择示例文件查看带注释的完整源码。示例与 <code>docs/API-GUIDE.md</code> 配合阅读。</p><ul>${list.map(f => `<li><code>${f.name}</code></li>`).join('')}</ul></div>`
    } else {
      const r = await get('/api/docs/guide')
      await ensureMarked()
      content.innerHTML = `<div class="doc-md">${renderMarkdown(r.content)}</div>`
    }
  }))
  const first = side.querySelector('[data-doc="guide"]')
  first.click()
}
```

- [ ] **Step 5: 编写 docs/API-GUIDE.md（九章，中文，覆盖以下要点）**

要求逐章覆盖（实现者按代码实际接口撰写，不允许编造不存在的参数；手册是 Task 6 注释之外的独立文档，结构如下）：

1. **快速开始**：新增签到任务 5 步（建文件/写 meta/写 run/注册/面板验证），附完整最小任务代码
2. **TaskMeta 字段全解**：每个字段（key/name/url/sourceUrl/note/category/lastUpdated/deprecated/schedule/wallet/timeoutSec/retry/captcha）含义、类型、示例值、default；错峰与 cron 写法
3. **TaskContext 方法全解**：goto（重试 3 次语义）、clickCheckin（assert 用法）、assertVisible、typeInto、solveCaptcha（返回语义与抛错行为）、screenshot、loginByWallet（钱包 key 来源、密码读取来源）、textPresent、urlIncludes——每个方法：签名、参数表、返回值、典型用法代码、选择器查找技巧（DevTools、data-testid 优先、稳定选择器原则）
4. **钱包弹窗**：任务级钱包配置、窗口级密码配置（面板/SQLite）、弹窗识别机制（URL 正则 + 轮询）、新增钱包适配器步骤（实现 WalletAdapter、注册到 app.ts）
5. **验证码**：支持类型与 yescaptcha 类型映射、auto 配置、手动 solveCaptcha 时机、费用上限（点数）、余额不足行为、失败进入 captcha_failed
6. **拟人接口**：Humanizer 全部方法（click/type/moveTo/scroll/sleep/randomMicroMove）、延迟参数默认值与含义、CDP 派发原理（为什么不用原生 mouse）
7. **调度**：cron 语法示例、错峰窗口、deprecated/空 url 跳过、手动触发（面板/API）、fireNow 语义
8. **常用模式**：签到成功/已签到/频率限制/维护中的状态判断写法、faker 填表单、多步骤流程、条件分支与抛错重试、成功断言写法
9. **排错**：选择器失效（sourceUrl 回溯）、钱包弹窗不出现（URL 正则、轮询窗口）、打码失败与余额、熔断触发与重置、截图与日志位置

- [ ] **Step 6: 重写三个示例任务（逐行中文注释，注释即文档）**

`src/tasks/example-checkin.ts`（标准签到闭环）：

```ts
import { SiteTask, TaskContext, type TaskMeta } from './base'

// 标准每日签到参考实现：登录(钱包) → 点击签到 → 断言成功
// 新增任务从这里复制改起：先跑通流程，再逐步替换选择器
export class ExampleCheckinTask extends SiteTask {
  meta: TaskMeta = {
    // key 全局唯一，API 与数据库都用它标识任务
    key: 'example-checkin',
    // 面板任务页显示名
    name: '示例签到',
    // 站点入口页 URL（任务从这里开始）
    url: '',
    // 信息来源页：选择器是从哪个页面确认的，站点改版时回这里重查
    sourceUrl: '',
    // 备注：记录站点的坑与特殊逻辑，面板任务页直接可见
    note: '示例任务，未配置真实 url，仅手动触发演示',
    // 分类：checkin/faucet/mint/other，面板显示对应颜色徽章
    category: 'checkin',
    // 最后更新日期，提醒自己多久没核对过这个站点
    lastUpdated: '2026-08-28',
    // 每日错峰执行：9 点到 11 点之间随机取一个时间点
    schedule: { stagger: ['09:00', '11:00'] },
    // 本任务用 MetaMask 钱包登录，loginByWallet 会按此查找适配器
    wallet: 'metamask',
    // 单次运行超时（秒）
    timeoutSec: 180,
    // 失败重试 2 次，每次间隔 600 秒
    retry: { max: 2, backoffSec: 600 },
    // 验证码自动处理，单任务打码费用上限 1500 点（¥1.5）
    captcha: { auto: true, maxCost: 1500 },
  }

  async run(ctx: TaskContext): Promise<void> {
    // goto：打开 url，失败自动重试 3 次（2s-5s 退避）
    await ctx.goto()
    // loginByWallet：等站点唤起钱包弹窗 → 自动解锁（密码按窗口配置）→ 点连接
    await ctx.loginByWallet()
    // clickCheckin：拟人点击签到按钮，并断言成功后出现的元素
    // 选择器查找：DevTools 右键按钮 → Copy → Copy selector
    // 断言元素选成功后才出现的标志（徽章/文案），宁严勿松
    await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
    // 更多状态判断示例见 faucet-example.ts 与 API 手册第 8 章
  }
}
```

`src/tasks/faucet-example.ts`（领水流程）：

```ts
import { faker } from '@faker-js/faker'
import { SiteTask, TaskContext, type TaskMeta } from './base'

// 测试网水龙头领水参考实现：
// 打开页面 → 状态判断（已领过/可领/维护中）→ faker 邮箱 → 验证码 → 领取 → 断言成功
export class FaucetExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-example',
    name: '示例领水',
    url: '',
    sourceUrl: '',
    note: '示例任务，未配置真实 url；水龙头一般每 24h 限领一次',
    category: 'faucet',
    lastUpdated: '2026-08-28',
    schedule: { stagger: ['10:00', '12:00'] },
    wallet: 'metamask',
    timeoutSec: 240,
    retry: { max: 1, backoffSec: 300 },
    captcha: { auto: true, maxCost: 1500 },
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()
    // 状态判断：先看是否已领过（出现"已领取"文案直接成功返回）
    if (await ctx.textPresent('已领取')) return
    // 维护中直接失败并带上原因，跑失败后去面板看截图/日志
    if (await ctx.textPresent('维护中')) throw new Error('水龙头维护中')
    // 生成拟人化邮箱：faker 按真实域名随机，避免同窗口同邮箱
    const email = faker.internet.email()
    // 拟人输入（逐键延迟 + 少量错键回删），选择器换成站点真实输入框
    await ctx.typeInto('input[name="email"]', email)
    // 显式处理验证码：auto 模式会在 goto 后自动检测；
    // 这里再手动调用一次适用于"点击领取时才出现验证码"的站点
    await ctx.solveCaptcha()
    // 点击领取并断言成功文案（出现余额变化或成功提示）
    await ctx.clickCheckin('#claim-btn', { assert: '.success-toast' })
    // 成功截图留档（自动存档到 data/screenshots/<日期>/<窗口>/<任务>/）
    await ctx.screenshot('faucet-success')
  }
}
```

`src/tasks/mint-example.ts`（铸币流程）：

```ts
import { faker } from '@faker-js/faker'
import { SiteTask, TaskContext, type TaskMeta } from './base'

// 铸币参考实现（多步骤表单 + 钱包确认弹窗）：
// 钱包登录 → 第一步填代币信息 → 第二步填数量/描述 → 提交 → 钱包弹窗确认 → 断言链上结果提示
export class MintExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'mint-example',
    name: '示例铸币',
    url: '',
    sourceUrl: '',
    note: '示例任务，未配置真实 url；多步骤表单站点常见"下一步"按钮无 loading 提示',
    category: 'mint',
    lastUpdated: '2026-08-28',
    schedule: null, // 无固定时间，手动触发（面板任务页点"立即触发"）
    wallet: 'petra', // 该站点用 Petra 钱包
    timeoutSec: 300,
    retry: { max: 1, backoffSec: 600 },
    captcha: { auto: true, maxCost: 3000 },
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()
    await ctx.loginByWallet()
    // faker 生成代币信息：word 组合做名称、去元音做符号
    const tokenName = faker.word.words(2)
    const tokenSymbol = tokenName.replace(/[aeiou]/gi, '').slice(0, 4).toUpperCase()
    // 第一步：代币名称与符号
    await ctx.typeInto('input[name="name"]', tokenName)
    await ctx.typeInto('input[name="symbol"]', tokenSymbol)
    // 多步骤表单：点击"下一步"后等待第二步元素出现（用 assertVisible 等待而非固定 sleep）
    await ctx.clickCheckin('#step-next', { assert: '#step-2' })
    // 第二步：描述与数量
    await ctx.typeInto('textarea[name="description"]', faker.lorem.sentence())
    await ctx.typeInto('input[name="amount"]', String(faker.number.int({ min: 1, max: 100 })))
    // 提交：站点会唤起钱包弹窗；框架自动等待弹窗并点确认（密码已在窗口配置）
    await ctx.clickCheckin('#mint-submit')
    // 断言链上结果提示：等待"交易已提交/成功"文案，超时则任务失败进入重试
    await ctx.assertVisible('.tx-success', 30000)
    await ctx.screenshot('mint-success')
  }
}
```

`src/tasks/index.ts` 注册三个示例：

```ts
import type { SiteTask } from './base'
import { ExampleCheckinTask } from './example-checkin'
import { FaucetExampleTask } from './faucet-example'
import { MintExampleTask } from './mint-example'

const ALL: SiteTask[] = [new ExampleCheckinTask(), new FaucetExampleTask(), new MintExampleTask()]

export function loadTasks(): Map<string, SiteTask> {
  const map = new Map<string, SiteTask>()
  for (const t of ALL) map.set(t.meta.key, t)
  return map
}
```

注意：三个示例 `url: ''` → 调度器跳过（Task 4 逻辑），仅手动触发；任务页会显示来源页/备注/分类徽章。

- [ ] **Step 7: 验证 + Commit**

```powershell
npm test
npm run typecheck
git add -A
git commit -m "feat: API guide with documented example tasks served on panel docs page"
```

---

### Task 6: A 全代码中文注释（终态收尾）

**Files:** src/ 全部 .ts、scripts/*.ts、src/server/public/js/*.js（关键段）、css 关键段（已有注释则保留）

**注释规范（每文件必须满足）：**

- **文件头注释块**（2-6 行）：本文件职责 / 所在分层 / 依赖方向 / 关键设计思路
- **类级 JSDoc**：解决什么问题、关键设计决策与权衡（例：CoalescingEnqueuer 的 running/followUp 两套机制为什么存在；yescaptcha 串行队列对应平台 1 并发限制；humanize 为什么用 CDP Input.dispatchMouseEvent 而不用 Playwright 原生 mouse；WindowRunner 三段 try 的异常分区）
- **方法级 JSDoc**：`@param` / `@returns` / 用途 / 抛错条件 / 设计权衡
- **关键变量行内注释**：含义、取值范围、默认值依据（如 `retryBackoffMs: [5000, 30000, 120000]` 为什么是这个数列；`isInvisible`、`ESTIMATED_COST_POINTS` 来源）
- 前端 JS：每个模块头一行职责说明 + 关键函数一行说明；CSS 按区块一行分组注释
- 只加注释，**禁止改动任何逻辑**；tests/ 不注释

**覆盖清单（逐文件勾验）：**

- infrastructure/：config.ts、logger.ts、http.ts、db.ts
- integrations/：bitbrowser.ts、yescaptcha.ts
- automation/：humanize.ts、wallet/types.ts、wallet/popup.ts、wallet/metamask.ts、wallet/petra.ts
- engine/：state.ts、queue.ts、scheduler.ts、window-runner.ts
- tasks/：base.ts、index.ts、example-checkin.ts（已有）、faucet-example.ts（已有）、mint-example.ts（已有）——示例三件在 Task 5 已带注释，本步补齐 base.ts/index.ts
- server/：app.ts、http/response.ts、http/error.ts、routes/*.ts（7+1 个）
- app.ts、index.ts、scripts/*.ts

**验证：** `npm run typecheck` + `npm test` 全绿且无任何行为差异；diff 应只增注释（允许示例任务注释在 Task 5 已含）。

- [ ] **Step 1: 逐文件加注释（按清单）**
- [ ] **Step 2: 全量验证**

```powershell
npm test
npm run typecheck
git diff --stat  # 确认只有注释行变更
```

- [ ] **Step 3: Commit**

```powershell
git add -A
git commit -m "docs: comprehensive Chinese comments across all source files"
```

---

## Self-Review 记录

- 规格覆盖：D→Task 1/2/3；B→Task 4；C→Task 5；A→Task 6；spec 3.3 面板文档页→Task 3（骨架）+Task 5（实现）；spec 1.4 路由表→Task 2 测试与路由文件一一对应；spec 1.3 统一封装→Task 1（http.ts）+Task 2（envelope）+Task 3（api.js）
- 类型一致性：`TaskMeta` 新字段在 Task 4 定义、Task 2 的 tasks 路由与 Task 3 的 tasks.js 已先行按同名字段读取（顺序兼容：先落路由再补类型，最终一致）；`createApp` 签名 Task 2 定义、Task 1 的 app.ts 装配与 Task 5 挂 docs 路由一致；`docsRouter()` 无依赖参数
- 已知偏差 1：spec 1.1 目录表中 tasks/base.ts 留在 tasks 层，但 base.ts 会对 integrations/automation 做 type-only import——plan 已在 Global Constraints 明确该规则
- 已知偏差 2：dashboard 响应在 Task 2 移除了 tasks 数组（改由 GET /api/tasks 提供），与 spec 1.4 一致；前端 Task 3 的 dashboard.js 相应改为二次请求
- 占位符扫描：示例任务的 url/sourceUrl 为空字符串是**文档示例的刻意设计**（调度器跳过空 url，Task 4），非占位符

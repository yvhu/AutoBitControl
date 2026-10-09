# 诊断落库与面板（Plan 6）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务失败时自动采集**失败诊断包**（URL/关键文本/弹窗文本/步骤时间线/截图），落盘并在 `runs.diag_path` 记路径；新增 `GET /api/diagnostics/:runId`；看板失败行提供「诊断」视图。

**Architecture:** `automation/diag` 增加 `bundle.ts`（采集+写盘）；`window-runner` 失败时调用它并随行落库；`db` 加 `diag_path` 列；`server` 加只读接口；`web` 看板明细行弹窗展示。诊断包是排障证据，不改变任务成败判定。

**Tech Stack:** TypeScript（严格）、libsql/SQLite、express、React 18 + antd 5 + react-query、vitest。

## Global Constraints

- 依赖方向：`tasks → engine → automation/integrations → infrastructure`；`server → {engine, infrastructure}`。
- 每个 automation 子目录一个 `index.ts` 出口；错误响应走 `ok/fail` + `asyncHandler`；DB 改动加 migrate 补列（老库兼容）。
- 代码风格：无分号、单引号、2 空格缩进；文件头/注释中文；日志 `logger.warn({...}, '中文')`。
- 验证：`npm run typecheck`、`npm test`、`npm run test:web`。
- 提交风格：conventional + 中文。
- 分支 `feat/task-thin-facade`；文档（API-GUIDE）同步在 Task 6 收尾（AGENTS 硬性）。
- **诊断包不得抛出/影响任务结果**：采集与写盘全程 best-effort（catch 忽略）。

---

### Task 1: `runs.diag_path` 列与查询

**Files:**
- Modify: `src/infrastructure/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- `RunRow` 增 `diagPath: string | null`。
- `upsertRun(...)` 的 `patch` 支持 `diagPath`（写入 `diag_path`，`COALESCE` 保留旧值）。
- 新增 `getRunById(id: number): Promise<RunRow | null>`。

- [ ] **Step 1: 写失败测试**（`tests/db.test.ts` 追加）

```ts
it('upsertRun 写入 diagPath 并可经 getRunById 取回', async () => {
  const row = await db.upsertRun(1, 'k', '2026-10-09', 0, 'failed', { error: 'e', diagPath: 'D:/x/diag.json' })
  expect(row.diagPath).toBe('D:/x/diag.json')
  const byId = await db.getRunById(row.id)
  expect(byId?.diagPath).toBe('D:/x/diag.json')
})
```

（沿用该文件既有 db 构造方式。）

- [ ] **Step 2: 运行验证失败** `npx vitest run tests/db.test.ts` → FAIL

- [ ] **Step 3: 实现**

`src/infrastructure/db.ts`：
1. `RunRow` 增 `diagPath: string | null`。
2. `runs` 建表 DDL 增 `diag_path TEXT,`（在 `batch_id INTEGER,` 附近）。
3. migrate 补列（仿 `batch_id`）：

```ts
    const runsInfo3 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo3.rows.some((r) => String(r.name) === 'diag_path')) {
      await this.client.execute(`ALTER TABLE runs ADD COLUMN diag_path TEXT`)
    }
```

（并同步「runs 重建」分支里的旧表 CREATE/INSERT 若无 slot 时的列——保持与建表一致，补 `diag_path` 到重建 DDL 与 INSERT 的 SELECT 列表，缺省 NULL。）

4. `SELECT_RUN` 增 `r.diag_path AS diagPath`。
5. `upsertRun`：INSERT 列加 `diag_path`、VALUES 占位加一个、`DO UPDATE SET` 加 `diag_path = COALESCE(excluded.diag_path, runs.diag_path)`，参数加 `patch.diagPath ?? null`。
6. 新增：

```ts
  /** 按 run id 取值（不存在返回 null） */
  async getRunById(id: number): Promise<RunRow | null> {
    const rows = await this.exec(`${SELECT_RUN} WHERE r.id = ?`, [id])
    return (rows[0] as unknown as RunRow | undefined) ?? null
  }
```

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/db.test.ts`；`npm run typecheck` → PASS

- [ ] **Step 5: 提交** `feat: runs.diag_path 列 + getRunById`

---

### Task 2: `diag/bundle.ts` 诊断包采集与写盘

**Files:**
- Create: `src/automation/diag/bundle.ts`
- Modify: `src/automation/diag/index.ts`
- Test: `tests/diag-bundle.test.ts`

**Interfaces:**
- `interface DiagBundle { taskKey; profileName; status; error; url; capturedAt; steps: StepRecord[]; visibleText; dialogText }`
- `collectDiagnostics(opts: { page; steps; error; status; windowName; taskKey }): Promise<DiagBundle>`（全程 catch，失败字段置空串）
- `writeDiagBundle(dir, name, bundle): string`（写 `${name}.json`，返回路径）

- [ ] **Step 1: 写失败测试** `tests/diag-bundle.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { collectDiagnostics, writeDiagBundle } from '../src/automation/diag'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function page(over: Record<string, unknown> = {}) {
  return {
    url: () => 'https://x/quests',
    evaluate: async (fn: () => unknown) => fn(),
    ...over,
  }
}

describe('diag bundle', () => {
  it('collectDiagnostics 采集 url/文本/步骤，page 抛错则字段置空', async () => {
    const pageObj = {
      url: () => 'https://x/quests',
      evaluate: async (fn: () => unknown) =>
        new Function('document', `return (${fn.toString()})()`)({ body: { innerText: 'body-文本' }, querySelector: () => ({ textContent: '弹窗文本' }) }),
    }
    const b = await collectDiagnostics({ page: pageObj as never, steps: [{ name: 's', startMs: 0, ms: 1, ok: true }], error: 'err', status: 'failed', windowName: '窗口1', taskKey: 'k' })
    expect(b.url).toBe('https://x/quests')
    expect(b.visibleText).toContain('body-文本')
    expect(b.dialogText).toContain('弹窗文本')
    expect(b.error).toBe('err')

    const bad = { url: () => { throw new Error('closed') }, evaluate: async () => { throw new Error('closed') } }
    const b2 = await collectDiagnostics({ page: bad as never, steps: [], error: 'e', status: 'failed', windowName: 'w', taskKey: 'k' })
    expect(b2.url).toBe('')
    expect(b2.visibleText).toBe('')
  })

  it('writeDiagBundle 写 JSON 文件并返回路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-'))
    const file = writeDiagBundle(dir, 'x-attempt1.diag', { taskKey: 'k' } as never)
    expect(file.endsWith('x-attempt1.diag.json')).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).taskKey).toBe('k')
  })
})
```

- [ ] **Step 2: 运行验证失败** `npx vitest run tests/diag-bundle.test.ts` → FAIL

- [ ] **Step 3: 实现**

`src/automation/diag/bundle.ts`：

```ts
/**
 * 失败诊断包（automation/diag 层）：任务失败瞬间采集页面与步骤上下文，供面板排障
 * 依赖方向：仅依赖 patchright 类型与 ./recorder；采集全程 best-effort，绝不抛错影响任务结果
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'patchright'
import type { StepRecord } from './recorder'

export interface DiagBundle {
  taskKey: string
  profileName: string
  status: string
  error: string
  url: string
  capturedAt: string
  steps: StepRecord[]
  visibleText: string
  dialogText: string
}

export interface CollectDiagOpts {
  page: Page
  steps: StepRecord[]
  error: string
  status: string
  windowName: string
  taskKey: string
}

/** 采集诊断（字段级 catch：任一项失败置空串，不抛错） */
export async function collectDiagnostics(opts: CollectDiagOpts): Promise<DiagBundle> {
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => fn().catch(() => fallback)
  const url = await safe(async () => opts.page.url(), '')
  const visibleText = await safe(
    async () => opts.page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText.slice(0, 2000)),
    '',
  )
  const dialogText = await safe(
    async () =>
      opts.page.evaluate(() =>
        ((globalThis as unknown as { document: { querySelector: (s: string) => { textContent: string | null } | null } }).document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 1000),
      ),
    '',
  )
  return {
    taskKey: opts.taskKey,
    profileName: opts.windowName,
    status: opts.status,
    error: opts.error,
    url,
    capturedAt: new Date().toISOString(),
    steps: opts.steps,
    visibleText,
    dialogText,
  }
}

/** 写诊断包 JSON（best-effort；返回文件绝对路径） */
export function writeDiagBundle(dir: string, name: string, bundle: DiagBundle): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8')
  return file
}
```

`src/automation/diag/index.ts` 追加：

```ts
export { collectDiagnostics, writeDiagBundle } from './bundle'
export type { DiagBundle, CollectDiagOpts } from './bundle'
```

> 注意：`page.evaluate` 的 fn 必须自包含（patchright 序列化）；用 `globalThis.document` 取法或直接 `document`（与既有 `ctx.js` 同）。实现时以能在测试 `new Function('document', ...)` 下可执行为准——测试用 `document` 形参，故实现体用裸 `document`（`$eval` 场景）而非 `globalThis`。**采用裸 `document`**：

```ts
const visibleText = await safe(async () => opts.page.evaluate(() => document.body.innerText.slice(0, 2000)), '')
const dialogText = await safe(async () => opts.page.evaluate(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 1000)), '')
```

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/diag-bundle.test.ts`；`npm run typecheck` → PASS

- [ ] **Step 5: 提交** `feat: diag 失败诊断包采集与写盘`

---

### Task 3: `window-runner` 失败时采集并随行落库

**Files:**
- Modify: `src/engine/window-runner.ts`
- Test: `tests/windowRunner.test.ts`

**Interfaces:**
- `WindowRunnerDeps` 不变（复用 `artifactsDir`）。
- 失败落库时传 `diagPath`（写入 `${artifacts}/${date}-attempt${attempt}.diag.json`）。

- [ ] **Step 1: 写失败测试**（`tests/windowRunner.test.ts` 追加）

用已有 fake 驱动一个失败任务，断言：`upsertRun` 末次 `patch.diagPath` 非空且指向 artifacts 目录下的 `.diag.json`，文件存在且含 `steps`/`error`/`url` 字段。若既有测试的 fake db 记录 patch，可直接断言；否则注入一个 recording db stub。

- [ ] **Step 2: 运行验证失败** `npx vitest run tests/windowRunner.test.ts` → FAIL

- [ ] **Step 3: 实现**

`src/engine/window-runner.ts` `runTask`：
1. 把 `const ctx = new TaskContext(...)` 提升为 `let ctx: TaskContext | null = null`（在循环 try 外声明），try 内赋值。
2. catch 中，失败截图之后、`upsertRun` 之前，采集诊断：

```ts
        let diagPath: string | null = null
        if (ctx) {
          try {
            const { collectDiagnostics, writeDiagBundle } = await import('../automation')
            const bundle = await collectDiagnostics({
              page,
              steps: ctx.steps(),
              error: (e as Error).message,
              status,
              windowName: profile.name,
              taskKey,
            })
            diagPath = writeDiagBundle(artifacts, `${date}-attempt${attempt}.diag`, bundle)
          } catch (de) {
            logger.warn({ profile: profile.name, task: taskKey, err: (de as Error).message }, '诊断包采集失败（不影响任务结果）')
          }
        }
```

3. `upsertRun(..., { error, screenshot: shot, diagPath, finishedAt })`（失败分支）。

（`artifacts` 已在该方法内计算。）

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/windowRunner.test.ts`；`npm run typecheck` → PASS

- [ ] **Step 5: 提交** `feat: 任务失败采集诊断包并随 run 落库`

---

### Task 4: `GET /api/diagnostics/:runId` 接口

**Files:**
- Create: `src/server/routes/diagnostics.ts`
- Modify: `src/server/app.ts`（挂载 router）
- Modify: `src/app.ts`（注入 `getRunById` 能力，若无直接持有 db 则经 deps）
- Test: `tests/diagnostics-route.test.ts`

**Interfaces:**
- `GET /api/diagnostics/:runId` → `{ code, message, data: DiagBundle }`；run 不存在或无 diagPath 或无文件 → 404（业务码 `40407`，新增）。
- 依赖注入：`{ getRunById: (id:number)=>Promise<RunRow|null> }`。

- [ ] **Step 1: 写失败测试** `tests/diagnostics-route.test.ts`

用 supertest：注入 fake `getRunById` 返回 `{ diagPath }`（指向临时写好的 JSON）→ 期望 200 + `steps`；无 diagPath → 404。

- [ ] **Step 2: 运行验证失败** `npx vitest run tests/diagnostics-route.test.ts` → FAIL

- [ ] **Step 3: 实现**

`src/server/http/errors.ts`：加业务码 `RUN_DIAG_NOT_FOUND: 40407`（若采用集中错误码；否则在路由内 `fail(res, 40407, '诊断不存在')`）。

`src/server/routes/diagnostics.ts`：

```ts
/**
 * 诊断路由（server 层）：按 run id 取失败诊断包 JSON
 * 依赖方向：依赖注入的 getRunById（app 提供）；只读文件，失败安全
 */
import { Router } from 'express'
import { readFileSync } from 'node:fs'
import { ok, fail, asyncHandler } from '../http/response'
import type { RunRow } from '../../infrastructure/db'

export function diagnosticsRouter(deps: { getRunById: (id: number) => Promise<RunRow | null> }): Router {
  const router = Router()
  /** @swagger ... GET /api/diagnostics/{runId} ... */
  router.get('/diagnostics/:runId', asyncHandler(async (req, res) => {
    const id = Number(req.params.runId)
    if (!Number.isFinite(id)) { fail(res, 400, 'runId 非法'); return }
    const run = await deps.getRunById(id)
    if (!run || !run.diagPath) { fail(res, 40407, '诊断不存在'); return }
    let data: unknown
    try {
      data = JSON.parse(readFileSync(run.diagPath, 'utf8'))
    } catch {
      fail(res, 40407, '诊断文件不存在'); return
    }
    ok(res, data)
  }))
  return router
}
```

`src/server/app.ts`：`app.use('/api', diagnosticsRouter({ getRunById: deps.getRunById }))`（把 `getRunById` 加进 `ServerDeps` 并在 `src/app.ts` 装配时传 `(id) => db.getRunById(id)`）。

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/diagnostics-route.test.ts`；`npm run typecheck` → PASS

- [ ] **Step 5: 提交** `feat: GET /api/diagnostics/:runId`

---

### Task 5: 看板失败行「诊断」视图

**Files:**
- Modify: `web/src/api/endpoints.ts`（`fetchDiagnostics(runId)`）
- Modify: `web/src/pages/dashboard/index.tsx`（失败行加「诊断」按钮 + Modal）
- Create: `web/src/pages/dashboard/DiagModal.tsx`
- Modify: `web/src/api/schema.d.ts`（手补类型即可）
- Test: `web/src/pages/dashboard/DiagModal.test.tsx`（或 hooks 测试）

**Interfaces:**
- `fetchDiagnostics(runId: number)` → `DiagBundle`（前端类型：`{ url, error, steps: {name,ms,ok,detail?}[], visibleText, dialogText, capturedAt }`）。
- 失败行（`status==='failed'` 且有值）显示「诊断」按钮 → Modal：错误/URL/步骤时间线（antd Timeline 或 List，标出耗时与成败）/关键文本/弹窗文本 + 截图（复用现有截图查看逻辑）。

- [ ] **Step 1: 写失败测试** `web/src/pages/dashboard/DiagModal.test.tsx`

渲染 DiagModal（注入 fake data）断言步骤名与错误文案出现。用 testing-library（同 `web.test.ts` 先例）。

- [ ] **Step 2: 运行验证失败** `npm run test:web`（该文件失败）

- [ ] **Step 3: 实现**

- `endpoints.ts`：`export const fetchDiagnostics = (runId: number) => get<DiagBundle>('/api/diagnostics/' + runId)`
- `DiagModal.tsx`：props `{ runId: number | null; open: boolean; onClose: () => void }`；`useQuery(['diag', runId], () => fetchDiagnostics(runId!), { enabled: open && runId != null })`；渲染。
- `index.tsx`：明细表失败行操作列加「诊断」按钮，state 控制 Modal。

- [ ] **Step 4: 运行验证通过** `npm run test:web`；`npm run typecheck` → PASS

- [ ] **Step 5: 提交** `feat: 看板失败行诊断视图`

---

### Task 6: 文档同步、回归与终审

**Files:**
- Modify: `docs/API-GUIDE.md`（第 10 章 REST 加 `GET /api/diagnostics/:runId`；第 12 章排错补「失败诊断包」说明；漂移守卫不受影响）

- [ ] **Step 1: 文档同步**

在 `docs/API-GUIDE.md` 第 10 章总表加一行；第 12 章加「失败时自动诊断包」小节（字段、位置、面板入口）。

- [ ] **Step 2: 全量回归**

Run: `npm run typecheck`；`npm test`；`npm run test:web` → 全部 PASS

- [ ] **Step 3: 终审**

独立 subagent 审查本计划 diff（诊断采集 best-effort、不改变任务成败；DB migrate 兼容老库；接口错误码；前端展示）。

- [ ] **Step 4: 提交** `docs: 诊断包接口与排错说明`

---

## Self-Review

- **Spec coverage**：Task1 `diag_path`+查询；Task2 采集/写盘；Task3 window-runner 采集落库；Task4 接口；Task5 面板；Task6 文档+回归+终审。
- **Placeholder scan**：无 TBD；核心文件给完整代码，集成点给出明确接口与插入位置。
- **Type consistency**：`DiagBundle`/`RunRow.diagPath`/`getRunById`/`fail(40407)` 贯穿各任务；前端 `DiagBundle` 类型与后端一致。
- **风险**：`ctx` 提升到 try 外以在 catch 采集；`page.evaluate` 用裸 `document`（与既有 `ctx.js` 一致）；诊断包 best-effort 全程 catch；DB 重建分支需同步补 `diag_path` 列。

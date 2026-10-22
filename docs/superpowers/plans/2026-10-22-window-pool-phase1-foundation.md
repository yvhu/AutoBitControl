# 窗口池调度 Phase 1：基础治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先移除批量错峰、加入窗口池/健康配置、窗口状态字段、内存调速与全局健康门禁模块、开窗/关窗串行与状态协议，为 Phase 2 的窗口池调度打好可独立验收的基础。

**Architecture:** Phase 1 不改任务认领模型（仍是 `CoalescingEnqueuer` + `claimDueRuns`），只做三件事：删除批量 stagger；把 `open_windows` 扩展成带状态/归属/使用记录的窗口登记；新增纯函数式的内存调速与全局健康门禁模块，并用串行队列修正开窗/关窗竞态。Phase 2 再把这些模块接进窗口池调度。

**Tech Stack:** Node 20 + TypeScript（strict，无分号、单引号、2 空格）、Express、libsql（自定义 `sqlite-client`）、Vitest、patchright。

## Global Constraints

- 中文注释/文档/commit message；标识符英文；文件 kebab-case，类 PascalCase。
- 不加分号、单引号、2 空格缩进；TS 严格模式。
- 本地库只经 `src/infrastructure/sqlite-client.ts` / `AppDb`，不要直接开 `@libsql/client` 本地 client。
- 开窗/关窗路径必须容错：失败只告警/排队，不让任务因此崩进程。
- 每个任务结束前跑 `npm run typecheck` + 对应测试；最后跑全量 `npm test`。
- Phase 1 保留 `execution.maxConcurrentWindows` 给旧调度器使用；`windowPool.enabled` 默认 `false`，Phase 2 才切换。
- 删除错峰后，`runs.not_before_ms` 只用于重试退避，不再用于初始铺开。
- 文档同步：`docs/API-GUIDE.md`、`AGENTS.md` 中涉及错峰/配置的段落必须同批更新。

---

### Task 1: 移除批量错峰（stagger）

**Files:**
- Modify: `src/infrastructure/config.ts`
- Modify: `config/config.json`
- Modify: `src/engine/scheduler.ts`
- Modify: `src/server/routes/tasks.ts`
- Modify: `src/server/routes/batches.ts`
- Modify: `src/server/app.ts`
- Modify: `src/app.ts`
- Delete: `src/engine/stagger.ts`
- Delete: `tests/stagger.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/scheduler.test.ts`
- Modify: `tests/web.test.ts`

**Interfaces:**
- Consumes: `CoalescingEnqueuer.enqueue(profile, taskKey, { batchId, notBeforeMs })`
- Produces: 所有触发入口统一 `notBeforeMs: Date.now()`；`ExecutionConfig` 不再有 `staggerMaxSec` / `staggerJitterPct`；`SchedulerDeps`、`tasksRouter`、`batchesRouter` 不再接收 `stagger`。

- [ ] **Step 1: 改写测试，断言触发后所有窗口立即到期**

在 `tests/web.test.ts` 的 trigger 测试里，把断言 `notBeforeMs` 递增/错峰的用例改为：

```ts
it('批量触发不铺开：所有窗口入队时间几乎一致', async () => {
  const res = await request(app).post('/api/tasks/example-checkin/trigger').send({})
  expect(res.status).toBe(200)
  const rows = await db.listRunsForDate(todayStr())
  const pending = rows.filter((r) => r.status === 'pending')
  expect(pending.length).toBeGreaterThan(1)
  const times = pending.map((r) => r.notBeforeMs ?? 0)
  expect(Math.max(...times) - Math.min(...times)).toBeLessThan(1000)
})
```

在 `tests/scheduler.test.ts` 中，找到已有的“到点触发”用例（约第 171 行 `await s.tick()`），把对 `notBeforeMs` 的错峰断言改成：

```ts
const times = deps.enqueuer.enqueue.mock.calls.map(
  (call) => (call[2] as { notBeforeMs: number }).notBeforeMs,
)
expect(times.length).toBeGreaterThan(1)
expect(Math.max(...times) - Math.min(...times)).toBeLessThan(1000)
```

不要新增直接调用 `scheduler.fire` 的测试（`fire` 是私有方法）；沿用现有 `new Scheduler(deps); await s.tick()` 的写法。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts tests/scheduler.test.ts -t "不铺开"`

Expected: FAIL（仍按 stagger 铺开）。

- [ ] **Step 3: 删除配置与校验**

在 `src/infrastructure/config.ts`：

```ts
export interface ExecutionConfig {
  windowTimeoutMs: number
  taskTimeoutMs: number
  retryMax: number
  retryBackoffSec: number
  circuitBreakerThreshold: number
  circuitBreakerEnabled: boolean
  circuitBreakerCooldownSec: number
  circuitBreakerMaxCooldownSec: number
  circuitBreakerResetAt: string
  maxConcurrentWindows: number
}
```

删除 `defaults.execution.staggerMaxSec`、`staggerJitterPct`，以及 `loadConfig` 中第 271-280 行的 stagger 校验。`config/config.json` 删除：

```json
"staggerMaxSec": 120,
"staggerJitterPct": 15,
```

- [ ] **Step 4: 删除调度器/路由中的 stagger**

`src/engine/scheduler.ts`：

```ts
// 删除 import { staggerNotBefore, type StaggerConfig } from './stagger'
// 删除 SchedulerDeps.stagger
// fire() 第二遍入队改为：
for (const key of passing) {
  // ...
  const batch = await this.deps.db.createBatch('schedule', key, `计划#${schedule.id} ${schedule.name}`)
  for (const profile of profiles) {
    await this.deps.enqueuer.enqueue(profile, key, { batchId: batch.id, notBeforeMs: Date.now() })
  }
  result.taskKeys.push(key)
}
```

`src/server/routes/tasks.ts`：删除 `stagger` import/依赖，三处 `staggerNotBefore(...)` 改为：

```ts
const notBeforeMs = Date.now()
```

`src/server/routes/batches.ts`：同样删除 stagger，`rerun-failed` 入队用 `notBeforeMs: Date.now()`。

`src/server/app.ts` 与 `src/app.ts`：删除 `stagger` 依赖与 `stagger: {...}` 传参。

- [ ] **Step 5: 删除 stagger 模块与测试**

```bash
git rm src/engine/stagger.ts tests/stagger.test.ts
```

删除/更新 `tests/config.test.ts` 中 stagger 默认值/非法值用例；删除 `tests/web.test.ts` 中依赖错峰顺序的断言。

- [ ] **Step 6: 跑测试**

Run: `npm run typecheck && npx vitest run tests/config.test.ts tests/scheduler.test.ts tests/web.test.ts`

Expected: PASS。

- [ ] **Step 7: 更新用户文档**

`docs/API-GUIDE.md` 中删除/改写 `staggerMaxSec`、`staggerJitterPct` 的描述（第 7 章配置速查与任务触发相关段落）；`AGENTS.md` 删除错峰相关条目，改为“触发即 pending，开窗节奏由窗口池/冷却控制（Phase 2）”。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: 移除批量触发错峰，触发只写 pending"
```

---

### Task 2: 新增 windowPool / health 配置（Phase 2 使用，默认关闭）

**Files:**
- Modify: `src/infrastructure/config.ts`
- Modify: `config/config.json`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Produces: `WindowPoolConfig`、`HealthConfig`、`AppConfig.execution.windowPool`、`AppConfig.execution.health`。

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 增加：

```ts
it('windowPool 默认值与覆盖', () => {
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { windowPool: { maxOpenWindows: 6 } } }))
  const cfg = loadConfig({ rootDir: dir })
  expect(cfg.execution.windowPool).toMatchObject({
    enabled: false,
    maxOpenWindows: 6,
    memoryReserveMb: 100,
    perWindowMb: 1024,
    criticalFreeMb: 1024,
    resumeFreeMb: 2048,
    checkIntervalMs: 5000,
    openCooldownMs: 10000,
    idleCloseSec: 180,
    windowMaxTasks: 3,
    windowMaxLifetimeSec: 600,
    cohortMaxSec: 1800,
  })
})

it('health 默认值与非法回退', () => {
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { health: { globalEnvFailureThreshold: 0 } } }))
  const warnings: string[] = []
  const cfg = loadConfig({ rootDir: dir, warnings })
  expect(cfg.execution.health.globalEnvFailureThreshold).toBe(3)
  expect(cfg.execution.health.backoffSec).toEqual([30, 60, 120, 300, 600])
  expect(warnings.some((w) => w.includes('globalEnvFailureThreshold'))).toBe(true)
})
```

> 注：如果 `loadConfig` 测试辅助的入参名不同，按现有 `tests/config.test.ts` 的写法调整；不要改生产签名。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/config.test.ts -t "windowPool|health"`

Expected: FAIL（`windowPool` 不存在）。

- [ ] **Step 3: 添加类型与默认值**

`src/infrastructure/config.ts`：

```ts
export interface WindowPoolConfig {
  enabled: boolean
  maxOpenWindows: number
  memoryReserveMb: number
  perWindowMb: number
  criticalFreeMb: number
  resumeFreeMb: number
  checkIntervalMs: number
  openCooldownMs: number
  idleCloseSec: number
  windowMaxTasks: number
  windowMaxLifetimeSec: number
  cohortMaxSec: number
}

export interface HealthConfig {
  bitbrowserProbeMs: number
  globalEnvFailureWindowSec: number
  globalEnvFailureThreshold: number
  probeEnabled: boolean
  backoffSec: number[]
}

export interface ExecutionConfig {
  // ...原字段
  windowPool: WindowPoolConfig
  health: HealthConfig
}
```

`defaults.execution` 增加：

```ts
windowPool: {
  enabled: false,
  maxOpenWindows: 4,
  memoryReserveMb: 100,
  perWindowMb: 1024,
  criticalFreeMb: 1024,
  resumeFreeMb: 2048,
  checkIntervalMs: 5000,
  openCooldownMs: 10000,
  idleCloseSec: 180,
  windowMaxTasks: 3,
  windowMaxLifetimeSec: 600,
  cohortMaxSec: 1800,
},
health: {
  bitbrowserProbeMs: 30000,
  globalEnvFailureWindowSec: 300,
  globalEnvFailureThreshold: 3,
  probeEnabled: true,
  backoffSec: [30, 60, 120, 300, 600],
},
```

校验：`maxOpenWindows` 正整数（默认 4）；`memoryReserveMb >= 0`；`perWindowMb >= 128`；`criticalFreeMb >= 0` 且 `< resumeFreeMb`；`checkIntervalMs >= 1000`；`openCooldownMs >= 0`；`idleCloseSec >= 0`；`windowMaxTasks >= 0`；`windowMaxLifetimeSec >= 0`；`cohortMaxSec >= 0`；`globalEnvFailureThreshold >= 1`；`backoffSec` 非空正数数组。非法值回退默认并 `warnings.push(...)`。

`config/config.json` 增加 `execution.windowPool` 与 `execution.health`（值同 defaults，`enabled: false`）。

- [ ] **Step 4: 跑测试**

Run: `npm run typecheck && npx vitest run tests/config.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/config.ts config/config.json tests/config.test.ts
git commit -m "feat: 新增窗口池与全局健康配置（默认关闭）"
```

---

### Task 3: open_windows 扩展状态字段与读写方法

**Files:**
- Modify: `src/infrastructure/db.ts`
- Modify: `tests/db.test.ts`

**Interfaces:**
- Produces:
  - `OpenWindowRow { bitbrowserId; http; ownerPid; state: 'opening'|'open'|'closing'; ownerKind: 'pool'|'manual'|'taskrun'; lastUsedAt: string|null; tasksDone: number }`
  - `reserveOpenWindow(id, ownerPid, ownerKind?)`
  - `setOpenWindow(id, http, ownerPid?, state?)`
  - `setWindowState(id, state)`
  - `touchWindowUsed(id, tasksDone)`
  - `listPoolWindows()`

- [ ] **Step 1: 写失败测试**

`tests/db.test.ts` 增加：

```ts
describe('open_windows 状态', () => {
  it('预留/开窗/使用记录/状态更新/池窗口列表', async () => {
    const db = await AppDb.open('file::memory:')
    await db.reserveOpenWindow('bb-1', 123, 'pool')
    let rows = await db.listOpenWindows()
    expect(rows[0]).toMatchObject({ bitbrowserId: 'bb-1', ownerPid: 123, state: 'opening', ownerKind: 'pool', tasksDone: 0 })

    await db.setOpenWindow('bb-1', '127.0.0.1:9222', 123, 'open')
    await db.touchWindowUsed('bb-1', 1)
    rows = await db.listPoolWindows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'open', ownerKind: 'pool', lastUsedAt: expect.any(String), tasksDone: 1 })

    await db.setWindowState('bb-1', 'closing')
    expect(await db.listPoolWindows()).toHaveLength(0)
    await db.clearOpenWindow('bb-1')
    expect(await db.listOpenWindows()).toHaveLength(0)
    db.close()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/db.test.ts -t "open_windows 状态"`

Expected: FAIL（列/方法不存在）。

- [ ] **Step 3: 扩展 schema 与迁移**

`open_windows` 建表 SQL 增加：

```sql
state TEXT NOT NULL DEFAULT 'open',
owner_kind TEXT NOT NULL DEFAULT 'manual',
last_used_at TEXT,
tasks_done INTEGER NOT NULL DEFAULT 0
```

`migrate()` 中补列（幂等）：

```ts
const owInfo = await this.client.execute(`PRAGMA table_info(open_windows)`)
const owCols = new Set(owInfo.rows.map((r) => String(r.name)))
const owNew: Array<[string, string]> = [
  ['state', "TEXT NOT NULL DEFAULT 'open'"],
  ['owner_kind', "TEXT NOT NULL DEFAULT 'manual'"],
  ['last_used_at', 'TEXT'],
  ['tasks_done', 'INTEGER NOT NULL DEFAULT 0'],
]
for (const [col, type] of owNew) {
  if (!owCols.has(col)) await this.client.execute(`ALTER TABLE open_windows ADD COLUMN ${col} ${type}`)
}
```

`OpenWindowRow` 与 `listOpenWindows` 映射新增字段；`reserveOpenWindow` / `setOpenWindow` 增加参数与 SQL：

```ts
async reserveOpenWindow(bitbrowserId: string, ownerPid: number, ownerKind: 'pool' | 'manual' | 'taskrun' = 'manual'): Promise<void> {
  await this.exec(
    `INSERT INTO open_windows (bitbrowser_id, http, opened_at, owner_pid, state, owner_kind)
     VALUES (?, '', ?, ?, 'opening', ?)
     ON CONFLICT(bitbrowser_id) DO UPDATE SET
       http = '', opened_at = excluded.opened_at, owner_pid = excluded.owner_pid,
       state = 'opening', owner_kind = excluded.owner_kind`,
    [bitbrowserId, localWallNow(), ownerPid, ownerKind],
  )
}
```

```ts
async setOpenWindow(bitbrowserId: string, http: string, ownerPid?: number, state: 'opening' | 'open' | 'closing' = 'open'): Promise<void> {
  await this.exec(
    `INSERT INTO open_windows (bitbrowser_id, http, opened_at, owner_pid, state)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bitbrowser_id) DO UPDATE SET
       http = excluded.http, opened_at = excluded.opened_at,
       owner_pid = excluded.owner_pid, state = excluded.state`,
    [bitbrowserId, http, localWallNow(), ownerPid ?? null, state],
  )
}

async setWindowState(bitbrowserId: string, state: 'opening' | 'open' | 'closing'): Promise<void> {
  await this.exec('UPDATE open_windows SET state = ? WHERE bitbrowser_id = ?', [state, bitbrowserId])
}

async touchWindowUsed(bitbrowserId: string, tasksDone: number): Promise<void> {
  await this.exec('UPDATE open_windows SET last_used_at = ?, tasks_done = ? WHERE bitbrowser_id = ?', [localWallNow(), tasksDone, bitbrowserId])
}

async listPoolWindows(): Promise<OpenWindowRow[]> {
  const rows = await this.exec(
    `SELECT bitbrowser_id AS bitbrowserId, http, owner_pid AS ownerPid, state, owner_kind AS ownerKind,
            last_used_at AS lastUsedAt, tasks_done AS tasksDone
     FROM open_windows WHERE owner_kind = 'pool' AND state = 'open'`,
  )
  return rows.map(/* 同 listOpenWindows 的映射 */)
}
```

- [ ] **Step 4: 跑测试**

Run: `npm run typecheck && npx vitest run tests/db.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/db.ts tests/db.test.ts
git commit -m "feat: open_windows 增加窗口池状态与使用记录"
```

---

### Task 4: 内存调速纯模块

**Files:**
- Create: `src/engine/memory-governor.ts`
- Create: `tests/memory-governor.test.ts`

**Interfaces:**
- Produces:
  - `computeEffectivePool(input: { freeMb; actualOpen; maxOpenWindows; perWindowMb; reserveMb }): number`
  - `class MemoryGovernor { update(input: { freeMb; actualOpen; maxOpenWindows }): { state; effectivePool; perWindowMb }; recordOpenDelta(deltaMb): void }`

- [ ] **Step 1: 写失败测试**

`tests/memory-governor.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { computeEffectivePool, MemoryGovernor } from '../src/engine/memory-governor'

describe('computeEffectivePool', () => {
  it('硬上限优先；空闲不足按每窗口内存降级', () => {
    expect(computeEffectivePool({ freeMb: 12600, actualOpen: 0, maxOpenWindows: 4, perWindowMb: 1024, reserveMb: 100 })).toBe(4)
    expect(computeEffectivePool({ freeMb: 2048, actualOpen: 0, maxOpenWindows: 4, perWindowMb: 1024, reserveMb: 100 })).toBe(1)
    expect(computeEffectivePool({ freeMb: 1000, actualOpen: 0, maxOpenWindows: 4, perWindowMb: 1024, reserveMb: 100 })).toBe(0)
  })
})

describe('MemoryGovernor', () => {
  it('normal → critical → recover 迟滞', () => {
    const g = new MemoryGovernor({ reserveMb: 100, perWindowMb: 1024, criticalFreeMb: 1024, resumeFreeMb: 2048, checkCount: 3 })
    expect(g.update({ freeMb: 8000, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('normal')
    expect(g.update({ freeMb: 900, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('critical')
    expect(g.update({ freeMb: 2500, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('critical')
    expect(g.update({ freeMb: 2500, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('critical')
    expect(g.update({ freeMb: 2500, actualOpen: 2, maxOpenWindows: 4 }).state).toBe('normal')
  })

  it('开窗实测内存差更新 perWindowMb（EWMA，夹在 512–2048）', () => {
    const g = new MemoryGovernor({ reserveMb: 100, perWindowMb: 1024, criticalFreeMb: 1024, resumeFreeMb: 2048, checkCount: 1 })
    g.recordOpenDelta(3000)
    expect(g.update({ freeMb: 8000, actualOpen: 0, maxOpenWindows: 4 }).perWindowMb).toBe(2048)
    g.recordOpenDelta(100)
    expect(g.update({ freeMb: 8000, actualOpen: 0, maxOpenWindows: 4 }).perWindowMb).toBeGreaterThanOrEqual(512)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/memory-governor.test.ts`

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现模块**

```ts
/**
 * 内存调速（engine 层）：按空闲内存计算有效窗口池，并维护 normal/warning/critical 迟滞与单窗口内存 EWMA
 * 依赖方向：仅依赖标准库；被窗口池调度使用
 */
export type MemoryState = 'normal' | 'warning' | 'critical'

export interface PoolSizingInput {
  freeMb: number
  actualOpen: number
  maxOpenWindows: number
  perWindowMb: number
  reserveMb: number
}

export function computeEffectivePool(input: PoolSizingInput): number {
  const allowance = Math.max(0, Math.floor((input.freeMb - input.reserveMb) / input.perWindowMb))
  return Math.max(0, Math.min(input.maxOpenWindows, input.actualOpen + allowance))
}

export interface MemoryGovernorOptions {
  reserveMb: number
  perWindowMb: number
  criticalFreeMb: number
  resumeFreeMb: number
  checkCount?: number
}

export class MemoryGovernor {
  private state: MemoryState = 'normal'
  private perWindowMb: number
  private healthyChecks = 0
  private readonly checkCount: number

  constructor(private readonly opts: MemoryGovernorOptions) {
    this.perWindowMb = opts.perWindowMb
    this.checkCount = opts.checkCount ?? 3
  }

  recordOpenDelta(deltaMb: number): void {
    if (!Number.isFinite(deltaMb) || deltaMb <= 0) return
    this.perWindowMb = Math.max(512, Math.min(2048, Math.round(this.perWindowMb * 0.7 + deltaMb * 0.3)))
  }

  update(input: { freeMb: number; actualOpen: number; maxOpenWindows: number }): { state: MemoryState; effectivePool: number; perWindowMb: number } {
    const freeMb = Math.max(0, input.freeMb)
    if (freeMb < this.opts.criticalFreeMb) {
      this.state = 'critical'
      this.healthyChecks = 0
    } else if (freeMb >= this.opts.resumeFreeMb) {
      this.healthyChecks++
      if (this.healthyChecks >= this.checkCount) this.state = 'normal'
    } else if (freeMb < this.opts.reserveMb + this.perWindowMb) {
      this.state = 'warning'
      this.healthyChecks = 0
    }
    const effectivePool = computeEffectivePool({
      freeMb,
      actualOpen: input.actualOpen,
      maxOpenWindows: input.maxOpenWindows,
      perWindowMb: this.perWindowMb,
      reserveMb: this.opts.reserveMb,
    })
    return { state: this.state, effectivePool, perWindowMb: this.perWindowMb }
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/memory-governor.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/engine/memory-governor.ts tests/memory-governor.test.ts
git commit -m "feat: 新增内存调速模块"
```

---

### Task 5: 全局健康门禁模块

**Files:**
- Create: `src/engine/global-health.ts`
- Create: `tests/global-health.test.ts`

**Interfaces:**
- Produces:
  - `type GlobalHealthState = 'normal' | 'paused' | 'probing'`
  - `class GlobalHealthGate { canOpen(nowMs): boolean; recordEnvironmentFailure(windowId, nowMs): GlobalHealthState; recordProbeSuccess(): void; recordProbeFailure(nowMs): GlobalHealthState; state: GlobalHealthState; nextProbeMs: number | null }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { GlobalHealthGate } from '../src/engine/global-health'

describe('GlobalHealthGate', () => {
  it('不同窗口环境失败达到阈值后暂停；冷却后进入 probing，成功恢复', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 3, backoffSec: [30, 60], probeEnabled: true })
    expect(g.canOpen(0)).toBe(true)
    g.recordEnvironmentFailure('w1', 1000)
    g.recordEnvironmentFailure('w2', 2000)
    expect(g.canOpen(3000)).toBe(true)
    expect(g.recordEnvironmentFailure('w3', 3000)).toBe('paused')
    expect(g.canOpen(10_000)).toBe(false)
    expect(g.canOpen(33_001)).toBe(true) // 进入 probing，允许一次探测
    expect(g.state).toBe('probing')
    g.recordProbeSuccess()
    expect(g.state).toBe('normal')
    expect(g.canOpen(40_000)).toBe(true)
  })

  it('同一窗口重复失败不重复计数；探测失败按退避下一次', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 2, backoffSec: [30, 60], probeEnabled: true })
    g.recordEnvironmentFailure('w1', 0)
    g.recordEnvironmentFailure('w1', 1000)
    expect(g.canOpen(2000)).toBe(true)
    g.recordEnvironmentFailure('w2', 2000)
    expect(g.state).toBe('paused')
    expect(g.canOpen(32_001)).toBe(true)
    g.recordProbeFailure(32_001)
    expect(g.state).toBe('paused')
    expect(g.canOpen(32_001 + 60_000)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/global-health.test.ts`

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现模块**

```ts
/**
 * 全局健康门禁（engine 层）：多窗口环境失败聚合 → 暂停窗口池 → 指数退避 → half-open 探测
 * 依赖方向：仅依赖标准库；被窗口池调度使用
 */
export type GlobalHealthState = 'normal' | 'paused' | 'probing'

export interface GlobalHealthConfig {
  windowSec: number
  threshold: number
  backoffSec: number[]
  probeEnabled: boolean
}

export class GlobalHealthGate {
  state: GlobalHealthState = 'normal'
  nextProbeMs: number | null = null
  private failures = new Map<string, number>()
  private level = 0

  constructor(private readonly cfg: GlobalHealthConfig) {}

  canOpen(nowMs: number): boolean {
    if (this.state === 'paused' && this.cfg.probeEnabled && this.nextProbeMs != null && nowMs >= this.nextProbeMs) {
      this.state = 'probing'
      return true
    }
    return this.state === 'normal'
  }

  recordEnvironmentFailure(windowId: string, nowMs: number): GlobalHealthState {
    this.failures.set(windowId, nowMs)
    for (const [id, at] of this.failures) {
      if (nowMs - at > this.cfg.windowSec * 1000) this.failures.delete(id)
    }
    if (this.state === 'normal' && this.failures.size >= this.cfg.threshold) {
      this.state = 'paused'
      this.level = 0
      this.nextProbeMs = nowMs + this.backoffMs()
    }
    return this.state
  }

  recordProbeSuccess(): void {
    this.state = 'normal'
    this.failures.clear()
    this.level = 0
    this.nextProbeMs = null
  }

  recordProbeFailure(nowMs: number): GlobalHealthState {
    this.state = 'paused'
    this.level = Math.min(this.level + 1, this.cfg.backoffSec.length - 1)
    this.nextProbeMs = nowMs + this.backoffMs()
    return this.state
  }

  private backoffMs(): number {
    const sec = this.cfg.backoffSec[Math.min(this.level, this.cfg.backoffSec.length - 1)] ?? 30
    return sec * 1000
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/global-health.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/engine/global-health.ts tests/global-health.test.ts
git commit -m "feat: 新增全局健康门禁模块"
```

---

### Task 6: 开窗/关窗串行队列、状态协议与孤儿回收修正

**Files:**
- Create: `src/engine/serial-queue.ts`
- Create: `tests/serial-queue.test.ts`
- Modify: `src/engine/window-runner.ts:520-601`
- Modify: `src/engine/window-registry.ts`
- Modify: `src/app.ts`（把 serial queue 注入 WindowRunner）
- Modify: `tests/window-registry.test.ts`
- Modify: `tests/windowRunner.test.ts`

**Interfaces:**
- Produces:
  - `class SerialQueue { run<T>(fn: () => Promise<T>): Promise<T> }`（带冷却）
  - `WindowRunnerDeps.openCloseQueue: SerialQueue`
  - `open_windows.state` 在开窗/关窗路径中正确转移；关窗等待 pids 消失。
- Consumes: Task 3 的 `setWindowState` / `touchWindowUsed`、Task 2 的 `openCooldownMs`。

- [ ] **Step 1: 写串行队列测试**

```ts
import { describe, it, expect } from 'vitest'
import { SerialQueue } from '../src/engine/serial-queue'

it('同一时刻只执行一个任务，且按 FIFO', async () => {
  const q = new SerialQueue(0)
  const order: string[] = []
  await Promise.all([
    q.run(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a') }),
    q.run(async () => { order.push('b') }),
  ])
  expect(order).toEqual(['a', 'b'])
})
```

- [ ] **Step 2: 实现 SerialQueue**

```ts
/** 串行队列（engine 层）：同一时刻只执行一个异步操作，可选操作间冷却；用于比特开/关窗 API */
export class SerialQueue {
  private chain: Promise<void> = Promise.resolve()
  private lastFinishedAt = 0

  constructor(private readonly cooldownMs = 0) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const wait = this.lastFinishedAt + this.cooldownMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      return await fn()
    } finally {
      this.lastFinishedAt = Date.now()
      release()
    }
  }
}
```

- [ ] **Step 3: WindowRunner 注入并使用串行队列**

`src/app.ts` 构造 `const openCloseQueue = new SerialQueue(cfg.execution.windowPool.openCooldownMs)` 并传给 `new WindowRunner({ ... openCloseQueue })`。

`WindowRunnerDeps` 增加：

```ts
/** 比特 open/close 串行队列（避免异步开窗/关闭互相踩踏与 API 限频） */
openCloseQueue: SerialQueue
```

`openWithRetry` 中每次 open/close 都经队列：

```ts
return await this.deps.openCloseQueue.run(() => this.deps.bitbrowser.openBrowser(id))
```

`closeWindowSafely` 改为：

```ts
private async closeWindowSafely(bitbrowserId: string, reason: string): Promise<void> {
  try {
    await this.deps.db.setWindowState(bitbrowserId, 'closing').catch(() => {})
    await this.deps.openCloseQueue.run(() => this.deps.bitbrowser.closeBrowser(bitbrowserId))
    // 等 pids 真正消失；超时保留 closing 行，交由对账/孤儿回收后台重试
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const alive = await this.deps.bitbrowser.openPids([bitbrowserId]).catch(() => new Set<string>())
      if (!alive.has(bitbrowserId)) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  } catch (e) {
    this.deps.logger.warn({ bitbrowserId, reason, err: (e as Error).message }, '关窗失败（窗口可能残留）')
  }
}
```

开窗成功后 `setOpenWindow(..., 'open')`；失败清行。成功/失败会话 finally 中不再直接 `clearOpenWindow` 前，先 `setWindowState('closing')`，由 `closeWindowSafely` 完成后清行；`reusedFlag` 不关窗，保持 `open`。

- [ ] **Step 4: 孤儿回收跳过 opening/closing**

`src/engine/window-registry.ts`：

- `OpenWindowRow` 增加 `state` 后，`reclaimOrphanWindows` 只处理 `state === 'open'` 的行；`opening/closing` 直接跳过。
- 对“存活但无登记”的窗口，保留现有回收，但增加最小年龄：无法判定年龄时跳过（Phase 2 再用 opened_at）；Phase 1 只处理有登记且 owner dead 的窗口，避免误关正在打开的窗口。

```ts
for (const id of alive) {
  const row = byId.get(id)
  if (row && row.state !== 'open') continue
  const ownerDead = row?.ownerPid != null && !isProcessAlive(row.ownerPid)
  if (row && ownerDead) { /* 关闭 + 清行 */ }
}
```

- [ ] **Step 5: 更新测试**

`tests/window-registry.test.ts`：新增 opening/closing 行不被回收；owner dead 的 open 行被回收。
`tests/windowRunner.test.ts`：断言关窗失败/成功路径调用 `setWindowState`、`openCloseQueue`；复用窗口不关。

- [ ] **Step 6: 跑测试**

Run: `npm run typecheck && npx vitest run tests/serial-queue.test.ts tests/window-registry.test.ts tests/windowRunner.test.ts`

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/engine/serial-queue.ts tests/serial-queue.test.ts src/engine/window-runner.ts src/engine/window-registry.ts src/app.ts tests/window-registry.test.ts tests/windowRunner.test.ts
git commit -m "fix: 串行化开窗/关窗并修正窗口状态与孤儿回收"
```

---

### Task 7: 文档同步与 Phase 1 验收

**Files:**
- Modify: `docs/API-GUIDE.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-10-22-window-pool-scheduler-design.md`（仅状态标记，可选）

- [ ] **Step 1: 更新配置速查**

`docs/API-GUIDE.md` 第 7 章删除 stagger 两项，增加 `execution.windowPool.*` 与 `execution.health.*` 的说明（标明 Phase 2 启用、`enabled` 默认 false；`maxConcurrentWindows` 暂保留）。

- [ ] **Step 2: 更新 AGENTS.md**

删除“批量触发/rerun/定时错峰”的旧描述，改为：

```md
- 触发即写 `pending`，不再按窗口铺开；开窗节奏由窗口池/开窗冷却控制（`execution.windowPool`，Phase 2 启用）。
- `not_before_ms` 只用于失败重试退避，不用于初始错峰。
- 开窗/关窗统一经 `SerialQueue` 串行，关窗要等 pids 消失；`open_windows.state` 区分 opening/open/closing。
```

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck && npm test`

Expected: 所有用例 PASS。

- [ ] **Step 4: Commit**

```bash
git add docs/API-GUIDE.md AGENTS.md
git commit -m "docs: 同步 Phase 1 窗口治理配置与错峰移除"
```

---

## Phase 1 验收标准

- 批量触发/rerun/定时触发不再按窗口铺开；`not_before_ms` 不再用于初始错峰。
- `windowPool` / `health` 配置可加载、非法值回退并告警；`enabled` 默认 false，不影响 Phase 2 前行为。
- `open_windows` 能区分 opening/open/closing、pool/manual/taskrun，并记录 last_used_at/tasks_done。
- 内存调速与全局健康门禁模块有完整单测，可被 Phase 2 直接调用。
- 开窗/关窗串行；关窗等 pids 消失；孤儿回收不再误关 opening/closing 窗口。
- `npm run typecheck` 与 `npm test` 通过。
- 真机：手动触发两个任务时不再出现同时开窗风暴；关窗失败不再立即清登记导致孤儿回收循环。

## 后续计划

- Phase 2（窗口池调度）：`WindowRunner` keep-open/单任务会话、池调度器、窗口队列/轮转/寿命回收、定时入队幂等、面板池状态。Phase 1 验收后单独写 plan。
- Phase 3（清理调优）：移除 `maxConcurrentWindows`、`meta.concurrency`、旧 claim 代码；按真机校准 `perWindowMb`/`idleCloseSec`/`windowMaxLifetimeSec`。

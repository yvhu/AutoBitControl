# 看板「运行批次」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「一次触发动作」变成看板的一级维度：后端落批次（batches 表 + runs.batch_id），前端看板从「日期 + slot 折叠矩阵」重构为「批次时间线」。

**Architecture:** 触发入口创建批次 → batchId 沿 enqueue → 窗口会话透传 → window-runner 预写 pending 行时写入 batchId（此后一切 upsert 用 COALESCE 沿用）→ 新 batches 路由聚合出批次列表/详情 → 前端批次时间线渲染。

**Tech Stack:** Node + TS（tsx）、Turso libsql、Express 5 + swagger-jsdoc、React 18 + antd 5 + react-query、vitest（后端 tests/ + 前端 web/ 各一套）。

**Spec:** `docs/superpowers/specs/2026-09-04-run-batches-design.md`

## Global Constraints

- 无分号、单引号、2 空格缩进、TS 严格模式；注释/日志/commit 全部中文
- 每个任务完成时验证：`npm run typecheck`、`npm test`（后端）、`npm run test:web`（前端）
- 测试不连真库：`file::memory:` 或注入 mock（见 tests/db.test.ts / web.test.ts 既有模式）
- API 统一 `{code, message, data}` envelope：用 `ok(res, data)` + `HttpError`（server/http/response.ts）
- 前端请求只走 `web/src/api/client.ts` / `endpoints.ts`；页面 hooks 放 `pages/<页>/hooks.ts` 配单测
- commit 风格 conventional 中文：`feat:` / `refactor:` / `test:` 等
- 批次命名：`kind` 取值 `'bulk' | 'single'`；`source` 取值 `'trigger-all' | 'trigger-single' | 'task-run'`；时间统一 `localWallNow()` 口径
- 重试归原批次：重试/恢复 enqueue 带原 `batchId`；window-runner 只在预写 pending 时写 batchId，后续 upsert 一律不传（COALESCE 保留）

---

### Task 1: db 层——batches 表、runs.batch_id 迁移与批次查询

**Files:**
- Modify: `src/infrastructure/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: 现有 `AppDb` 结构、`RunStatus`、`localWallNow`
- Produces:
  - `export interface BatchRow { id: number; kind: 'bulk' | 'single'; taskKey: string; source: string; createdAt: string }`
  - `export interface BatchStats { total: number; success: number; failed: number; captchaFailed: number; skipped: number; running: number; pending: number }`
  - `RunRow` 增加字段 `batchId: number | null`（SELECT_RUN 加 `r.batch_id AS batchId` 与 `p.bitbrowser_id AS bitbrowserId`）
  - `AppDb.createBatch(kind, taskKey, source, createdAt?) => Promise<BatchRow>`
  - `AppDb.getBatch(id: number) => Promise<BatchRow | null>`
  - `AppDb.listBatchesForRange(from: string | null, to: string) => Promise<Array<BatchRow & { stats: BatchStats }>>`（按 createdAt 倒序）
  - `AppDb.listRunsForBatch(batchId: number) => Promise<RunRow[]>`
  - `AppDb.listUnbatchedRuns(from: string | null, to: string) => Promise<RunRow[]>`（batch_id IS NULL 且 date 在区间）
  - `upsertRun` 的 `patch` 支持 `batchId?: number | null`，ON CONFLICT 时 `batch_id = COALESCE(excluded.batch_id, runs.batch_id)`

- [ ] **Step 1: 写失败测试**（tests/db.test.ts 末尾新增 describe）

```ts
describe('批次（batches）', () => {
  it('createBatch 落库并可读回', async () => {
    const b = await db.createBatch('bulk', 't1', 'trigger-all')
    expect(b.id).toBeGreaterThan(0)
    expect(b.kind).toBe('bulk')
    expect(b.taskKey).toBe('t1')
    expect(b.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })

  it('upsertRun 带 batchId 写入新行；不带 batchId 更新时沿用旧值', async () => {
    const p = await db.upsertProfile('bb-1', '窗口1')
    const b1 = await db.createBatch('bulk', 't1', 'trigger-all')
    const b2 = await db.createBatch('single', 't1', 'trigger-single')
    await db.upsertRun(p.id, 't1', '2026-09-04', 0, 'pending', { batchId: b1.id })
    // 不带 batchId 更新（续跑）→ 保留 b1
    const r = await db.upsertRun(p.id, 't1', '2026-09-04', 0, 'success', { attempts: 1 })
    expect(r.batchId).toBe(b1.id)
    // 新 slot 带 batchId b2 → 写入 b2
    const r2 = await db.upsertRun(p.id, 't1', '2026-09-04', 1, 'pending', { batchId: b2.id })
    expect(r2.batchId).toBe(b2.id)
    // 不带 batchId 的新行 → null
    const r3 = await db.upsertRun(p.id, 't2', '2026-09-04', 0, 'running')
    expect(r3.batchId).toBeNull()
  })

  it('listBatchesForRange 按时间倒序返回批次并聚合状态统计', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    const b1 = await db.createBatch('bulk', 't1', 'trigger-all', '2026-09-04 08:00:00.000')
    const b2 = await db.createBatch('bulk', 't2', 'trigger-all', '2026-09-04 09:00:00.000')
    const b3 = await db.createBatch('bulk', 't3', 'trigger-all', '2026-09-05 09:00:00.000')
    await db.upsertRun(p1.id, 't1', '2026-09-04', 0, 'success', { batchId: b1.id })
    await db.upsertRun(p2.id, 't1', '2026-09-04', 0, 'failed', { batchId: b1.id })
    await db.upsertRun(p1.id, 't2', '2026-09-04', 0, 'running', { batchId: b2.id })
    await db.upsertRun(p1.id, 't3', '2026-09-05', 0, 'success', { batchId: b3.id })
    const list = await db.listBatchesForRange('2026-09-04', '2026-09-04')
    expect(list.map((b) => b.id)).toEqual([b2.id, b1.id])
    expect(list[1].stats.total).toBe(2)
    expect(list[1].stats.success).toBe(1)
    expect(list[1].stats.failed).toBe(1)
    expect(list[0].stats.running).toBe(1)
  })

  it('listBatchesForRange from=null 查全部区间', async () => {
    const b1 = await db.createBatch('bulk', 't1', 'trigger-all', '2026-08-01 08:00:00.000')
    await db.createBatch('single', 't2', 'trigger-single', '2026-09-04 09:00:00.000')
    const list = await db.listBatchesForRange(null, '2026-09-04')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBeGreaterThan(b1.id)
  })

  it('listRunsForBatch 返回该批次全部 run 行（含 profileName/bitbrowserId）', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    const b = await db.createBatch('bulk', 't1', 'trigger-all')
    await db.upsertRun(p1.id, 't1', '2026-09-04', 0, 'success', { batchId: b.id })
    await db.upsertRun(p2.id, 't1', '2026-09-04', 0, 'failed', { batchId: b.id })
    const rows = await db.listRunsForBatch(b.id)
    expect(rows).toHaveLength(2)
    expect(rows[0].profileName).toBe('A')
    expect(rows[0].bitbrowserId).toBe('bb-1')
    expect(rows[0].batchId).toBe(b.id)
  })

  it('listUnbatchedRuns 返回区间内 batch_id IS NULL 的行', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    const b = await db.createBatch('bulk', 't1', 'trigger-all')
    await db.upsertRun(p1.id, 't1', '2026-09-04', 0, 'success', { batchId: b.id })
    await db.upsertRun(p1.id, 't2', '2026-09-04', 0, 'success')
    await db.upsertRun(p1.id, 't2', '2026-09-01', 0, 'success')
    const rows = await db.listUnbatchedRuns('2026-09-04', '2026-09-04')
    expect(rows).toHaveLength(1)
    expect(rows[0].taskKey).toBe('t2')
  })

  it('老库 runs 无 batch_id 列时 migrate 自动补列', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-batch-'))
    const file = join(dir, 'app.db')
    const raw = createClient({ url: `file:${file}` })
    await raw.execute(`CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, bitbrowser_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, circuit_breaker_count INTEGER NOT NULL DEFAULT 0)`)
    await raw.execute(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, task_key TEXT NOT NULL, date TEXT NOT NULL, slot INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, screenshot TEXT, started_at TEXT, finished_at TEXT, UNIQUE(profile_id, task_key, date, slot))`)
    raw.close()
    const legacy = await AppDb.open({ url: `file:${file}`, authToken: '' })
    const info = await (legacy as unknown as { client: { execute: (sql: string) => Promise<{ rows: Array<{ name: string }> }> } }).client.execute(`PRAGMA table_info(runs)`)
    expect(info.rows.map((r) => r.name)).toContain('batch_id')
    const b = await legacy.createBatch('bulk', 't', 'trigger-all')
    expect(b.id).toBeGreaterThan(0)
    legacy.close()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/db.test.ts -t "批次"`
Expected: FAIL（createBatch 不存在 / batchId 未定义）

- [ ] **Step 3: 实现 db.ts 改动**

`RunRow` 接口加字段（在 `slot: number` 后）：

```ts
  /** 所属批次 id（NULL = 老数据未分批） */
  batchId: number | null
  /** JOIN profiles 得到的窗口比特 id（行级执行用） */
  bitbrowserId: string
```

`SELECT_RUN` 改为：

```ts
const SELECT_RUN = `SELECT r.id, r.profile_id AS profileId, r.task_key AS taskKey, r.date, r.slot, r.status, r.attempts, r.error, r.screenshot, r.started_at AS startedAt, r.finished_at AS finishedAt, r.batch_id AS batchId, p.name AS profileName, p.bitbrowser_id AS bitbrowserId FROM runs r JOIN profiles p ON p.id = r.profile_id`
```

SCHEMA 数组（`captcha_logs` 之前）加：

```ts
  `CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    task_key TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batches_created_at ON batches(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_batch_id ON runs(batch_id)`,
```

注意：`idx_runs_batch_id` 引用了还没补的列——SQLite 建索引时不校验列存在与否，但为了顺序清晰，把 `CREATE INDEX IF NOT EXISTS idx_runs_batch_id` 放到 `migrate()` 的补列逻辑之后执行，不要放进 SCHEMA 数组。SCHEMA 里只放 batches 表与 `idx_batches_created_at`。

`migrate()` 在 runs 重建逻辑之后加补列：

```ts
    // 老库补列：runs.batch_id（批次归属，可空；不参与 UNIQUE，直接 ADD COLUMN 无需重建表）
    const runsInfo2 = await this.client.execute(`PRAGMA table_info(runs)`)
    if (!runsInfo2.rows.some((r) => String(r.name) === 'batch_id')) {
      await this.client.execute(`ALTER TABLE runs ADD COLUMN batch_id INTEGER`)
      await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_runs_batch_id ON runs(batch_id)`)
    }
```

`upsertRun` SQL 改为：

```ts
      `INSERT INTO runs (profile_id, task_key, date, slot, status, attempts, error, screenshot, started_at, finished_at, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, task_key, date, slot) DO UPDATE SET
         status = excluded.status,
         attempts = CASE WHEN excluded.attempts = 0 THEN runs.attempts ELSE excluded.attempts END,
         error = excluded.error,
         screenshot = excluded.screenshot, started_at = COALESCE(excluded.started_at, runs.started_at),
         finished_at = COALESCE(excluded.finished_at, runs.finished_at),
         batch_id = COALESCE(excluded.batch_id, runs.batch_id)`,
      [profileId, taskKey, date, slot, status, patch.attempts ?? 0, patch.error ?? null, patch.screenshot ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, patch.batchId ?? null],
```

在 `upsertRun` 之后加新方法：

```ts
  /** 创建批次（每次触发动作一行）；createdAt 缺省当前本地墙钟时间 */
  async createBatch(kind: 'bulk' | 'single', taskKey: string, source: string, createdAt = localWallNow()): Promise<BatchRow> {
    const rs = await this.client.execute({
      sql: 'INSERT INTO batches (kind, task_key, source, created_at) VALUES (?, ?, ?, ?)',
      args: [kind, taskKey, source, createdAt],
    })
    const rows = await this.exec('SELECT id, kind, task_key AS taskKey, source, created_at AS createdAt FROM batches WHERE id = ?', [Number(rs.lastInsertRowid)])
    return rows[0] as unknown as BatchRow
  }

  /** 按 id 查批次行（不存在返回 null） */
  async getBatch(id: number): Promise<BatchRow | null> {
    const rows = await this.exec('SELECT id, kind, task_key AS taskKey, source, created_at AS createdAt FROM batches WHERE id = ?', [id])
    return (rows[0] as unknown as BatchRow | undefined) ?? null
  }

  /** 时间段内的批次列表（含每批状态聚合）；createdAt 倒序；from=null 表示不设下界 */
  async listBatchesForRange(from: string | null, to: string): Promise<Array<BatchRow & { stats: BatchStats }>> {
    const rows = await this.exec(
      `SELECT b.id, b.kind, b.task_key AS taskKey, b.source, b.created_at AS createdAt, r.status, COUNT(r.id) AS c
       FROM batches b LEFT JOIN runs r ON r.batch_id = b.id
       WHERE date(b.created_at) >= COALESCE(date(?), '0000-01-01') AND date(b.created_at) <= date(?)
       GROUP BY b.id, r.status
       ORDER BY b.created_at DESC, b.id DESC`,
      [from, to],
    )
    const list: Array<BatchRow & { stats: BatchStats }> = []
    const byId = new Map<number, BatchRow & { stats: BatchStats }>()
    for (const r of rows) {
      const id = Number(r.id)
      let item = byId.get(id)
      if (!item) {
        item = {
          id,
          kind: String(r.kind) as 'bulk' | 'single',
          taskKey: String(r.taskKey),
          source: String(r.source),
          createdAt: String(r.createdAt),
          stats: { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0 },
        }
        byId.set(id, item)
        list.push(item)
      }
      const n = Number(r.c)
      item.stats.total += n
      const s = String(r.status) as RunStatus
      if (s === 'success') item.stats.success += n
      else if (s === 'failed') item.stats.failed += n
      else if (s === 'captcha_failed') item.stats.captchaFailed += n
      else if (s === 'skipped') item.stats.skipped += n
      else if (s === 'running' || s === 'retry_wait') item.stats.running += n
      else if (s === 'pending') item.stats.pending += n
    }
    return list
  }

  /** 某批次的全部 run 行（窗口明细；按窗口与任务排序） */
  async listRunsForBatch(batchId: number): Promise<RunRow[]> {
    return (await this.exec(`${SELECT_RUN} WHERE r.batch_id = ? ORDER BY p.id, r.task_key, r.slot`, [batchId])) as unknown as RunRow[]
  }

  /** 区间内未分批的 run 行（老数据 batch_id IS NULL）；from=null 不设下界 */
  async listUnbatchedRuns(from: string | null, to: string): Promise<RunRow[]> {
    return (await this.exec(
      `${SELECT_RUN} WHERE r.batch_id IS NULL AND date(r.date) >= COALESCE(?, '0000-01-01') AND date(r.date) <= date(?) ORDER BY p.id, r.task_key, r.slot`,
      [from, to],
    )) as unknown as RunRow[]
  }
```

在文件头类型区（`RunStatus` 之后）加：

```ts
/** batches 表行：一次触发动作 */
export interface BatchRow {
  id: number
  kind: 'bulk' | 'single'
  taskKey: string
  source: string
  createdAt: string
}

/** 批次状态统计（列表接口聚合用；total 含全部行数） */
export interface BatchStats {
  total: number
  success: number
  failed: number
  captchaFailed: number
  skipped: number
  running: number
  pending: number
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/db.test.ts`
Expected: 全部 PASS（含旧用例——注意旧用例里 `runs` 老库迁移测试不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/db.ts tests/db.test.ts
git commit -m "feat: db 增加批次表与 runs.batch_id（创建/区间查询/未分批查询）"
```

---

### Task 2: queue——Entry 任务列表携带 batchId

**Files:**
- Modify: `src/engine/queue.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: Task 1 无直接依赖（只改内存结构）
- Produces:
  - `export interface SessionTask { taskKey: string; batchId?: number }`
  - `enqueue(profile, taskKey, opts?: { immediate?: boolean; batchId?: number })`（签名不变，opts 扩展）
  - `runner.runWindowTasks(profile, tasks: SessionTask[])` 的新调用约定
  - 新方法 `pendingCount(): number`（错峰等待中的窗口数，供路由计算「实时运行」）

- [ ] **Step 1: 更新失败测试**（tests/queue.test.ts）

现有断言 `run.mock.calls[1][1]).toEqual(['task-b'])` 等全部改为对象数组。逐个改：

```ts
it('同一窗口多任务合并为一次会话（各占各自任务额度）', async () => {
  const run = vi.fn().mockResolvedValue(undefined)
  const enq = makeEnq(run)
  const p = mk(1, 'bb-1')
  enq.enqueue(p, 'task-a')
  enq.enqueue(p, 'task-b', { batchId: 7 })
  enq.enqueue(p, 'task-c')
  await tick()
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0][1]).toEqual([{ taskKey: 'task-a' }, { taskKey: 'task-b', batchId: 7 }, { taskKey: 'task-c' }])
})

it('batchId 随 enqueue 透传并在 followUp 重入队时保留', async () => {
  let releaseFirst: () => void = () => {}
  const firstGate = new Promise<void>((r) => { releaseFirst = r })
  const run = vi.fn((profile: { id: number }) => {
    if (run.mock.calls.length === 1) return firstGate.then(() => undefined)
    return Promise.resolve(undefined)
  })
  const enq = makeEnq(run)
  const profile = mk(1, 'bb-1')
  enq.enqueue(profile, 'task-a')
  await tick()
  enq.enqueue(profile, 'task-b', { batchId: 9 })
  await tick()
  expect(run).toHaveBeenCalledTimes(1)
  releaseFirst()
  await tick()
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[1][1]).toEqual([{ taskKey: 'task-b', batchId: 9 }])
})

it('pendingCount 返回错峰等待中的窗口数', async () => {
  const run = vi.fn().mockResolvedValue(undefined)
  const enq = makeEnq(run, () => 4, 1000)
  enq.enqueue(mk(1, 'bb-1'), 'task-a')
  enq.enqueue(mk(2, 'bb-2'), 'task-a')
  expect(enq.pendingCount()).toBe(2)
  await tick()
})
```

其余用例中 `_taskKeys: string[]` 参数声明改成 `_tasks: Array<{ taskKey: string }>`；断言 `expect(run.mock.calls[1][1]).toEqual(['task-b'])` → `toEqual([{ taskKey: 'task-b' }])`；`['task-a', 'task-b', 'task-c']` → `[{ taskKey: 'task-a' }, { taskKey: 'task-b' }, { taskKey: 'task-c' }]`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/queue.test.ts`
Expected: FAIL（TypeError：entry.tasks 未定义等）

- [ ] **Step 3: 实现 queue.ts 改动**

文件头注释与类型：

```ts
/** 窗口会话要跑的一个任务（batchId 可选：重试恢复等场景不带） */
export interface SessionTask {
  taskKey: string
  batchId?: number
}

/** 一个窗口的合并任务条目 */
interface Entry {
  profile: ProfileRow
  tasks: SessionTask[]
  /** 单窗口手动入口（看板行级执行/重跑）标记：跳过错峰立即投递 */
  immediate?: boolean
}
```

所有 `taskKeys: Set<string>` 改为 `tasks: SessionTask[]`，辅助函数：

```ts
  /** 条目内是否已含某任务（去重用） */
  private static hasTask(entry: Entry | undefined, taskKey: string): boolean {
    return !!entry?.tasks.some((t) => t.taskKey === taskKey)
  }

  /** 追加任务到条目（去重） */
  private static addTask(entry: Entry, taskKey: string, batchId?: number): void {
    if (entry.tasks.some((t) => t.taskKey === taskKey)) return
    entry.tasks.push(batchId === undefined ? { taskKey } : { taskKey, batchId })
  }
```

`enqueue`：

```ts
  enqueue(profile: ProfileRow, taskKey: string, opts?: { immediate?: boolean; batchId?: number }): void {
    // 窗口正在跑：追加到 followUp，本轮结束后统一重排（不能进 pending，见类注释）
    if (this.running.has(profile.id)) {
      const fu = this.followUp.get(profile.id) ?? { profile, tasks: [] }
      CoalescingEnqueuer.addTask(fu, taskKey, opts?.batchId)
      if (opts?.immediate) fu.immediate = true
      this.followUp.set(profile.id, fu)
      return
    }
    // 已排队未启动：同窗口同任务去重（并发触发竞态下防止额度重复占用与同窗口双跑）
    if (CoalescingEnqueuer.hasTask(this.pending.get(profile.id), taskKey)) return
    const gate = this.gateFor(taskKey)
    // 额度已满：进等待队列（同窗口同任务去重），额度释放后滚动续跑
    if (gate.active >= gate.concurrency) {
      const dup = gate.waiting.find((e) => e.profile.id === profile.id && e.tasks.some((t) => t.taskKey === taskKey))
      if (dup) {
        // 同窗口同任务已在等待：升级 immediate 标记（手动入口要求不等待错峰）
        if (opts?.immediate) dup.immediate = true
      } else {
        gate.waiting.push({ profile, tasks: [{ taskKey, ...(opts?.batchId === undefined ? {} : { batchId: opts.batchId }) }], immediate: opts?.immediate })
      }
      return
    }
    this.occupy(taskKey, profile, opts?.immediate, opts?.batchId)
  }
```

`occupy`：

```ts
  private occupy(taskKey: string, profile: ProfileRow, immediate = false, batchId?: number): void {
    const gate = this.gateFor(taskKey)
    const entry = this.pending.get(profile.id)
    if (entry) {
      // 纵深去重：并发触发竞态下同窗口同任务已在 pending 时不重复占额度（不双跑、不泄漏）
      if (entry.tasks.some((t) => t.taskKey === taskKey)) return
      // 已排入错峰等待的条目按原调度时间开窗：immediate 不回溯改写（定时器已排，标志无效）
      CoalescingEnqueuer.addTask(entry, taskKey, batchId)
      gate.active++
      return
    }
    gate.active++
    const fresh: Entry = { profile, tasks: [{ taskKey, ...(batchId === undefined ? {} : { batchId }) }], immediate }
    this.pending.set(profile.id, fresh)
    if (fresh.immediate) {
      this.dispatch(fresh)
      return
    }
    const delayMs = Math.floor(Math.random() * this.staggerMaxSec * 1000)
    if (delayMs <= 0) {
      this.dispatch(fresh)
    } else {
      setTimeout(() => this.dispatch(fresh), delayMs)
    }
  }
```

`dispatch` 内两处：

```ts
      this.pending.delete(entry.profile.id)
      this.running.set(entry.profile.id, new Set(entry.tasks.map((t) => t.taskKey)))
      try {
        await this.runner.runWindowTasks(entry.profile, entry.tasks)
```

```ts
      const fu = this.followUp.get(entry.profile.id)
      if (fu) {
        this.followUp.delete(entry.profile.id)
        for (const t of fu.tasks) this.enqueue(fu.profile, t.taskKey, { immediate: fu.immediate, batchId: t.batchId })
      }
      // 释放本会话各任务额度并滚动续跑等待队列
      for (const t of entry.tasks) this.release(t.taskKey)
```

`release` 内 followUp 追加改 `CoalescingEnqueuer.addTask(fu, taskKey, next.immediate && next.tasks.length > 0 ? undefined : undefined)` —— 不对，waiting 条目升级到 followUp 时要携带 batchId：

```ts
    if (this.running.has(next.profile.id)) {
      const fu = this.followUp.get(next.profile.id) ?? { profile: next.profile, tasks: [] }
      const t = next.tasks.find((x) => x.taskKey === taskKey)
      CoalescingEnqueuer.addTask(fu, taskKey, t?.batchId)
      if (next.immediate) fu.immediate = true
      this.followUp.set(next.profile.id, fu)
      return
    }
    this.occupy(taskKey, next.profile, next.immediate, next.tasks.find((x) => x.taskKey === taskKey)?.batchId)
```

`hasTaskInFlight` 里全部 `taskKeys` 引用改 `tasks`：

```ts
  private hasTask = (keys: SessionTask[] | undefined, taskKey: string) => !!keys?.some((t) => t.taskKey === taskKey)
```

然后替换各处：

```ts
  hasTaskInFlight(taskKey: string, profileId?: number): boolean {
    if (profileId !== undefined) {
      if (this.hasTask(this.pending.get(profileId)?.tasks, taskKey)) return true
      if (this.running.get(profileId)?.has(taskKey)) return true
      if (this.hasTask(this.followUp.get(profileId)?.tasks, taskKey)) return true
      return this.gates.get(taskKey)?.waiting.some((e) => e.profile.id === profileId) ?? false
    }
    for (const e of this.pending.values()) if (this.hasTask(e.tasks, taskKey)) return true
    for (const keys of this.running.values()) if (keys.has(taskKey)) return true
    for (const e of this.followUp.values()) if (this.hasTask(e.tasks, taskKey)) return true
    return (this.gates.get(taskKey)?.waiting.length ?? 0) > 0
  }
```

新增（`hasTaskInFlight` 之前）：

```ts
  /** 错峰等待中的窗口数（已入队未开窗；路由层「实时运行」口径的队列部分） */
  pendingCount(): number {
    return this.pending.size
  }
```

`runner` 字段类型同步改为 `{ runWindowTasks(profile: ProfileRow, tasks: SessionTask[]): Promise<unknown> }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/queue.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/queue.ts tests/queue.test.ts
git commit -m "refactor: 队列条目任务携带 batchId（Set 改 SessionTask 数组）"
```

---

### Task 3: window-runner——batchId 透传 + pending 预写

**Files:**
- Modify: `src/engine/window-runner.ts`
- Modify: `src/engine/retry-recovery.ts`（enqueue 带原 batchId）
- Modify: `src/app.ts`（scheduleRetry 透传 batchId）
- Test: `tests/windowRunner.test.ts`、`tests/retry-recovery.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `upsertRun(patch.batchId)`、Task 2 的 `SessionTask`
- Produces:
  - `runWindowTasks(profile, tasks: SessionTask[])`
  - `runManual(bitbrowserId, taskKey, batchId?)`
  - `WindowRunnerDeps.scheduleRetry(profile, taskKey, delayMs, batchId?)`

- [ ] **Step 1: 写失败测试**（tests/windowRunner.test.ts 新增 describe，文件头注释说明）

```ts
describe('批次透传与 pending 预写', () => {
  it('新轮次会话启动时预写 pending 行并带 batchId', async () => {
    const b = await db.createBatch('bulk', 'ok-task', 'trigger-all')
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 'ok-task', batchId: b.id }])
    const row = await db.getLatestRun(1, 'ok-task', todayStr())
    expect(row?.batchId).toBe(b.id)
    expect(row?.status).toBe('success')
  })

  it('开窗失败时预写的 pending 行被结算为 skipped 且沿用 batchId', async () => {
    const b = await db.createBatch('bulk', 't', 'trigger-all')
    const runner = new WindowRunner({ cfg, db, bitbrowser: { openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) } as never, driver: makeDriver(), tasks: new Map(), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), [{ taskKey: 't', batchId: b.id }])
    const row = await db.getLatestRun(1, 't', todayStr())
    expect(row?.status).toBe('skipped')
    expect(row?.batchId).toBe(b.id)
    expect(row?.error).toContain('开窗失败')
  })

  it('retry_wait 续跑不预写新行、沿用原 batchId', async () => {
    const b = await db.createBatch('bulk', 'fail-task', 'trigger-all')
    const first = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['fail-task', new FailTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await first.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task', batchId: b.id }])
    // 第二次会话（重试恢复，不带 batchId）→ 续跑同一 slot，batchId 沿用
    await first.runWindowTasks(makeProfile(), [{ taskKey: 'fail-task' }])
    const row = await db.getLatestRun(1, 'fail-task', todayStr())
    expect(row?.batchId).toBe(b.id)
    expect(row?.attempts).toBe(2)
  })
})
```

说明：本文件既有 `makeProfile()` 返回 id=1 的窗口、`bb`/`makeDriver`/`OkTask`/`FailTask` 等夹具与 `cfg` 顶部共享——新 describe 复用即可；`scheduleRetry` 是文件顶部共享 mock。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/windowRunner.test.ts`
Expected: FAIL（runWindowTasks 第二参类型不匹配 / batchId 未写入）

- [ ] **Step 3: 实现 window-runner.ts 改动**

导入加 `SessionTask` 类型：`import type { SessionTask } from './queue'`（注意只 import type，避免循环——queue.ts 只 import 类型 db/logger，无循环风险）。

`WindowRunnerDeps.scheduleRetry` 签名：

```ts
  scheduleRetry: (profile: ProfileRow, taskKey: string, delayMs: number, batchId?: number) => void
```

`runWindowTasks` 开头（`const date = todayStr()` 之后、`let open` 之前）加预写段：

```ts
    const date = todayStr()
    const results = new Map<string, RunRow | null>()
    // 预写 pending：新轮次任务落「待执行」行（批次看板在错峰/开窗期间即可见）；
    // 续跑行（retry_wait 等非终态）不动——重试沿用原行与批次。
    // batch_id 只在此写入，后续 upsert 一律不传（ON CONFLICT COALESCE 保留）
    for (const t of tasks) {
      const existing = await this.safeDb(() => this.deps.db.getLatestRun(profile.id, t.taskKey, date), null)
      const terminal = existing ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(existing.status) : false
      if (existing && !terminal) continue
      const slot = await this.nextSlot(profile, t.taskKey, date)
      await this.safeDb(() => this.deps.db.upsertRun(profile.id, t.taskKey, date, slot, 'pending', { batchId: t.batchId ?? null }), null)
    }
```

签名与循环：

```ts
  async runWindowTasks(profile: ProfileRow, tasks: SessionTask[]): Promise<Map<string, RunRow | null>> {
```

开窗失败/连接失败段：`for (const key of taskKeys)` → `for (const t of tasks)`，`settleWindowSkip(profile, t.taskKey, ...)`（settleWindowSkip 不再需要 batchId 参数——预写已带，见下）。循环段同理：

```ts
      for (const t of tasks) {
        const key = t.taskKey
        if (Date.now() >= deadline) {
          for (const rest of tasks.slice(i)) { ... settleWindowSkip(profile, rest.taskKey, ...) }
```

`runManual`：

```ts
  async runManual(bitbrowserId: string, taskKey: string, batchId?: number): Promise<RunRow | null> {
    const profiles = await this.safeDb(() => this.deps.db.listProfiles(false), [] as ProfileRow[])
    const profile = profiles.find(p => p.bitbrowserId === bitbrowserId)
    if (!profile) throw new Error(`窗口不存在: ${bitbrowserId}`)
    const results = await this.runWindowTasks(profile, [{ taskKey, ...(batchId === undefined ? {} : { batchId }) }])
    return results.get(taskKey) ?? null
  }
```

`settleWindowSkip` 修正（预写行要结算在同一 slot，不再开新轮）：

```ts
  private async settleWindowSkip(profile: ProfileRow, taskKey: string, date: string, status: 'skipped' | 'failed', error: string): Promise<RunRow | null> {
    const existing = await this.safeDb(() => this.deps.db.getLatestRun(profile.id, taskKey, date), null)
    const terminal = existing ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(existing.status) : false
    // 非终态行（retry_wait 待续跑 / 预写 pending）直接结算该行——沿用 slot 与 batch_id；
    // 终态或无行才开新轮次（新行 batch_id 取预写值？此处新行罕见：预写已覆盖所有任务，兜底按新轮落库）
    if (existing && !terminal) {
      return this.safeDb(() => this.deps.db.upsertRun(profile.id, taskKey, date, existing.slot, status, { error, finishedAt: localWallNow() }), null)
    }
    const slot = await this.nextSlot(profile, taskKey, date)
    return this.safeDb(() => this.deps.db.upsertRun(profile.id, taskKey, date, slot, status, { error, finishedAt: localWallNow() }), null)
  }
```

注释改为准确表述：终态/无行的兜底新轮次不传 batchId，归入未分批（正常流程预写已带）。

`runTask` 不需要改 batchId（预写已带；续跑沿用）。`scheduleRetry` 调用处：

```ts
          this.deps.scheduleRetry(profile, taskKey, backoffSec * 1000, row?.batchId ?? undefined)
```

- [ ] **Step 4: 改 retry-recovery.ts（两处 enqueue 带原 batchId）**

```ts
          if (p) enqueuer.enqueue(p, r.taskKey, { batchId: r.batchId ?? undefined })
```

（retry_wait 恢复段与崩溃残留恢复段各一处；第二处同此。注释同步改为「沿用原批次」）

- [ ] **Step 5: 改 app.ts 的 scheduleRetry 装配**

```ts
    // 重试不占窗：退避到期后重新入队（新一轮窗口会话），当前窗口正常继续/关窗；
    // 到期时重取最新 profile（名称/开关可能已被面板修改），窗口已被删除则放弃重试；
    // batchId 沿用原批次（重试不产生新批次）
    scheduleRetry: (profile, taskKey, delayMs, batchId) => {
      setTimeout(() => {
        void (async () => {
          try {
            const p = (await db.listProfiles(false)).find(x => x.id === profile.id)
            if (p) enqueuer.enqueue(p, taskKey, { batchId })
          } catch (e) {
            logger.warn({ err: (e as Error).message }, '重试到期查询窗口失败，放弃本次重试')
          }
        })()
      }, delayMs)
    },
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/windowRunner.test.ts tests/retry-recovery.test.ts`
Expected: 全部 PASS（retry-recovery 测试若断言了 enqueue 调用参数需同步更新：mock 断言 `enqueue.mock.calls` 的第三参包含 batchId）

若 retry-recovery.test.ts 中 `expect(enqueuer.enqueue).toHaveBeenCalledWith(p, 'task-x')` 之类断言失败，改为 `toHaveBeenCalledWith(expect.objectContaining({ id: p.id }), 'task-x', expect.anything())` 或按实际行加 `{ batchId: expect.any(Number) }`。

- [ ] **Step 7: 提交**

```bash
git add src/engine/window-runner.ts src/engine/retry-recovery.ts src/app.ts tests/windowRunner.test.ts tests/retry-recovery.test.ts
git commit -m "feat: 窗口会话预写 pending 并透传批次归属（重试沿用原批次）"
```

---

### Task 4: server——trigger 创建批次 + batches 路由替换 dashboard

**Files:**
- Modify: `src/server/routes/tasks.ts`（trigger 创建批次）
- Create: `src/server/routes/batches.ts`
- Delete: `src/server/routes/dashboard.ts`
- Modify: `src/server/app.ts`（挂载 batchesRouter 替换 dashboardRouter）
- Test: `tests/web.test.ts`（dashboard 用例改为 batches 用例；trigger 用例断言 createBatch）

**Interfaces:**
- Consumes: Task 1 `createBatch/listBatchesForRange/listRunsForBatch/listUnbatchedRuns/captchaStats/countInFlightRuns`、Task 2 `enqueue(opts.batchId)` + `pendingCount`
- Produces:
  - `GET /api/batches?range=today|7d|all` → `{ range, batches: Array<BatchRow & {stats}>, unbatched: RunRow[], running: number, captchaToday: { count, totalCost }, taskNames: Record<string, string> }`
  - `GET /api/batches/:id` → `{ batch: BatchRow, runs: Array<RunRow & { durationSec: number | null; inFlight: boolean }> }`

- [ ] **Step 1: 写失败测试**（tests/web.test.ts）

makeDeps 的 db mock 增加：

```ts
      createBatch: vi.fn().mockResolvedValue({ id: 88, kind: 'bulk', taskKey: 't1', source: 'trigger-all', createdAt: '2026-09-04 09:00:00.000' }),
      listBatchesForRange: vi.fn().mockResolvedValue([]),
      listRunsForBatch: vi.fn().mockResolvedValue([]),
      listUnbatchedRuns: vi.fn().mockResolvedValue([]),
```

enqueuer mock 增加：`pendingCount: vi.fn().mockReturnValue(0),`

删除三个 dashboard 用例（92-127 行：'GET /api/dashboard 返回'、'durationSec'、'inFlight'），替换为：

```ts
describe('batches API', () => {
  it('GET /api/batches 返回批次列表与全局数字', async () => {
    const deps = makeDeps()
    deps.db.listBatchesForRange.mockResolvedValue([
      { id: 2, kind: 'bulk', taskKey: 't1', source: 'trigger-all', createdAt: '2026-09-04 09:00:00.000', stats: { total: 2, success: 1, failed: 1, captchaFailed: 0, skipped: 0, running: 0, pending: 0 } },
    ])
    deps.db.listUnbatchedRuns.mockResolvedValue([{ id: 9, profileId: 1, taskKey: 't2', date: '2026-09-04', slot: 0, status: 'success', attempts: 1, error: null, screenshot: null, startedAt: null, finishedAt: null, batchId: null, profileName: '窗口1', bitbrowserId: 'bb-1' }])
    deps.db.countInFlightRuns.mockResolvedValue(3)
    const res = await request(createApp(deps as never)).get('/api/batches?range=today')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.batches).toHaveLength(1)
    expect(res.body.data.batches[0].id).toBe(2)
    expect(res.body.data.batches[0].stats.failed).toBe(1)
    expect(res.body.data.unbatched).toHaveLength(1)
    expect(res.body.data.running).toBeGreaterThan(0)
    expect(res.body.data.captchaToday).toEqual({ count: 5, totalCost: 230 })
    expect(res.body.data.taskNames).toEqual({ t1: '任务1' })
  })

  it('GET /api/batches 默认 range=today', async () => {
    const deps = makeDeps()
    await request(createApp(deps as never)).get('/api/batches')
    expect(deps.db.listBatchesForRange).toHaveBeenCalledWith(expect.any(String), expect.any(String))
  })

  it('GET /api/batches?range=7d 与 all 计算不同下界', async () => {
    const deps = makeDeps()
    await request(createApp(deps as never)).get('/api/batches?range=7d')
    expect(deps.db.listBatchesForRange.mock.calls[0][0]).not.toBeNull()
    await request(createApp(deps as never)).get('/api/batches?range=all')
    expect(deps.db.listBatchesForRange.mock.calls[1][0]).toBeNull()
  })

  it('GET /api/batches/:id 返回批次明细并附加 durationSec/inFlight', async () => {
    const deps = makeDeps()
    deps.db.listRunsForBatch.mockResolvedValue([
      { id: 1, profileId: 1, taskKey: 't1', date: '2026-09-04', slot: 0, status: 'success', attempts: 1, error: null, screenshot: null, startedAt: '2026-09-04 09:00:00.000', finishedAt: '2026-09-04 09:01:05.000', batchId: 2, profileName: '窗口1', bitbrowserId: 'bb-1' },
    ])
    deps.db.countInFlightRuns.mockResolvedValue(0)
    const res = await request(createApp(deps as never)).get('/api/batches/2')
    expect(res.status).toBe(200)
    expect(res.body.data.runs[0].durationSec).toBe(65)
    expect(res.body.data.runs[0].inFlight).toBe(false)
    expect(res.body.data.runs[0].bitbrowserId).toBe('bb-1')
  })

  it('GET /api/batches/abc 返回 400', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/batches/abc')
    expect(res.status).toBe(400)
  })
})
```

trigger 用例更新（151-157 行）：断言创建批次与 batchId 透传：

```ts
  it('POST /api/tasks/:key/trigger 创建批次并入队（带 batchId）', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({})
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(deps.db.createBatch).toHaveBeenCalledWith('bulk', 't1', 'trigger-all')
    expect(deps.enqueuer.enqueue).toHaveBeenCalled()
    expect(deps.enqueuer.enqueue.mock.calls[0][2]).toEqual({ batchId: 88 })
  })

  it('单窗口触发创建 single 批次', async () => {
    const deps = makeDeps()
    const res = await request(createApp(deps as never)).post('/api/tasks/t1/trigger').send({ bitbrowserId: 'bb-1' })
    expect(res.status).toBe(200)
    expect(deps.db.createBatch).toHaveBeenCalledWith('single', 't1', 'trigger-single')
    expect(deps.enqueuer.enqueue.mock.calls[0][2]).toEqual({ immediate: true, batchId: 88 })
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts`
Expected: FAIL（/api/batches 404；dashboard 路由已删前先失败在新接口）

- [ ] **Step 3: 创建 src/server/routes/batches.ts**

```ts
/**
 * 批次路由（server 层）：运行批次列表与明细（看板批次时间线数据源）
 * 依赖方向：依赖 infrastructure/db 与 engine/queue，被 app 装配
 * 设计思路：列表接口轻量（仅批次行 + 聚合统计 + 全局数字）供 15s 轮询；
 *           明细接口懒加载（展开窗口明细时请求）
 */
import { Router } from 'express'
import { todayStr, type AppDb } from '../../infrastructure/db'
import type { CoalescingEnqueuer } from '../../engine/queue'
import type { SiteTask } from '../../tasks/base'
import { ok, asyncHandler, HttpError } from '../http/response'

/** 运行耗时（秒）：started/finished 任一缺失或解析失败返回 null（墙钟字符串解析与重试恢复同口径） */
function runDurationSec(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null
  const s = new Date(startedAt.replace(' ', 'T')).getTime()
  const f = new Date(finishedAt.replace(' ', 'T')).getTime()
  if (Number.isNaN(s) || Number.isNaN(f)) return null
  return Math.round((f - s) / 1000)
}

/** 7 天前的日期字符串（本地时区） */
function daysAgoStr(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return todayStr(d)
}

/**
 * @swagger
 * /api/batches:
 *   get:
 *     summary: 运行批次列表（含每批统计与全局数字）
 *     parameters:
 *       - in: query
 *         name: range
 *         schema: { type: string, enum: [today, 7d, all] }
 *         description: 时间范围（缺省 today）
 *     responses:
 *       '200':
 *         description: 批次列表
 */
export function batchesRouter(deps: { db: AppDb; enqueuer: CoalescingEnqueuer; tasks: Map<string, SiteTask> }): Router {
  const router = Router()
  router.get('/batches', asyncHandler(async (req, res) => {
    const range = typeof req.query.range === 'string' ? req.query.range : 'today'
    const today = todayStr()
    const from = range === 'all' ? null : range === '7d' ? daysAgoStr(6) : today
    const batches = await deps.db.listBatchesForRange(from, today)
    const unbatched = await deps.db.listUnbatchedRuns(from, today)
    // 实时运行：DB 在途行数（跨任务）+ 队列错峰等待窗口数（尚未开窗落库）
    let running = 0
    for (const key of deps.tasks.keys()) {
      running += await deps.db.countInFlightRuns(key, today)
    }
    running += deps.enqueuer.pendingCount()
    const taskNames: Record<string, string> = {}
    for (const [key, t] of deps.tasks) taskNames[key] = t.meta.name
    ok(res, {
      range,
      batches,
      unbatched,
      running,
      captchaToday: await deps.db.captchaStats(today),
      taskNames,
      today,
    })
  }))
  router.get('/batches/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 40001, '批次 id 必须为正整数')
    const batch = await deps.db.getBatch(id)
    if (!batch) throw new HttpError(404, 40401, '批次不存在')
    const rows = await deps.db.listRunsForBatch(id)
    ok(res, {
      batch,
      runs: await Promise.all(rows.map(async (r) => ({
        ...r,
        durationSec: runDurationSec(r.startedAt, r.finishedAt),
        inFlight: (await deps.db.countInFlightRuns(r.taskKey, todayStr(), r.profileId)) > 0 || deps.enqueuer.hasTaskInFlight(r.taskKey, r.profileId),
      }))),
    })
  }))
  return router
}
```

swagger 明细注解（放在明细路由前）：

```ts
/**
 * @swagger
 * /api/batches/{id}:
 *   get:
 *     summary: 批次明细（窗口运行行）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       '200':
 *         description: 批次明细
 */
```

- [ ] **Step 4: 修改 tasks.ts 触发路由**

single 分支（`deps.enqueuer.enqueue(profile, key, { immediate: true })` 前）：

```ts
      const batch = await deps.db.createBatch('single', key, 'trigger-single')
      deps.enqueuer.enqueue(profile, key, { immediate: true, batchId: batch.id })
```

bulk 分支（循环前）：

```ts
    const batch = await deps.db.createBatch('bulk', key, 'trigger-all')
    for (const p of await deps.db.listProfiles(true)) deps.enqueuer.enqueue(p, key, { batchId: batch.id })
```

- [ ] **Step 5: 修改 server/app.ts 挂载并删除 dashboard.ts**

```ts
import { batchesRouter } from './routes/batches'
```

删除 `import { dashboardRouter } from './routes/dashboard'` 与 `api.use(dashboardRouter(...))`，改为：

```ts
  api.use(batchesRouter({ db: deps.db, enqueuer: deps.enqueuer, tasks: deps.tasks }))
```

删除文件 `src/server/routes/dashboard.ts`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/web.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add src/server/routes/tasks.ts src/server/routes/batches.ts src/server/app.ts tests/web.test.ts src/infrastructure/db.ts
git rm src/server/routes/dashboard.ts
git commit -m "feat: 批次列表/明细 API 替换 dashboard；触发入口创建批次"
```

（若 Task 1 未提交 getBatch，本任务的 db.ts 改动合并进本次提交；计划按序执行时 Task 1 已含 getBatch。）

---

### Task 5: task:run 脚本创建 single 批次

**Files:**
- Modify: `scripts/run-task.ts`

**Interfaces:**
- Consumes: Task 1 `createBatch`、Task 3 `runManual(bitbrowserId, taskKey, batchId?)`

- [ ] **Step 1: 实现（脚本无单测，靠 typecheck）**

`main()` 里 `let runner!: WindowRunner` 附近加：

```ts
  // 本脚本运行产生的批次：首次运行时创建，重试（retry_wait 后 scheduleRetry 重跑）沿用同一批次
  let lastBatchId: number | null = null
```

`runOnce` 里 `runner.runManual(profileId, taskKey)` 改为：

```ts
    if (lastBatchId === null) {
      lastBatchId = (await db.createBatch('single', taskKey, 'task-run')).id
    }
    const row2 = await runner.runManual(profileId, taskKey, lastBatchId)
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck`
Expected: 0 错误

- [ ] **Step 3: 提交**

```bash
git add scripts/run-task.ts
git commit -m "feat: task:run 脚本运行创建 single 批次"
```

---

### Task 6: web——类型/接口/纯函数（groupBatches）

**Files:**
- Modify: `web/src/api/schema.d.ts`（删 `/api/dashboard` 段、加 `/api/batches` 与 `/api/batches/{id}`）
- Modify: `web/src/types.ts`
- Modify: `web/src/api/endpoints.ts`
- Create: `web/src/pages/dashboard/groupBatches.ts`
- Create: `web/src/pages/dashboard/groupBatches.test.ts`
- Delete: `web/src/pages/dashboard/groupRuns.ts`、`web/src/pages/dashboard/groupRuns.test.ts`

**Interfaces:**
- Consumes: Task 4 的 API 形状
- Produces:
  - `export type BatchItem = EnvelopeData<'/api/batches'>['batches'][number]`
  - `export type BatchesData = EnvelopeData<'/api/batches'>`
  - `export type RunRow = EnvelopeData<'/api/batches/{id}'>['runs'][number]`
  - `splitBatches(batches: BatchItem[]): { bulk: BatchItem[]; single: BatchItem[] }`
  - `batchProgress(b: BatchItem): { done: number; pct: number }`

- [ ] **Step 1: 写失败测试**（web/src/pages/dashboard/groupBatches.test.ts）

```ts
import { describe, it, expect } from 'vitest'
import { splitBatches, batchProgress } from './groupBatches'
import type { BatchItem } from '../../types'

function makeBatch(over: Partial<BatchItem>): BatchItem {
  return {
    id: over.id ?? 1,
    kind: over.kind ?? 'bulk',
    taskKey: over.taskKey ?? 't1',
    source: over.source ?? 'trigger-all',
    createdAt: over.createdAt ?? '2026-09-04 09:00:00.000',
    stats: over.stats ?? { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0 },
  } as BatchItem
}

describe('splitBatches 散批聚合', () => {
  it('bulk 与 single 分流', () => {
    const { bulk, single } = splitBatches([
      makeBatch({ id: 1 }),
      makeBatch({ id: 2, kind: 'single', source: 'trigger-single' }),
      makeBatch({ id: 3 }),
      makeBatch({ id: 4, kind: 'single', source: 'task-run' }),
    ])
    expect(bulk.map((b) => b.id)).toEqual([1, 3])
    expect(single.map((b) => b.id)).toEqual([2, 4])
  })
})

describe('batchProgress 批次完成率', () => {
  it('done = 终态行数；pct 四舍五入；total=0 时 pct=0', () => {
    const p = batchProgress(makeBatch({ stats: { total: 50, success: 40, failed: 3, captchaFailed: 2, skipped: 1, running: 2, pending: 2 } }))
    expect(p.done).toBe(46)
    expect(p.pct).toBe(92)
    expect(batchProgress(makeBatch({})).pct).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --root web src/pages/dashboard/groupBatches.test.ts`（若根配置不认 --root，用 `npm run test:web -- groupBatches`）
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 groupBatches.ts**

```ts
/**
 * 批次时间线纯函数（前端）：散批聚合分流与批次完成率计算
 * 设计思路：bulk 批次按时间线主列表展示；single 批次聚合进「单窗口散批」折叠卡
 */
import type { BatchItem } from '../../types'

/** 散批分流：kind=single 的批次从主列表抽出（主列表仍按后端 createdAt 倒序） */
export function splitBatches(batches: BatchItem[]): { bulk: BatchItem[]; single: BatchItem[] } {
  const bulk: BatchItem[] = []
  const single: BatchItem[] = []
  for (const b of batches) (b.kind === 'single' ? single : bulk).push(b)
  return { bulk, single }
}

/** 批次完成率：终态行数 / 总行数（百分比四舍五入；total=0 返回 0） */
export function batchProgress(b: BatchItem): { done: number; pct: number } {
  const s = b.stats
  const done = s.success + s.failed + s.captchaFailed + s.skipped
  const pct = s.total > 0 ? Math.round((done / s.total) * 100) : 0
  return { done, pct }
}
```

- [ ] **Step 4: 改 schema.d.ts**

删除 787-884 行的 `/api/dashboard` 整段（含前导缩进与逗号结构，保持类型文件语法正确——该段是 `paths` 对象的一个键，删除键连同其 value 与尾随逗号）。

在原位置（按字母序在 `/api/batches` 应在 `/api/captcha/balance` 之前——项目手补风格不强制字母序，放原 dashboard 位置即可）插入：

```ts
    "/api/batches": {
        parameters: { query?: never; header?: never; path?: never; cookie?: never; };
        /** 运行批次列表（含每批统计与全局数字） */
        get: {
            parameters: {
                query?: {
                    /** @description 时间范围 today|7d|all（缺省 today） */
                    range?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 批次列表 */
                200: {
                    headers: { [name: string]: unknown; };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                            data?: {
                                range?: string;
                                today?: string;
                                batches?: {
                                    id?: number;
                                    /** @enum {string} */
                                    kind?: "bulk" | "single";
                                    taskKey?: string;
                                    source?: string;
                                    createdAt?: string;
                                    stats?: {
                                        total?: number;
                                        success?: number;
                                        failed?: number;
                                        captchaFailed?: number;
                                        skipped?: number;
                                        running?: number;
                                        pending?: number;
                                    };
                                }[];
                                unbatched?: {
                                    id?: number;
                                    profileId?: number;
                                    taskKey?: string;
                                    date?: string;
                                    slot?: number;
                                    /** @enum {string} */
                                    status?: "pending" | "running" | "success" | "failed" | "captcha_failed" | "skipped" | "retry_wait";
                                    attempts?: number;
                                    error?: string | null;
                                    screenshot?: string | null;
                                    startedAt?: string | null;
                                    finishedAt?: string | null;
                                    batchId?: number | null;
                                    profileName?: string;
                                    bitbrowserId?: string;
                                }[];
                                running?: number;
                                captchaToday?: { count?: number; totalCost?: number; };
                                taskNames?: { [key: string]: string; };
                            };
                        };
                    };
                };
            };
        };
        put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
    };
    "/api/batches/{id}": {
        parameters: { query?: never; header?: never; path?: never; cookie?: never; };
        /** 批次明细（窗口运行行） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: { id: number; };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 批次明细 */
                200: {
                    headers: { [name: string]: unknown; };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                            data?: {
                                batch?: {
                                    id?: number;
                                    /** @enum {string} */
                                    kind?: "bulk" | "single";
                                    taskKey?: string;
                                    source?: string;
                                    createdAt?: string;
                                };
                                runs?: {
                                    id?: number;
                                    profileId?: number;
                                    taskKey?: string;
                                    date?: string;
                                    slot?: number;
                                    /** @enum {string} */
                                    status?: "pending" | "running" | "success" | "failed" | "captcha_failed" | "skipped" | "retry_wait";
                                    attempts?: number;
                                    error?: string | null;
                                    screenshot?: string | null;
                                    startedAt?: string | null;
                                    finishedAt?: string | null;
                                    batchId?: number | null;
                                    profileName?: string;
                                    bitbrowserId?: string;
                                    durationSec?: number | null;
                                    inFlight?: boolean;
                                }[];
                            };
                        };
                    };
                };
            };
        };
        put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
    };
```

- [ ] **Step 5: 改 types.ts**

```ts
export type BatchItem = EnvelopeData<'/api/batches'>['batches'][number]

export type BatchesData = EnvelopeData<'/api/batches'>

export type BatchDetailData = EnvelopeData<'/api/batches/{id}'>

export type RunRow = EnvelopeData<'/api/batches/{id}'>['runs'][number]
```

注意：`RunRow` 在此重定义后，旧 `groupRuns.ts` / 旧看板页对其引用可能因字段变化（新增 batchId/bitbrowserId、移除旧字段引用）报错——本任务的 Step 7 typecheck 若因此失败，属预期内，跳过并记录：在 Task 7 重写页面时一并解决。原 `DashboardData` 别名保留不动（Task 7 删除）。schema.d.ts 的 `/api/dashboard` 段同理保留到 Task 7 删除（本任务只新增两个键，不删旧键）。

- [ ] **Step 6: 改 endpoints.ts（只增不删）**

```ts
export const fetchBatches = (range: string) => get<BatchesData>(`/api/batches?range=${range}`)
export const fetchBatchDetail = (id: number) => get<BatchDetailData>(`/api/batches/${id}`)
```

类型导入改为 `import type { BatchesData, BatchDetailData, DashboardData, TaskMetaView, ProfileRow, SettingsData, DatasourceInfo } from '../types'`（`fetchDashboard` 保留到 Task 7 删除）。

- [ ] **Step 7: 跑 web 单测与全量 typecheck**

Run: `npm run test:web -- groupBatches`
Expected: PASS（groupBatches 纯函数单测）

Run: `npm run typecheck`
Expected: 0 错误（旧页面仍引用旧类型，项目保持可编译）

- [ ] **Step 8: 提交**

```bash
git add web/src/api/schema.d.ts web/src/types.ts web/src/api/endpoints.ts web/src/pages/dashboard/groupBatches.ts web/src/pages/dashboard/groupBatches.test.ts
git commit -m "feat: 前端批次类型与纯函数（散批分流/完成率）"
```

---

### Task 7: web——dashboard 页重构为批次时间线

**Files:**
- Modify: `web/src/pages/dashboard/index.tsx`（整体重写）
- Modify: `web/src/pages/dashboard/hooks.ts`
- Modify: `web/src/types.ts`（删除 `DashboardData`、旧 `RunRow` 由批次版替代）
- Modify: `web/src/api/endpoints.ts`（删除 `fetchDashboard`）
- Modify: `web/src/api/schema.d.ts`（删除 `/api/dashboard` 段）
- Delete: `web/src/pages/dashboard/groupRuns.ts`、`web/src/pages/dashboard/groupRuns.test.ts`
- Keep: `web/src/pages/dashboard/format.ts`（formatDuration 继续用）

**Interfaces:**
- Consumes: Task 6 的 `fetchBatches/fetchBatchDetail`、`BatchItem/BatchesData/RunRow`、`splitBatches/batchProgress`
- Produces: 看板页最终 UI（筛选行 + 全局数字 + 批次时间线 + 散批折叠 + 未分批聚合）

- [ ] **Step 1: 改 hooks.ts**

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchBatches, fetchBatchDetail, fetchTasks, triggerTask } from '../../api/endpoints'
import { HttpError } from '../../api/client'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

export function useBatches(range: string) {
  return useQuery({
    queryKey: ['batches', range],
    queryFn: () => fetchBatches(range),
    refetchInterval: 15000,
  })
}

export function useBatchDetail(id: number | null) {
  return useQuery({
    queryKey: ['batchDetail', id],
    queryFn: () => fetchBatchDetail(id as number),
    enabled: id !== null,
  })
}

export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, refetchInterval: 5000 })
}

export function useTriggerTask() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, bitbrowserId }: { key: string; bitbrowserId?: string }) => triggerTask(key, bitbrowserId),
    onSuccess: (res) => {
      message.success(res.scope === 'single' ? '已提交执行' : '已提交全部启用窗口执行')
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 2: 重写 index.tsx**

```tsx
import { useMemo, useState } from 'react'
import { Button, Card, Collapse, Empty, Progress, Segmented, Space, Table, Tag, Tooltip, Typography, theme } from 'antd'
import dayjs from 'dayjs'
import StatusPill from '../../components/StatusPill'
import type { BatchItem, BatchesData, RunRow } from '../../types'
import { useBatches, useBatchDetail, useTasks, useTriggerTask } from './hooks'
import { formatDuration } from './format'
import { splitBatches, batchProgress } from './groupBatches'

const RANGE_OPTIONS = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '全部', value: 'all' },
]

const STATUS_TAG: Array<{ key: keyof BatchItem['stats']; label: string; color: string; bg: string; border: string }> = [
  { key: 'success', label: '成功', color: '#52c41a', bg: '#f6ffed', border: '#b7eb8f' },
  { key: 'failed', label: '失败', color: '#ff4d4f', bg: '#fff2f0', border: '#ffccc7' },
  { key: 'captchaFailed', label: '验证码', color: '#13c2c2', bg: '#e6fffb', border: '#87e8de' },
  { key: 'running', label: '进行中', color: '#faad14', bg: '#fffbe6', border: '#ffe58f' },
  { key: 'pending', label: '待执行', color: '#8c8c8c', bg: '#fafafa', border: '#d9d9d9' },
]

const KIND_TAG: Record<BatchItem['kind'], { label: string; color: string }> = {
  bulk: { label: '批量 · 全部窗口', color: 'blue' },
  single: { label: '单窗口', color: 'default' },
}

function runTime(v: string | null): string {
  return v ? (v.includes('T') ? v.slice(11, 23) : v.slice(11)) : '—'
}

function RunsTable({ runs, loading, taskNames }: { runs: RunRow[]; loading: boolean; taskNames: Record<string, string> }) {
  const trigger = useTriggerTask()
  return (
    <Table<RunRow>
      size="small"
      rowKey={(r) => `${r.id}-${r.taskKey}`}
      pagination={false}
      loading={loading}
      dataSource={runs}
      columns={[
        { title: '窗口', dataIndex: 'profileName', width: 150, render: (n: string, r) => (
          <span>{n}<div style={{ fontSize: 11, color: '#999' }}>{(r.bitbrowserId ?? '').slice(0, 8)}</div></span>
        ) },
        { title: '任务', dataIndex: 'taskKey', width: 130, render: (k: string) => taskNames[k] ?? k },
        { title: '开始', dataIndex: 'startedAt', width: 110, render: runTime },
        { title: '耗时', dataIndex: 'durationSec', width: 80, render: (s: number | null) => formatDuration(s) },
        { title: '状态', dataIndex: 'status', width: 100, render: (s: RunRow['status']) => <StatusPill status={s} /> },
        { title: '错误', dataIndex: 'error', ellipsis: true, render: (e: string | null) => (e ? <Typography.Text type="danger" ellipsis={{ tooltip: e }} style={{ maxWidth: 240 }}>{e}</Typography.Text> : '—') },
        { title: '截图', dataIndex: 'screenshot', width: 80, render: (s: string | null) => (s ? <Button type="link" size="small" onClick={() => window.open(`/api/screenshots?path=${encodeURIComponent(s)}`, '_blank')}>🖼</Button> : '—') },
        { title: '操作', width: 80, render: (_, r) => (
          <Button type="link" size="small" disabled={!r.bitbrowserId || r.inFlight} onClick={() => { if (r.bitbrowserId) trigger.mutate({ key: r.taskKey, bitbrowserId: r.bitbrowserId }) }}>
            {r.status === 'failed' || r.status === 'captcha_failed' ? '重跑' : '执行'}
          </Button>
        ) },
      ]}
    />
  )
}

function BatchCard({ batch, taskNames, defaultOpen }: { batch: BatchItem; taskNames: Record<string, string>; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const detail = useBatchDetail(open ? batch.id : null)
  const { done, pct } = batchProgress(batch)
  const stats = batch.stats
  return (
    <Card size="small" style={{ marginBottom: 12, border: defaultOpen ? '1px solid #91caff' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <b>{batch.createdAt.slice(11, 16)}</b>
        <Tag color={KIND_TAG[batch.kind].color}>{KIND_TAG[batch.kind].label}</Tag>
        <span style={{ fontWeight: 600 }}>{taskNames[batch.taskKey] ?? batch.taskKey}</span>
        <span style={{ color: '#999', fontSize: 12 }}>{open ? '▼ 收起' : '▶ 展开窗口明细'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Progress percent={pct} size="small" style={{ flex: 1, minWidth: 120, margin: 0 }} format={() => null} />
        <span style={{ fontSize: 12, color: '#666' }}>{done}/{stats.total}</span>
        {STATUS_TAG.filter((t) => stats[t.key] > 0).map((t) => (
          <Tag key={t.key} style={{ color: t.color, background: t.bg, borderColor: t.border, margin: 0 }}>{t.label} {stats[t.key]}</Tag>
        ))}
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {detail.data
            ? <RunsTable runs={detail.data.runs} loading={false} taskNames={taskNames} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail.isPending ? '加载中…' : '暂无运行记录'} />}
        </div>
      )}
    </Card>
  )
}

function SingleBatchRow({ batch, taskNames }: { batch: BatchItem; taskNames: Record<string, string> }) {
  const detail = useBatchDetail(batch.id)
  const trigger = useTriggerTask()
  const run = detail.data?.runs[0]
  return (
    <Table<RunRow>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={run ? [run] : []}
      loading={detail.isPending}
      locale={{ emptyText: detail.isPending ? '加载中…' : '暂无记录' }}
      columns={[
        { title: '时间', width: 80, render: () => batch.createdAt.slice(11, 16) },
        { title: '任务', width: 120, render: () => taskNames[batch.taskKey] ?? batch.taskKey },
        { title: '窗口', dataIndex: 'profileName', width: 130, render: (n: string, r) => (
          <span>{n}<div style={{ fontSize: 11, color: '#999' }}>{(r.bitbrowserId ?? '').slice(0, 8)}</div></span>
        ) },
        { title: '状态', dataIndex: 'status', width: 100, render: (s: RunRow['status']) => <StatusPill status={s} /> },
        { title: '错误', dataIndex: 'error', ellipsis: true, render: (e: string | null) => (e ? <Typography.Text type="danger" ellipsis={{ tooltip: e }} style={{ maxWidth: 220 }}>{e}</Typography.Text> : '—') },
        { title: '操作', width: 80, render: (_, r) => (
          <Button type="link" size="small" disabled={!r.bitbrowserId} onClick={() => { if (r.bitbrowserId) trigger.mutate({ key: batch.taskKey, bitbrowserId: r.bitbrowserId }) }}>
            {r.status === 'failed' || r.status === 'captcha_failed' ? '重跑' : '执行'}
          </Button>
        ) },
      ]}
    />
  )
}

export default function DashboardPage() {
  const { token } = theme.useToken()
  const [range, setRange] = useState('today')
  const batches = useBatches(range)
  const tasks = useTasks()

  const taskNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const t of tasks.data ?? []) map[t.key] = t.name
    return map
  }, [tasks.data])

  const { bulk, single } = useMemo(() => splitBatches(batches.data?.batches ?? []), [batches.data])
  const data = batches.data
  const costYuan = ((data?.captchaToday.totalCost ?? 0) / 1000).toFixed(2)
  const unbatched = data?.unbatched ?? []

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card size="small">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>运行批次</span>
          <Segmented value={range} onChange={(v) => setRange(String(v))} options={RANGE_OPTIONS} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, color: token.colorTextSecondary, fontSize: 13 }}>
            <span>⚡ 实时运行 <b style={{ color: '#faad14' }}>{data?.running ?? 0}</b></span>
            <span>💴 今日打码 <b>¥{costYuan}</b><span style={{ fontSize: 11 }}> / {data?.captchaToday.count ?? 0} 次</span></span>
          </div>
        </div>
      </Card>

      {bulk.length === 0 && single.length === 0 && unbatched.length === 0 ? (
        <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行批次" /></Card>
      ) : (
        bulk.map((b, i) => <BatchCard key={b.id} batch={b} taskNames={taskNames} defaultOpen={i === 0 && !!data?.running} />)
      )}

      {(single.length > 0 || unbatched.length > 0) && (
        <Card size="small" style={{ borderStyle: 'dashed' }}>
          <Collapse
            ghost
            size="small"
            items={[
              ...(single.length > 0 ? [{
                key: 'single',
                label: <span style={{ color: token.colorTextSecondary }}>📦 单窗口散批 ×{single.length}</span>,
                children: single.map((b) => <SingleBatchRow key={b.id} batch={b} taskNames={taskNames} />),
              }] : []),
              ...(unbatched.length > 0 ? [{
                key: 'unbatched',
                label: <span style={{ color: token.colorTextSecondary }}>🗂 未分批历史 ×{unbatched.length}</span>,
                children: <RunsTable runs={unbatched} loading={false} taskNames={taskNames} />,
              }] : []),
            ]}
          />
        </Card>
      )}
    </Space>
  )
}
```

文件头 import（完整列表）：

```tsx
import { useMemo, useState } from 'react'
import { Button, Card, Collapse, Empty, Progress, Segmented, Space, Table, Tag, Typography, theme } from 'antd'
import StatusPill from '../../components/StatusPill'
import type { BatchItem, RunRow } from '../../types'
import { useBatches, useBatchDetail, useTasks, useTriggerTask } from './hooks'
import { formatDuration } from './format'
import { splitBatches, batchProgress } from './groupBatches'
```

`BatchesData` 类型若未被直接引用可不在 import 中出现（`batches.data` 由 useQuery 泛型推断）。

- [ ] **Step 3: 清理旧引用并验证**

删除 `web/src/types.ts` 的 `DashboardData` 别名；`web/src/api/endpoints.ts` 的 `fetchDashboard` 与 `DashboardData` 导入；`web/src/api/schema.d.ts` 的 `/api/dashboard` 整段（787-884 行左右，删除键及其 value 与尾随逗号，保持 `paths` 对象语法合法）。删除旧文件：

```bash
git rm web/src/pages/dashboard/groupRuns.ts web/src/pages/dashboard/groupRuns.test.ts
```

Run: `npm run typecheck`（全项目，包含脚本与后端——确认 Task 1-5 无遗留错误）
Run: `npm run test:web`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/dashboard/index.tsx web/src/pages/dashboard/hooks.ts web/src/types.ts web/src/api/endpoints.ts web/src/api/schema.d.ts
git commit -m "feat: 看板重构为运行批次时间线（散批折叠/未分批聚合）"
```

---

### Task 8: 全量验证与收尾

**Files:**
- Modify: `docs/API-GUIDE.md`（如提到 /api/dashboard 需同步；先 `grep dashboard docs/` 确认）
- 无其他文件

- [ ] **Step 1: 检查文档引用**

Run: `grep -rn "dashboard" docs/ web/src --include=*.md --include=*.ts --include=*.tsx | grep -v "pages/dashboard" | grep -v node_modules`
清理所有对 `/api/dashboard`、`fetchDashboard`、`DashboardData`、`groupRuns` 的引用（如有）。

- [ ] **Step 2: 三套验证全跑**

Run: `npm run typecheck`
Run: `npm test`
Run: `npm run test:web`
Expected: 全绿

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: 批次看板收尾（清理 dashboard 旧引用）"
```

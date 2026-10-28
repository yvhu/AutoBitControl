# 批次重跑归属原批次实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有重跑/执行入口写回原批次，并让批次状态按每个窗口的最新一轮统计。

**Architecture:** 后端把批次统计改成“每窗口最新 run 行”，新增 `POST /api/batches/{id}/rerun` 原批次入队；前端批次头按钮不再限制批次类型，明细默认只显示最新轮次，行级操作统一走新接口。历史失败行与截图保留，跨日重跑按批次最近活动时间回到今天列表。

**Tech Stack:** TypeScript 严格模式、Express 5、libsql/SQLite、React 18、antd 5、react-query、vitest、supertest、testing-library。

## Global Constraints

- 注释/文档/commit message 用中文；代码无分号、单引号、2 空格缩进、TS 严格模式。
- 不覆盖旧 run 行，不改 `runs` 唯一键 `(profile_id, task_key, date, slot)`。
- “最新轮次”按 `runs.id` 最大判定，禁止用 `slot`（跨日会归零）。
- 批次时间线按“最近活动时间”归属与排序。
- 改完必须通过 `npm run typecheck`、`npm test`、`npm run test:web`。
- 用户文档 `docs/API-GUIDE.md` 必须与代码同批更新。
- 不提交 `config/.env`、`config/config.local.json`、`data/` 下的真实数据。

---

### Task 1: 批次统计改为每窗口最新一轮

**Files:**
- Modify: `src/infrastructure/db.ts:894-938`（`listBatchesForRange`）
- Modify: `src/infrastructure/db.ts:1524-1538`（`cleanupOld`）
- Test: `tests/db.test.ts:631-753`

**Interfaces:**
- Consumes: 现有 `runs`、`batches` 表与 `localWallNow`。
- Produces: `AppDb.listBatchesForRange(from, to)` 返回项新增 `lastActivityAt: string`；`stats` 口径变为每窗口最新一轮。

- [ ] **Step 1: 写失败测试**

在 `tests/db.test.ts` 的 `describe('批次（batches）')` 内追加：

```ts
  it('同批次多轮只统计每窗口最新一轮', async () => {
    const p1 = await db.upsertProfile('bb-1', 'A')
    const p2 = await db.upsertProfile('bb-2', 'B')
    const b = await db.createBatch('bulk', 't1', 'trigger-all', '2026-09-04 08:00:00.000')
    await db.upsertRun(p1.id, 't1', '2026-09-04', 0, 'failed', { batchId: b.id })
    await db.upsertRun(p1.id, 't1', '2026-09-04', 1, 'success', { batchId: b.id, finishedAt: '2026-09-04 09:00:00.000' })
    await db.upsertRun(p2.id, 't1', '2026-09-04', 0, 'failed', { batchId: b.id })
    const list = await db.listBatchesForRange('2026-09-04', '2026-09-04')
    expect(list[0].stats.total).toBe(2)
    expect(list[0].stats.success).toBe(1)
    expect(list[0].stats.failed).toBe(1)
    expect(list[0].lastFinishedAt).toBe('2026-09-04 09:00:00.000')
  })

  it('跨日重跑 slot 归零仍按 run id 取最新一轮', async () => {
    const p = await db.upsertProfile('bb-1', 'A')
    const b = await db.createBatch('bulk', 't1', 'trigger-all', '2026-09-04 08:00:00.000')
    await db.upsertRun(p.id, 't1', '2026-09-04', 2, 'failed', { batchId: b.id, queuedAt: '2026-09-04 08:00:00.000' })
    await db.upsertRun(p.id, 't1', '2026-09-05', 0, 'success', { batchId: b.id, queuedAt: '2026-09-05 08:00:00.000', finishedAt: '2026-09-05 09:00:00.000' })
    const list = await db.listBatchesForRange('2026-09-05', '2026-09-05')
    expect(list).toHaveLength(1)
    expect(list[0].stats.total).toBe(1)
    expect(list[0].stats.success).toBe(1)
    expect(list[0].stats.failed).toBe(0)
    expect(list[0].lastActivityAt).toBe('2026-09-05 09:00:00.000')
  })

  it('昨天创建的批次今天重跑后按最近活动时间归入今天', async () => {
    const p = await db.upsertProfile('bb-1', 'A')
    const b = await db.createBatch('bulk', 't1', 'trigger-all', '2026-09-04 08:00:00.000')
    await db.upsertRun(p.id, 't1', '2026-09-04', 0, 'failed', { batchId: b.id, queuedAt: '2026-09-04 08:00:00.000' })
    await db.upsertRun(p.id, 't1', '2026-09-05', 0, 'pending', { batchId: b.id, queuedAt: '2026-09-05 08:00:00.000' })
    const list = await db.listBatchesForRange('2026-09-05', '2026-09-05')
    expect(list.map((item) => item.id)).toEqual([b.id])
  })
```

在 `describe('cleanupOld 历史数据清理')` 内追加：

```ts
  it('重跑过的旧批次按最近活动时间保留', async () => {
    const p = await db.upsertProfile('bb-clean', 'A')
    const oldDate = todayStr(new Date(Date.now() - 400 * 86400000))
    const today = todayStr()
    const b = await db.createBatch('bulk', 't', 'trigger-all', `${oldDate} 08:00:00.000`)
    await db.upsertRun(p.id, 't', today, 0, 'success', { batchId: b.id, queuedAt: `${today} 08:00:00.000` })
    const result = await db.cleanupOld(90)
    expect(result.batches).toBe(0)
    expect(await db.listBatchesForRange(null, today)).toHaveLength(1)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/db.test.ts -t "同批次多轮|跨日重跑|最近活动时间"`

Expected: FAIL（`stats.total` 为原始行数、`lastActivityAt` 为 undefined、旧批次被删）。

- [ ] **Step 3: 实现统计口径**

把 `listBatchesForRange` 整体替换为：

```ts
  /** 时间段内的批次列表（每窗口只取批次内最新一轮；按最近活动时间倒序）；from=null 表示不设下界 */
  async listBatchesForRange(from: string | null, to: string): Promise<Array<BatchRow & { stats: BatchStats; lastFinishedAt: string | null; lastActivityAt: string }>> {
    const rows = await this.exec(
      `SELECT b.id, b.kind, b.task_key AS taskKey, b.source, b.created_at AS createdAt,
              r.status, COUNT(r.id) AS c, MAX(r.finished_at) AS lastFinishedAt,
              COALESCE((SELECT MAX(r3.queued_at) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at) AS lastActivityAt
       FROM batches b
       LEFT JOIN runs r ON r.batch_id = b.id
         AND r.id = (
           SELECT MAX(r2.id) FROM runs r2
           WHERE r2.batch_id = b.id AND r2.profile_id = r.profile_id
         )
       WHERE date(COALESCE((SELECT MAX(r3.queued_at) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at))
               >= COALESCE(date(?), '0000-01-01')
         AND date(COALESCE((SELECT MAX(r3.queued_at) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at))
               <= date(?)
       GROUP BY b.id, r.status
       ORDER BY COALESCE((SELECT MAX(r3.queued_at) FROM runs r3 WHERE r3.batch_id = b.id), b.created_at) DESC,
                b.id DESC`,
       [from, to],
    )
```

实现口径补充：`lastActivityAt` 取批次内 run 的 `queued_at` 与 `finished_at` 较晚者（排队与跑完都算活动），无 run 时退回 `created_at`；`cleanupOld` 用同一口径。上面的 SQL 片段以 `MAX(r3.queued_at)` 示意，实际实现用 `MAX(CASE WHEN finished_at > queued_at THEN finished_at ELSE COALESCE(finished_at, queued_at) END)`（SQLite 多参数 `max()` 遇 NULL 返回 NULL，必须用 CASE）。

```ts
    const list: Array<BatchRow & { stats: BatchStats; lastFinishedAt: string | null; lastActivityAt: string }> = []
    const byId = new Map<number, BatchRow & { stats: BatchStats; lastFinishedAt: string | null; lastActivityAt: string }>()
    for (const r of rows) {
      const id = Number(r.id)
      let item = byId.get(id)
      if (!item) {
        item = {
          id,
          kind: String(r.kind) as BatchKind,
          taskKey: String(r.taskKey),
          source: String(r.source),
          createdAt: String(r.createdAt),
          lastFinishedAt: r.lastFinishedAt === null || r.lastFinishedAt === undefined ? null : String(r.lastFinishedAt),
          lastActivityAt: String(r.lastActivityAt),
          stats: { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, retryWait: 0, pending: 0 },
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
      else if (s === 'running') item.stats.running += n
      else if (s === 'retry_wait') item.stats.retryWait += n
      else if (s === 'pending') item.stats.pending += n
      const v = r.lastFinishedAt === null || r.lastFinishedAt === undefined ? null : String(r.lastFinishedAt)
      if (v && (item.lastFinishedAt === null || v > item.lastFinishedAt)) item.lastFinishedAt = v
    }
    return list
  }
```

把 `cleanupOld` 的批次删除改为按活动时间（同时把方法注释里的“batches 的 created_at”改为“批次最近活动时间”）：

```ts
  async cleanupOld(retainDays: number): Promise<{ runs: number; batches: number }> {
    const safeDays = Math.max(0, retainDays)
    const now = new Date()
    const cutoff = todayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - safeDays))
    const r1 = await this.client.execute({ sql: 'DELETE FROM runs WHERE date < ?', args: [cutoff] })
    const r2 = await this.client.execute({
      sql: `DELETE FROM batches
            WHERE date(COALESCE(
              (SELECT MAX(queued_at) FROM runs WHERE batch_id = batches.id),
              created_at
            )) < date(?)`,
      args: [cutoff],
    })
    return { runs: Number(r1.rowsAffected), batches: Number(r2.rowsAffected) }
  }
```

同时更新旧测试 `listBatchesForRange 按时间倒序返回批次并聚合状态统计`：该用例 b1 的 `stats.total` 从 3 改成 2，`success` 保持 1，`failed` 从 1 改成 0，`retryWait` 保持 1，`lastFinishedAt` 保持 `2026-09-04 08:05:00.000`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/db.test.ts`

Expected: PASS（全部用例通过）。

- [ ] **Step 5: 提交**

```bash
git add tests/db.test.ts src/infrastructure/db.ts
git commit -m "feat: 批次统计改为每窗口最新一轮并按活动时间归属"
```

---

### Task 2: 批次明细返回最新轮次标记

**Files:**
- Modify: `src/infrastructure/db.ts:940-943`（`listRunsForBatch` 排序）
- Modify: `src/server/routes/batches.ts:203-218`（明细接口）
- Test: `tests/web.test.ts:188-257`

**Interfaces:**
- Consumes: `AppDb.listRunsForBatch(batchId): Promise<RunRow[]>`。
- Produces: `GET /api/batches/{id}` 的每行新增 `isLatest: boolean`；行按窗口、`run.id` 升序。

- [ ] **Step 1: 写失败测试**

在 `tests/web.test.ts` 的批次 API 用例组内追加：

```ts
    it('GET /api/batches/:id 标记每窗口最新轮次', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([
        runRow(101, 1, 'failed', 0),
        runRow(102, 1, 'success', 1),
        runRow(103, 2, 'failed', 0),
      ])
      const res = await request(createApp(deps as never)).get('/api/batches/2')
      expect(res.status).toBe(200)
      const byId = Object.fromEntries(res.body.data.runs.map((r: { id: number }) => [r.id, r]))
      expect(byId[101].isLatest).toBe(false)
      expect(byId[102].isLatest).toBe(true)
      expect(byId[103].isLatest).toBe(true)
    })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web.test.ts -t "标记每窗口最新轮次"`

Expected: FAIL（`isLatest` 为 undefined）。

- [ ] **Step 3: 实现**

`listRunsForBatch` 排序改为 `p.id, r.task_key, r.id`：

```ts
  /** 某批次的全部 run 行（窗口明细；按窗口与追加顺序排序） */
  async listRunsForBatch(batchId: number): Promise<RunRow[]> {
    return (await this.exec(`${SELECT_RUN} WHERE r.batch_id = ? ORDER BY p.id, r.task_key, r.id`, [batchId])) as unknown as RunRow[]
  }
```

明细接口改为：

```ts
  router.get('/batches/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '批次 id 必须为正整数')
    const batch = await deps.db.getBatch(id)
    if (!batch) throw new HttpError(404, ERROR_CODES.BATCH_NOT_FOUND, '批次不存在')
    const rows = await deps.db.listRunsForBatch(id)
    const latestIdByProfile = new Map<number, number>()
    for (const r of rows) {
      const prev = latestIdByProfile.get(r.profileId)
      if (prev == null || r.id > prev) latestIdByProfile.set(r.profileId, r.id)
    }
    const today = todayStr()
    ok(res, {
      batch,
      runs: await Promise.all(rows.map(async (r) => ({
        ...r,
        isLatest: latestIdByProfile.get(r.profileId) === r.id,
        durationSec: runDurationSec(r.startedAt, r.finishedAt),
        inFlight: (await deps.db.countInFlightRuns(r.taskKey, today, r.profileId)) > 0,
      }))),
    })
  }))
```

在 `@swagger` 的 `runs` 属性里补 `isLatest: { type: boolean }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web.test.ts -t "批量|批次|rerun"`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/web.test.ts src/infrastructure/db.ts src/server/routes/batches.ts
git commit -m "feat: 批次明细标记每窗口最新轮次"
```

---

### Task 3: enqueue 返回真实入队结果

**Files:**
- Modify: `src/engine/queue.ts:16-26`
- Modify: `src/engine/window-pool.ts:195-220`
- Modify: `src/engine/scheduler.ts:36-42`
- Test: `tests/window-pool.test.ts:540-565`

**Interfaces:**
- Produces: `RunEnqueuer.enqueue(...): Promise<boolean>`；`true` 表示已写/提升为可执行行，`false` 表示已在运行或 `skipIfSuccess` 跳过。

- [ ] **Step 1: 写失败测试**

在 `tests/window-pool.test.ts` 对应用例中追加断言（找到现有 `skipIfSuccess` 用例，在其后新增）：

```ts
  it('enqueue 返回是否真实入队', async () => {
    const h = await makeHarness({ windows: 1 })
    const profile = h.profiles[0]
    expect(await h.scheduler.enqueue(profile, 'task1')).toBe(true)
    await h.tick()
    expect(await h.scheduler.enqueue(profile, 'task1', { skipIfSuccess: true })).toBe(false)
    h.scheduler.stop()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/window-pool.test.ts -t "enqueue 返回"`

Expected: FAIL（实际返回 undefined）。

- [ ] **Step 3: 实现**

`src/engine/queue.ts`：

```ts
  enqueue(
    profile: ProfileRow,
    taskKey: string,
    opts?: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean },
  ): Promise<boolean>
```

`src/engine/scheduler.ts` 的 `SchedulerDeps.enqueuer.enqueue` 返回类型改为 `Promise<boolean>`。

`src/engine/window-pool.ts` 的 `enqueue`：

```ts
  async enqueue(
    profile: ProfileRow,
    taskKey: string,
    opts: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean } = {},
  ): Promise<boolean> {
    const now = this.now()
    const date = todayStr(now)
    if (opts.skipIfSuccess) {
      const latest = await this.deps.db.getLatestRun(profile.id, taskKey, date)
      if (latest?.status === 'success') {
        this.deps.logger.debug({ profile: profile.name, task: taskKey }, '今日已成功，跳过重复入队')
        return false
      }
    }
    const row = await this.deps.db.enqueueRun(
      profile.id,
      taskKey,
      date,
      opts.batchId ?? null,
      opts.notBeforeMs ?? now.getTime(),
    )
    if (row.status === 'running') {
      this.deps.logger.warn({ profile: profile.name, task: taskKey }, '任务已在运行，本次入队忽略')
      return false
    }
    this.requestTick()
    return true
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/window-pool.test.ts tests/run-enqueuer.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/window-pool.test.ts src/engine/queue.ts src/engine/window-pool.ts src/engine/scheduler.ts
git commit -m "feat: 入队接口返回真实入队结果"
```

---

### Task 4: 重跑接口写回原批次

**Files:**
- Modify: `src/server/routes/batches.ts:24-35`（最新轮次辅助函数）
- Modify: `src/server/routes/batches.ts:220-357`（候选与重跑接口）
- Test: `tests/web.test.ts:296-487`

**Interfaces:**
- Consumes: `RunEnqueuer.enqueue(...): Promise<boolean>`、`AppDb.listRunsForBatch`。
- Produces: `POST /api/batches/{id}/rerun`（`/rerun-failed` 为别名），响应 `{ batchId: number; queued: number }`；不创建批次。

- [ ] **Step 1: 写失败测试**

把 `tests/web.test.ts` 中现有重跑用例按新语义调整，并新增：

```ts
    it('POST /api/batches/:id/rerun 写回原批次且强跑不跳过', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'failed')])
      deps.db.getLatestRun.mockResolvedValue({ status: 'success', finishedAt: '2026-10-17 11:00:00.000' })
      deps.enqueuer.enqueue.mockResolvedValue(true)
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun').send({ runIds: [101] })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ batchId: 2, queued: 1 })
      expect(deps.db.createBatch).not.toHaveBeenCalled()
      expect(deps.enqueuer.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 't1', { batchId: 2, notBeforeMs: expect.any(Number) })
    })

    it('POST /api/batches/:id/rerun 允许成功行执行（行级执行）', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'success')])
      deps.enqueuer.enqueue.mockResolvedValue(true)
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun').send({ runIds: [101] })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ batchId: 2, queued: 1 })
    })

    it('POST /api/batches/:id/rerun 拒绝非最新轮次', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([
        runRow(101, 1, 'failed', 0),
        runRow(102, 1, 'failed', 1),
      ])
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun').send({ runIds: [101] })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain('该窗口已有更新轮次')
      expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
    })

    it('POST /api/batches/:id/rerun queued 统计真实入队数', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'failed'), runRow(102, 2, 'failed')])
      deps.db.listProfiles.mockResolvedValue([
        { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        { id: 2, bitbrowserId: 'bb-2', name: '窗口2', enabled: 1, circuitBreakerCount: 0 },
      ])
      deps.enqueuer.enqueue.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun').send({ runIds: [101, 102] })
      expect(res.body.data).toEqual({ batchId: 2, queued: 1 })
    })

    it('POST /api/batches/:id/rerun-failed 旧路径仍可用', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'failed')])
      deps.enqueuer.enqueue.mockResolvedValue(true)
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun-failed').send({ runIds: [101] })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ batchId: 2, queued: 1 })
    })
```

同时修改旧用例：
- `已成功窗口交给幂等入队（skipIfSuccess）` → 删除，由上面的“强跑不跳过”替代。
- `同窗口多条 runId 去重` → 替换为：

```ts
    it('POST /api/batches/:id/rerun 同窗口多条 runId 拒绝历史行', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([
        runRow(101, 1, 'failed', 0),
        runRow(102, 1, 'failed', 1),
      ])
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun').send({ runIds: [101, 102] })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain('该窗口已有更新轮次')
    })
```

- `runId 不属于批次或非失败状态 400` → 替换为：

```ts
    it('POST /api/batches/:id/rerun runId 不属于批次 400', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'failed')])
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun').send({ runIds: [999] })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(40000)
      expect(res.body.message).toContain('运行记录不属于该批次')
    })
```

- `circuitBreakerEnabled=false` 用例里加 `deps.enqueuer.enqueue.mockResolvedValue(true)`。
- 其余 `rerun-failed` 路径统一改为 `/rerun`；拒绝类用例不再断言 `createBatch` 未被调用（该接口已不建批次），改为断言 `deps.enqueuer.enqueue` 未被调用。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web.test.ts -t "rerun"`

Expected: FAIL（`/rerun` 404、仍调用 `createBatch`）。

- [ ] **Step 3: 实现**

把 `failedRunsByProfile` 替换为：

```ts
const RERUNNABLE_STATUSES: RunRow['status'][] = ['failed', 'captcha_failed']

/** 每窗口取批次内最新一轮（按 run id，跨日 slot 会归零不能按 slot） */
function latestRunsByProfile(runs: RunRow[]): Map<number, RunRow> {
  const byProfile = new Map<number, RunRow>()
  for (const run of runs) {
    const prev = byProfile.get(run.profileId)
    if (!prev || run.id > prev.id) byProfile.set(run.profileId, run)
  }
  return byProfile
}

/** 最新一轮仍为失败的窗口（批次头弹窗候选） */
function failedLatestRuns(runs: RunRow[]): RunRow[] {
  return [...latestRunsByProfile(runs).values()].filter((run) => RERUNNABLE_STATUSES.includes(run.status))
}
```

候选接口的循环改为：

```ts
    for (const run of failedLatestRuns(await deps.db.listRunsForBatch(batch.id))) {
```

重跑接口替换为（两个路径共用）：

```ts
  const rerunBatchHandler = asyncHandler(async (req, res) => {
    const batch = await getBatchOrThrow(deps.db, String(req.params.id))
    await ensureTaskRunnable(deps, batch.taskKey)
    const body = (req.body ?? {}) as { runIds?: unknown }
    const rawIds = body.runIds
    if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((id) => Number.isInteger(id) && (id as number) > 0)) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'runIds 必须为非空正整数数组')
    }
    const runIds = [...new Set(rawIds as number[])]
    const allRuns = await deps.db.listRunsForBatch(batch.id)
    const runById = new Map(allRuns.map((r: RunRow) => [r.id, r]))
    const latestByProfile = latestRunsByProfile(allRuns)
    const profileById = new Map((await deps.db.listProfiles(false)).map((p: ProfileRow) => [p.id, p]))
    const chosen = new Map<number, RunRow>()
    const blocked: string[] = []
    for (const runId of runIds) {
      const run = runById.get(runId)
      if (!run) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `运行记录不属于该批次: ${runId}`)
      const latest = latestByProfile.get(run.profileId)
      if (!latest || latest.id !== run.id) {
        throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `该窗口已有更新轮次，请刷新后重试: ${run.profileName}`)
      }
      const profile = profileById.get(run.profileId)
      if (!profile) {
        blocked.push(`窗口不存在(${run.profileId})`)
        continue
      }
      if (profile.enabled !== 1) {
        blocked.push(`${profile.name} 已停用`)
        continue
      }
      if (deps.circuitBreakerEnabled && (profile.circuitBreakerState ?? 'closed') !== 'closed') {
        blocked.push(`${profile.name} 熔断中`)
        continue
      }
      const inFlight = (await deps.db.countInFlightRuns(batch.taskKey, todayStr(), profile.id)) > 0
      if (inFlight) {
        blocked.push(`${profile.name} 执行中`)
        continue
      }
      chosen.set(profile.id, latest)
    }
    if (blocked.length > 0) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `以下窗口不可执行: ${blocked.join('、')}`)
    }
    let queued = 0
    for (const run of chosen.values()) {
      const profile = profileById.get(run.profileId) as ProfileRow
      if (await deps.enqueuer.enqueue(profile, batch.taskKey, { batchId: batch.id, notBeforeMs: Date.now() })) queued++
    }
    ok(res, { batchId: batch.id, queued })
  })
  router.post('/batches/:id/rerun', rerunBatchHandler)
  router.post('/batches/:id/rerun-failed', rerunBatchHandler)
```

Swagger 增加 `/api/batches/{id}/rerun`（summary：「按勾选窗口在原批次追加一轮」），旧路径标注 `deprecated: true`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/web.test.ts src/server/routes/batches.ts
git commit -m "feat: 批次重跑写回原批次并修复强跑与入队计数"
```

---

### Task 5: 前端 API 类型与调用

**Files:**
- Modify: `web/src/api/schema.d.ts:1250-1268`（批次项加 `lastActivityAt`）
- Modify: `web/src/api/schema.d.ts:1328-1348`（明细项加 `isLatest`）
- Modify: `web/src/types.ts:63-75`
- Modify: `web/src/api/endpoints.ts:6-7`
- Modify: `web/src/pages/dashboard/hooks.ts:83-95`
- Modify: `web/src/pages/dashboard/RerunFailedModal.tsx:12,29`
- Modify: `web/src/pages/dashboard/RerunFailedModal.test.tsx:13-18,115-223`

**Interfaces:**
- Produces: `rerunBatch(batchId: number, runIds: number[]): Promise<BatchRerunResult>`、`useRerunBatch()`；`BatchItem.lastActivityAt`、`RunRow.isLatest`。

- [ ] **Step 1: 更新类型与接口（先改代码，随后由类型检查兜底）**

`web/src/api/schema.d.ts` 批次项：

```ts
                                    createdAt?: string;
                                    lastActivityAt?: string;
```

明细 run 项：

```ts
                                    inFlight?: boolean;
                                    isLatest?: boolean;
```

`web/src/types.ts`：

```ts
export interface BatchRerunResult {
  batchId: number
  queued: number
}
```

删除原 `RerunFailedResult`，并把引用全部改为 `BatchRerunResult`。

`web/src/api/endpoints.ts`：

```ts
export const rerunBatch = (batchId: number, runIds: number[]) => post<BatchRerunResult>(`/api/batches/${batchId}/rerun`, { runIds })
```

`web/src/pages/dashboard/hooks.ts`：

```ts
export function useRerunBatch() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ batchId, runIds }: { batchId: number; runIds: number[] }) => rerunBatch(batchId, runIds),
    onSuccess: (res) => {
      message.success(`已提交 ${res.queued} 个窗口执行`)
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['batchDetail'] })
      queryClient.invalidateQueries({ queryKey: ['rerunCandidates'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

`RerunFailedModal.tsx` 与测试文件同步改名：`useRerunFailedBatch` → `useRerunBatch`、`rerunFailedBatch` → `rerunBatch`。`RerunFailedModal.test.tsx` 的 mock 改为：

```ts
import { fetchRerunCandidates, rerunBatch } from '../../api/endpoints'

vi.mock('../../api/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../../api/endpoints')>('../../api/endpoints')
  return { ...actual, fetchRerunCandidates: vi.fn(), rerunBatch: vi.fn() }
})
```

并把文中所有 `rerunFailedBatch` 替换为 `rerunBatch`。

- [ ] **Step 2: 跑类型检查确认失败已修复**

Run: `npm run typecheck`

Expected: PASS（若报未使用 `RerunFailedResult` 或找不到导出，按报错清理）。

- [ ] **Step 3: 跑前端测试**

Run: `npm run test:web`

Expected: PASS（`RerunFailedModal.test.tsx` 的 mock 名称已同步）。

- [ ] **Step 4: 提交**

```bash
git add web/src/api/schema.d.ts web/src/types.ts web/src/api/endpoints.ts web/src/pages/dashboard/hooks.ts web/src/pages/dashboard/RerunFailedModal.tsx web/src/pages/dashboard/RerunFailedModal.test.tsx
git commit -m "feat: 前端改用原批次重跑接口与最新轮次字段"
```

---

### Task 6: 看板按钮、历史轮次与行级动作

**Files:**
- Modify: `web/src/pages/dashboard/groupBatches.ts:15-18`
- Modify: `web/src/pages/dashboard/groupBatches.test.ts:38-58`
- Modify: `web/src/pages/dashboard/index.tsx`
- Test: `web/src/pages/dashboard/groupBatches.test.ts`

**Interfaces:**
- Consumes: `RunRow.isLatest`、`BatchItem.lastActivityAt`、`useRerunBatch()`。
- Produces: `canRerunFailed` 不再限制 `kind`；`latestOnly(runs)` 过滤历史轮次。

- [ ] **Step 1: 写失败测试**

`groupBatches.test.ts` 顶部导入改为：

```ts
import { splitBatches, batchProgress, batchTiming, canRerunFailed, latestOnly, isRunActionable, runActionTarget } from './groupBatches'
```

替换 `canRerunFailed` 用例：

```ts
describe('canRerunFailed 重跑失败按钮可见性', () => {
  const stats = (failed: number, captchaFailed = 0) => ({ total: 5, success: 4, failed, captchaFailed, skipped: 0, running: 0, pending: 0, retryWait: 0 })

  it('任意批次类型有失败即显示', () => {
    for (const kind of ['bulk', 'schedule', 'single'] as const) {
      expect(canRerunFailed(makeBatch({ kind, stats: stats(1) }))).toBe(true)
    }
  })

  it('验证码失败同样显示', () => {
    expect(canRerunFailed(makeBatch({ kind: 'schedule', stats: stats(0, 1) }))).toBe(true)
  })

  it('无失败不显示', () => {
    for (const kind of ['bulk', 'schedule', 'single'] as const) {
      expect(canRerunFailed(makeBatch({ kind, stats: stats(0) }))).toBe(false)
    }
  })
})

describe('latestOnly 历史轮次过滤', () => {
  it('保留 isLatest 为 true 或缺失的行', () => {
    const runs = [
      { id: 1, isLatest: false },
      { id: 2, isLatest: true },
      { id: 3 },
    ] as never
    expect(latestOnly(runs).map((r) => r.id)).toEqual([2, 3])
  })
})

describe('行级操作路由', () => {
  it('历史轮次不可操作，最新轮次可操作', () => {
    expect(isRunActionable({ isLatest: false } as never)).toBe(false)
    expect(isRunActionable({ isLatest: true } as never)).toBe(true)
    expect(isRunActionable({} as never)).toBe(true)
  })

  it('有 batchId 走原批次重跑，无 batchId 走单窗口触发', () => {
    expect(runActionTarget({ batchId: 2 } as never)).toBe('batch')
    expect(runActionTarget({ batchId: null } as never)).toBe('single')
    expect(runActionTarget({} as never)).toBe('single')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix web run test -- groupBatches`

Expected: FAIL（`schedule`/`single` 不显示、`latestOnly` 未导出）。

- [ ] **Step 3: 实现**

`groupBatches.ts`：

```ts
/** 批次卡片是否显示「重跑失败」：任意批次类型，只要最新一轮存在失败窗口 */
export function canRerunFailed(batch: BatchItem): boolean {
  return batch.stats.failed + batch.stats.captchaFailed > 0
}

/** 明细默认只展示每窗口最新一轮（旧数据无 isLatest 时视为最新） */
export function latestOnly(runs: RunRow[]): RunRow[] {
  return runs.filter((r) => r.isLatest !== false)
}

/** 只有每窗口最新一轮允许执行/重跑/停止 */
export function isRunActionable(run: RunRow): boolean {
  return run.isLatest !== false
}

/** 行级动作路由：批次内行写回原批次，未分批历史走单窗口触发 */
export function runActionTarget(run: RunRow): 'batch' | 'single' {
  return run.batchId == null ? 'single' : 'batch'
}
```

`RunActionCell` 使用这两个纯函数：

```tsx
function RunActionCell({ run }: { run: RunRow }) {
  const trigger = useTriggerTask()
  const stop = useStopRun()
  const rerun = useRerunBatch()
  if (!isRunActionable(run)) return <Tag>历史轮次</Tag>
  if (run.inFlight) {
    return (
      <ConfirmButton
        type="link"
        size="small"
        danger
        confirm={{ title: `停止窗口「${run.profileName}」的任务？`, okText: '停止' }}
        loading={stop.isPending && stop.variables === run.id}
        onConfirm={() => stop.mutate(run.id)}
      >
        停止
      </ConfirmButton>
    )
  }
  const failed = run.status === 'failed' || run.status === 'captcha_failed'
  const target = runActionTarget(run)
  const busy = target === 'batch'
    ? rerun.isPending && rerun.variables?.batchId === run.batchId && rerun.variables?.runIds[0] === run.id
    : trigger.isPending && trigger.variables?.bitbrowserId === run.bitbrowserId
  return (
    <Button
      type="link"
      size="small"
      loading={busy}
      disabled={!run.bitbrowserId}
      onClick={() => {
        if (!run.bitbrowserId) return
        if (target === 'batch' && run.batchId != null) rerun.mutate({ batchId: run.batchId, runIds: [run.id] })
        else trigger.mutate({ key: run.taskKey, bitbrowserId: run.bitbrowserId })
      }}
    >
      {failed ? '重跑' : '执行'}
    </Button>
  )
}
```

`index.tsx`：

1. 导入 `useRerunBatch`、`latestOnly`、`isRunActionable`、`runActionTarget`。
2. `BatchCard` 增加 `const [showHistory, setShowHistory] = useState(false)`；明细渲染：

```tsx
          {detail.data ? (
            <>
              {detail.data.runs.length > latestOnly(detail.data.runs).length && (
                <Button type="link" size="small" onClick={() => setShowHistory(!showHistory)}>
                  {showHistory ? '仅看最新轮次' : `显示历史轮次 ${detail.data.runs.length - latestOnly(detail.data.runs).length}`}
                </Button>
              )}
              <RunsTable
                runs={showHistory ? detail.data.runs : latestOnly(detail.data.runs)}
                loading={false}
                taskInfo={taskInfo}
              />
            </>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail.isPending ? '加载中…' : '暂无运行记录'} />}
```

3. 批次头时间追加最近活动：

```tsx
        <b>{formatDateTime(batch.createdAt)}</b>
        {batch.lastActivityAt != null && batch.lastActivityAt.slice(0, 10) !== batch.createdAt.slice(0, 10) && (
          <span style={{ color: '#999', fontSize: 12 }}>最近活动 {formatDateTime(batch.lastActivityAt)}</span>
        )}
```

4. 使用第 3 步定义的 `RunActionCell`（基于 `isRunActionable` / `runActionTarget`），在 `RunsTable` 与 `SingleBatchRow` 中替换行操作；两张表操作列的 `Space` 内容统一为：

```tsx
          <Space size={0}>
            {run.status === 'failed' && <DiagButton runId={run.id} screenshot={run.screenshot} />}
            <RunActionCell run={run} />
          </Space>
```

注意 `RunsTable` 内的 `useTriggerTask/useStopRun` 改为只由 `RunActionCell` 使用，删除未使用的 hook 调用。

5. `SingleBatchRow` 默认只渲染最新轮次：

```tsx
function SingleBatchRow({ batch, taskInfo }: { batch: BatchItem; taskInfo: TaskInfoMap }) {
  const detail = useBatchDetail(batch.id)
  const [showHistory, setShowHistory] = useState(false)
  const [rerunOpen, setRerunOpen] = useState(false)
  const allRuns = detail.data?.runs ?? []
  const runs = showHistory ? allRuns : latestOnly(allRuns)
  const failedCount = batch.stats.failed + batch.stats.captchaFailed
  return (
    <Space direction="vertical" size={4} style={{ display: 'flex' }}>
      <Space size={8}>
        {canRerunFailed(batch) && (
          <Button size="small" onClick={() => setRerunOpen(true)}>重跑失败 {failedCount}</Button>
        )}
        {allRuns.length > latestOnly(allRuns).length && (
          <Button type="link" size="small" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? '仅看最新轮次' : `显示历史轮次 ${allRuns.length - latestOnly(allRuns).length}`}
          </Button>
        )}
      </Space>
      <Table<RunRow>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={runs}
        loading={detail.isPending}
        locale={{ emptyText: detail.isPending ? '加载中…' : '暂无记录' }}
        columns={[
          { title: '时间', width: 130, render: () => formatDateTime(batch.createdAt) },
          { title: '任务', width: 120, render: () => <TaskName info={taskInfo[batch.taskKey]} fallback={batch.taskKey} /> },
          { title: '窗口', dataIndex: 'profileName', width: 130, render: (n: string, r) => (
            <span>{n}<div style={{ fontSize: 11, color: '#999' }}>{(r.bitbrowserId ?? '').slice(0, 8)}</div></span>
          ) },
          {
            title: '预计开始',
            dataIndex: 'notBeforeMs',
            width: 90,
            render: (ms: number | null | undefined, r) =>
              r.status === 'pending' || r.status === 'retry_wait' ? formatEta(ms) : '—',
          },
          { title: '状态', dataIndex: 'status', width: 100, render: (s: RunRow['status']) => <StatusPill status={s} /> },
          { title: '失败类型', dataIndex: 'failureKind', width: 100, render: (k: RunRow['failureKind']) => (k ? failureKindLabel(k) : '—') },
          { title: '错误', dataIndex: 'error', ellipsis: true, render: (e: string | null) => (e ? <Typography.Text type="danger" ellipsis={{ tooltip: e }} style={{ maxWidth: 220 }}>{e}</Typography.Text> : '—') },
          { title: '截图', width: 80, render: (_, r) => <ScreenshotButton runId={r.id} /> },
          { title: '操作', width: 130, render: (_, r) => (
            <Space size={0}>
              {r.status === 'failed' && <DiagButton runId={r.id} screenshot={r.screenshot} />}
              <RunActionCell run={r} />
            </Space>
          ) },
        ]}
      />
      <RerunFailedModal batchId={batch.id} open={rerunOpen} onClose={() => setRerunOpen(false)} />
    </Space>
  )
}
```

导入补充：`import { useState } from 'react'` 已有；`import { splitBatches, batchProgress, batchTiming, canRerunFailed, latestOnly, isRunActionable, runActionTarget } from './groupBatches'`。

`groupBatches.ts` 顶部补 `import type { BatchItem, RunRow } from '../../types'`。

`RunsTable` 与 `SingleBatchRow` 内原有的 `useTriggerTask/useStopRun` 调用删除，只保留 `RunActionCell` 内的调用，避免未使用变量导致类型检查失败。

6. 修正批次耗时起算（Task 1 审阅遗留）：跨日重跑后不能再用 `createdAt` 起算，否则显示多天耗时。`groupBatches.ts` 的 `batchTiming` 改为从 `lastActivityAt` 起算（缺省回落 `createdAt`），并同步 `splitBatches` 的过时注释：

```ts
export function batchTiming(batch: BatchItem): { finished: boolean; durationSec: number | null } {
  const s = batch.stats
  const finished = s.running === 0 && s.pending === 0 && s.retryWait === 0
  if (!finished || !batch.lastFinishedAt) return { finished, durationSec: null }
  const end = new Date(batch.lastFinishedAt.replace(' ', 'T')).getTime()
  const start = new Date((batch.lastActivityAt ?? batch.createdAt).replace(' ', 'T')).getTime()
  const sec = Math.round((end - start) / 1000)
  return { finished, durationSec: Number.isFinite(sec) ? sec : null }
}
```

`groupBatches.test.ts` 的 `makeBatch` 增加 `lastActivityAt: over.lastActivityAt ?? over.createdAt ?? '2026-09-04 09:00:00.000'`，并追加用例：

```ts
  it('跨日重跑后耗时从最近活动起算', () => {
    const t = batchTiming(makeBatch({
      createdAt: '2026-09-04 09:00:00.000',
      lastActivityAt: '2026-09-05 09:00:00.000',
      lastFinishedAt: '2026-09-05 09:26:10.000',
      stats: { total: 1, success: 1, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 },
    }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBe(1570)
  })
```

`splitBatches` 注释改为「主列表仍按后端最近活动时间倒序」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:web`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/dashboard/groupBatches.ts web/src/pages/dashboard/groupBatches.test.ts web/src/pages/dashboard/index.tsx
git commit -m "feat: 看板重跑按钮覆盖所有批次类型并折叠历史轮次"
```

---

### Task 7: 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md:148`（看板使用步骤）
- Modify: `docs/API-GUIDE.md:1163`、`1185`（触发与幂等口径）
- Modify: `docs/API-GUIDE.md` 第 8.2 节（面板使用）
- Modify: `AGENTS.md:122`

**Interfaces:**
- Consumes: 前六个任务完成后的实际行为。
- Produces: 用户手册与协作者说明不再描述“新建 rerun-failed 批次 / skipIfSuccess”。

- [ ] **Step 1: 更新 API-GUIDE 批次重跑说明**

把第 5 条（约第 148 行）改为：

```markdown
5. **重跑批次失败**：任意批次类型（批量/定时/单窗口）只要存在失败窗口，卡片头都会显示「重跑失败 N」；弹窗预览该批次每窗口最新一轮，已成功窗口默认不勾（可手勾强跑），停用/熔断/执行中的窗口不可勾。确认后所有勾选窗口在原批次追加新一轮（不新建批次），失败数随最新一轮成功自动减少。明细行「重跑/执行」同样写回当前批次；历史轮次默认折叠，只读保留截图与诊断。
```

把第 1163 行中 `rerun-failed 带 skipIfSuccess` 的表述改为：

```markdown
批量触发、批次重跑、多窗口测试触发与定时计划都不按窗口铺开；批次重跑写回原批次并强制入队（不按当天成功跳过）。
```

把第 1185 行幂等说明改为：

```markdown
- 幂等：定时计划与批量/测试触发按触发时刻执行，不按当天成功跳过；批次重跑/行级执行由用户显式勾选即执行，也不按当天成功跳过；单窗口触发始终新建一轮。定时计划额外用 `last_fired_minute` 持久化分钟去重。
```

第 8.2 节补充：

```markdown
- 批次统计按“每个窗口最新一轮”计算，`total` 为窗口数；重跑成功后原失败状态被最新轮次替代。
- 批次时间线按最近活动时间归属：昨天的批次今天重跑后会回到今天列表，卡片显示最近活动时间。
- 批次明细默认只显示最新轮次，可展开历史轮次；历史行不可再执行。
- 接口：`POST /api/batches/{id}/rerun`（body `{ runIds }`，写回原批次）；旧 `/rerun-failed` 保留为别名。
```

- [ ] **Step 2: 更新 AGENTS.md**

把第 122 行替换为：

```markdown
- 批量触发（任务页「立即触发」）、批次重跑、多窗口测试触发与定时触发都不再按窗口铺开：触发即写 `pending` 并立即到期。批次重跑（批次头/明细行）写回原批次并强制入队，不按当天成功跳过；批次统计与明细按每窗口最新一轮（`run.id` 最大）计算，历史轮次保留但只读。定时/批量/测试触发属于显式执行，不按当天成功跳过（否则 hourly 计划会退化成每天一次），定时计划用 `last_fired_minute` 持久化分钟去重；单窗口手动触发始终新建一轮可重跑。
```

- [ ] **Step 3: 提交**

```bash
git add docs/API-GUIDE.md AGENTS.md
git commit -m "docs: 同步批次重跑归属原批次与最新轮次口径"
```

---

### Task 8: 全量验证

**Files:**
- 无新增文件。

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`

Expected: 无错误输出，退出码 0。

- [ ] **Step 2: 后端测试**

Run: `npm test`

Expected: 全部测试通过，退出码 0。

- [ ] **Step 3: 前端测试**

Run: `npm run test:web`

Expected: 全部测试通过，退出码 0。

- [ ] **Step 4: 检查工作区**

Run: `git status --short`

Expected: 无未提交改动（或仅剩用户自己的临时文件，且不在暂存区）。

- [ ] **Step 5: 手动冒烟（可选，需真实环境）**

1. 打开看板，确认昨天的 `schedule` 批次今天重跑后出现在今天列表。
2. 对含失败窗口的定时批次点「重跑失败 N」，确认弹窗候选为最新失败窗口。
3. 确认重跑后原批次 `N` 递减、明细出现新轮次、历史轮次可展开且无操作按钮。
4. 对明细行点「执行」，确认新轮次仍归属该批次。

# 看板批次「重跑失败」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板批次卡片支持「重跑失败」：先预览每个失败窗口今天最新一轮状态，弹窗二次勾选，用户确认后按勾选窗口强制执行。

**Architecture:** 后端在 `batchesRouter` 增加两个接口——预览候选与按 `runIds` 执行；执行时新建 `bulk` 批次并复用 `CoalescingEnqueuer`（错峰 + 双闸门）。前端新增 `RerunFailedModal`，用 antd Table 的 `rowSelection` 完成默认勾选与强跑勾选，批次卡片只负责打开弹窗。

**Tech Stack:** TypeScript 严格模式、Express 5、libsql/SQLite、React 18、antd 5、react-query、vitest、supertest、testing-library。

## Global Constraints

- 无分号、单引号、2 空格缩进、TS 严格模式；注释/文档/commit message 用中文。
- 分层依赖不可反向：`server → engine/infrastructure`；前端请求只走 `web/src/api/client.ts` / `endpoints.ts`。
- API 统一响应 `{code,message,data}`，使用 `ok` / `asyncHandler`；错误用 `HttpError` + `ERROR_CODES`。
- 不新增 `src/api/index.ts` 导出函数（否则会触发文档漂移守卫）。
- 验证命令：`npm run typecheck`、`npm test`、`npm run test:web`、`npx tsc -b web/tsconfig.json`。
- 不提交 `config/.env`、`config/config.local.json`、`config/accounts.xlsx`。
- 只有用户明确要求时才执行 git commit；本计划中的提交步骤按此约束执行。

---

### Task 1: 后端预览与按勾选重跑接口

**Files:**
- Modify: `src/server/routes/batches.ts`
- Modify: `src/server/app.ts:74`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: `AppDb.getBatch/listRunsForBatch/listProfiles/getLatestRun/countInFlightRuns/getTaskEnabled/createBatch`、`CoalescingEnqueuer.enqueue/hasTaskInFlight`、`cfg.execution.circuitBreakerThreshold`。
- Produces:
  - `GET /api/batches/:id/rerun-candidates` → `{ batchId, taskKey, candidates: RerunCandidateView[] }`
  - `POST /api/batches/:id/rerun-failed` body `{ runIds: number[] }` → `{ batchId, queued }`
  - `batchesRouter(deps)` 依赖新增 `circuitBreakerThreshold: number`。

- [ ] **Step 1: 写失败测试（扩展到 `tests/web.test.ts`）**

在 `MockDeps['db']` 中加一行：

```ts
    getLatestRun: Mock
```

在 `makeDeps().db` 中加一行（放在 `countInFlightRuns` 后）：

```ts
      getLatestRun: vi.fn().mockResolvedValue(null),
```

在 `describe('batches API', () => {` 内、现有用例前加辅助函数：

```ts
    const runRow = (id: number, profileId: number, status: 'failed' | 'captcha_failed' | 'success', slot = 0) => ({
      id,
      profileId,
      taskKey: 't1',
      date: '2026-10-17',
      slot,
      status,
      attempts: 1,
      error: 'boom',
      screenshot: null,
      startedAt: null,
      finishedAt: null,
      batchId: 2,
      diagPath: null,
      profileName: `窗口${profileId}`,
      bitbrowserId: `bb-${profileId}`,
    })
```

在 `POST /api/runs/:id/stop 不存在 404（40409）` 用例之后追加：

```ts
    it('GET /api/batches/:id/rerun-candidates 标记已成功/在途/停用/熔断并计算默认勾选', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([
        runRow(101, 1, 'failed'),
        runRow(102, 2, 'captcha_failed'),
        runRow(103, 3, 'failed'),
        runRow(104, 4, 'failed'),
      ])
      deps.db.listProfiles.mockResolvedValue([
        { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        { id: 2, bitbrowserId: 'bb-2', name: '窗口2', enabled: 1, circuitBreakerCount: 0 },
        { id: 3, bitbrowserId: 'bb-3', name: '窗口3', enabled: 0, circuitBreakerCount: 0 },
        { id: 4, bitbrowserId: 'bb-4', name: '窗口4', enabled: 1, circuitBreakerCount: 2 },
      ])
      deps.db.getLatestRun.mockImplementation((profileId: number) => Promise.resolve(
        profileId === 1
          ? { status: 'success', finishedAt: '2026-10-17 11:00:00.000' }
          : profileId === 2
            ? { status: 'running', finishedAt: null }
            : { status: 'failed', finishedAt: '2026-10-17 10:00:00.000' },
      ))
      deps.db.countInFlightRuns.mockImplementation((_task: string, _date: string, profileId?: number) => Promise.resolve(profileId === 2 ? 1 : 0))

      const res = await request(createApp(deps as never)).get('/api/batches/2/rerun-candidates')
      expect(res.status).toBe(200)
      const byProfile = Object.fromEntries(res.body.data.candidates.map((c: { profileId: number }) => [c.profileId, c]))
      expect(byProfile[1]).toMatchObject({ alreadySuccess: true, latestStatus: 'success', selectable: true, defaultSelected: false })
      expect(byProfile[2]).toMatchObject({ alreadySuccess: false, inFlight: true, selectable: true, defaultSelected: true })
      expect(byProfile[3]).toMatchObject({ selectable: false, defaultSelected: false, blockedReason: 'profile-disabled' })
      expect(byProfile[4]).toMatchObject({ selectable: false, defaultSelected: false, blockedReason: 'circuit-breaker' })
    })

    it('GET /api/batches/:id/rerun-candidates 同窗口多行取 slot 最大', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([
        runRow(101, 1, 'failed', 0),
        runRow(102, 1, 'failed', 1),
      ])
      const res = await request(createApp(deps as never)).get('/api/batches/2/rerun-candidates')
      expect(res.status).toBe(200)
      expect(res.body.data.candidates).toHaveLength(1)
      expect(res.body.data.candidates[0].runId).toBe(102)
    })

    it('GET /api/batches/:id/rerun-candidates 批次不存在 404（40405）', async () => {
      const deps = makeDeps()
      deps.db.getBatch.mockResolvedValue(null)
      const res = await request(createApp(deps as never)).get('/api/batches/999/rerun-candidates')
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(40405)
    })

    it('GET /api/batches/:id/rerun-candidates 任务停用 409（40901）', async () => {
      const deps = makeDeps()
      deps.db.getTaskEnabled.mockResolvedValue(false)
      const res = await request(createApp(deps as never)).get('/api/batches/2/rerun-candidates')
      expect(res.status).toBe(409)
      expect(res.body.code).toBe(40901)
    })

    it('POST /api/batches/:id/rerun-failed 勾选已成功窗口也强制执行', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'failed')])
      deps.db.getLatestRun.mockResolvedValue({ status: 'success', finishedAt: '2026-10-17 11:00:00.000' })
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun-failed').send({ runIds: [101] })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ batchId: 88, queued: 1 })
      expect(deps.db.createBatch).toHaveBeenCalledWith('bulk', 't1', 'rerun-failed')
      expect(deps.enqueuer.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 't1', { batchId: 88 })
    })

    it('POST /api/batches/:id/rerun-failed 停用窗口拒绝执行', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'failed')])
      deps.db.listProfiles.mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 0, circuitBreakerCount: 0 }])
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun-failed').send({ runIds: [101] })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(40000)
      expect(res.body.message).toContain('窗口1 已停用')
      expect(deps.db.createBatch).not.toHaveBeenCalled()
      expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
    })

    it('POST /api/batches/:id/rerun-failed 熔断窗口拒绝执行', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'failed')])
      deps.db.listProfiles.mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 2 }])
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun-failed').send({ runIds: [101] })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(40000)
      expect(res.body.message).toContain('窗口1 熔断中')
    })

    it('POST /api/batches/:id/rerun-failed runId 不属于批次或非失败状态 400', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([runRow(101, 1, 'success')])
      const res1 = await request(createApp(deps as never)).post('/api/batches/2/rerun-failed').send({ runIds: [101] })
      expect(res1.status).toBe(400)
      expect(res1.body.code).toBe(40000)
      const res2 = await request(createApp(deps as never)).post('/api/batches/2/rerun-failed').send({ runIds: [999] })
      expect(res2.status).toBe(400)
      expect(res2.body.code).toBe(40000)
    })

    it('POST /api/batches/:id/rerun-failed 同窗口多条 runId 去重', async () => {
      const deps = makeDeps()
      deps.db.listRunsForBatch.mockResolvedValue([
        runRow(101, 1, 'failed', 0),
        runRow(102, 1, 'failed', 1),
      ])
      const res = await request(createApp(deps as never)).post('/api/batches/2/rerun-failed').send({ runIds: [101, 102] })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ batchId: 88, queued: 1 })
      expect(deps.enqueuer.enqueue).toHaveBeenCalledTimes(1)
    })

    it('POST /api/batches/:id/rerun-failed runIds 为空或非法 400', async () => {
      const res1 = await request(createApp(makeDeps() as never)).post('/api/batches/2/rerun-failed').send({ runIds: [] })
      expect(res1.status).toBe(400)
      expect(res1.body.code).toBe(40000)
      const res2 = await request(createApp(makeDeps() as never)).post('/api/batches/2/rerun-failed').send({ runIds: ['1'] })
      expect(res2.status).toBe(400)
      expect(res2.body.code).toBe(40000)
    })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web.test.ts -t "rerun"`
Expected: FAIL（新接口返回 404，`getLatestRun` 未被调用）。

- [ ] **Step 3: 实现后端**

把 `src/server/routes/batches.ts` 顶部导入改为：

```ts
import { todayStr, type AppDb, type BatchRow, type ProfileRow, type RunRow } from '../../infrastructure/db'
```

在 `runDurationSec` 下方加入：

```ts
const RERUN_FAILED_STATUSES: RunRow['status'][] = ['failed', 'captcha_failed']

/** 批次内失败行按窗口去重（同窗口取 slot 最大的一行） */
function failedRunsByProfile(runs: RunRow[]): RunRow[] {
  const byProfile = new Map<number, RunRow>()
  for (const run of runs) {
    if (!RERUN_FAILED_STATUSES.includes(run.status)) continue
    const prev = byProfile.get(run.profileId)
    if (!prev || run.slot > prev.slot) byProfile.set(run.profileId, run)
  }
  return [...byProfile.values()]
}

/** 取批次并校验 id；不存在抛 404 */
async function getBatchOrThrow(db: AppDb, rawId: string): Promise<BatchRow> {
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '批次 id 必须为正整数')
  const batch = await db.getBatch(id)
  if (!batch) throw new HttpError(404, ERROR_CODES.BATCH_NOT_FOUND, '批次不存在')
  return batch
}

/** 任务不存在 404、任务停用 409（与手动触发守卫一致） */
async function ensureTaskRunnable(deps: BatchesDeps, taskKey: string): Promise<SiteTask> {
  const task = deps.tasks.get(taskKey)
  if (!task) throw new HttpError(404, ERROR_CODES.TASK_NOT_FOUND, `任务不存在: ${taskKey}`)
  if (!(await deps.db.getTaskEnabled(taskKey, task.meta.enabled ?? true))) {
    throw new HttpError(409, ERROR_CODES.TASK_DISABLED, '任务已停用')
  }
  return task
}
```

把 `batchesRouter` 签名改为：

```ts
export interface BatchesDeps {
  db: AppDb
  enqueuer: CoalescingEnqueuer
  tasks: Map<string, SiteTask>
  stopper: TaskStopper
  getRunById: AppDb['getRunById']
  circuitBreakerThreshold: number
}

export function batchesRouter(deps: BatchesDeps): Router {
```

在 `GET /batches/:id` 路由之后、`POST /batches/:id/stop` 之前插入：

```ts
  /**
   * @swagger
   * /api/batches/{id}/rerun-candidates:
   *   get:
   *     summary: 预览批次内失败窗口（今天最新一轮状态/在途/可执行性）
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       '200':
   *         description: 候选窗口列表
   */
  router.get('/batches/:id/rerun-candidates', asyncHandler(async (req, res) => {
    const batch = await getBatchOrThrow(deps.db, String(req.params.id))
    await ensureTaskRunnable(deps, batch.taskKey)
    const profiles = await deps.db.listProfiles(false)
    const profileById = new Map(profiles.map((p: ProfileRow) => [p.id, p]))
    const today = todayStr()
    const candidates = []
    for (const run of failedRunsByProfile(await deps.db.listRunsForBatch(batch.id))) {
      const profile = profileById.get(run.profileId)
      const latest = profile ? await deps.db.getLatestRun(profile.id, batch.taskKey, today) : null
      const inFlight = profile
        ? (await deps.db.countInFlightRuns(batch.taskKey, today, profile.id)) > 0 || deps.enqueuer.hasTaskInFlight(batch.taskKey, profile.id)
        : false
      const blockedReason = !profile
        ? 'profile-missing'
        : profile.enabled !== 1
          ? 'profile-disabled'
          : profile.circuitBreakerCount >= deps.circuitBreakerThreshold
            ? 'circuit-breaker'
            : null
      const alreadySuccess = latest?.status === 'success'
      candidates.push({
        runId: run.id,
        profileId: run.profileId,
        profileName: profile?.name ?? run.profileName,
        bitbrowserId: profile?.bitbrowserId ?? run.bitbrowserId,
        status: run.status,
        error: run.error,
        finishedAt: run.finishedAt,
        latestStatus: latest?.status ?? null,
        latestFinishedAt: latest?.finishedAt ?? null,
        alreadySuccess,
        inFlight,
        selectable: blockedReason === null,
        defaultSelected: blockedReason === null && !alreadySuccess,
        blockedReason,
      })
    }
    ok(res, { batchId: batch.id, taskKey: batch.taskKey, candidates })
  }))

  /**
   * @swagger
   * /api/batches/{id}/rerun-failed:
   *   post:
   *     summary: 按勾选的失败运行行重跑（新建 bulk 批次，勾选即执行）
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [runIds]
   *             properties:
   *               runIds:
   *                 type: array
   *                 items: { type: integer }
   *     responses:
   *       '200':
   *         description: 已入队窗口数
   *       '400':
   *         description: runIds 非法或窗口不可执行（业务码 40000）
   *       '404':
   *         description: 批次/任务不存在（40405/40401）
   *       '409':
   *         description: 任务已停用（40901）
   */
  router.post('/batches/:id/rerun-failed', asyncHandler(async (req, res) => {
    const batch = await getBatchOrThrow(deps.db, String(req.params.id))
    await ensureTaskRunnable(deps, batch.taskKey)
    const body = (req.body ?? {}) as { runIds?: unknown }
    const rawIds = body.runIds
    if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((id) => Number.isInteger(id) && (id as number) > 0)) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'runIds 必须为非空正整数数组')
    }
    const runIds = [...new Set(rawIds as number[])]
    const runById = new Map((await deps.db.listRunsForBatch(batch.id)).map((r: RunRow) => [r.id, r]))
    const profileById = new Map((await deps.db.listProfiles(false)).map((p: ProfileRow) => [p.id, p]))
    const chosen = new Map<number, RunRow>()
    const blocked: string[] = []
    for (const runId of runIds) {
      const run = runById.get(runId)
      if (!run || (run.status !== 'failed' && run.status !== 'captcha_failed')) {
        throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `运行记录不属于该批次或不是失败状态: ${runId}`)
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
      if (profile.circuitBreakerCount >= deps.circuitBreakerThreshold) {
        blocked.push(`${profile.name} 熔断中`)
        continue
      }
      const prev = chosen.get(profile.id)
      if (!prev || run.slot > prev.slot) chosen.set(profile.id, run)
    }
    if (blocked.length > 0) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `以下窗口不可执行: ${blocked.join('、')}`)
    }
    const batchRow = await deps.db.createBatch('bulk', batch.taskKey, 'rerun-failed')
    const profilesToRun = [...chosen.values()].map((run) => profileById.get(run.profileId) as ProfileRow)
    for (const profile of profilesToRun) deps.enqueuer.enqueue(profile, batch.taskKey, { batchId: batchRow.id })
    ok(res, { batchId: batchRow.id, queued: profilesToRun.length })
  }))
```

修改 `src/server/app.ts:74`：

```ts
  api.use(batchesRouter({ db: deps.db, enqueuer: deps.enqueuer, tasks: deps.tasks, stopper: deps.stopper, getRunById: deps.getRunById, circuitBreakerThreshold: deps.cfg.execution.circuitBreakerThreshold }))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web.test.ts -t "rerun"`
Expected: 全部 PASS。

- [ ] **Step 5: 全量后端验证**

Run: `npm run typecheck; npm test`
Expected: 0 errors，全部用例 PASS。

- [ ] **Step 6: 提交（仅在用户明确要求提交时执行）**

```powershell
git add src/server/routes/batches.ts src/server/app.ts tests/web.test.ts
git commit -m "feat: 批次失败窗口预检与按勾选重跑接口"
```

---

### Task 2: 前端类型、接口与 hooks

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api/endpoints.ts`
- Modify: `web/src/pages/dashboard/hooks.ts`

**Interfaces:**
- Consumes: Task 1 的两个接口响应。
- Produces:
  - `RerunBlockedReason`、`RerunCandidate`、`RerunCandidatesData`、`RerunFailedResult`
  - `fetchRerunCandidates(batchId)`、`rerunFailedBatch(batchId, runIds)`
  - `useRerunCandidates(batchId)`、`useRerunFailedBatch()`

- [ ] **Step 1: 在 `web/src/types.ts` 的 `RunRow` 定义后追加**

```ts
/** 失败重跑不可执行原因（与后端 blockedReason 枚举一致） */
export type RerunBlockedReason = 'profile-missing' | 'profile-disabled' | 'circuit-breaker'

/** 批次失败重跑候选窗口（预览接口返回） */
export interface RerunCandidate {
  runId: number
  profileId: number
  profileName: string
  bitbrowserId: string
  status: RunStatus
  error: string | null
  finishedAt: string | null
  latestStatus: RunStatus | null
  latestFinishedAt: string | null
  alreadySuccess: boolean
  inFlight: boolean
  selectable: boolean
  defaultSelected: boolean
  blockedReason: RerunBlockedReason | null
}

export interface RerunCandidatesData {
  batchId: number
  taskKey: string
  candidates: RerunCandidate[]
}

export interface RerunFailedResult {
  batchId: number
  queued: number
}
```

- [ ] **Step 2: 修改 `web/src/api/endpoints.ts`**

第 2 行的类型导入追加 `RerunCandidatesData, RerunFailedResult`：

```ts
import { get, post, patch, del } from './client'
import type { BatchesData, BatchDetailData, RerunCandidatesData, RerunFailedResult, TaskMetaView, ProfileRow, ProfileBatchAction, ProfileBatchResult, SettingsData, DatasourceInfo, ScheduleItem, ScheduleConfigInput, ToolItem, FileAssignTemplate, FileAssignRow, FileAssignPreview, FileAssignApplyResult, RunScheduleResult, AirdropPriority, AirdropImportItem, AirdropImportResult, AirdropProjectInput, AirdropProjectPatch, AirdropProjectView, AirdropReminders, AirdropStatusItem, AirdropTodoItem, DiagBundle } from '../types'
```

在 `fetchBatchDetail` 后加：

```ts
export const fetchRerunCandidates = (batchId: number) => get<RerunCandidatesData>(`/api/batches/${batchId}/rerun-candidates`)
export const rerunFailedBatch = (batchId: number, runIds: number[]) => post<RerunFailedResult>(`/api/batches/${batchId}/rerun-failed`, { runIds })
```

- [ ] **Step 3: 修改 `web/src/pages/dashboard/hooks.ts`**

第 3 行改为：

```ts
import { fetchBatches, fetchBatchDetail, fetchRerunCandidates, rerunFailedBatch, fetchTasks, triggerTask, stopBatch, stopRun } from '../../api/endpoints'
```

在 `useBatchDetail` 后加：

```ts
export function useRerunCandidates(batchId: number | null) {
  return useQuery({
    queryKey: ['rerunCandidates', batchId],
    queryFn: () => fetchRerunCandidates(batchId as number),
    enabled: batchId !== null,
    staleTime: 0,
    retry: false,
  })
}
```

在 `useStopRun` 前加：

```ts
export function useRerunFailedBatch() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ batchId, runIds }: { batchId: number; runIds: number[] }) => rerunFailedBatch(batchId, runIds),
    onSuccess: (res) => {
      message.success(`已提交 ${res.queued} 个窗口重跑`)
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['batchDetail'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc -b web/tsconfig.json`
Expected: 0 errors。

---

### Task 3: 失败重跑弹窗

**Files:**
- Create: `web/src/pages/dashboard/RerunFailedModal.tsx`
- Create: `web/src/pages/dashboard/RerunFailedModal.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `useRerunCandidates`、`useRerunFailedBatch`、`RerunCandidate`、`RerunBlockedReason`。
- Produces: `RerunFailedModal({ batchId, open, onClose })`，供 Task 4 的批次卡片使用。

- [ ] **Step 1: 写失败测试**

创建 `web/src/pages/dashboard/RerunFailedModal.test.tsx`：

```tsx
/**
 * RerunFailedModal 单测：默认勾选、已成功可强勾、停用不可选、确认提交 runIds
 * 依赖方向：mock ../../api/endpoints，用 QueryClientProvider + App 包裹
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import type { ReactNode } from 'react'
import RerunFailedModal from './RerunFailedModal'
import { fetchRerunCandidates, rerunFailedBatch } from '../../api/endpoints'
import type { RerunCandidatesData } from '../../types'

vi.mock('../../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints')>()
  return { ...actual, fetchRerunCandidates: vi.fn(), rerunFailedBatch: vi.fn() }
})

// antd Table 在 jsdom 下渲染较重，全量并行跑时默认 5s 超时不够，本文件单独放宽
vi.setConfig({ testTimeout: 20000 })

const data: RerunCandidatesData = {
  batchId: 2,
  taskKey: 't1',
  candidates: [
    { runId: 1, profileId: 1, profileName: '窗口1', bitbrowserId: 'bb-1', status: 'failed', error: 'boom', finishedAt: null, latestStatus: 'success', latestFinishedAt: '2026-10-17 11:00:00.000', alreadySuccess: true, inFlight: false, selectable: true, defaultSelected: false, blockedReason: null },
    { runId: 2, profileId: 2, profileName: '窗口2', bitbrowserId: 'bb-2', status: 'captcha_failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: true, selectable: true, defaultSelected: true, blockedReason: null },
    { runId: 3, profileId: 3, profileName: '窗口3', bitbrowserId: 'bb-3', status: 'failed', error: null, finishedAt: null, latestStatus: 'failed', latestFinishedAt: null, alreadySuccess: false, inFlight: false, selectable: false, defaultSelected: false, blockedReason: 'profile-disabled' },
  ],
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}><App>{children}</App></QueryClientProvider>
}

describe('RerunFailedModal', () => {
  it('默认勾选非成功窗口，已成功可手动勾选，停用不可选，确认提交选中 runIds', async () => {
    vi.mocked(fetchRerunCandidates).mockResolvedValue(data)
    vi.mocked(rerunFailedBatch).mockResolvedValue({ batchId: 9, queued: 2 })
    render(<RerunFailedModal batchId={2} open onClose={() => {}} />, { wrapper })
    await screen.findByText('后续已成功')
    await waitFor(() => expect(screen.getByRole('button', { name: /重跑选中 1 个/ })).toBeEnabled())
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[1]).not.toBeChecked()
    expect(boxes[2]).toBeChecked()
    expect(boxes[3]).toBeDisabled()
    fireEvent.click(boxes[1])
    expect(screen.getByRole('button', { name: /重跑选中 2 个/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重跑选中 2 个/ }))
    await waitFor(() => expect(rerunFailedBatch).toHaveBeenCalledWith(2, [1, 2]))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web -- RerunFailedModal`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `RerunFailedModal.tsx`**

```tsx
/**
 * 批次失败重跑弹窗（dashboard 层）：预览失败窗口最新状态，二次勾选后按 runId 提交
 * 依赖方向：依赖 api/endpoints、types 与 hooks；打开时拉取预览，提交走 useRerunFailedBatch
 */
import { useEffect, useRef, useState } from 'react'
import type { Key, ReactNode } from 'react'
import { Alert, Button, Empty, Modal, Spin, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import StatusPill from '../../components/StatusPill'
import type { RerunBlockedReason, RerunCandidate } from '../../types'
import { formatDateTime } from './format'
import { useRerunCandidates, useRerunFailedBatch } from './hooks'

const BLOCKED_TEXT: Record<RerunBlockedReason, string> = {
  'profile-missing': '窗口不存在',
  'profile-disabled': '窗口已停用',
  'circuit-breaker': '窗口熔断中，请先重置',
}

export interface RerunFailedModalProps {
  batchId: number | null
  open: boolean
  onClose: () => void
}

export default function RerunFailedModal({ batchId, open, onClose }: RerunFailedModalProps) {
  const query = useRerunCandidates(open ? batchId : null)
  const submit = useRerunFailedBatch()
  const [selected, setSelected] = useState<Key[]>([])
  const initializedBatch = useRef<number | null>(null)

  useEffect(() => {
    if (!open) {
      initializedBatch.current = null
      setSelected([])
      return
    }
    if (!query.data || initializedBatch.current === query.data.batchId) return
    initializedBatch.current = query.data.batchId
    setSelected(query.data.candidates.filter((c) => c.defaultSelected).map((c) => c.runId))
  }, [open, query.data])

  const candidates = query.data?.candidates ?? []
  const columns: ColumnsType<RerunCandidate> = [
    {
      title: '窗口',
      width: 160,
      render: (_, c) => (
        <span>
          {c.profileName}
          <div style={{ fontSize: 11, color: '#999' }}>{c.bitbrowserId.slice(0, 8)}</div>
        </span>
      ),
    },
    {
      title: '失败状态',
      width: 180,
      render: (_, c) => (
        <span>
          <StatusPill status={c.status} />
          {c.error && <Typography.Text type="danger" ellipsis={{ tooltip: c.error }} style={{ maxWidth: 120, marginLeft: 6 }}>{c.error}</Typography.Text>}
        </span>
      ),
    },
    {
      title: '今天最新一轮',
      width: 190,
      render: (_, c) => c.latestStatus
        ? (
          <span>
            <StatusPill status={c.latestStatus} />
            <span style={{ fontSize: 12, color: '#999' }}> {c.latestFinishedAt ? formatDateTime(c.latestFinishedAt) : '—'}</span>
          </span>
        )
        : '无记录',
    },
    {
      title: '提示',
      render: (_, c) => (
        <span>
          {c.alreadySuccess && <Tag color="green">后续已成功</Tag>}
          {c.inFlight && <Tag color="orange">在途·将排队</Tag>}
          {c.blockedReason && <Tag color="red">{BLOCKED_TEXT[c.blockedReason]}</Tag>}
        </span>
      ),
    },
  ]

  let content: ReactNode
  if (query.isPending) {
    content = <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
  } else if (query.isError || !query.data) {
    content = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="预览加载失败" />
  } else if (candidates.length === 0) {
    content = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该批次没有失败窗口" />
  } else {
    content = (
      <>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message="已成功窗口默认不勾选，勾选后仍会强制执行；停用/熔断窗口不可选。"
        />
        <Table<RerunCandidate>
          size="small"
          rowKey="runId"
          pagination={false}
          dataSource={candidates}
          columns={columns}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys),
            getCheckboxProps: (c) => ({ disabled: !c.selectable }),
          }}
        />
      </>
    )
  }

  return (
    <Modal
      open={open}
      title="重跑失败窗口"
      width={760}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button
          key="ok"
          type="primary"
          loading={submit.isPending}
          disabled={selected.length === 0}
          onClick={() => {
            if (batchId == null || selected.length === 0) return
            submit.mutate({ batchId, runIds: selected.map(Number) }, { onSuccess: onClose })
          }}
        >
          重跑选中 {selected.length} 个
        </Button>,
      ]}
    >
      {content}
    </Modal>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:web -- RerunFailedModal`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npx tsc -b web/tsconfig.json`
Expected: 0 errors。

---

### Task 4: 批次卡片接入与批次标签

**Files:**
- Modify: `web/src/pages/dashboard/index.tsx`

**Interfaces:**
- Consumes: Task 3 的 `RerunFailedModal({ batchId, open, onClose })`。
- Produces: 批次卡片「重跑失败 N」按钮；`source='rerun-failed'` 显示「批量 · 重跑失败」。

- [ ] **Step 1: 接入弹窗与按钮**

在 `index.tsx` 第 10 行后加：

```tsx
import RerunFailedModal from './RerunFailedModal'
```

在 `KIND_TAG` 后加：

```tsx
function batchTag(batch: BatchItem): { label: string; color: string } {
  if (batch.source === 'rerun-failed') return { label: '批量 · 重跑失败', color: 'orange' }
  return KIND_TAG[batch.kind]
}
```

在 `BatchCard` 的 `const stop = useStopBatch()` 后加：

```tsx
  const [rerunOpen, setRerunOpen] = useState(false)
```

在 `const stats = batch.stats` 后加：

```tsx
  const failedCount = stats.failed + stats.captchaFailed
  const tag = batchTag(batch)
```

把显示标签的 `<Tag color={KIND_TAG[batch.kind].color}>{KIND_TAG[batch.kind].label}</Tag>` 改为：

```tsx
        <Tag color={tag.color}>{tag.label}</Tag>
```

在停止按钮的 `</span>` 之后、`<span style={{ marginLeft: 'auto' ... }}>` 之前加：

```tsx
        {failedCount > 0 && (
          <span onClick={(e) => e.stopPropagation()}>
            <Button size="small" onClick={() => setRerunOpen(true)}>重跑失败 {failedCount}</Button>
          </span>
        )}
```

在 `</Card>` 前、展开明细 `<div>` 之后加：

```tsx
      <RerunFailedModal batchId={batch.id} open={rerunOpen} onClose={() => setRerunOpen(false)} />
```

- [ ] **Step 2: 全量验证**

Run: `npm run typecheck; npm test; npm run test:web; npx tsc -b web/tsconfig.json`
Expected: 全部 PASS，0 类型错误。

- [ ] **Step 3: 手动验证（可选，需用户环境）**

Run: `npm run dev`
Expected:
- 打开看板，含失败窗口的批次卡片显示「重跑失败 N」。
- 点击后弹窗列出失败窗口；今天最新一轮成功的窗口默认不勾选、可手动勾选；停用/熔断窗口 checkbox 置灰。
- 勾选后确认，提示「已提交 N 个窗口重跑」，看板出现「批量 · 重跑失败」新批次。
- 勾选已成功窗口时确实重新执行（不再被后端跳过）。

- [ ] **Step 4: 提交（仅在用户明确要求提交时执行）**

```powershell
git add web/src/types.ts web/src/api/endpoints.ts web/src/pages/dashboard/hooks.ts web/src/pages/dashboard/RerunFailedModal.tsx web/src/pages/dashboard/RerunFailedModal.test.tsx web/src/pages/dashboard/index.tsx
git commit -m "feat(web): 看板批次失败窗口二次勾选重跑"
```

---

## 自检结果

- **Spec 覆盖**：预览接口、执行接口、默认勾选、已成功强勾、停用/熔断不可选、在途排队、批次标签、测试与验证均有对应任务。
- **占位符**：无 TBD/TODO，所有代码步骤含完整代码。
- **类型一致性**：`RerunCandidate` / `RerunCandidatesData` / `RerunFailedResult` / `blockedReason` 前后端命名一致；执行接口统一用 `runIds`。
- **文档**：已核实 `docs/API-GUIDE.md` 当前只有第 1~7 章函数手册，无「面板使用」「REST 接口总表」章节；本次以 Swagger 注解为 API 文档，不新增 `src/api/index.ts` 导出，不触发文档漂移守卫。

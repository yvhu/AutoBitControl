/**
 * 批次路由（server 层）：运行批次列表与明细（看板批次时间线数据源）
 * 依赖方向：依赖 infrastructure/db 与 engine/queue，被 app 装配
 * 设计思路：列表接口轻量（仅批次行 + 聚合统计 + 全局数字）供 15s 轮询；
 *           明细接口懒加载（展开窗口明细时请求）
 */
import { Router } from 'express'
import { todayStr, type AppDb, type BatchRow, type ProfileRow, type RunRow } from '../../infrastructure/db'
import type { RunEnqueuer } from '../../engine/queue'
import type { TaskStopper } from '../../engine/task-stopper'
import type { SiteTask } from '../../tasks/base'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'

/** 运行耗时（秒）：started/finished 任一缺失或解析失败返回 null（墙钟字符串解析与重试恢复同口径） */
function runDurationSec(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null
  const s = new Date(startedAt.replace(' ', 'T')).getTime()
  const f = new Date(finishedAt.replace(' ', 'T')).getTime()
  if (Number.isNaN(s) || Number.isNaN(f)) return null
  return Math.round((f - s) / 1000)
}

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
 *     summary: 列出运行批次（含每批统计与全局数字）
 *     parameters:
 *       - in: query
 *         name: range
 *         schema: { type: string, enum: [today, 7d, all] }
 *         description: 时间范围（缺省 today）
 *     responses:
 *       '200':
 *         description: 批次列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     range: { type: string }
 *                     batches:
 *                       type: array
 *                       items: { type: object }
 *                     unbatched:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           profileId: { type: integer }
 *                           taskKey: { type: string }
 *                           date: { type: string }
 *                           slot: { type: integer }
 *                           status: { type: string }
 *                           attempts: { type: integer }
 *                           error: { type: string, nullable: true }
 *                           screenshot: { type: string, nullable: true }
 *                           startedAt: { type: string, nullable: true }
 *                           finishedAt: { type: string, nullable: true }
 *                           batchId: { type: integer, nullable: true }
 *                           diagPath: { type: string, nullable: true }
 *                           failureKind: { type: string, nullable: true, enum: [environment, task, timeout, stopped, captcha, breaker] }
 *                           durationSec: { type: integer, nullable: true }
 *                           inFlight: { type: boolean }
 *                           notBeforeMs: { type: integer, format: int64, nullable: true }
 *                           profileName: { type: string }
 *                           bitbrowserId: { type: string }
 *                     running: { type: integer }
 *                     taskNames: { type: object, additionalProperties: { type: string } }
 *                     today: { type: string }
 */

/**
 * @swagger
 * /api/batches/{id}:
 *   get:
 *     summary: 查看批次明细（窗口运行行）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       '200':
 *         description: 批次明细
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     batch: { type: object }
 *                     runs:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           profileId: { type: integer }
 *                           taskKey: { type: string }
 *                           date: { type: string }
 *                           slot: { type: integer }
 *                           status: { type: string }
 *                           attempts: { type: integer }
 *                           error: { type: string, nullable: true }
 *                           screenshot: { type: string, nullable: true }
 *                           startedAt: { type: string, nullable: true }
 *                           finishedAt: { type: string, nullable: true }
 *                           batchId: { type: integer, nullable: true }
 *                           diagPath: { type: string, nullable: true }
 *                           failureKind: { type: string, nullable: true, enum: [environment, task, timeout, stopped, captcha, breaker] }
 *                           durationSec: { type: integer, nullable: true }
 *                           inFlight: { type: boolean }
 *                           notBeforeMs: { type: integer, format: int64, nullable: true }
 *                           profileName: { type: string }
 *                           bitbrowserId: { type: string }
 */
export interface BatchesDeps {
  db: AppDb
  enqueuer: RunEnqueuer
  tasks: Map<string, SiteTask>
  stopper: TaskStopper
  getRunById: AppDb['getRunById']
  /** 窗口熔断总开关：关闭时不把数据库里的历史 raw 状态当作重跑阻塞原因 */
  circuitBreakerEnabled: boolean
}

export function batchesRouter(deps: BatchesDeps): Router {
  const router = Router()
  router.get('/batches', asyncHandler(async (req, res) => {
    const range = typeof req.query.range === 'string' ? req.query.range : 'today'
    const today = todayStr()
    const from = range === 'all' ? null : range === '7d' ? daysAgoStr(6) : today
    const batches = await deps.db.listBatchesForRange(from, today)
    const unbatched = await Promise.all((await deps.db.listUnbatchedRuns(from, today)).map(async (r) => ({
      ...r,
      durationSec: runDurationSec(r.startedAt, r.finishedAt),
      inFlight: (await deps.db.countInFlightRuns(r.taskKey, today, r.profileId)) > 0,
    })))
    // 实时运行：DB 在途行数（跨任务，并发查询后求和；pending 已计入，队列无需额外补数）
    const running = (await Promise.all([...deps.tasks.keys()].map((key) => deps.db.countInFlightRuns(key, today)))).reduce((a, b) => a + b, 0)
    const taskNames: Record<string, string> = {}
    for (const [key, t] of deps.tasks) taskNames[key] = t.meta.name
    ok(res, {
      range,
      batches,
      unbatched,
      running,
      taskNames,
      today,
    })
  }))
  router.get('/batches/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '批次 id 必须为正整数')
    const batch = await deps.db.getBatch(id)
    if (!batch) throw new HttpError(404, ERROR_CODES.BATCH_NOT_FOUND, '批次不存在')
    const rows = await deps.db.listRunsForBatch(id)
    const today = todayStr()
    ok(res, {
      batch,
      runs: await Promise.all(rows.map(async (r) => ({
        ...r,
        durationSec: runDurationSec(r.startedAt, r.finishedAt),
        inFlight: (await deps.db.countInFlightRuns(r.taskKey, today, r.profileId)) > 0,
      }))),
    })
  }))

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
        ? (await deps.db.countInFlightRuns(batch.taskKey, today, profile.id)) > 0
        : false
      const breakerBlocked = deps.circuitBreakerEnabled && (profile?.circuitBreakerState ?? 'closed') !== 'closed'
      const blockedReason = !profile
        ? 'profile-missing'
        : profile.enabled !== 1
          ? 'profile-disabled'
          : breakerBlocked
            ? 'circuit-breaker'
            : inFlight
              ? 'in-flight'
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
      if (deps.circuitBreakerEnabled && (profile.circuitBreakerState ?? 'closed') !== 'closed') {
        blocked.push(`${profile.name} 熔断中`)
        continue
      }
      const inFlight = (await deps.db.countInFlightRuns(batch.taskKey, todayStr(), profile.id)) > 0
      if (inFlight) {
        blocked.push(`${profile.name} 执行中`)
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
    for (const profile of profilesToRun) {
      await deps.enqueuer.enqueue(profile, batch.taskKey, { batchId: batchRow.id, notBeforeMs: Date.now(), skipIfSuccess: true })
    }
    ok(res, { batchId: batchRow.id, queued: profilesToRun.length })
  }))

  /**
   * @swagger
   * /api/batches/{id}/stop:
   *   post:
   *     summary: 停止批次内全部在途运行与排队窗口（置 skipped「手动停止」）
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       '200':
   *         description: 已停止数据
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 code: { type: integer, example: 0 }
   *                 message: { type: string, example: ok }
   *                 data:
   *                   type: object
   *                   properties:
   *                     stopped: { type: integer }
   *       '404':
   *         description: 批次不存在（业务码 40405）
   */

  /**
   * @swagger
   * /api/runs/{id}/stop:
   *   post:
   *     summary: 停止单个运行行（置 skipped「手动停止」）
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       '200':
   *         description: 是否停止
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 code: { type: integer, example: 0 }
   *                 message: { type: string, example: ok }
   *                 data:
   *                   type: object
   *                   properties:
   *                     stopped: { type: boolean }
   *       '404':
   *         description: 运行记录不存在（业务码 40409）
   */
  router.post('/batches/:id/stop', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '批次 id 必须为正整数')
    const batch = await deps.db.getBatch(id)
    if (!batch) throw new HttpError(404, ERROR_CODES.BATCH_NOT_FOUND, '批次不存在')
    ok(res, { stopped: await deps.stopper.stopBatch(id) })
  }))
  router.post('/runs/:id/stop', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '运行 id 必须为正整数')
    const run = await deps.getRunById(id)
    if (!run) throw new HttpError(404, ERROR_CODES.RUN_NOT_FOUND, '运行记录不存在')
    ok(res, { stopped: await deps.stopper.stop(run.profileId, run.taskKey, run.date) })
  }))
  return router
}

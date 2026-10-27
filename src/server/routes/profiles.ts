/**
 * 窗口路由（server 层）：窗口列表、启用开关、打开/关闭与熔断重置
 * 依赖方向：依赖 engine/infrastructure；被 app 装配
 * 设计思路：find 辅助统一 404 语义；PATCH 幂等局部更新（只改传了的字段）；
 * "是否已打开"以比特浏览器 pid 实测为准（open_windows 登记行仅供复用/清理，不参与判定）
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import type { AppDb, ProfileRow } from '../../infrastructure/db'
import type { Logger } from '../../infrastructure/logger'
import { isProcessAlive, reclaimOrphanWindows, waitForWindowClosed } from '../../engine/window-registry'

/** 面板关窗后等待 pids 消失的总时长（毫秒） */
const PANEL_CLOSE_CONFIRM_TIMEOUT_MS = 15_000

/** epoch 毫秒转本地墙钟字符串（与 db.localWallNow 同口径，供面板展示下次探测时间） */
function probeAtText(ms: number | null | undefined): string | null {
  if (ms == null) return null
  const d = new Date(ms)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace('T', ' ')
}

/** 窗口记录转面板视图：在原始字段上补充稳定命名的熔断健康字段 */
function toProfileView(p: ProfileRow, open: boolean) {
  return {
    ...p,
    open,
    breakerState: p.circuitBreakerState ?? 'closed',
    breakerNextProbeAt: probeAtText(p.circuitBreakerNextProbeMs),
    breakerReason: p.circuitBreakerReason ?? null,
    breakerUpdatedAt: p.circuitBreakerUpdatedAt ?? null,
  }
}

/**
 * @swagger
 * /api/profiles:
 *   get:
 *     summary: 列出窗口（含启用状态、熔断计数与打开状态）
 *     responses:
 *       '200':
 *         description: 窗口列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       bitbrowserId: { type: string }
 *                       name: { type: string }
 *                       enabled: { type: integer, description: '0/1 开关' }
 *                       circuitBreakerCount: { type: integer }
 *                       breakerState: { type: string, enum: [closed, open, half_open] }
 *                       breakerNextProbeAt: { type: string, nullable: true }
 *                       breakerReason: { type: string, nullable: true }
 *                       breakerUpdatedAt: { type: string, nullable: true }
 *                       open: { type: boolean, description: '是否已打开（比特浏览器 pid 实测）' }
 *                       remark: { type: string, nullable: true, description: '比特客户端窗口备注' }
 *                       seq: { type: integer, nullable: true, description: '比特客户端排序号' }
 *                       lastIp: { type: string, nullable: true, description: '最近探测 IP' }
 *                       lastCountry: { type: string, nullable: true, description: '最近探测国家' }
 *                       coreVersion: { type: string, nullable: true, description: '浏览器内核版本' }
 */

/**
 * @swagger
 * /api/profiles/{id}:
 *   patch:
 *     summary: 切换窗口开关（只更新显式传入的 enabled 字段）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *     responses:
 *       '200':
 *         description: 当前窗口记录快照（更新前的字段值）
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
 *                     id: { type: integer }
 *                     bitbrowserId: { type: string }
 *                     name: { type: string }
 *                     enabled: { type: integer }
 *                     circuitBreakerCount: { type: integer }
 *       '404':
 *         description: 窗口不存在（业务码 40402）
 */

/**
 * @swagger
 * /api/profiles/{id}/breaker/reset:
 *   post:
 *     summary: 重置窗口熔断健康状态
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     responses:
 *       '200':
 *         description: 重置后的窗口视图
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
 *                     id: { type: integer }
 *                     bitbrowserId: { type: string }
 *                     name: { type: string }
 *                     enabled: { type: integer }
 *                     circuitBreakerCount: { type: integer }
 *                     breakerState: { type: string, enum: [closed, open, half_open] }
 *                     breakerNextProbeAt: { type: string, nullable: true }
 *                     breakerReason: { type: string, nullable: true }
 *                     breakerUpdatedAt: { type: string, nullable: true }
 *       '404':
 *         description: 窗口不存在（业务码 40402）
 */

/**
 * @swagger
 * /api/profiles/{id}/open:
 *   post:
 *     summary: 打开窗口（已打开则直接复用；登记 open_windows 供跨进程复用）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     responses:
 *       '200':
 *         description: 打开完成（already=true 表示此前已在打开状态，未重新开窗）
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
 *                     already: { type: boolean, description: 'true=复用已开窗口；false=本次新开' }
 *       '404':
 *         description: 窗口不存在（业务码 40402）
 *       '409':
 *         description: 同时打开的窗口已达 windowPool.maxOpenWindows 上限（业务码 40907）
 */

/**
 * @swagger
 * /api/profiles/{id}/close:
 *   post:
 *     summary: 关闭窗口并清除打开状态登记（未登记也会尝试关窗一次）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     responses:
 *       '200':
 *         description: 已关闭
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data: { nullable: true }
 *       '404':
 *         description: 窗口不存在（业务码 40402）
 */

/**
 * @swagger
 * /api/profiles/batch:
 *   post:
 *     summary: 批量操作窗口（打开、关闭、重置熔断，逐项处理并汇总成败）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, ids]
 *             properties:
 *               action: { type: string, enum: [open, close, resetBreaker] }
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *     responses:
 *       '200':
 *         description: 逐项结果汇总
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
 *                     total: { type: integer }
 *                     succeeded: { type: integer }
 *                     failed:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           error: { type: string }
 *       '400':
 *         description: action 非法或 ids 非空数字数组（业务码 40000）
 */

export function profilesRouter(deps: {
  db: AppDb
  bitbrowser: {
    openBrowser(id: string): Promise<{ http: string; ws: string }>
    closeBrowser(id: string): Promise<void>
    isOpen(id: string): Promise<boolean>
    openPids(ids: string[]): Promise<Set<string>>
  }
  /** 同时打开窗口上限（execution.windowPool.maxOpenWindows）；打开前校验，达上限拒绝 */
  maxOpenWindows: number
  /** 置窗口会话取消标记（手动关窗前中止在途会话；由 app 注入 CancelRegistry.requestSession） */
  cancelSession(profileId: number): void
  /** 日志器（孤儿回收打点用） */
  logger: Logger
}): Router {
  const router = Router()
  /** 按内部 id 查窗口，不存在抛 404（各端点共用） */
  const find = async (id: number): Promise<ProfileRow> => {
    const profile = (await deps.db.listProfiles(false)).find((p: ProfileRow) => p.id === id)
    if (!profile) throw new HttpError(404, ERROR_CODES.PROFILE_NOT_FOUND, `窗口不存在: ${id}`)
    return profile
  }

  /** 批量操作类型（打开/关闭/重置熔断） */
  type BatchAction = 'open' | 'close' | 'resetBreaker'

  /**
   * 打开前校验同时打开窗口上限（execution.windowPool.maxOpenWindows）：
   * 以 /browser/pids 实测全量窗口数为准；满额时先回收孤儿窗口（仅 state=open 且归属进程已死）腾名额，
   * 仍满才抛 409；探测/回收失败（本地 API 未就绪）放行，避免校验本身阻断。
   * Phase 1 不回收「存活但无登记」的窗口（可能处于已开未登记窗口期，留给 Phase 2 对账）。
   */
  const ensureWindowCapacity = async (): Promise<void> => {
    const max = deps.maxOpenWindows
    if (!Number.isFinite(max)) return
    const ids = (await deps.db.listProfiles(false)).map((p: ProfileRow) => p.bitbrowserId)
    let open: Set<string>
    try {
      open = await deps.bitbrowser.openPids(ids)
    } catch {
      return
    }
    if (open.size >= max) {
      const reclaimed = await reclaimOrphanWindows({ db: deps.db, bitbrowser: deps.bitbrowser }, deps.logger).catch(() => 0)
      if (reclaimed > 0) {
        try {
          open = await deps.bitbrowser.openPids(ids)
        } catch {
          return
        }
      }
    }
    if (open.size >= max) {
      throw new HttpError(409, ERROR_CODES.WINDOW_LIMIT_REACHED, `同时打开的窗口已达上限（${max}），请先关闭部分窗口再开`)
    }
  }

  /** 单窗口动作执行（单窗口端点与批量端点共用）；open 返回 already 语义；openIds 为批量预探测的存活集合（缺省逐窗口 isOpen） */
  const applyAction = async (profile: ProfileRow, action: BatchAction, openIds?: Set<string>): Promise<{ already?: boolean }> => {
    if (action === 'resetBreaker') {
      await deps.db.resetWindowHealth(profile.id)
      deps.logger.info({ profile: profile.name }, '手动重置窗口熔断状态')
      return {}
    }
    if (action === 'open') {
      // 已有登记且 pid 实测存活 → 直接复用（already），避免重复开窗
      const row = await deps.db.getOpenWindow(profile.bitbrowserId)
      const alive = openIds ? openIds.has(profile.bitbrowserId) : await deps.bitbrowser.isOpen(profile.bitbrowserId)
      // 空 http 是残留占位登记，不能当作「已打开」直接返回，否则任务仍会复用空地址；
      // 存活但状态不是 open（如 closing）时先归一到 open，保持与复用规则一致
      if (row?.http.trim() && alive) {
        if (row.state !== 'open') await deps.db.setWindowState(profile.bitbrowserId, 'open')
        return { already: true }
      }
      // 已有 opening 登记：窗口池/其它入口正在开窗，重复开窗会改写归属（pool → manual）
      if (row?.state === 'opening') return { already: true }
      await ensureWindowCapacity()
      // 先预留归属登记（避免「已开未登记」竞态被孤儿回收误关），开成功后补 http
      await deps.db.reserveOpenWindow(profile.bitbrowserId, process.pid)
      try {
        const opened = await deps.bitbrowser.openBrowser(profile.bitbrowserId)
        await deps.db.setOpenWindow(profile.bitbrowserId, opened.http, process.pid)
      } catch (e) {
        await deps.db.clearOpenWindow(profile.bitbrowserId).catch(() => {})
        throw e
      }
      return { already: false }
    }
    // close：有在途 running 行时先置会话取消标记（关窗会打断任务，runner 按手动停止结算）；
    // 无 running 不置，避免标记泄漏到该窗口的下一次合法会话
    if (await deps.db.hasRunningRun(profile.id)) deps.cancelSession(profile.id)
    // 无论有无登记都调一次关窗（窗口可能由别处打开未登记）；有登记时先标 closing，
    // 关窗后确认 pids 消失再清行；关窗/探测失败/超时保留登记，交由 Phase 2 对账
    const row = await deps.db.getOpenWindow(profile.bitbrowserId)
    if (row) await deps.db.setWindowState(profile.bitbrowserId, 'closing').catch(() => {})
    let closeFailed = false
    await deps.bitbrowser.closeBrowser(profile.bitbrowserId).catch((e) => {
      closeFailed = true
      deps.logger.warn({ bitbrowserId: profile.bitbrowserId, err: (e as Error).message }, '面板关窗失败，保留登记待 Phase 2 对账')
    })
    if (row && !closeFailed) {
      const closed = await waitForWindowClosed(
        async () => (await deps.bitbrowser.openPids([profile.bitbrowserId])).has(profile.bitbrowserId),
        { timeoutMs: PANEL_CLOSE_CONFIRM_TIMEOUT_MS },
      )
      if (closed) await deps.db.clearOpenWindow(profile.bitbrowserId)
    }
    return {}
  }

  router.get('/profiles', asyncHandler(async (req, res) => {
    const profiles = await deps.db.listProfiles(false)
    // 批量一次探测全部窗口 pid（避免 100 窗口逐个 isOpen 请求）；
    // 探测失败（本地 API 未就绪）时不清理登记行（无法判定真死），全部按未开返回
    let openIds: Set<string> | null
    try {
      openIds = await deps.bitbrowser.openPids(profiles.map(p => p.bitbrowserId))
    } catch {
      openIds = null
    }
    const result: Array<ReturnType<typeof toProfileView>> = []
    for (const p of profiles) {
      // 打开状态以比特浏览器 pid 实测为准：窗口可能由任务运行/手动打开，未必有 open_windows 登记行，
      // 故不能要求「登记行存在」才算已开（否则真实已开的窗口会显示未打开）；
      // 探测失败（openIds=null）保守按未开；顺带清理「有登记行但 pid 已死」的残留登记。
      // state=opening 的预留行不能清：开窗请求已发出但 pid 尚未可见，清掉会让归属登记丢失
      const alive = openIds?.has(p.bitbrowserId) ?? false
      if (!alive && openIds !== null) {
        const row = await deps.db.getOpenWindow(p.bitbrowserId)
        // 归属进程仍存活时不做单次探测清行：窗口可能只是瞬时未上报，
        // 交给调度器对账清理，避免把在用登记删成「无登记存活窗口」占满额度。
        if (row && row.state !== 'opening' && (row.ownerPid == null || !isProcessAlive(row.ownerPid))) {
          await deps.db.clearOpenWindow(p.bitbrowserId)
        }
      }
      result.push(toProfileView(p, alive))
    }
    ok(res, result)
  }))
  router.patch('/profiles/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const profile = await find(id)
    const body = req.body as { enabled?: boolean } ?? {}
    // 只更新显式传入的字段：enabled 开关（钱包密码已改为环境变量 WALLET_PASSWORDS 配置，不在此处修改）
    if (typeof body.enabled === 'boolean') await deps.db.setProfileEnabled(id, body.enabled)
    ok(res, profile)
  }))
  router.post('/profiles/:id/breaker/reset', asyncHandler(async (req, res) => {
    const profile = await find(Number(req.params.id))
    await applyAction(profile, 'resetBreaker')
    // 重置只清熔断状态，不改窗口开关：open 以比特浏览器 pid 实测为准；
    // 探测失败（本地 API 短暂不可用）降级为未打开，不让重置接口 500
    const open = await deps.bitbrowser.isOpen(profile.bitbrowserId).catch(() => false)
    ok(res, toProfileView(await find(profile.id), open))
  }))
  router.post('/profiles/:id/open', asyncHandler(async (req, res) => {
    ok(res, await applyAction(await find(Number(req.params.id)), 'open'))
  }))
  router.post('/profiles/:id/close', asyncHandler(async (req, res) => {
    await applyAction(await find(Number(req.params.id)), 'close')
    ok(res)
  }))
  router.post('/profiles/batch', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { action?: unknown; ids?: unknown }
    const valid: BatchAction[] = ['open', 'close', 'resetBreaker']
    if (!valid.includes(body.action as BatchAction)) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'action 必须为 open/close/resetBreaker')
    }
    if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((x) => typeof x === 'number')) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'ids 必须为非空数字数组')
    }
    const action = body.action as BatchAction
    const ids = body.ids as number[]
    // 一次性加载窗口表建 id→profile 映射，避免逐项全表 listProfiles
    const byId = new Map<number, ProfileRow>((await deps.db.listProfiles(false)).map((p: ProfileRow) => [p.id, p] as const))
    // open 前一次性探测全部选中窗口 pid（避免逐项 isOpen 单窗口请求）；探测失败降级为逐窗口 isOpen
    let openIds: Set<string> | null = null
    if (action === 'open') {
      try {
        openIds = await deps.bitbrowser.openPids(ids.map((id) => byId.get(id)?.bitbrowserId).filter((x): x is string => x !== undefined))
      } catch {
        openIds = null
      }
    }
    const failed: Array<{ id: number; error: string }> = []
    let succeeded = 0
    for (const id of ids) {
      try {
        const profile = byId.get(id)
        if (!profile) throw new HttpError(404, ERROR_CODES.PROFILE_NOT_FOUND, `窗口不存在: ${id}`)
        await applyAction(profile, action, openIds ?? undefined)
        succeeded++
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) })
      }
    }
    ok(res, { total: ids.length, succeeded, failed })
  }))
  return router
}

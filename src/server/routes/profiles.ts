/**
 * 窗口路由（server 层）：窗口列表、启用开关、打开/关闭与熔断重置
 * 依赖方向：依赖 engine/infrastructure；被 app 装配
 * 设计思路：find 辅助统一 404 语义；PATCH 幂等局部更新（只改传了的字段）；
 * "是否已打开"以 open_windows 登记 + 比特浏览器 pid 实测双重判定（跨进程共享）
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import type { AppDb, ProfileRow } from '../../infrastructure/db'

/**
 * @swagger
 * /api/profiles:
 *   get:
 *     summary: 窗口列表（含启用状态、熔断计数与打开状态）
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
 *                       open: { type: boolean, description: '是否已打开（open_windows 登记 + 比特浏览器 pid 实测）' }
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
 *     summary: 窗口开关（只更新显式传入的 enabled 字段）
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
 *     summary: 重置该窗口熔断计数
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 窗口内部 id
 *     responses:
 *       '200':
 *         description: 已重置
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

export function profilesRouter(deps: {
  db: AppDb
  bitbrowser: {
    openBrowser(id: string): Promise<{ http: string; ws: string }>
    closeBrowser(id: string): Promise<void>
    isOpen(id: string): Promise<boolean>
    openPids(ids: string[]): Promise<Set<string>>
  }
}): Router {
  const router = Router()
  /** 按内部 id 查窗口，不存在抛 404（各端点共用） */
  const find = async (id: number): Promise<ProfileRow> => {
    const profile = (await deps.db.listProfiles(false)).find((p: ProfileRow) => p.id === id)
    if (!profile) throw new HttpError(404, ERROR_CODES.PROFILE_NOT_FOUND, `窗口不存在: ${id}`)
    return profile
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
    const result: Array<ProfileRow & { open: boolean }> = []
    for (const p of profiles) {
      // 判定链：无登记 → 未开；有登记且 pid 存活 → 已开；有登记但 pid 已死 → 视为已关（自动清行）
      const row = await deps.db.getOpenWindow(p.bitbrowserId)
      if (row && openIds?.has(p.bitbrowserId)) {
        result.push({ ...p, open: true })
        continue
      }
      if (row && openIds !== null) await deps.db.clearOpenWindow(p.bitbrowserId)
      result.push({ ...p, open: false })
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
    const id = Number(req.params.id)
    await find(id)
    // 手动重置熔断：面板详情抽屉入口（连续失败恢复后放行）
    await deps.db.resetCircuitBreaker(id)
    ok(res)
  }))
  router.post('/profiles/:id/open', asyncHandler(async (req, res) => {
    const profile = await find(Number(req.params.id))
    // 已有登记且 pid 实测存活 → 直接复用（already），避免重复开窗
    const row = await deps.db.getOpenWindow(profile.bitbrowserId)
    if (row && await deps.bitbrowser.isOpen(profile.bitbrowserId)) {
      ok(res, { already: true })
      return
    }
    const opened = await deps.bitbrowser.openBrowser(profile.bitbrowserId)
    // 登记打开状态（http 调试地址）：供面板状态展示与 task:run/窗口会话跨进程复用
    await deps.db.setOpenWindow(profile.bitbrowserId, opened.http)
    ok(res, { already: false })
  }))
  router.post('/profiles/:id/close', asyncHandler(async (req, res) => {
    const profile = await find(Number(req.params.id))
    const row = await deps.db.getOpenWindow(profile.bitbrowserId)
    // 无论有无登记都调一次关窗（窗口可能由别处打开未登记）；关窗失败忽略（pid 已死等同已关）
    await deps.bitbrowser.closeBrowser(profile.bitbrowserId).catch(() => {})
    if (row) await deps.db.clearOpenWindow(profile.bitbrowserId)
    ok(res)
  }))
  return router
}

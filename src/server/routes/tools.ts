/**
 * 工具路由（server 层）：工具清单 + 文件随机分配 + 代理网络（clash）
 * 依赖方向：server → tools（注册表/planner/applier）；ToolError 在此映射为统一响应
 */
import { Router } from 'express'
import type { Response } from 'express'
import { ok, fail, asyncHandler } from '../http/response'
import { ERROR_CODES } from '../http/errors'
import { TOOLS } from '../../tools'
import { preparePreview } from '../../tools/file-assign/planner'
import type { FileAssignService } from '../../tools/file-assign/applier'
import { ToolError } from '../../tools/errors'
import type { AssignRow, FileAssignTemplate } from '../../tools/file-assign/types'
import type { ClashTestResult, OptimizeResult, AutoOptimizerStatus } from '../../tools/clash/types'

/**
 * @swagger
 * /api/tools:
 *   get:
 *     summary: 工具清单（面板工具中心卡片数据源）
 *     responses:
 *       '200':
 *         description: 工具列表
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
 *                     tools:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key: { type: string }
 *                           name: { type: string }
 *                           description: { type: string }
 */

/**
 * @swagger
 * /api/tools/file-assign/preview:
 *   post:
 *     summary: 文件随机分配预览（校验并生成分配计划，不落盘）
 *     responses:
 *       '200':
 *         description: 分配计划
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
 *                     accountsCount: { type: integer }
 *                     filesCount: { type: integer }
 *                     plan:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           rowNumber: { type: integer }
 *                           window: { type: string }
 *                           oldName: { type: string }
 *                           newName: { type: string }
 *                           newPath: { type: string }
 */

/**
 * @swagger
 * /api/tools/file-assign/apply:
 *   post:
 *     summary: 文件随机分配执行（按预览回传计划改名并写回 xlsx）
 *     responses:
 *       '200':
 *         description: 执行结果
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
 *                     renamedCount: { type: integer }
 *                     updatedRows: { type: integer }
 *                     reloadedRows: { type: integer }
 */

/**
 * @swagger
 * /api/tools/clash/status:
 *   get:
 *     summary: 代理网络状态（客户端探测/分组/当前节点/自动检测状态）
 *     responses:
 *       '200':
 *         description: 状态汇总
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
 *                     detected: { type: boolean }
 *                     kernel: { type: string, nullable: true }
 *                     mixedPort: { type: integer, nullable: true }
 *                     apiBase: { type: string }
 *                     delaySupported: { type: boolean }
 *                     group: { type: string }
 *                     currentNode: { type: string, nullable: true }
 *                     groups: { type: array, items: { type: object } }
 *                     auto: { type: object }
 *                     anyRunning: { type: boolean }
 */

/**
 * @swagger
 * /api/tools/clash/test:
 *   post:
 *     summary: 代理节点测速（只读，不切换）
 *     responses:
 *       '200':
 *         description: 测速结果（nodes 按得分升序）
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
 *                     group: { type: string }
 *                     currentNode: { type: string, nullable: true }
 *                     currentUsable: { type: boolean, nullable: true }
 *                     nodes:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           urls: { type: array, items: { type: object } }
 *                           score: { type: number }
 *                           usable: { type: boolean }
 */

/**
 * @swagger
 * /api/tools/clash/optimize:
 *   post:
 *     summary: 测速选优并切换节点（手动入口；任务在途由前端确认提示）
 *     responses:
 *       '200':
 *         description: 切换结果
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
 *                     chosen: { type: string, nullable: true }
 *                     switched: { type: boolean }
 *                     nodes: { type: array, items: { type: object } }
 *                     switchNote: { type: string }
 */

/**
 * @swagger
 * /api/tools/clash/group:
 *   post:
 *     summary: 设置目标分组（写回 config.json 的 clash.group）
 *     responses:
 *       '200':
 *         description: 分组已更新
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
 *                     group: { type: string }
 */

/** clash 工具的路由依赖面（结构化类型，测试传普通对象替身） */
export interface ClashRouteDeps {
  service: {
    status(): Promise<{
      detected: boolean
      kernel: string | null
      mixedPort: number | null
      apiBase: string
      delaySupported: boolean
      group: string
      currentNode: string | null
      groups: Array<{ name: string; now?: string }>
    }>
    test(): Promise<ClashTestResult>
    optimize(prev?: ClashTestResult): Promise<OptimizeResult>
    setGroup(group: string): void
  }
  auto: { status(): AutoOptimizerStatus }
  saveGroup(group: string): Promise<void>
  anyRunning(): boolean
}

export function toolsRouter(deps: {
  xlsxPath: string
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void> }
  clash: ClashRouteDeps
  /** 文件随机分配服务（app.ts 单例注入：面板手动分配与计划自动分配共用 busy 锁） */
  fileAssignService: FileAssignService
}): Router {
  const router = Router()

  router.get('/tools', (req, res) => {
    ok(res, { tools: TOOLS })
  })

  router.post('/tools/file-assign/preview', asyncHandler(async (req, res) => {
    const body = req.body as { sourceDir?: unknown; column?: unknown; template?: unknown }
    if (typeof body?.sourceDir !== 'string' || typeof body?.column !== 'string' || typeof body?.template !== 'object' || body.template === null) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（sourceDir/column/template）')
      return
    }
    try {
      const data = await preparePreview({
        sourceDir: body.sourceDir,
        column: body.column,
        template: body.template as FileAssignTemplate,
        xlsxPath: deps.xlsxPath,
      })
      ok(res, data)
    } catch (e) {
      if (e instanceof ToolError) {
        fail(res, e.status, e.code, e.message)
        return
      }
      throw e
    }
  }))

  router.post('/tools/file-assign/apply', asyncHandler(async (req, res) => {
    const body = req.body as { sourceDir?: unknown; column?: unknown; plan?: unknown }
    if (typeof body?.sourceDir !== 'string' || typeof body?.column !== 'string' || !Array.isArray(body?.plan)) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（sourceDir/column/plan）')
      return
    }
    try {
      const result = await deps.fileAssignService.apply({
        sourceDir: body.sourceDir,
        column: body.column,
        plan: body.plan as AssignRow[],
        xlsxPath: deps.xlsxPath,
      })
      await deps.datasource.reload()
      ok(res, { ...result, reloadedRows: deps.datasource.summary().rows })
    } catch (e) {
      if (e instanceof ToolError) {
        fail(res, e.status, e.code, e.message)
        return
      }
      throw e
    }
  }))

  /** 统一执行 clash 工具操作：ToolError 转统一响应，其余异常交给全局错误处理器 */
  const clashGuard = (res: Response, e: unknown) => {
    if (e instanceof ToolError) {
      fail(res, e.status, e.code, e.message)
      return
    }
    throw e
  }

  router.get('/tools/clash/status', asyncHandler(async (req, res) => {
    try {
      const s = await deps.clash.service.status()
      ok(res, { ...s, auto: deps.clash.auto.status(), anyRunning: deps.clash.anyRunning() })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/test', asyncHandler(async (req, res) => {
    try {
      ok(res, await deps.clash.service.test())
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/optimize', asyncHandler(async (req, res) => {
    try {
      ok(res, await deps.clash.service.optimize())
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/group', asyncHandler(async (req, res) => {
    const body = req.body as { group?: unknown }
    if (typeof body?.group !== 'string' || body.group.trim() === '') {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（group 不能为空）')
      return
    }
    try {
      await deps.clash.saveGroup(body.group)
      deps.clash.service.setGroup(body.group)
      ok(res, { group: body.group })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  return router
}

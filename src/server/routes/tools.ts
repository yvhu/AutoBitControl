/**
 * 工具路由（server 层）：工具清单 + 文件随机分配的预览/执行
 * 依赖方向：server → tools（注册表/planner/applier）；ToolError 在此映射为统一响应
 */
import { Router } from 'express'
import { ok, fail, asyncHandler } from '../http/response'
import { ERROR_CODES } from '../http/errors'
import { TOOLS } from '../../tools'
import { preparePreview } from '../../tools/file-assign/planner'
import { FileAssignService } from '../../tools/file-assign/applier'
import { ToolError } from '../../tools/errors'
import type { AssignRow, FileAssignTemplate } from '../../tools/file-assign/types'

/** 进程内单实例：FileAssignService 的执行锁跨请求生效（面板并发点击靠它拦截） */
const service = new FileAssignService()

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

export function toolsRouter(deps: {
  xlsxPath: string
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void> }
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
      const result = await service.apply({
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

  return router
}

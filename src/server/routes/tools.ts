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
import { FileAssignService } from '../../tools/file-assign/applier'
import { ToolError } from '../../tools/errors'
import type { AssignRow, FileAssignTemplate } from '../../tools/file-assign/types'
import type { ClashTestResult, ClashSubscription, OptimizeResult, AutoOptimizerStatus, ClashCapability } from '../../tools/clash/types'

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
 *                     capability: { type: object }
 *                     group: { type: string }
 *                     currentNode: { type: string, nullable: true }
 *                     groups: { type: array, items: { type: object } }
 *                     subscriptions: { type: array, items: { type: object } }
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
 * /api/tools/clash/subscriptions:
 *   get:
 *     summary: 订阅列表（proxy-provider 模式；非该模式为空数组）
 *     responses:
 *       '200':
 *         description: 订阅列表
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
 *                     subscriptions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           vehicleType: { type: string }
 *                           updatedAt: { type: string }
 *                           proxiesCount: { type: integer }
 */

/**
 * @swagger
 * /api/tools/clash/subscriptions/{name}/update:
 *   post:
 *     summary: 更新订阅（重拉节点列表）
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: 更新完成
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
 *                     name: { type: string }
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

/**
 * @swagger
 * /api/tools/clash/profiles:
 *   get:
 *     summary: 订阅配置文件列表（clash.configPath 目录下 *.yaml）
 *     responses:
 *       '200':
 *         description: 文件列表
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
 *                     files: { type: array, items: { type: string } }
 */

/**
 * @swagger
 * /api/tools/clash/profiles/switch:
 *   post:
 *     summary: 切换订阅文件（PUT /configs 以指定配置重载）
 *     responses:
 *       '200':
 *         description: 切换完成
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
 *                     file: { type: string }
 */

/** clash 工具的路由依赖面（结构化类型，测试传普通对象替身） */
export interface ClashRouteDeps {
  service: {
    status(): Promise<{
      detected: boolean
      kernel: string | null
      mixedPort: number | null
      apiBase: string
      capability: Partial<ClashCapability>
      group: string
      currentNode: string | null
      groups: Array<{ name: string; now?: string }>
      subscriptions: ClashSubscription[]
    }>
    test(): Promise<ClashTestResult>
    optimize(prev?: ClashTestResult): Promise<OptimizeResult>
    subscriptions(): Promise<ClashSubscription[]>
    updateSubscription(name: string): Promise<void>
    setGroup(group: string): void
    profileFiles(): string[]
    switchProfile(file: string): Promise<void>
  }
  auto: { status(): AutoOptimizerStatus }
  saveGroup(group: string): Promise<void>
  anyRunning(): boolean
}

export function toolsRouter(deps: {
  xlsxPath: string
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void> }
  clash: ClashRouteDeps
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

  router.get('/tools/clash/subscriptions', asyncHandler(async (req, res) => {
    try {
      ok(res, { subscriptions: await deps.clash.service.subscriptions() })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/subscriptions/:name/update', asyncHandler(async (req, res) => {
    try {
      await deps.clash.service.updateSubscription(String(req.params.name ?? ''))
      ok(res, { name: req.params.name })
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

  router.get('/tools/clash/profiles', (req, res) => {
    ok(res, { files: deps.clash.service.profileFiles() })
  })

  router.post('/tools/clash/profiles/switch', asyncHandler(async (req, res) => {
    const body = req.body as { file?: unknown }
    if (typeof body?.file !== 'string' || body.file === '') {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（file 不能为空）')
      return
    }
    try {
      await deps.clash.service.switchProfile(body.file)
      ok(res, { file: body.file })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  return router
}

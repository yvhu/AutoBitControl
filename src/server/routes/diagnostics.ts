/**
 * 诊断路由（server 层）：按 run id 取失败诊断包 JSON
 * 依赖方向：server → infrastructure（RunRow 类型）；getRunById 由 app 注入
 * 设计思路：只读文件、失败安全——run 不存在/无 diagPath/文件不可读统一 404（业务码 40407）
 */
import { Router } from 'express'
import { readFileSync } from 'node:fs'
import { ok, fail, asyncHandler } from '../http/response'
import { ERROR_CODES } from '../http/errors'
import type { RunRow } from '../../infrastructure/db'

/**
 * @swagger
 * /api/diagnostics/{runId}:
 *   get:
 *     summary: 失败诊断包（按 run id）
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       '200':
 *         description: 诊断包 JSON（DiagBundle）
 *       '404':
 *         description: run 不存在/无诊断/文件不可读（业务码 40407）
 */
export function diagnosticsRouter(deps: { getRunById: (id: number) => Promise<RunRow | null> }): Router {
  const router = Router()
  router.get('/diagnostics/:runId', asyncHandler(async (req, res) => {
    const id = Number(req.params.runId)
    if (!Number.isInteger(id) || id <= 0) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, 'runId 必须为正整数')
      return
    }
    const run = await deps.getRunById(id)
    if (!run || !run.diagPath) {
      fail(res, 404, ERROR_CODES.RUN_DIAG_NOT_FOUND, '诊断不存在')
      return
    }
    let data: unknown
    try {
      data = JSON.parse(readFileSync(run.diagPath, 'utf8'))
    } catch {
      fail(res, 404, ERROR_CODES.RUN_DIAG_NOT_FOUND, '诊断文件不存在')
      return
    }
    ok(res, data)
  }))
  return router
}

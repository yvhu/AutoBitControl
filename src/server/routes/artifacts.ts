/**
 * 运行产物路由（server 层）：按 run id 列出该次运行的截图文件
 * 依赖方向：server → infrastructure（config / RunRow 类型）；getRunById 由 app 注入
 * 设计思路：截图目录固定为 <screenshotDir>/<date>/<bitbrowserId>/<taskKey>/，
 *           每次运行最多 1–3 张，直接扫描目录即可，不新增数据库表；
 *           只回传目录内的 .png，目录越界或不存在一律返回空列表（不报错）
 */
import { Router } from 'express'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ok, fail, asyncHandler } from '../http/response'
import { ERROR_CODES } from '../http/errors'
import type { RunRow } from '../../infrastructure/db'
import type { AppConfig } from '../../infrastructure/config'

/** 单张运行截图（path 为截图根目录内的绝对路径，可直接交给 /api/screenshots?path=） */
export interface RunArtifact {
  /** 文件名（含 .png） */
  name: string
  /** 绝对路径 */
  path: string
  /** 字节大小 */
  size: number
  /** 修改时间（epoch 毫秒，用于按截图顺序排序） */
  mtimeMs: number
}

/**
 * @swagger
 * /api/runs/{runId}/artifacts:
 *   get:
 *     summary: 列出某次运行的全部截图（1–3 张，按截图时间排序）
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       '200':
 *         description: 截图文件列表（files 为空表示该 run 没有截图或目录已清理）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId: { type: integer }
 *                 files:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       path: { type: string }
 *                       size: { type: integer }
 *                       mtimeMs: { type: integer }
 *       '400':
 *         description: runId 非法（业务码 40000）
 *       '404':
 *         description: run 不存在（业务码 40409）
 */
export function artifactsRouter(deps: { cfg: AppConfig; getRunById: (id: number) => Promise<RunRow | null> }): Router {
  const router = Router()
  router.get('/runs/:runId/artifacts', asyncHandler(async (req, res) => {
    const id = Number(req.params.runId)
    if (!Number.isInteger(id) || id <= 0) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, 'runId 必须为正整数')
      return
    }
    const run = await deps.getRunById(id)
    if (!run) {
      fail(res, 404, ERROR_CODES.RUN_NOT_FOUND, '运行记录不存在')
      return
    }
    const files = listRunArtifacts(deps.cfg.storage.screenshotDir, run)
    ok(res, { runId: id, files })
  }))
  return router
}

/** 扫描某次运行的截图目录；越界/不存在/读取失败均返回空列表（读列表失败不应阻断面板） */
export function listRunArtifacts(screenshotDir: string, run: Pick<RunRow, 'date' | 'bitbrowserId' | 'taskKey'>): RunArtifact[] {
  const root = resolve(screenshotDir)
  const dir = resolve(join(root, run.date, run.bitbrowserId, run.taskKey))
  const rootPrefix = root.toLowerCase() + sep
  // 目录必须严格位于截图根目录内（date/bitbrowserId/taskKey 均来自库，仍做防御）
  if (!dir.toLowerCase().startsWith(rootPrefix) || !existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: RunArtifact[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.png')) continue
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      files.push({ name, path, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // 单个文件读取失败（正在写入/被删除）忽略，不影响其它截图
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return files
}

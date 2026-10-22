/**
 * 窗口池路由（server 层）：池状态只读查询
 * 依赖方向：只依赖装配层注入的池状态快照函数；被 app 装配
 * 设计思路：窗口池未启用时返回 enabled=false + status=null，面板据此展示「窗口池未启用」
 */
import { Router } from 'express'
import type { PoolStatus } from '../../engine/window-pool'
import { ok } from '../http/response'

/**
 * @swagger
 * /api/pool/status:
 *   get:
 *     summary: 读取窗口池状态（未启用时 enabled=false、status=null）
 *     responses:
 *       '200':
 *         description: 池状态快照
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
 *                     enabled:
 *                       type: boolean
 *                       description: 是否启用窗口池调度（execution.windowPool.enabled）
 *                     status:
 *                       type: object
 *                       nullable: true
 *                       description: 窗口池启用时的状态快照；未启用为 null
 *                       properties:
 *                         memoryState: { type: string, enum: [normal, warning, critical] }
 *                         globalHealthState: { type: string, enum: [normal, paused, probing] }
 *                         freeMb: { type: integer, description: 当前系统空闲内存（MB） }
 *                         perWindowMb: { type: integer, description: 单窗口内存预估（MB） }
 *                         effectivePool: { type: integer, description: 有效池上限（maxOpenWindows 与内存共同约束） }
 *                         maxOpenWindows: { type: integer, description: 配置的最大打开窗口数 }
 *                         actualOpen: { type: integer, description: 实际打开的窗口数（含手动/task:run） }
 *                         poolSize: { type: integer, description: 当前池内窗口数 }
 *                         busy: { type: integer, description: 正在执行任务的池窗口数 }
 *                         idle: { type: integer, description: 空闲池窗口数 }
 *                         opening: { type: integer, description: 开窗中的窗口数 }
 *                         queueWindows: { type: integer, description: 有排队任务但尚未打开的窗口数 }
 *                         pendingTasks: { type: integer, description: 到期/排队中的任务数 }
 *                         updatedAt:
 *                           type: string
 *                           nullable: true
 *                           description: 最近一次 tick 更新时间
 */

export function poolRouter(deps: { poolStatus?: () => PoolStatus }): Router {
  const router = Router()
  // 池状态只读：启用时透出最近一次 tick 的快照，旧调度下明确返回未启用
  router.get('/pool/status', (req, res) => {
    if (!deps.poolStatus) {
      ok(res, { enabled: false, status: null })
      return
    }
    ok(res, { enabled: true, status: deps.poolStatus() })
  })
  return router
}

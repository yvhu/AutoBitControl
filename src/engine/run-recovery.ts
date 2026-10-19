/**
 * 启动恢复（engine 层）：结算跨日残留、被更新 slot 取代的旧行，再把当天崩溃残留 running 重置为 pending
 * 依赖方向：依赖 infrastructure/db 与 logger；被 app 装配
 */
import { todayStr, type AppDb } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'

export interface RecoverRunsResult {
  superseded: number
  oldQueued: number
  oldRunning: number
  requeued: number
}

export async function recoverRuns(deps: { db: AppDb; logger: Logger; now?: Date }): Promise<RecoverRunsResult> {
  const now = deps.now ?? new Date()
  const date = todayStr(now)
  // 先结算旧日期：排队行直接 skipped，崩溃残留 running 落 failed（新进程无法续跑，不能永久占住窗口）
  const oldQueued = await deps.db.settleOldQueuedRuns(date)
  const oldRunning = await deps.db.settleOldRunningRuns(date)
  const superseded = await deps.db.settleSupersededRuns(date)
  const requeued = await deps.db.requeueStaleRunning(date, now.getTime())
  if (oldQueued > 0) deps.logger.warn({ count: oldQueued }, '已结算跨日未执行的排队行')
  if (oldRunning > 0) deps.logger.warn({ count: oldRunning }, '已结算跨日崩溃残留 running 行')
  if (superseded > 0) deps.logger.warn({ count: superseded }, '已结算被更新 slot 取代的旧运行行')
  if (requeued > 0) deps.logger.warn({ count: requeued }, '已把崩溃残留 running 行重新排队')
  return { superseded, oldQueued, oldRunning, requeued }
}

/**
 * 任务停止器（engine 层）：停止某 (窗口, 任务) 当天的在途运行
 * 依赖方向：依赖 infrastructure/db 类型与 CancelRegistry，被 app 装配、server 路由调用
 * 设计思路：置取消标记（runner 消费）→ 结算非终态行为 skipped（手动停止）→
 *          关窗中止运行中会话 → 清开窗登记
 */
import { todayStr, localWallNow, type AppDb } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'
import type { CancelRegistry } from './cancel-registry'

export interface TaskStopperDeps {
  db: AppDb
  registry: CancelRegistry
  logger: Logger
  /** 关闭比特浏览器窗口（中止正在跑的会话；失败忽略） */
  closeBrowser(bitbrowserId: string): Promise<void>
  /** 取开窗登记（停止后清理用） */
  getOpenWindow(bitbrowserId: string): Promise<{ http: string } | null>
  /** 清开窗登记 */
  clearOpenWindow(bitbrowserId: string): Promise<void>
}

export interface TaskStopper {
  /** 停止某窗口某任务当天的在途运行；返回是否确实处理了在途（false = 无在途/窗口不存在） */
  stop(profileId: number, taskKey: string): Promise<boolean>
}

const TERMINAL = ['success', 'failed', 'captcha_failed', 'skipped']

export function createTaskStopper(deps: TaskStopperDeps): TaskStopper {
  const { db, registry, logger } = deps
  return {
    async stop(profileId: number, taskKey: string): Promise<boolean> {
      const date = todayStr()
      const profile = (await db.listProfiles(false)).find((p) => p.id === profileId)
      if (!profile) return false
      const existing = await db.getLatestRun(profileId, taskKey, date)
      const terminal = existing ? TERMINAL.includes(existing.status) : true
      if (!existing || terminal) return false
      registry.request(profileId, taskKey)
      await db.upsertRun(profileId, taskKey, date, existing.slot, 'skipped', { error: '手动停止', finishedAt: localWallNow() })
      await deps.closeBrowser(profile.bitbrowserId).catch((e) => logger.warn({ profile: profile.name, err: (e as Error).message }, '停止时关窗失败（窗口可能仍开着）'))
      const row = await deps.getOpenWindow(profile.bitbrowserId).catch(() => null)
      if (row) await deps.clearOpenWindow(profile.bitbrowserId).catch(() => {})
      logger.info({ profile: profile.name, task: taskKey }, '已请求停止任务')
      return true
    },
  }
}

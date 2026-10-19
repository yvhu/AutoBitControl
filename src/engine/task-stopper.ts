/**
 * 任务停止器（engine 层）：停止某 (窗口, 任务) 或整批的运行
 * 依赖方向：依赖 infrastructure/db 类型与 CancelRegistry，被 app 装配、server 路由调用
 * 设计思路：置取消标记（runner 消费）→ 结算非终态行为 skipped（手动停止）→
 *          关窗中止运行中会话 → 清开窗登记；
 *          批次停止先撤队列（尚未落行的错峰/排队窗口）再按行结算，避免窗口随后仍开窗执行
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
  /**
   * 取消某批次仍在队列中的任务（错峰/额度/全局排队/followUp），返回被取消的（窗口, 任务）：
   * 这些窗口尚未落运行行，按行停止看不到；running=true 表示会话已进入运行阶段
   * （需要置取消标记防止竞态下仍执行），纯排队项只撤队列、不置标记（避免标记残留误伤下次触发）
   */
  cancelQueued?(batchId: number): Array<{ profileId: number; taskKey: string; running: boolean }>
}

export interface TaskStopper {
  /** 停止某窗口某任务当天的在途运行；返回是否确实处理了在途（false = 无在途/窗口不存在） */
  stop(profileId: number, taskKey: string): Promise<boolean>
  /** 停止整批：在途行 + 仍在排队、尚未落行的窗口都停止；返回处理的数量 */
  stopBatch(batchId: number): Promise<number>
}

const TERMINAL = ['success', 'failed', 'captcha_failed', 'skipped']

export function createTaskStopper(deps: TaskStopperDeps): TaskStopper {
  const { db, registry, logger } = deps

  async function stop(profileId: number, taskKey: string): Promise<boolean> {
    const date = todayStr()
    const profile = (await db.listProfiles(false)).find((p) => p.id === profileId)
    if (!profile) return false
    const existing = await db.getLatestRun(profileId, taskKey, date)
    const terminal = existing ? TERMINAL.includes(existing.status) : true
    if (!existing || terminal) return false
    registry.request(profileId, taskKey)
    // 停止会关窗，同会话其余任务会收到 Target closed：仅在确有活动会话时置会话级标记，
    // runner 按手动停止结算而非环境失败；纯 retry_wait/无窗口的停止只置任务级标记，
    // 避免会话标记残留到下一次合法会话导致整窗跳过
    const row = await deps.getOpenWindow(profile.bitbrowserId).catch(() => null)
    const hasActiveSession = existing.status === 'running' || row !== null
    if (hasActiveSession) registry.requestSession(profileId)
    await db.upsertRun(profileId, taskKey, date, existing.slot, 'skipped', { error: '手动停止', finishedAt: localWallNow(), failureKind: 'stopped' })
    await deps.closeBrowser(profile.bitbrowserId).catch((e) => logger.warn({ profile: profile.name, err: (e as Error).message }, '停止时关窗失败（窗口可能仍开着）'))
    if (row) await deps.clearOpenWindow(profile.bitbrowserId).catch(() => {})
    logger.info({ profile: profile.name, task: taskKey }, '已请求停止任务')
    return true
  }

  return {
    stop,

    async stopBatch(batchId: number): Promise<number> {
      const date = todayStr()
      const candidates = new Map<string, { profileId: number; taskKey: string; running: boolean }>()
      const add = (profileId: number, taskKey: string, running: boolean): void => {
        const key = `${profileId}:${taskKey}`
        const prev = candidates.get(key)
        if (prev) {
          if (running) prev.running = true
          return
        }
        candidates.set(key, { profileId, taskKey, running })
      }
      // 先撤队列：错峰/额度/全局排队中的窗口还没落运行行，单靠 listRunsForBatch 看不到
      for (const c of deps.cancelQueued?.(batchId) ?? []) add(c.profileId, c.taskKey, c.running)
      // 已在跑的批次行（含 pending 预写、retry_wait）：是否有活动会话以内存 running 标记为准，
      // 行候选不直接置 running，避免「读到非终态后已自然完成」时残留取消标记
      for (const r of await db.listRunsForBatch(batchId)) {
        if (!TERMINAL.includes(r.status)) add(r.profileId, r.taskKey, false)
      }
      let stopped = 0
      for (const c of candidates.values()) {
        const existing = await db.getLatestRun(c.profileId, c.taskKey, date)
        if (existing && !TERMINAL.includes(existing.status)) {
          if (await stop(c.profileId, c.taskKey)) stopped++
          continue
        }
        // 终态或无行：该批次此窗口还没真正开跑（或会话刚启动尚未落行）
        // 仅 running 竞态需要取消标记；纯排队项已撤出队列，置标记会残留并误伤下一次合法触发
        if (c.running) registry.request(c.profileId, c.taskKey)
        const slot = await db.nextRunSlot(c.profileId, c.taskKey, date)
        await db.upsertRun(c.profileId, c.taskKey, date, slot, 'skipped', { batchId, error: '手动停止', finishedAt: localWallNow(), failureKind: 'stopped' })
        stopped++
      }
      if (stopped > 0) logger.info({ batchId, stopped }, '已请求停止批次')
      return stopped
    },
  }
}

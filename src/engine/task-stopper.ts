/**
 * 任务停止器（engine 层）：停止某 (窗口, 任务) 或整批的运行
 * 依赖方向：依赖 infrastructure/db 类型与 CancelRegistry，被 app 装配、server 路由调用
 * 设计思路：排队行（pending/retry_wait）条件结算 DB（与 dispatcher 认领原子竞争），不置标记、不关窗；
 *          running 行置取消标记（runner 消费）→ 结算 skipped（手动停止）→
 *          关窗中止运行中会话 → 清开窗登记；
 *          批次停止先原子撤队列，再逐行处理 running，queued 行不重复关窗
 */
import { todayStr, localWallNow, type AppDb } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'
import type { CancelRegistry } from './cancel-registry'
import { waitForWindowClosed } from './window-registry'

/** 停止任务关窗后等待窗口关闭的总时长（毫秒） */
const STOP_CLOSE_CONFIRM_TIMEOUT_MS = 10_000

export interface TaskStopperDeps {
  db: AppDb
  registry: CancelRegistry
  logger: Logger
  /** 关闭比特浏览器窗口（中止正在跑的会话；失败忽略） */
  closeBrowser(bitbrowserId: string): Promise<void>
  /**
   * 实测窗口是否仍存活（可选：提供后关窗需确认消失才清登记；未提供保持旧的立即清登记行为）。
   * 实现必须在探测失败时 reject，禁止把探测异常吞成 false，否则会误清仍在关闭中的登记。
   */
  isOpen?(bitbrowserId: string): Promise<boolean>
  /** 取开窗登记（停止后清理用） */
  getOpenWindow(bitbrowserId: string): Promise<{ http: string; state?: string } | null>
  /** 清开窗登记 */
  clearOpenWindow(bitbrowserId: string): Promise<void>
  /**
   * 取消某批次仍排队的运行（pending/retry_wait 结算为 skipped），返回结算行数；
   * 已被 dispatcher 认领/运行中的行由 stopBatch 按 running 行处理后关窗
   */
  cancelQueued?(batchId: number): Promise<number>
}

export interface TaskStopper {
  /** 停止某窗口某任务指定日期的在途运行（缺省今天，跨午夜会话需传行内日期）；返回是否确实处理了在途（false = 无在途/窗口不存在） */
  stop(profileId: number, taskKey: string, date?: string): Promise<boolean>
  /** 停止整批：在途行 + 仍在排队的 pending/retry_wait 行都停止；返回处理的数量 */
  stopBatch(batchId: number): Promise<number>
}

const TERMINAL = ['success', 'failed', 'captcha_failed', 'skipped']

export function createTaskStopper(deps: TaskStopperDeps): TaskStopper {
  const { db, registry, logger } = deps

  async function stop(profileId: number, taskKey: string, date = todayStr()): Promise<boolean> {
    const profile = (await db.listProfiles(false)).find((p) => p.id === profileId)
    if (!profile) return false
    const existing = await db.getLatestRun(profileId, taskKey, date)
    if (!existing || TERMINAL.includes(existing.status)) return false

    let current = existing

    // 还没开始跑（DB 队列中的 pending/retry_wait）：条件更新结算行，
    // 不置取消标记、不关窗——队列由 dispatcher 按 DB 状态驱动，不会再有执行机会。
    // 条件更新与 dispatcher 的认领竞争：若行刚被认领为 running，则不能覆盖，需改走运行分支。
    if (existing.status === 'pending' || existing.status === 'retry_wait') {
      const settled = await db.stopQueuedRun(profileId, taskKey, date, existing.slot)
      if (settled) {
        logger.info({ profile: profile.name, task: taskKey, status: existing.status }, '已停止排队任务')
        return true
      }
      const claimed = await db.getLatestRun(profileId, taskKey, date)
      if (!claimed || TERMINAL.includes(claimed.status)) return false
      current = claimed
    }

    // running：先置任务级 + 会话级标记（runner 按手动停止结算，不记环境失败），
    // 再 CAS 结算本行；若行已变成终态（任务恰好成功/失败），撤销标记并放弃，绝不覆盖终态
    registry.request(profileId, taskKey)
    registry.requestSession(profileId)
    const settled = await db.stopRunningRun(profileId, taskKey, date, current.slot)
    if (!settled) {
      registry.clear(profileId, taskKey)
      registry.clearSession(profileId)
      return false
    }
    const row = await deps.getOpenWindow(profile.bitbrowserId).catch(() => null)
    if (row && deps.isOpen) await deps.db.setWindowState(profile.bitbrowserId, 'closing').catch(() => {})
    await deps.closeBrowser(profile.bitbrowserId).catch((e) => logger.warn({ profile: profile.name, err: (e as Error).message }, '停止时关窗失败（窗口可能仍开着）'))
    if (row) {
      if (!deps.isOpen) {
        // 旧行为：未注入存活探测时保持立即清登记（兼容既有调用方/测试夹具）
        await deps.clearOpenWindow(profile.bitbrowserId).catch(() => {})
      } else {
        const closed = await waitForWindowClosed(
          () => deps.isOpen!(profile.bitbrowserId),
          { timeoutMs: STOP_CLOSE_CONFIRM_TIMEOUT_MS },
        )
        if (closed) await deps.clearOpenWindow(profile.bitbrowserId).catch(() => {})
        else logger.warn({ profile: profile.name }, '停止任务后窗口未确认关闭，保留 closing 登记待 Phase 2 对账')
      }
    }
    logger.info({ profile: profile.name, task: taskKey }, '已请求停止任务')
    return true
  }

  return {
    stop,

    async stopBatch(batchId: number): Promise<number> {
      // 先原子撤销仍排队的行（dispatcher 认领前）并等待结算数量；
      // 已被认领/运行中的行再按 running 状态停止（并发竞态由 claimQueuedRuns 收口）
      const queued = await (deps.cancelQueued?.(batchId) ?? Promise.resolve(0))
      let running = 0
      for (const r of await db.listRunsForBatch(batchId)) {
        if (r.status !== 'running') continue
        if (await stop(r.profileId, r.taskKey, r.date)) running++
      }
      const stopped = queued + running
      if (stopped > 0) logger.info({ batchId, stopped }, '已请求停止批次')
      return stopped
    },
  }
}

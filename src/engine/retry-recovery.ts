/**
 * 重试恢复（engine 层）：进程重启后 retry_wait 行的重试定时器丢失（内存态），
 * 启动时扫描当日 retry_wait 行：退避已到期的立即重新入队，未到期的重新挂定时器。
 * 关键修正：若该 (窗口, 任务, 日期) 已存在更新的 slot（重试已被后续轮次取代），
 * 不入队、把陈旧行结算为 failed 终态——否则陈旧行每次重启都会被扫描到并重复执行
 * 依赖方向：依赖 infrastructure 与 engine 类型，被 app 顶层装配
 */
import { todayStr, localWallNow, type AppDb } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'
import type { TaskMeta } from './task'
import type { CoalescingEnqueuer } from './queue'

export interface RetryRecoveryDeps {
  db: AppDb
  tasks: Map<string, { meta: TaskMeta }>
  enqueuer: CoalescingEnqueuer
  logger: Logger
  /** 全局默认重试退避（秒），任务级 backoffSec 缺省时回落 */
  retryBackoffSec: number
}

/** 扫描当日 retry_wait 行并恢复重试；返回实际重新入队的行数（被取代的陈旧行不计） */
export async function recoverRetryTasks(deps: RetryRecoveryDeps): Promise<number> {
  const { db, tasks, enqueuer, logger, retryBackoffSec } = deps
  const date = todayStr()
  const rows = (await db.listRunsForDate(date)).filter(r => r.status === 'retry_wait')
  let recovered = 0
  for (const r of rows) {
    const profile = (await db.listProfiles(false)).find(p => p.id === r.profileId)
    if (!profile) continue
    // 陈旧行判定：该 (窗口,任务,日期) 已出现更新的 slot，重试已被后续轮次取代——
    // 重新入队会造成重复执行，直接结算该行为 failed 终态
    const latest = await db.getLatestRun(r.profileId, r.taskKey, date)
    if (latest && latest.slot > r.slot) {
      await db.upsertRun(r.profileId, r.taskKey, date, r.slot, 'failed', { error: '重试已被后续轮次取代', finishedAt: localWallNow() })
      logger.warn({ profile: profile.name, task: r.taskKey, slot: r.slot }, '重试行已被后续轮次取代，结算为失败')
      continue
    }
    const taskMeta = tasks.get(r.taskKey)?.meta
    const backoffMs = (taskMeta?.retry?.backoffSec ?? retryBackoffSec) * 1000
    const finished = r.finishedAt ? new Date(r.finishedAt.replace(' ', 'T')).getTime() : NaN
    const delay = Number.isNaN(finished) ? 0 : Math.max(0, finished + backoffMs - Date.now())
    recovered++
    setTimeout(() => {
      void (async () => {
        try {
          const p = (await db.listProfiles(false)).find(x => x.id === profile.id)
          if (p) enqueuer.enqueue(p, r.taskKey)
        } catch (e) {
          logger.warn({ task: r.taskKey, err: (e as Error).message }, '重试恢复入队失败，放弃本次重试')
        }
      })()
    }, delay)
  }
  if (recovered > 0) logger.info({ count: recovered }, '已恢复待重试任务')
  return recovered
}

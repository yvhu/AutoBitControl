/**
 * 运行队列契约（engine 层）：runs 表即队列，窗口池调度器实现此接口
 * 依赖方向：只依赖 infrastructure/db 的行类型；被 app 装配、server 路由使用
 * 设计思路：入队只写 DB，调度全部由 WindowPoolScheduler 按池状态与到期行推进
 */
import type { ProfileRow } from '../infrastructure/db'

/** 窗口会话要跑的一个任务 */
export interface SessionTask {
  taskKey: string
  /** 已认领行所属日期（跨午夜按行日期落库，不再用 todayStr 重新推导） */
  date?: string
  batchId?: number
}

/** 入队器契约：面板触发与调度器只依赖此接口，便于测试替换实现 */
export interface RunEnqueuer {
  enqueue(
    profile: ProfileRow,
    taskKey: string,
    opts?: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean },
  ): Promise<boolean>
  cancelBatch(batchId: number): Promise<number>
  start(): void
  stop(): void
}

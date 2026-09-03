/**
 * 窗口任务队列（engine 层）：p-queue 并发控制 + 同窗口任务合并
 * 依赖方向：依赖 p-queue 与基础设施类型，被 server 路由依赖
 */
import PQueue from 'p-queue'
import type { ProfileRow } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'

/** p-queue 薄封装：统一并发入口，size 供外部观察负载 */
export class TaskQueue {
  private q: PQueue

  constructor(concurrency: number) {
    this.q = new PQueue({ concurrency })
  }

  /** 入队一个异步任务（并发槽位有空则立即执行） */
  add(fn: () => Promise<void>): Promise<void> {
    return this.q.add(fn)
  }

  /** 队列全部空闲时 resolve（测试/停机等待用） */
  onIdle(): Promise<void> {
    return this.q.onIdle()
  }

  /** 当前负载：排队中 + 执行中 */
  get size(): number {
    return this.q.size + this.q.pending
  }
}

/** 一个窗口的合并任务条目 */
interface Entry {
  profile: ProfileRow
  taskKeys: Set<string>
}

/**
 * 同窗口任务合并入队器
 * 目标：同一窗口的多个任务合并进一次开窗会话（开窗/连接/IP 探活只做一遍，关一次窗）
 * 两套机制的由来（关键设计）：
 * - pending：窗口会话尚未开始（还没拿到 p-queue 槽位）时到达的任务在此合并，启动时一次性执行
 * - running/followUp：p-queue v9 的 add() 在有空闲槽位时同步启动任务——此时若把任务放进
 *   pending 会再占一个槽位并发开同一窗口（同窗口两会话会互相打架）；
 *   因此运行中的窗口的新任务进 followUp，等本轮结束后重新入队
 * 结果：同窗口永不并发跑两个会话；不同窗口各自独立
 */
export class CoalescingEnqueuer {
  /** 尚未启动的窗口会话合并区（按窗口 id） */
  private pending = new Map<number, Entry>()
  /** 正在运行的窗口 → 会话内任务集合（in-flight 判定用，会话结束即删） */
  private running = new Map<number, Set<string>>()
  /** 运行中窗口收到的追加任务（本轮结束后重新入队） */
  private followUp = new Map<number, Entry>()

  constructor(
    private queue: TaskQueue,
    private runner: { runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<unknown> },
    private logger: Logger,
  ) {}

  /**
   * 为某窗口入队一个任务（自动合并）
   * @param profile 窗口记录
   * @param taskKey 任务 key
   */
  enqueue(profile: ProfileRow, taskKey: string): void {
    // 窗口正在跑：追加到 followUp，本轮结束后统一重排（不能进 pending，见类注释）
    if (this.running.has(profile.id)) {
      const fu = this.followUp.get(profile.id) ?? { profile, taskKeys: new Set<string>() }
      fu.taskKeys.add(taskKey)
      this.followUp.set(profile.id, fu)
      return
    }
    // 已排队未启动：合并进已有条目（共享一次开窗）
    const entry = this.pending.get(profile.id)
    if (entry) {
      entry.taskKeys.add(taskKey)
      return
    }
    // 首次入队：建条目并投递 p-queue
    const fresh: Entry = { profile, taskKeys: new Set([taskKey]) }
    this.pending.set(profile.id, fresh)
    void this.queue.add(async () => {
      // 让出微任务：等后续 enqueue 合并完成后再删除 pending 条目
      await Promise.resolve()
      this.pending.delete(profile.id)
      this.running.set(profile.id, new Set(fresh.taskKeys))
      try {
        await this.runner.runWindowTasks(fresh.profile, [...fresh.taskKeys])
      } catch (e) {
        // 单窗口会话异常不影响其他窗口，只记日志
        this.logger.error({ err: (e as Error).message }, '窗口任务执行异常')
      }
      this.running.delete(profile.id)
      // 本轮期间收到的追加任务重新入队（下一轮会话）
      const fu = this.followUp.get(profile.id)
      if (fu) {
        this.followUp.delete(profile.id)
        for (const k of fu.taskKeys) this.enqueue(fu.profile, k)
      }
    })
  }

  /**
   * 某任务是否在途：排队中（pending 条目）或正在跑（running 会话）的窗口会话包含该任务；
   * 指定 profileId 时只看该窗口（看板行级判定用）。followUp 是「已合并待重排」不算在途
   */
  hasTaskInFlight(taskKey: string, profileId?: number): boolean {
    const inSet = (keys: Set<string> | undefined) => !!keys?.has(taskKey)
    if (profileId !== undefined) {
      return inSet(this.pending.get(profileId)?.taskKeys) || inSet(this.running.get(profileId))
    }
    for (const e of this.pending.values()) if (e.taskKeys.has(taskKey)) return true
    for (const keys of this.running.values()) if (keys.has(taskKey)) return true
    return false
  }
}

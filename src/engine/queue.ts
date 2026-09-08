/**
 * 窗口任务队列（engine 层）：任务级并发额度 + 全局窗口上限 + 同窗口任务合并
 * 依赖方向：依赖基础设施类型，被 server 路由依赖
 * 设计思路：
 * - 每个任务有独立并发额度（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4）：
 *   active 计数已占窗口数，超额的窗口进 waiting FIFO，会话结束释放额度时滚动续跑
 * - 全局窗口上限（maxConcurrentWindows，缺省 Infinity）：所有任务共享的同时开窗总数封顶，
 *   dispatch 开窗前同步检查，超额会话进 globalWaiting FIFO（条目保留在 pending 合并区，
 *   同窗口后续任务继续合并）；会话结束先释放全局额度滚动续跑，再释放任务额度
 * - 同窗口任务合并保留：pending 合并区 + running/followUp 两套机制（由来见类注释）
 * - 错峰：首次入队随机延迟 staggerMaxSec 内再开窗（批量触发打散起点；0 = 关闭）
 */
import type { ProfileRow } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'

/** 窗口会话要跑的一个任务（batchId 可选：重试恢复等场景不带） */
export interface SessionTask {
  taskKey: string
  batchId?: number
}

/** 一个窗口的合并任务条目 */
interface Entry {
  profile: ProfileRow
  tasks: SessionTask[]
  /** 单窗口手动入口（看板行级执行/重跑）标记：跳过错峰立即投递 */
  immediate?: boolean
}

/** 单任务额度：concurrency 上限、active 已占窗口数、waiting 等待队列（FIFO） */
interface Gate {
  concurrency: number
  active: number
  waiting: Entry[]
}

/**
 * 同窗口任务合并入队器（任务级并发）
 * 两套机制的由来（关键设计）：
 * - pending：窗口会话尚未开始（还没拿到额度或错峰等待中）时到达的任务在此合并，启动时一次性执行
 * - running/followUp：窗口会话运行中到达的任务进 followUp，等本轮结束后重新入队——
 *   直接开会话会与当前会话并发开同一窗口（同窗口两会话互相打架）
 * 结果：同窗口永不并发跑两个会话；不同窗口各自独立
 * - 额度：每个任务 active 计数不超过 concurrency；超额窗口进 waiting，release 时滚动续跑
 * - 错峰：首次入队随机延迟 staggerMaxSec 内再投递开窗（批量触发打散各窗口起点；
 *   task:run 调试脚本独立进程直接跑 runManual，不经本队列；0 = 关闭）
 */
export class CoalescingEnqueuer {
  /** 尚未启动的窗口会话合并区（按窗口 id） */
  private pending = new Map<number, Entry>()
  /** 正在运行的窗口 → 会话内任务集合（in-flight 判定用，会话结束即删） */
  private running = new Map<number, Set<string>>()
  /** 运行中窗口收到的追加任务（本轮结束后重新入队） */
  private followUp = new Map<number, Entry>()
  /** 全局窗口闸门：同时开窗总数上限（clamp 到 ≥1；Infinity = 不限制） */
  private readonly globalMax: number
  /** 全局闸门已占开窗数 */
  private globalActive = 0
  /** 全局额度已满时的窗口会话 FIFO 排队（条目保留在 pending 合并区，续跑时直接 dispatch 不重复错峰） */
  private globalWaiting: Entry[] = []
  /** 任务级并发额度表（懒创建） */
  private gates = new Map<string, Gate>()

  constructor(
    private runner: { runWindowTasks(profile: ProfileRow, tasks: SessionTask[]): Promise<unknown> },
    private logger: Logger,
    /** 任务并发上限取值（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4） */
    private taskConcurrencyOf: (taskKey: string) => number,
    /** 窗口会话启动随机错峰上限（秒，0 = 关闭）：批量触发时各窗口在 [0, staggerMaxSec] 内随机延迟后开窗 */
    private staggerMaxSec = 0,
    /** 全局窗口上限：同时最多开几个窗口会话（机器资源兜底；Infinity = 不限制） */
    maxConcurrentWindows = Number.POSITIVE_INFINITY,
  ) {
    // 非法值（NaN/非数字，如配置误写字符串）不静默失效：回退为不限制，由配置层语义兜底
    this.globalMax = Number.isFinite(maxConcurrentWindows) ? Math.max(1, maxConcurrentWindows) : Number.POSITIVE_INFINITY
  }

  /** 取（或懒创建）任务额度表 */
  private gateFor(taskKey: string): Gate {
    let gate = this.gates.get(taskKey)
    if (!gate) {
      gate = { concurrency: Math.max(1, this.taskConcurrencyOf(taskKey)), active: 0, waiting: [] }
      this.gates.set(taskKey, gate)
    }
    return gate
  }

  /** 条目内是否已含某任务（入队去重 / in-flight 判定共用） */
  private static hasTask(entry: Entry | undefined, taskKey: string): boolean {
    return !!entry?.tasks.some((t) => t.taskKey === taskKey)
  }

  /** 追加任务到条目（去重） */
  private static addTask(entry: Entry, taskKey: string, batchId?: number): void {
    if (entry.tasks.some((t) => t.taskKey === taskKey)) return
    entry.tasks.push(batchId === undefined ? { taskKey } : { taskKey, batchId })
  }

  /**
   * 为某窗口入队一个任务（自动合并 + 任务级额度控制）
   * @param profile 窗口记录
   * @param taskKey 任务 key
   * @param opts.immediate 单窗口手动入口（看板行级执行/重跑）：跳过错峰立即投递
   * @param opts.batchId 运行批次 id（批次看板落库归属；重试恢复等场景不带）
   */
  enqueue(profile: ProfileRow, taskKey: string, opts?: { immediate?: boolean; batchId?: number }): void {
    // 窗口正在跑：追加到 followUp，本轮结束后统一重排（不能进 pending，见类注释）
    if (this.running.has(profile.id)) {
      const fu = this.followUp.get(profile.id) ?? { profile, tasks: [] }
      CoalescingEnqueuer.addTask(fu, taskKey, opts?.batchId)
      if (opts?.immediate) fu.immediate = true
      this.followUp.set(profile.id, fu)
      return
    }
    // 已排队未启动：同窗口同任务去重（并发触发竞态下防止额度重复占用与同窗口双跑）
    if (CoalescingEnqueuer.hasTask(this.pending.get(profile.id), taskKey)) return
    const gate = this.gateFor(taskKey)
    // 额度已满：进等待队列（同窗口同任务去重），额度释放后滚动续跑
    if (gate.active >= gate.concurrency) {
      const dup = gate.waiting.find((e) => e.profile.id === profile.id && e.tasks.some((t) => t.taskKey === taskKey))
      if (dup) {
        // 同窗口同任务已在等待：升级 immediate 标记（手动入口要求不等待错峰）
        if (opts?.immediate) dup.immediate = true
      } else {
        gate.waiting.push({ profile, tasks: [{ taskKey, ...(opts?.batchId === undefined ? {} : { batchId: opts.batchId }) }], immediate: opts?.immediate })
      }
      return
    }
    this.occupy(taskKey, profile, opts?.immediate, opts?.batchId)
  }

  /** 占额度并进入 pending 合并区（已排队未启动的合并进已有条目；否则新建 + 错峰投递，immediate 跳过延迟） */
  private occupy(taskKey: string, profile: ProfileRow, immediate = false, batchId?: number): void {
    const gate = this.gateFor(taskKey)
    const entry = this.pending.get(profile.id)
    if (entry) {
      // 纵深去重：并发触发竞态下同窗口同任务已在 pending 时不重复占额度（不双跑、不泄漏）
      if (entry.tasks.some((t) => t.taskKey === taskKey)) return
      // 已排入错峰等待的条目按原调度时间开窗：immediate 不回溯改写（定时器已排，标志无效）
      CoalescingEnqueuer.addTask(entry, taskKey, batchId)
      gate.active++
      return
    }
    gate.active++
    const fresh: Entry = { profile, tasks: [{ taskKey, ...(batchId === undefined ? {} : { batchId }) }], immediate }
    this.pending.set(profile.id, fresh)
    if (fresh.immediate) {
      this.dispatch(fresh)
      return
    }
    const delayMs = Math.floor(Math.random() * this.staggerMaxSec * 1000)
    if (delayMs <= 0) {
      this.dispatch(fresh)
    } else {
      setTimeout(() => this.dispatch(fresh), delayMs)
    }
  }

  /** 执行合并完成的窗口会话（delayMs=0 时与 enqueue 同步）；全局额度满时进全局 FIFO 排队 */
  private dispatch(entry: Entry): void {
    // 全局窗口闸门（同步判定，保证会话结束释放额度时的滚动续跑 FIFO 公平）：
    // 额度已满则进全局等待队列（条目保持 pending 合并区，同窗口后续任务继续合并进同一会话）
    if (this.globalActive >= this.globalMax) {
      this.globalWaiting.push(entry)
      return
    }
    this.globalActive++
    void (async () => {
      // 让出微任务：等后续 enqueue 合并完成后再删除 pending 条目
      await Promise.resolve()
      this.pending.delete(entry.profile.id)
      this.running.set(entry.profile.id, new Set(entry.tasks.map((t) => t.taskKey)))
      try {
        await this.runner.runWindowTasks(entry.profile, entry.tasks)
      } catch (e) {
        // 单窗口会话异常不影响其他窗口，只记日志
        this.logger.error({ err: (e as Error).message }, '窗口任务执行异常')
      }
      this.running.delete(entry.profile.id)
      // 本轮期间收到的追加任务重新入队（下一轮会话；先于额度释放，追加任务可立即占额度或排队；
      // 全局满时其 dispatch 走同步闸门自然排到全局队尾，FIFO 公平）
      const fu = this.followUp.get(entry.profile.id)
      if (fu) {
        this.followUp.delete(entry.profile.id)
        for (const t of fu.tasks) this.enqueue(fu.profile, t.taskKey, { immediate: fu.immediate, batchId: t.batchId })
      }
      // 先释放全局额度并滚动续跑全局队列（队首直接 dispatch，不重复错峰：会话结束时机天然错开），
      // 再释放本会话各任务额度（其滚动续跑的新会话 dispatch 时重新过全局闸门）
      this.globalActive--
      const next = this.globalWaiting.shift()
      if (next) this.dispatch(next)
      for (const t of entry.tasks) this.release(t.taskKey)
    })()
  }

  /** 释放一个任务的额度并滚动续跑：waiting 队首出队重新入队 */
  private release(taskKey: string): void {
    const gate = this.gates.get(taskKey)
    if (!gate) return
    gate.active--
    const next = gate.waiting.shift()
    if (!next) return
    // 等待期间该窗口可能已被其他任务的会话占用：转 followUp，由该会话结束后重新入队
    if (this.running.has(next.profile.id)) {
      const fu = this.followUp.get(next.profile.id) ?? { profile: next.profile, tasks: [] }
      const t = next.tasks.find((x) => x.taskKey === taskKey)
      CoalescingEnqueuer.addTask(fu, taskKey, t?.batchId)
      if (next.immediate) fu.immediate = true
      this.followUp.set(next.profile.id, fu)
      return
    }
    this.occupy(taskKey, next.profile, next.immediate, next.tasks.find((x) => x.taskKey === taskKey)?.batchId)
  }

  /** 错峰等待中的窗口数（已入队未开窗；路由层「实时运行」口径的队列部分） */
  pendingCount(): number {
    return this.pending.size
  }

  /** 是否有任何窗口会话正在运行（代理切换的在途守卫：任务运行中换 IP 会破坏签到会话） */
  anyRunning(): boolean {
    return this.running.size > 0
  }

  /**
   * 某任务是否在途：pending/running/followUp/waiting 任一命中；
   * 指定 profileId 时只看该窗口（看板行级判定用）
   */
  hasTaskInFlight(taskKey: string, profileId?: number): boolean {
    if (profileId !== undefined) {
      if (CoalescingEnqueuer.hasTask(this.pending.get(profileId), taskKey)) return true
      if (this.running.get(profileId)?.has(taskKey)) return true
      if (CoalescingEnqueuer.hasTask(this.followUp.get(profileId), taskKey)) return true
      return this.gates.get(taskKey)?.waiting.some((e) => e.profile.id === profileId) ?? false
    }
    for (const e of this.pending.values()) if (CoalescingEnqueuer.hasTask(e, taskKey)) return true
    for (const keys of this.running.values()) if (keys.has(taskKey)) return true
    for (const e of this.followUp.values()) if (CoalescingEnqueuer.hasTask(e, taskKey)) return true
    return (this.gates.get(taskKey)?.waiting.length ?? 0) > 0
  }
}

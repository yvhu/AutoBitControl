/**
 * 窗口任务队列（engine 层）：任务级并发额度 + 同窗口任务合并
 * 依赖方向：依赖基础设施类型，被 server 路由依赖
 * 设计思路：
 * - 每个任务有独立并发额度（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4）：
 *   active 计数已占窗口数，超额的窗口进 waiting FIFO，会话结束释放额度时滚动续跑
 * - 同窗口任务合并保留：pending 合并区 + running/followUp 两套机制（由来见类注释）
 * - 错峰：首次入队随机延迟 staggerMaxSec 内再开窗（批量触发打散起点；0 = 关闭）
 */
import type { ProfileRow } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'

/** 一个窗口的合并任务条目 */
interface Entry {
  profile: ProfileRow
  taskKeys: Set<string>
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
 *   单窗口 runManual 不经此路径不等待；0 = 关闭）
 */
export class CoalescingEnqueuer {
  /** 尚未启动的窗口会话合并区（按窗口 id） */
  private pending = new Map<number, Entry>()
  /** 正在运行的窗口 → 会话内任务集合（in-flight 判定用，会话结束即删） */
  private running = new Map<number, Set<string>>()
  /** 运行中窗口收到的追加任务（本轮结束后重新入队） */
  private followUp = new Map<number, Entry>()
  /** 任务级并发额度表（懒创建） */
  private gates = new Map<string, Gate>()

  constructor(
    private runner: { runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<unknown> },
    private logger: Logger,
    /** 任务并发上限取值（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4） */
    private taskConcurrencyOf: (taskKey: string) => number,
    /** 窗口会话启动随机错峰上限（秒，0 = 关闭）：批量触发时各窗口在 [0, staggerMaxSec] 内随机延迟后开窗 */
    private staggerMaxSec = 0,
  ) {}

  /** 取（或懒创建）任务额度表 */
  private gateFor(taskKey: string): Gate {
    let gate = this.gates.get(taskKey)
    if (!gate) {
      gate = { concurrency: this.taskConcurrencyOf(taskKey), active: 0, waiting: [] }
      this.gates.set(taskKey, gate)
    }
    return gate
  }

  /**
   * 为某窗口入队一个任务（自动合并 + 任务级额度控制）
   * @param profile 窗口记录
   * @param taskKey 任务 key
   * @param opts.immediate 单窗口手动入口（看板行级执行/重跑）：跳过错峰立即投递
   */
  enqueue(profile: ProfileRow, taskKey: string, opts?: { immediate?: boolean }): void {
    // 窗口正在跑：追加到 followUp，本轮结束后统一重排（不能进 pending，见类注释）
    if (this.running.has(profile.id)) {
      const fu = this.followUp.get(profile.id) ?? { profile, taskKeys: new Set<string>() }
      fu.taskKeys.add(taskKey)
      if (opts?.immediate) fu.immediate = true
      this.followUp.set(profile.id, fu)
      return
    }
    const gate = this.gateFor(taskKey)
    // 额度已满：进等待队列（同窗口同任务去重），额度释放后滚动续跑
    if (gate.active >= gate.concurrency) {
      if (!gate.waiting.some(e => e.profile.id === profile.id && e.taskKeys.has(taskKey))) {
        gate.waiting.push({ profile, taskKeys: new Set([taskKey]), immediate: opts?.immediate })
      }
      return
    }
    this.occupy(taskKey, profile, opts?.immediate)
  }

  /** 占额度并进入 pending 合并区（已排队未启动的合并进已有条目；否则新建 + 错峰投递，immediate 跳过延迟） */
  private occupy(taskKey: string, profile: ProfileRow, immediate = false): void {
    const gate = this.gateFor(taskKey)
    gate.active++
    const entry = this.pending.get(profile.id)
    if (entry) {
      entry.taskKeys.add(taskKey)
      if (immediate) entry.immediate = true
      return
    }
    const fresh: Entry = { profile, taskKeys: new Set([taskKey]), immediate }
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

  /** 执行合并完成的窗口会话（delayMs=0 时与 enqueue 同步） */
  private dispatch(entry: Entry): void {
    void (async () => {
      // 让出微任务：等后续 enqueue 合并完成后再删除 pending 条目
      await Promise.resolve()
      this.pending.delete(entry.profile.id)
      this.running.set(entry.profile.id, new Set(entry.taskKeys))
      try {
        await this.runner.runWindowTasks(entry.profile, [...entry.taskKeys])
      } catch (e) {
        // 单窗口会话异常不影响其他窗口，只记日志
        this.logger.error({ err: (e as Error).message }, '窗口任务执行异常')
      }
      this.running.delete(entry.profile.id)
      // 本轮期间收到的追加任务重新入队（下一轮会话；先于额度释放，追加任务可立即占额度或排队）
      const fu = this.followUp.get(entry.profile.id)
      if (fu) {
        this.followUp.delete(entry.profile.id)
        for (const k of fu.taskKeys) this.enqueue(fu.profile, k, { immediate: fu.immediate })
      }
      // 释放本会话各任务额度并滚动续跑等待队列
      for (const k of entry.taskKeys) this.release(k)
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
      const fu = this.followUp.get(next.profile.id) ?? { profile: next.profile, taskKeys: new Set<string>() }
      fu.taskKeys.add(taskKey)
      this.followUp.set(next.profile.id, fu)
      return
    }
    this.occupy(taskKey, next.profile, next.immediate)
  }

  /**
   * 某任务是否在途：pending/running/followUp/waiting 任一命中；
   * 指定 profileId 时只看该窗口（看板行级判定用）
   */
  hasTaskInFlight(taskKey: string, profileId?: number): boolean {
    const inSet = (keys: Set<string> | undefined) => !!keys?.has(taskKey)
    if (profileId !== undefined) {
      if (inSet(this.pending.get(profileId)?.taskKeys)) return true
      if (inSet(this.running.get(profileId))) return true
      if (inSet(this.followUp.get(profileId)?.taskKeys)) return true
      return this.gates.get(taskKey)?.waiting.some(e => e.profile.id === profileId) ?? false
    }
    for (const e of this.pending.values()) if (e.taskKeys.has(taskKey)) return true
    for (const keys of this.running.values()) if (keys.has(taskKey)) return true
    for (const e of this.followUp.values()) if (e.taskKeys.has(taskKey)) return true
    return (this.gates.get(taskKey)?.waiting.length ?? 0) > 0
  }
}

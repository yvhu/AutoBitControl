/**
 * 步骤记录器（automation/diag 层）：记录任务关键步骤的耗时与结果，累计为运行时间线
 * 依赖方向：仅依赖 logger 类型；每轮运行一个实例（window-runner 装配）
 */
import type { Logger } from '../../infrastructure/logger'

/** 单条步骤记录：一次被包裹的执行的名字、起止时刻、耗时与成败，失败时附带错误信息 */
export interface StepRecord {
  /** 步骤名（调用方自定义，如 'goto'/'login'） */
  name: string
  /** 步骤开始的绝对时间戳（毫秒） */
  startMs: number
  /** 步骤耗时（毫秒） */
  ms: number
  /** 是否成功完成 */
  ok: boolean
  /** 失败时的错误消息；成功时为空 */
  detail?: string
}

/**
 * 步骤记录器：把任务执行过程中若干关键步骤包裹起来，自动记录每步耗时与结果，累积成运行时间线。
 * 每轮运行创建一个实例（由 window-runner 装配），供失败诊断包采集上下文。
 */
export class StepRecorder {
  private list: StepRecord[] = []

  /**
   * 执行一个步骤并记录其耗时与成败。
   * 执行流程：记下开始时间，await 传入的函数；成功则追加一条 ok 记录并打 info 日志、
   * 返回结果；抛错则追加一条带错误详情的失败记录、打 warn 日志后把错误继续抛出（不吞异常）。
   * @param name 步骤名
   * @param fn 要执行的异步函数（其返回值原样透传）
   * @param log 可选日志器；提供时成功/失败都会记录
   * @returns fn 的返回值
   * @throws fn 抛出的错误（记录后原样重抛）
   */
  async run<T>(name: string, fn: () => Promise<T>, log?: Logger): Promise<T> {
    const startMs = Date.now()
    try {
      const out = await fn()
      const rec: StepRecord = { name, startMs, ms: Date.now() - startMs, ok: true }
      this.list.push(rec)
      log?.info({ step: name, ms: rec.ms }, `步骤完成: ${name}`)
      return out
    } catch (e) {
      const rec: StepRecord = { name, startMs, ms: Date.now() - startMs, ok: false, detail: (e as Error).message }
      this.list.push(rec)
      log?.warn({ step: name, ms: rec.ms, err: rec.detail }, `步骤失败: ${name}`)
      throw e
    }
  }

  /** 取全部已记录步骤的浅拷贝（返回副本，外部修改不会影响内部记录） */
  steps(): StepRecord[] {
    return [...this.list]
  }
}

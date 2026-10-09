/**
 * 步骤记录器（automation/diag 层）：记录任务关键步骤的耗时与结果，累计为运行时间线
 * 依赖方向：仅依赖 logger 类型；每轮运行一个实例（window-runner 装配）
 */
import type { Logger } from '../../infrastructure/logger'

export interface StepRecord {
  name: string
  startMs: number
  ms: number
  ok: boolean
  detail?: string
}

export class StepRecorder {
  private list: StepRecord[] = []

  /** 执行一步并记录耗时/结果（失败记录后继续抛出） */
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

  /** 已记录步骤（拷贝） */
  steps(): StepRecord[] {
    return [...this.list]
  }
}

/**
 * 诊断函数（api 层）：步骤记录（运行时间线）
 * 依赖方向：engine TaskContext 类型、automation/diag 的 StepRecord
 */
import type { TaskContext } from '../engine/task-context'
import type { StepRecord } from '../automation'

/** 记录一个步骤（名称/耗时/成败），累积为运行时间线 */
export async function recordStep<T>(ctx: TaskContext, name: string, fn: () => Promise<T>): Promise<T> {
  return ctx.recorder.run(name, fn, ctx.log)
}

/** 取已记录步骤 */
export function getSteps(ctx: TaskContext): StepRecord[] {
  return ctx.recorder.steps()
}

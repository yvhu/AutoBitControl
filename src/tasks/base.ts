/**
 * 任务基类（tasks 层）：所有站点任务的抽象契约与类型再导出
 * 依赖方向：对 engine 做 type-only import（Global Constraints 明确允许该例外），
 * 被 server/app 以 SiteTask 类型引用
 * 设计思路：任务 = 静态元信息 meta + 单一执行入口 run(ctx)；
 * 新增站点只需新建文件实现两者并在 index.ts 登记
 */
import { TaskContext } from '../engine/task-context'
import type { TaskMeta } from '../engine/task'

export { TaskContext } from '../engine/task-context'
export type { TaskMeta } from '../engine/task'

/** 站点任务抽象类：所有任务的基类 */
export abstract class SiteTask {
  abstract meta: TaskMeta
  abstract run(ctx: TaskContext): Promise<void>
}

import { TaskContext } from '../engine/task-context'
import type { TaskMeta } from '../engine/task'

export { TaskContext } from '../engine/task-context'
export type { TaskMeta } from '../engine/task'

export abstract class SiteTask {
  abstract meta: TaskMeta
  abstract run(ctx: TaskContext): Promise<void>
}

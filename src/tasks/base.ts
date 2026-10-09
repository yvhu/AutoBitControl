/**
 * 任务基类（tasks 层）：所有站点任务的抽象契约与类型再导出
 * 依赖方向：对 engine 做 type-only import（Global Constraints 明确允许该例外），
 * 被 server/app 以 SiteTask 类型引用
 * 设计思路：任务 = 静态元信息 meta + 运行主体 run(ctx)；
 * 运行主体只经 src/api 的能力函数操作 ctx（加载页面/等待/登录/截图等），不再有方法/命名空间
 */
import type { TaskContext } from '../engine/task-context'
import type { TaskMeta } from '../engine/task'

// 统一再导出任务上下文类型与实例，供各任务文件从 './base' 单点引入
export { TaskContext } from '../engine/task-context'
export type { TaskMeta } from '../engine/task'
// 再导出可恢复错误文案表与默认刷新超时，供站点任务直接复用（如 portal-rhuna/shelby-explorer）
export { RECOVER_TEXTS, DEFAULT_RELOAD_TIMEOUT_MS } from '../engine/task'

/**
 * 站点任务抽象类：所有站点任务的公共契约。
 * 任务 = 必填的静态元信息 meta + 运行主体 run(ctx)；
 * 子类只需声明 meta 并在 run 内调用 ../api 的能力函数完成站点动作，新增站点后在 index.ts 登记即可。
 */
export abstract class SiteTask {
  /** 任务元信息：key/name/url/wallet/timeoutSec/retry/concurrency/enabled 等（key 全局唯一） */
  abstract meta: TaskMeta

  /**
   * 任务运行主体：打开页面、登录、站点动作与成功断言都在此完成。
   * @param ctx 任务上下文（运行时数据袋子，能力经 src/api 函数使用）
   */
  abstract run(ctx: TaskContext): Promise<void>
}

/**
 * 任务基类（tasks 层）：所有站点任务的抽象契约与类型再导出
 * 依赖方向：对 engine 做 type-only import（Global Constraints 明确允许该例外），
 * 被 server/app 以 SiteTask 类型引用
 * 设计思路：任务 = 静态元信息 meta + 可选声明式登录 login + 可选站点动作 action，
 * 基类默认 run 提供统一骨架；新增站点只需新建文件定义 meta（及 login/action）并在 index.ts 登记
 */
import { TaskContext } from '../engine/task-context'
import type { TaskMeta, LoginSpec } from '../engine/task'

// 统一再导出任务上下文类型与实例，供各任务文件从 './base' 单点引入
export { TaskContext } from '../engine/task-context'
export type { TaskMeta, LoginSpec } from '../engine/task'
// 再导出可恢复错误文案表与默认刷新超时，供站点任务直接复用（如 portal-rhuna/shelby-explorer）
export { RECOVER_TEXTS, DEFAULT_RELOAD_TIMEOUT_MS } from '../engine/task'

/** 任务页面类型（复用 TaskContext 暴露的 patchright Page） */
type TaskPage = TaskContext['page']
/** 任务日志类型 */
type TaskLog = TaskContext['log']

/** 普通延时（毫秒），仅用于 goto 重试退避，非拟人化操作 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 打开任务页，带网络抖动重试。
 * 执行流程：最多 3 次调用 page.goto（45s 超时、DOMContentLoaded 即认为可用）；
 * 失败打警告，前两次失败后随机退避 2-5s 再试，第 3 次仍失败则抛出原错误。
 * @param page 当前任务页面
 * @param url 目标地址
 * @param log 日志器
 * @throws 三次均加载失败时抛出最后一次错误
 */
export async function gotoWithRetry(page: TaskPage, url: string, log: TaskLog): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' })
      return
    } catch (e) {
      log.warn({ url, attempt }, `页面加载失败，第 ${attempt}/3 次`)
      if (attempt === 3) throw e
      await sleep(2000 + Math.floor(Math.random() * 3000))
    }
  }
}

/**
 * 关闭当前浏览器上下文里除传入页面外的所有标签页，清掉上一任务/上轮留下的残留页。
 * 逐个关闭并吞掉错误（某页已关或关不掉都不影响其余）。
 * @param page 需要保留的当前任务页面
 */
export async function closeOtherTabs(page: TaskPage): Promise<void> {
  for (const p of page.context().pages()) {
    if (p === page) continue
    await p.close().catch(() => {})
  }
}

/**
 * 站点任务抽象类：所有站点任务的公共契约。
 * 任务 = 必填的静态元信息 meta + 可选声明式登录 login + 可选站点动作 action；
 * 基类提供默认 run 骨架，子类一般只需声明 meta（及 login/action），复杂场景（多页等）可覆盖 run。
 */
export abstract class SiteTask {
  /** 任务元信息：key/name/url/wallet/timeoutSec/retry/concurrency/enabled 等（key 全局唯一） */
  abstract meta: TaskMeta
  /** 声明式登录（可选）：配置后默认 run 自动执行 ensureLoggedIn */
  login?: LoginSpec
  /** 任务主体（可选）：登录完成后要做的站点特有动作；旧任务可继续覆盖 run */
  action?(ctx: TaskContext): Promise<void>

  /**
   * 默认执行骨架：清理残留标签页 → 打开任务页（带重试）→ 执行声明式登录 → 执行站点动作。
   * meta.url 为空时跳过导航；login/action 未配置时对应步骤跳过。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await closeOtherTabs(ctx.page)
    if (this.meta.url) {
      await gotoWithRetry(ctx.page, this.meta.url, ctx.log)
    }
    if (this.login) await ctx.wallet.ensureLoggedIn(this.login)
    if (this.action) await this.action(ctx)
  }
}

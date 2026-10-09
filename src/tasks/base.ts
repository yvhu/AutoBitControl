/**
 * 任务基类（tasks 层）：所有站点任务的抽象契约与类型再导出
 * 依赖方向：对 engine 做 type-only import（Global Constraints 明确允许该例外），
 * 被 server/app 以 SiteTask 类型引用
 * 设计思路：任务 = 静态元信息 meta + 可选声明式登录 login + 可选站点动作 action，
 * 基类默认 run 提供统一骨架；新增站点只需新建文件定义 meta（及 login/action）并在 index.ts 登记
 */
import { TaskContext } from '../engine/task-context'
import type { TaskMeta, LoginSpec } from '../engine/task'

export { TaskContext } from '../engine/task-context'
export type { TaskMeta, LoginSpec } from '../engine/task'

/** 普通延时（毫秒），仅用于 goto 重试退避，非拟人化操作 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 打开任务页：最多 3 次，失败按 2-5s 随机退避重试（真机网络抖动韧性），最后一次仍失败则抛出 */
async function gotoWithRetry(ctx: TaskContext, url: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ctx.page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' })
      return
    } catch (e) {
      ctx.log.warn({ url, attempt }, `页面加载失败，重试 ${attempt}/3`)
      if (attempt === 3) throw e
      await sleep(2000 + Math.floor(Math.random() * 3000))
    }
  }
}

/** 站点任务抽象类：默认 run 提供统一骨架，子类实现 action（可覆盖 run 处理多页等特殊情况） */
export abstract class SiteTask {
  abstract meta: TaskMeta
  /** 声明式登录（可选）：配置后默认 run 自动执行 ensureLoggedIn */
  login?: LoginSpec
  /** 任务主体（可选）：登录完成后要做的站点特有动作；旧任务可继续覆盖 run */
  action?(ctx: TaskContext): Promise<void>

  /** 默认骨架：清理残留标签页 → goto → 登录 → action */
  async run(ctx: TaskContext): Promise<void> {
    for (const p of ctx.page.context().pages()) {
      if (p !== ctx.page) await p.close().catch(() => {})
    }
    if (this.meta.url) {
      await gotoWithRetry(ctx, this.meta.url)
    }
    if (this.login) await ctx.wallet.ensureLoggedIn(this.login)
    if (this.action) await this.action(ctx)
  }
}

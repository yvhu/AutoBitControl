/**
 * 错峰纯函数（engine 层）：按窗口序号把一批触发均匀铺开，并叠加小幅抖动
 * 依赖方向：仅依赖标准库 Math；被触发入口（任务路由/批次重跑/定时调度）调用
 * 设计思路：同一批触发共用 startMs 与 count，各窗口按 index 均匀分布；
 *           抖动只用于打散相邻窗口，不改变整体节奏；结果不早于 nowMs
 */

/** 触发入口共享的错峰配置（spreadSec = 本批总铺开时长） */
export interface StaggerConfig {
  spreadSec: number
  jitterPct: number
}

/** 单个窗口的错峰时间参数 */
export interface StaggerNotBeforeOptions {
  /** 本批触发开始时间（所有任务共用） */
  startMs: number
  /** 允许的最早执行时间（结果不会早于它） */
  nowMs: number
  /** 窗口在本批中的序号（0 起） */
  index: number
  /** 本批窗口总数 */
  count: number
  /** 本批总铺开时长（毫秒） */
  spreadMs: number
  /** 抖动幅度占 spacing 的百分比 */
  jitterPct: number
  /** 随机数来源（测试注入；缺省 Math.random） */
  rng?: () => number
}

/**
 * 计算某窗口的 not_before_ms
 * @param opts 错峰参数
 * @returns 该窗口最早可被 claim 的时间戳（毫秒）
 */
export function staggerNotBefore(opts: StaggerNotBeforeOptions): number {
  if (opts.count <= 1 || opts.spreadMs <= 0) return Math.max(opts.nowMs, opts.startMs)
  const spacing = opts.spreadMs / (opts.count - 1)
  const even = opts.index * spacing
  const jitter = spacing * (opts.jitterPct / 100) * ((opts.rng ?? Math.random)() * 2 - 1)
  return Math.max(opts.nowMs, Math.round(opts.startMs + even + jitter))
}

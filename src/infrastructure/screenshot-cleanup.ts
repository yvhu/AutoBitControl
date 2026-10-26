/**
 * 截图目录清理（infrastructure 层）：按日期目录保留 N 天，启动时及运行期定时删除超期目录
 * 依赖方向：仅依赖 node:fs，被 app.ts 调用
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 截图清理间隔：6 小时（服务长开时不能只靠启动清理） */
export const SCREENSHOT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface ScreenshotCleanupScheduleOptions {
  screenshotDir: string
  retainDays: number
  intervalMs?: number
  onRemoved?: (result: { removed: number }) => void
  onError?: (err: Error) => void
}

/** 启动截图清理：立即执行一次，之后按 intervalMs 重复；返回 stop 用于优雅停机 */
export function startScreenshotCleanupSchedule(opts: ScreenshotCleanupScheduleOptions): { stop(): void; run(): void } {
  const run = (): void => {
    try {
      opts.onRemoved?.(pruneScreenshots(opts.screenshotDir, opts.retainDays))
    } catch (e) {
      opts.onError?.(e instanceof Error ? e : new Error(String(e)))
    }
  }
  run()
  const timer = setInterval(run, opts.intervalMs ?? SCREENSHOT_CLEANUP_INTERVAL_MS)
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
    run,
  }
}

/** 判定目录名是否为 YYYY-MM-DD 日期目录 */
function isDateDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name)
}

/**
 * 删除早于截止日的日期目录（screenshotDir/<YYYY-MM-DD>/...）；grid-debug 等非日期目录不动
 * @param screenshotDir 截图根目录（不存在则返回 0）
 * @param retainDays 保留天数（0 按 0 处理：删除今天之前全部）
 * @returns 删除的目录数（单个目录删除失败静默跳过，不影响其余）
 */
export function pruneScreenshots(screenshotDir: string, retainDays: number): { removed: number } {
  if (!existsSync(screenshotDir)) return { removed: 0 }
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - Math.max(0, retainDays) + 1)
  // 日期目录按本地日期命名，截止日也必须用本地日期（toISOString 在凌晨会偏到前一天，导致多留一天）
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
  let removed = 0
  for (const name of readdirSync(screenshotDir)) {
    if (!isDateDir(name)) continue
    if (name >= cutoffStr) continue
    try {
      rmSync(join(screenshotDir, name), { recursive: true, force: true })
      removed++
    } catch { /* 单个目录删除失败静默 */ }
  }
  return { removed }
}

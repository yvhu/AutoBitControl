/**
 * 截图目录清理（infrastructure 层）：按日期目录保留 N 天，启动时删除超期目录
 * 依赖方向：仅依赖 node:fs，被 app.ts 调用
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
  const cutoffStr = cutoff.toISOString().slice(0, 10)
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

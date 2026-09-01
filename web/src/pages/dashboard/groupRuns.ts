/**
 * 执行记录折叠分组（纯函数）：按（窗口,任务）分组，顶层为最新一轮，
 * 历史轮次按 slot 倒序；统计口径同步改为按最新轮计数
 */
import type { RunRow, DashboardData } from '../../types'

/** 一个（窗口,任务）组的折叠视图：latest 最新轮，history 历史轮次（slot 倒序） */
export interface RunGroup {
  latest: RunRow
  history: RunRow[]
}

/** 分组：组顺序按首次出现顺序（即 API 返回顺序 p.id, taskKey, slot 的自然序） */
export function groupRuns(runs: RunRow[]): RunGroup[] {
  const groups = new Map<string, RunRow[]>()
  for (const r of runs) {
    const key = `${r.profileId}-${r.taskKey}`
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => b.slot - a.slot)
    return { latest: sorted[0], history: sorted.slice(1) }
  })
}

/** 每窗口每任务最新一轮的统计（与折叠后表格行数一致） */
export function latestStats(runs: RunRow[]): DashboardData['stats'] {
  const stats = { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0 }
  for (const { latest } of groupRuns(runs)) {
    stats.total++
    if (latest.status === 'success') stats.success++
    else if (latest.status === 'failed') stats.failed++
    else if (latest.status === 'captcha_failed') stats.captchaFailed++
    else if (latest.status === 'skipped') stats.skipped++
    else if (latest.status === 'running' || latest.status === 'retry_wait') stats.running++
    else if (latest.status === 'pending') stats.pending++
  }
  return stats
}

/** 历史轮次索引：key = 该组最新行 id；单轮组不入表（展开区查询用） */
export function historyMap(runs: RunRow[]): Map<number, RunRow[]> {
  const map = new Map<number, RunRow[]>()
  for (const { latest, history } of groupRuns(runs)) {
    if (history.length > 0) map.set(latest.id, history)
  }
  return map
}

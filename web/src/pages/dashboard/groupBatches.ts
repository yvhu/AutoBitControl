/**
 * 批次时间线纯函数（前端）：散批聚合分流与批次完成率计算
 * 设计思路：bulk 批次按时间线主列表展示；single 批次聚合进「单窗口散批」折叠卡
 */
import type { BatchItem } from '../../types'

/** 散批分流：kind=single 的批次从主列表抽出（主列表仍按后端 createdAt 倒序） */
export function splitBatches(batches: BatchItem[]): { bulk: BatchItem[]; single: BatchItem[] } {
  const bulk: BatchItem[] = []
  const single: BatchItem[] = []
  for (const b of batches) (b.kind === 'single' ? single : bulk).push(b)
  return { bulk, single }
}

/** 批次完成率：终态行数 / 总行数（百分比四舍五入；total=0 返回 0） */
export function batchProgress(b: BatchItem): { done: number; pct: number } {
  const s = b.stats
  const done = s.success + s.failed + s.captchaFailed + s.skipped
  const pct = s.total > 0 ? Math.round((done / s.total) * 100) : 0
  return { done, pct }
}

/** 批次时间信息：finished = 无任何在途（running/pending/retryWait 全 0）；耗时 = lastFinishedAt - createdAt（秒取整，任一缺失返回 null） */
export function batchTiming(batch: BatchItem): { finished: boolean; durationSec: number | null } {
  const s = batch.stats
  const finished = s.running === 0 && s.pending === 0 && s.retryWait === 0
  if (!finished || !batch.lastFinishedAt) return { finished, durationSec: null }
  const end = new Date(batch.lastFinishedAt.replace(' ', 'T')).getTime()
  const start = new Date(batch.createdAt.replace(' ', 'T')).getTime()
  const sec = Math.round((end - start) / 1000)
  return { finished, durationSec: Number.isFinite(sec) ? sec : null }
}

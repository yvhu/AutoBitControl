/** 总耗时展示：null（无结束时间）→ '—'；60 秒以内 → 'Xs'；否则 → 'Xm Ys'（秒为整数值） */
export function formatDuration(sec: number | null): string {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

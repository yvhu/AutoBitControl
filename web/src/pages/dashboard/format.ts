/** 总耗时展示：null（无结束时间）→ '—'；60 秒以内 → 'Xs'；否则 → 'Xh Ym Zs'（不足 1 小时省略小时位，秒为整数值） */
export function formatDuration(sec: number | null): string {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ${s}s`
}

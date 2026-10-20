/** 批次时间展示：'YYYY-MM-DD HH:mm:ss.SSS' 字符串 → 'YYYY-MM-DD HH:mm'（跨天/跨月可区分） */
export function formatDateTime(v: string): string {
  return v.slice(0, 16)
}

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

/** 预计开始展示：null/非法值/0 → '—'；时间戳 → 本地 HH:mm */
export function formatEta(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 失败类型中文文案（未知/空为 —） */
export function failureKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'environment': return '环境失败'
    case 'task': return '任务失败'
    case 'timeout': return '超时'
    case 'stopped': return '手动停止'
    case 'captcha': return '验证码'
    case 'breaker': return '熔断跳过'
    default: return '—'
  }
}

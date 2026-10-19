/**
 * 窗口熔断展示（web 层）：把健康状态转成 Tag 文案/颜色/tooltip
 * 依赖方向：仅依赖前端 ProfileRow 类型
 */
import type { ProfileRow } from '../../types'

export interface BreakerTagView {
  color: string
  text: string
  title?: string
}

/** 从本地墙钟字符串中取 HH:mm；解析不出原样返回 */
export function formatProbeTime(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /(\d{2}):(\d{2})/.exec(value)
  return match ? `${match[1]}:${match[2]}` : value
}

export function breakerView(profile: ProfileRow, threshold: number, enabled: boolean): BreakerTagView {
  if (!enabled) return { color: 'default', text: '熔断已关闭' }
  const state = profile.breakerState ?? 'closed'
  if (state === 'open') {
    const at = formatProbeTime(profile.breakerNextProbeAt)
    return {
      color: 'red',
      text: at ? `熔断中 · ${at} 探测` : '熔断中',
      title: profile.breakerReason ?? undefined,
    }
  }
  if (state === 'half_open') {
    return { color: 'gold', text: '探测中', title: profile.breakerReason ?? undefined }
  }
  const count = profile.circuitBreakerCount
  if (count > 0) return { color: 'gold', text: `环境失败 ${count}/${threshold}` }
  return { color: 'green', text: '正常' }
}

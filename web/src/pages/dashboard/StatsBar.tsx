/**
 * 批次状态分段条（dashboard 组件）：整条长度 = total，各状态按数量占比分色；
 * 下方彩色方块图例带数量。仅展示数量 > 0 的状态；total = 0 时条为空。
 * 依赖方向：仅依赖 types（BatchItem stats 形状）
 */
import type { ReactNode } from 'react'
import type { BatchItem } from '../../types'

/** 状态分段顺序与配色（沿用状态标签色；skipped 原本无标签，补浅灰） */
export const STATS_SEGMENTS: Array<{ key: keyof BatchItem['stats']; label: string; color: string }> = [
  { key: 'success', label: '成功', color: '#52c41a' },
  { key: 'failed', label: '失败', color: '#ff4d4f' },
  { key: 'captchaFailed', label: '验证码', color: '#13c2c2' },
  { key: 'skipped', label: '跳过', color: '#d9d9d9' },
  { key: 'running', label: '进行中', color: '#faad14' },
  { key: 'retryWait', label: '重试中', color: '#fa8c16' },
  { key: 'pending', label: '待执行', color: '#8c8c8c' },
]

/** 批次状态分段条 + 图例；right 渲染在条右侧（如「完成数/总数」） */
export default function StatsBar({ stats, right }: { stats: BatchItem['stats']; right?: ReactNode }) {
  const total = stats.total
  const parts = STATS_SEGMENTS.filter((s) => stats[s.key] > 0)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 120, height: 9, borderRadius: 5, overflow: 'hidden', display: 'flex', background: '#f0f0f0' }}>
          {total > 0 && parts.map((s) => (
            <div key={s.key} style={{ width: `${(stats[s.key] / total) * 100}%`, background: s.color }} />
          ))}
        </div>
        {right}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6, fontSize: 12, color: '#555' }}>
        {parts.map((s) => (
          <span key={s.key}>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: s.color, marginRight: 4 }} />
            {s.label} {stats[s.key]}
          </span>
        ))}
      </div>
    </div>
  )
}

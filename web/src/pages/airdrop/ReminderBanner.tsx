/**
 * 提醒横幅组件：展示临近/逾期提醒，支持关闭（同文案不再弹，数据变化再现）
 * 依赖方向：仅依赖 ./board 与 ../types，被 index.tsx 引用
 */
import { Alert } from 'antd'
import { reminderBannerText } from './board'
import type { AirdropReminders } from '../../types'

/** 提醒横幅：有逾期用 error 色、仅临近用 warning 色；关闭后同文案不再弹（数据变化再现） */
export default function ReminderBanner({ reminders, dismissedKey, onDismiss }: {
  reminders: AirdropReminders
  dismissedKey: string | null
  onDismiss: (key: string) => void
}) {
  const text = reminderBannerText(reminders)
  if (!text || text === dismissedKey) return null
  return (
    <Alert
      type={reminders.overdue.length > 0 ? 'error' : 'warning'}
      showIcon
      closable
      message={text}
      onClose={() => onDismiss(text)}
      style={{ marginBottom: 16 }}
    />
  )
}

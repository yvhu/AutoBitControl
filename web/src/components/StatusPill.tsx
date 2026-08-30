import { Tag } from 'antd'
import type { RunStatus } from '../types'

const MAP: Record<RunStatus, { color: string; label: string }> = {
  success: { color: 'success', label: '成功' },
  failed: { color: 'error', label: '失败' },
  captcha_failed: { color: 'cyan', label: '验证码失败' },
  running: { color: 'gold', label: '执行中' },
  retry_wait: { color: 'gold', label: '重试中' },
  skipped: { color: 'default', label: '跳过' },
  pending: { color: 'default', label: '待执行' },
}

export default function StatusPill({ status }: { status: RunStatus }) {
  const m = MAP[status]
  return <Tag color={m.color}>{m.label}</Tag>
}

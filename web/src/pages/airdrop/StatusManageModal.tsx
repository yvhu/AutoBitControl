/**
 * 状态列管理弹窗：新增/改名/删除/上下换序
 * 依赖方向：依赖 ./hooks 与 ../types，被 index.tsx 引用
 */
import { useEffect, useState } from 'react'
import { App, Button, Input, Modal } from 'antd'
import { DeleteOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import { useCreateStatus, useDeleteStatus, useUpdateStatus } from './hooks'
import { statusColor } from './board'
import type { AirdropStatusItem } from '../../types'

/** 管理状态列弹窗：新增/改名/删除/上下换序 */
export default function StatusManageModal({ open, statuses, onClose }: {
  open: boolean
  statuses: AirdropStatusItem[]
  onClose: () => void
}) {
  const { message } = App.useApp()
  const [names, setNames] = useState<Record<number, string>>({})
  const [newName, setNewName] = useState('')
  const createStatus = useCreateStatus()
  const updateStatus = useUpdateStatus()
  const deleteStatus = useDeleteStatus()

  useEffect(() => {
    if (open) {
      setNames(Object.fromEntries(statuses.map((s) => [s.id, s.name])))
      setNewName('')
    }
  }, [open])

  const rename = (s: AirdropStatusItem) => {
    const name = (names[s.id] ?? '').trim()
    if (!name) { message.warning('状态名不能为空'); return }
    updateStatus.mutate({ id: s.id, body: { name } })
  }

  const swap = (a: AirdropStatusItem, b: AirdropStatusItem) => {
    updateStatus.mutate({ id: a.id, body: { sortOrder: b.sortOrder } })
    updateStatus.mutate({ id: b.id, body: { sortOrder: a.sortOrder } })
  }

  const addNew = () => {
    const name = newName.trim()
    if (!name) { message.warning('状态名不能为空'); return }
    createStatus.mutate(name, { onSuccess: () => setNewName('') })
  }

  return (
    <Modal open={open} title="管理状态列" onCancel={onClose} footer={null} width={480}>
      {statuses.map((s, i) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px solid #e5e9ef', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(i), flex: 'none' }} />
          <Input
            value={names[s.id] ?? s.name}
            onChange={(e) => setNames((prev) => ({ ...prev, [s.id]: e.target.value }))}
            onBlur={() => rename(s)}
            variant="borderless"
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: '#8c959f' }}>{s.projectCount} 项目</span>
          <Button type="text" size="small" icon={<UpOutlined />} disabled={i === 0} onClick={() => swap(s, statuses[i - 1])} />
          <Button type="text" size="small" icon={<DownOutlined />} disabled={i === statuses.length - 1} onClick={() => swap(s, statuses[i + 1])} />
          <Button type="text" size="small" icon={<DeleteOutlined style={{ color: '#cf1322' }} />} onClick={() => deleteStatus.mutate(s.id)} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Input value={newName} placeholder="新状态列名（如：空投已到账）" onChange={(e) => setNewName(e.target.value)} onPressEnter={addNew} style={{ flex: 1 }} />
        <Button onClick={addNew}>新增</Button>
      </div>
    </Modal>
  )
}

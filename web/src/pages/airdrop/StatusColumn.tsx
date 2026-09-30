/**
 * 状态列组件：列头（名称/数量/快捷新建）+ 卡片区，dnd 拖放目标
 * 依赖方向：仅依赖 ../types 与 @dnd-kit/core，被 index.tsx 引用
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button, theme, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useDroppable } from '@dnd-kit/core'
import type { AirdropStatusItem } from '../../types'

const COL_STYLE: CSSProperties = {
  flex: '0 0 290px',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 10,
  maxHeight: 'calc(100vh - 250px)',
}

/** 看板单列：列头（名称/数量/快捷新建）+ 卡片区；dnd drop 目标 */
export default function StatusColumn({ status, onAdd, color, children }: {
  status: AirdropStatusItem
  onAdd: () => void
  color: string
  children: ReactNode
}) {
  const { token } = theme.useToken()
  const { setNodeRef, isOver } = useDroppable({ id: `status-${status.id}` })
  return (
    <div ref={setNodeRef} style={{ ...COL_STYLE, background: token.colorFillQuaternary, outline: isOver ? `2px dashed ${token.colorPrimary}` : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 8px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }} />
        <Typography.Text strong style={{ fontSize: 13.5 }}>{status.name}</Typography.Text>
        <span style={{ background: token.colorFillSecondary, color: token.colorTextSecondary, fontSize: 12, padding: '0 8px', borderRadius: 10, lineHeight: '18px' }}>{status.projectCount}</span>
        <Button type="text" size="small" icon={<PlusOutlined />} style={{ marginLeft: 'auto' }} onClick={onAdd} title="在此列新增" />
      </div>
      <div style={{ padding: '2px 10px 12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 60 }}>
        {children}
      </div>
    </div>
  )
}

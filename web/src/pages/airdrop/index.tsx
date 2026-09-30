/**
 * 空投追踪看板页：提醒横幅 + 状态列拖拽 + 项目卡片 + 两个弹窗
 * 依赖方向：依赖 ./board、./hooks 与各子组件，被 App.tsx 路由挂载
 */
import { useMemo, useState } from 'react'
import { Alert, Button, Card, Space, Typography } from 'antd'
import { PlusOutlined, SettingOutlined } from '@ant-design/icons'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { groupByStatus } from './board'
import { useAirdropProjects, useAirdropReminders, useAirdropStatuses, useUpdateProject } from './hooks'
import ReminderBanner from './ReminderBanner'
import StatusColumn from './StatusColumn'
import ProjectCard from './ProjectCard'
import ProjectFormModal from './ProjectFormModal'
import StatusManageModal from './StatusManageModal'
import type { AirdropProjectView } from '../../types'

/** 空投追踪看板页：提醒横幅 + 状态列拖拽 + 项目卡片 + 两个弹窗 */
export default function AirdropPage() {
  const statuses = useAirdropStatuses()
  const projects = useAirdropProjects()
  const reminders = useAirdropReminders()
  const updateProject = useUpdateProject()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AirdropProjectView | null>(null)
  const [defaultStatusId, setDefaultStatusId] = useState<number | undefined>(undefined)
  const [statusModalOpen, setStatusModalOpen] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  const grouped = useMemo(() => groupByStatus(projects.data ?? []), [projects.data])

  const openCreate = (statusId?: number) => {
    setEditing(null)
    setDefaultStatusId(statusId)
    setFormOpen(true)
  }

  const openEdit = (p: AirdropProjectView) => {
    setEditing(p)
    setFormOpen(true)
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over) return
    const pid = Number(String(active.id).replace('project-', ''))
    const sid = Number(String(over.id).replace('status-', ''))
    if (!Number.isInteger(pid) || !Number.isInteger(sid)) return
    const project = (projects.data ?? []).find((p) => p.id === pid)
    if (!project || project.statusId === sid) return
    updateProject.mutate({ id: pid, statusId: sid })
  }

  if (statuses.isPending || projects.isPending) {
    return <Card size="small"><div style={{ textAlign: 'center', padding: 48 }}><Typography.Text type="secondary">加载中...</Typography.Text></div></Card>
  }
  if (statuses.isError || projects.isError || !statuses.data || !projects.data) {
    return <Alert type="error" showIcon message="空投追踪加载失败" description="请检查后端服务是否运行" />
  }

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <ReminderBanner reminders={reminders.data ?? { upcoming: [], overdue: [] }} dismissedKey={dismissedKey} onDismiss={setDismissedKey} />
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>空投追踪</Typography.Title>
          <Typography.Text type="secondary">项目备忘录 + 待办清单：记录每个空投的参与进度、备注与时间节点</Typography.Text>
        </div>
        <Space>
          <Button icon={<SettingOutlined />} onClick={() => setStatusModalOpen(true)}>管理状态列</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>新增项目</Button>
        </Space>
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 12 }}>
          {statuses.data.map((s) => (
            <StatusColumn key={s.id} status={s} onAdd={() => openCreate(s.id)}>
              {(grouped.get(s.id) ?? []).map((p) => (
                <ProjectCard key={p.id} project={p} onEdit={openEdit} />
              ))}
            </StatusColumn>
          ))}
        </div>
      </DndContext>
      <ProjectFormModal
        open={formOpen}
        editing={editing}
        statuses={statuses.data}
        defaultStatusId={defaultStatusId}
        onClose={() => setFormOpen(false)}
      />
      <StatusManageModal open={statusModalOpen} statuses={statuses.data} onClose={() => setStatusModalOpen(false)} />
    </Space>
  )
}

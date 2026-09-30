/**
 * 项目卡片组件：dnd 拖拽源 + 字段展示 + 子项勾选/删除 + 展开备注 + 编辑/删除入口
 * 依赖方向：依赖 ./board、./hooks 与 ../types，被 index.tsx 引用
 */
import { useState } from 'react'
import { Button, Checkbox, Dropdown, Popconfirm, Tag, Tooltip, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, LinkOutlined, MoreOutlined } from '@ant-design/icons'
import { useDraggable } from '@dnd-kit/core'
import { deadlineBadge, PRIORITY_LABEL, PRIORITY_TAG, todayLocal } from './board'
import { useDeleteProject, useDeleteTodo, useUpdateTodo } from './hooks'
import type { AirdropProjectView } from '../../types'

const DAYS_TEXT = (b: { daysLeft: number; kind: 'over' | 'warn' | 'fine' }) => {
  if (b.kind === 'over') return `已过期 ${-b.daysLeft} 天`
  if (b.daysLeft === 0) return '今天'
  return `剩 ${b.daysLeft} 天`
}

const DAYS_COLOR = { over: '#cf1322', warn: '#d46b08', fine: '#2f54eb' } as const

/** 项目卡片：拖拽源 + 字段展示 + 子项勾选/删除 + 展开备注 + 编辑/删除入口 */
export default function ProjectCard({ project, onEdit }: { project: AirdropProjectView; onEdit: (p: AirdropProjectView) => void }) {
  const [expanded, setExpanded] = useState(false)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `project-${project.id}` })
  const updateTodo = useUpdateTodo()
  const deleteTodo = useDeleteTodo()
  const deleteProject = useDeleteProject()
  const badge = deadlineBadge(project.deadline, todayLocal())

  const items = [
    { key: 'edit', icon: <EditOutlined />, label: '编辑' },
    { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
  ]

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        background: '#fff', borderRadius: 10, padding: '12px 13px', cursor: 'grab', opacity: isDragging ? 0.45 : 1,
        border: '1px solid #e5e9ef', boxShadow: '0 1px 2px rgba(16,24,40,.05)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <span style={{ color: '#c3c9d1', fontSize: 13 }}>⠿</span>
        <Tag color={PRIORITY_TAG[project.priority]} style={{ marginInlineEnd: 0 }}>{PRIORITY_LABEL[project.priority]}</Tag>
        <Typography.Text strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</Typography.Text>
        <Dropdown
          menu={{
            items,
            onClick: ({ key }) => {
              if (key === 'edit') onEdit(project)
              if (key === 'delete') deleteProject.mutate(project.id)
            },
          }}
          trigger={['click']}
        >
          <Button type="text" size="small" icon={<MoreOutlined />} />
        </Dropdown>
      </div>
      {project.deadline && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5b6470', marginBottom: 4 }}>
          <span>⏰ {project.deadline}</span>
          {badge && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: DAYS_COLOR[badge.kind], background: `${DAYS_COLOR[badge.kind]}18`, padding: '0 7px', borderRadius: 4 }}>{DAYS_TEXT(badge)}</span>}
        </div>
      )}
      {project.link && (
        <div style={{ fontSize: 12.5, marginBottom: 4 }}>
          <a href={project.link} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <LinkOutlined style={{ flex: 'none' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 210 }}>{project.link}</span>
          </a>
        </div>
      )}
      {project.note && (
        <Typography.Paragraph
          onClick={() => setExpanded(!expanded)}
          ellipsis={!expanded ? { rows: 2 } : false}
          style={{ fontSize: 12.5, color: '#8c959f', background: '#fafbfc', borderRadius: 6, padding: '7px 9px', marginTop: 6, marginBottom: 0, cursor: 'pointer' }}
        >
          {project.note}
        </Typography.Paragraph>
      )}
      {project.todos.length > 0 && (
        <div style={{ borderTop: '1px dashed #e5e9ef', marginTop: 9, paddingTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {project.todos.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <Checkbox
                checked={t.done === 1}
                onChange={(e) => updateTodo.mutate({ id: t.id, body: { done: e.target.checked } })}
                style={{ flex: 'none' }}
              />
              <span style={t.done === 1 ? { textDecoration: 'line-through', color: '#a6adb5' } : undefined}>{t.content}</span>
              {t.dueDate && (
                <Tooltip title={`截止 ${t.dueDate}`}>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, color: deadlineBadge(t.dueDate, todayLocal())?.kind === 'over' ? '#cf1322' : '#8c959f', flex: 'none' }}>{t.dueDate.slice(5)}</span>
                </Tooltip>
              )}
              <Popconfirm title="删除该子项？" onConfirm={() => deleteTodo.mutate(t.id)}>
                <Button type="text" size="small" icon={<DeleteOutlined style={{ fontSize: 11 }} />} style={{ flex: 'none', padding: 0 }} />
              </Popconfirm>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

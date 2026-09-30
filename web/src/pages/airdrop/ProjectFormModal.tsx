/**
 * 项目表单弹窗：新增/编辑项目字段 + 待办子项编辑器（保存时 diff 增删改）
 * 依赖方向：依赖 ./hooks、./board 与 ../types，被 index.tsx 引用
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, DatePicker, Form, Input, Modal, Select } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useAirdropProjects, useSaveProject, useTasks } from './hooks'
import { PRIORITY_LABEL, type TodoDraft } from './board'
import type { AirdropPriority, AirdropProjectView, AirdropStatusItem, TaskMetaView } from '../../types'

export interface ProjectFormValues {
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: Dayjs | null
  link: string | null
  note: string | null
  taskKey: string | null
}

let draftSeq = 0
const nextKey = () => `draft-${Date.now()}-${draftSeq++}`

const PRIORITY_OPTIONS = (['high', 'mid', 'low'] as const).map((v) => ({ value: v, label: PRIORITY_LABEL[v] }))

function toDrafts(todos: AirdropProjectView['todos']): TodoDraft[] {
  return todos.map((t) => ({ key: `todo-${t.id}`, id: t.id, content: t.content, dueDate: t.dueDate, priority: t.priority }))
}

/** 新增/编辑项目弹窗：项目字段 + 子项编辑器（保存时 diff 增删改） */
export default function ProjectFormModal({ open, editing, statuses, defaultStatusId, onClose }: {
  open: boolean
  editing: AirdropProjectView | null
  statuses: AirdropStatusItem[]
  defaultStatusId?: number
  onClose: () => void
}) {
  const [form] = Form.useForm<ProjectFormValues>()
  const [todos, setTodos] = useState<TodoDraft[]>([])
  const saveProject = useSaveProject()
  const tasks = useTasks()
  const projects = useAirdropProjects()
  const taskOptions = useMemo(() => (tasks.data ?? []).map((t: TaskMetaView) => {
    const holder = (projects.data ?? []).find((p) => p.taskKey === t.key && p.id !== editing?.id)
    return { value: t.key, label: holder ? `${t.name}（已关联：${holder.name}）` : t.name, disabled: Boolean(holder) }
  }), [tasks.data, projects.data, editing?.id])

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      name: editing?.name ?? '',
      statusId: editing?.statusId ?? defaultStatusId ?? statuses[0]?.id,
      priority: editing?.priority ?? 'mid',
      deadline: editing?.deadline ? dayjs(editing.deadline) : null,
      link: editing?.link ?? null,
      note: editing?.note ?? null,
      taskKey: editing?.taskKey ?? null,
    })
    setTodos(editing ? toDrafts(editing.todos) : [])
  }, [open, editing, defaultStatusId, form])

  const addTodo = () => setTodos((prev) => [...prev, { key: nextKey(), content: '', dueDate: null, priority: 'mid' }])

  const onOk = async () => {
    const values = await form.validateFields()
    const deadline = values.deadline ? values.deadline.format('YYYY-MM-DD') : null
    const cleaned = todos.filter((t) => t.content.trim()).map((t) => ({ ...t, content: t.content.trim() }))
    saveProject.mutate(
      { id: editing?.id ?? null, values: { ...values, deadline, taskKey: values.taskKey ?? null }, todos: cleaned },
      { onSuccess: onClose },
    )
  }

  return (
    <Modal open={open} title={editing ? '编辑项目' : '新增项目'} onCancel={onClose} onOk={onOk} confirmLoading={saveProject.isPending} okText="保存" cancelText="取消" width={560}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
          <Input placeholder="如：Starknet" />
        </Form.Item>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="statusId" label="状态列" style={{ flex: 1 }}>
            <Select options={statuses.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="priority" label="优先级" style={{ flex: 1 }}>
            <Select options={PRIORITY_OPTIONS} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="deadline" label="时间节点（快照/截止/发币）" style={{ flex: 1 }}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="link" label="项目链接" style={{ flex: 1 }}>
            <Input placeholder="https://..." />
          </Form.Item>
        </div>
        <Form.Item name="taskKey" label="关联系统任务">
          <Select
            allowClear
            placeholder="不关联（纯手动追踪）"
            options={taskOptions}
          />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={3} placeholder="记录规则、进度、注意点..." />
        </Form.Item>
      </Form>
      <div style={{ border: '1px dashed #d9dce1', borderRadius: 8, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: todos.length > 0 ? 8 : 0 }}>
          <span style={{ fontSize: 12.5, color: '#5b6470' }}>待办子项</span>
          <Button type="link" size="small" icon={<PlusOutlined />} onClick={addTodo}>添加待办</Button>
        </div>
        {todos.map((t) => (
          <div key={t.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 7 }}>
            <Input
              value={t.content}
              placeholder="待办内容"
              onChange={(e) => setTodos((prev) => prev.map((x) => (x.key === t.key ? { ...x, content: e.target.value } : x)))}
              style={{ flex: 1 }}
            />
            <DatePicker
              value={t.dueDate ? dayjs(t.dueDate) : null}
              placeholder="截止"
              onChange={(d) => setTodos((prev) => prev.map((x) => (x.key === t.key ? { ...x, dueDate: d ? d.format('YYYY-MM-DD') : null } : x)))}
              style={{ width: 118 }}
            />
            <Select
              value={t.priority}
              options={PRIORITY_OPTIONS}
              onChange={(v) => setTodos((prev) => prev.map((x) => (x.key === t.key ? { ...x, priority: v } : x)))}
              style={{ width: 86 }}
            />
            <Button type="text" icon={<DeleteOutlined style={{ color: '#cf1322' }} />} onClick={() => setTodos((prev) => prev.filter((x) => x.key !== t.key))} />
          </div>
        ))}
      </div>
    </Modal>
  )
}

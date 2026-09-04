/**
 * 定时任务页：Card+Table 列表 + 新建/编辑弹窗（模式 → 动态参数 → 选任务）
 * 依赖方向：页面 → 本目录 hooks → api/endpoints；任务多选数据源复用 tasks/hooks 的 useTasks
 * 弹窗内 times 用 dayjs 列表承载，提交时 buildPayload 转 'HH:mm' 字符串（interval 模式只取 everyHours）
 */
import { useState } from 'react'
import {
  Button, Card, Empty, Form, Input, InputNumber, Modal, Popconfirm,
  Segmented, Select, Space, Switch, Table, Tag, TimePicker, Typography,
} from 'antd'
import { ClockCircleOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import {
  MODE_OPTIONS, WEEKDAY_OPTIONS, DAY_OPTIONS, modeLabel,
  useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule, useRunSchedule,
  type ScheduleMode,
} from './hooks'
import { useTasks } from '../tasks/hooks'
import type { ScheduleItem, ScheduleConfigInput } from '../../types'

/** 弹窗表单值（times 为 dayjs 列表，提交时转 'HH:mm' 字符串；everyHours 可 null 与视图类型对齐） */
interface FormValues {
  name: string
  mode: ScheduleMode
  everyHours?: number | null
  weekdays?: number[]
  days?: number[]
  times?: Dayjs[]
  taskKeys: string[]
}

function buildPayload(values: FormValues): { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } {
  const base = { name: values.name, taskKeys: values.taskKeys, mode: values.mode }
  if (values.mode === 'interval') return { ...base, config: { everyHours: values.everyHours ?? 6 } }
  const times = (values.times ?? []).map((t) => t.format('HH:mm')).sort()
  if (values.mode === 'daily') return { ...base, config: { times } }
  if (values.mode === 'weekly') return { ...base, config: { weekdays: values.weekdays ?? [], times } }
  return { ...base, config: { days: values.days ?? [], times } }
}

export default function SchedulesPage() {
  const { data: schedules, isLoading } = useSchedules()
  const { data: tasks } = useTasks()
  const create = useCreateSchedule()
  const update = useUpdateSchedule()
  const remove = useDeleteSchedule()
  const run = useRunSchedule()

  const [form] = Form.useForm<FormValues>()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduleItem | null>(null)
  const mode = Form.useWatch('mode', form) ?? 'daily'

  const taskOptions = (tasks ?? []).map((t) => ({ label: t.name, value: t.key }))

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ mode: 'daily', times: [dayjs('09:00', 'HH:mm')], taskKeys: [] })
    setOpen(true)
  }

  const openEdit = (s: ScheduleItem) => {
    setEditing(s)
    form.resetFields()
    form.setFieldsValue({
      name: s.name,
      mode: s.mode,
      everyHours: s.config.everyHours,
      weekdays: s.config.weekdays ?? [],
      days: s.config.days ?? [],
      times: (s.config.times ?? []).map((t) => dayjs(t, 'HH:mm')),
      taskKeys: s.taskKeys,
    })
    setOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    const payload = buildPayload(values)
    if (editing) {
      update.mutate({ id: editing.id, body: payload }, { onSuccess: () => setOpen(false) })
    } else {
      create.mutate(payload, { onSuccess: () => setOpen(false) })
    }
  }

  const columns = [
    { title: '计划名称', dataIndex: 'name', render: (n: string) => <Typography.Text strong>{n}</Typography.Text> },
    {
      title: '触发规则', dataIndex: 'ruleText', render: (_: string, s: ScheduleItem) => (
        <Space size={6}><Tag color="blue">{modeLabel(s.mode)}</Tag><span>{s.ruleText}</span></Space>
      ),
    },
    { title: '下次执行', dataIndex: 'nextRun', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    {
      title: '关联任务', dataIndex: 'taskNames', render: (names: Array<string | null>) => (
        <Space size={4} wrap>{names.map((n, i) => (n ? <Tag key={i}>{n}</Tag> : <Tag key={i} color="red">未知任务</Tag>))}</Space>
      ),
    },
    {
      title: '启用', dataIndex: 'enabled', width: 80, render: (v: boolean, s: ScheduleItem) => (
        <Switch size="small" checked={v} onChange={(checked) => update.mutate({ id: s.id, body: { enabled: checked } })} />
      ),
    },
    {
      title: '操作', width: 200, render: (_: unknown, s: ScheduleItem) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<ClockCircleOutlined />} loading={run.isPending && run.variables === s.id} disabled={!s.enabled} onClick={() => run.mutate(s.id)}>立即运行</Button>
          <Button type="link" size="small" onClick={() => openEdit(s)}>编辑</Button>
          <Popconfirm title={`删除计划「${s.name}」？`} onConfirm={() => remove.mutate(s.id)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="定时任务"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建计划</Button>}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        独立调度子系统：先配时间，再选任务。到点对全部启用窗口入队（沿用全局错峰），错过不补跑，任务在途则跳过。
      </Typography.Paragraph>
      <Table<ScheduleItem>
        rowKey="id"
        size="middle"
        loading={isLoading}
        dataSource={schedules}
        columns={columns}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无计划，点击右上角新建" /> }}
      />

      <Modal
        title={editing ? `编辑计划 · ${editing.name}` : '新建计划'}
        open={open}
        onOk={submit}
        confirmLoading={create.isPending || update.isPending}
        onCancel={() => setOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ mode: 'daily', everyHours: 6, times: [dayjs('09:00', 'HH:mm')], taskKeys: [] }}>
          <Form.Item name="name" label="计划名称" rules={[{ required: true, message: '请填写计划名称' }]}>
            <Input placeholder="例如：每日签到集合" maxLength={30} />
          </Form.Item>
          <Form.Item name="mode" label="频率模式">
            <Segmented options={MODE_OPTIONS} />
          </Form.Item>

          {mode === 'interval' && (
            <Form.Item name="everyHours" label="执行间隔" rules={[{ required: true, message: '请填写间隔小时数' }]}>
              <InputNumber min={1} max={23} addonAfter="小时一次（自 00:00 起算）" style={{ width: 260 }} />
            </Form.Item>
          )}

          {mode === 'weekly' && (
            <Form.Item name="weekdays" label="星期" rules={[{ required: true, message: '至少选择一个星期' }]}>
              <Select mode="multiple" options={WEEKDAY_OPTIONS} placeholder="可多选" />
            </Form.Item>
          )}

          {mode === 'monthly' && (
            <Form.Item name="days" label="每月几号" rules={[{ required: true, message: '至少选择一个日期' }]}>
              <Select mode="multiple" options={DAY_OPTIONS} placeholder="可多选（小月无该日自动跳过）" />
            </Form.Item>
          )}

          {mode !== 'interval' && (
            <Form.Item label="执行时间点">
              <Form.List name="times" rules={[{ validator: async (_, value) => { if (!value || value.length === 0) throw new Error('至少一个时间点') } }]}>
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name }) => (
                      <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                        <Form.Item name={name} rules={[{ required: true, message: '请选择时间' }]} style={{ marginBottom: 0 }}>
                          <TimePicker format="HH:mm" />
                        </Form.Item>
                        <Button size="small" danger onClick={() => remove(name)}>删除</Button>
                      </Space>
                    ))}
                    <Button type="dashed" onClick={() => add(dayjs('09:00', 'HH:mm'))} block>
                      + 添加时间点
                    </Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          )}

          <Form.Item name="taskKeys" label="选择任务（到点后依次触发）" rules={[{ required: true, message: '至少选择一个任务' }]}>
            <Select mode="multiple" options={taskOptions} placeholder="多选任务" optionFilterProp="label" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

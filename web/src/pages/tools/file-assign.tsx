import { useEffect, useState } from 'react'
import { App, Button, Card, Divider, Form, Input, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import {
  useFileAssignApply, useFileAssignPreview, useFileAssignSchedule,
  useSaveFileAssignSchedule, useUpdateFileAssignSchedule, useRunFileAssignSchedule,
  buildFileAssignSchedulePayload,
} from './hooks'
import { buildTemplate, DEFAULT_TEMPLATE_FORM, type TemplateForm } from '../../components/name-template'
import { NameTemplateEditor } from '../../components/name-template-editor'
import { ScheduleFields } from '../../components/schedule-fields'
import type { FileAssignPreview } from '../../types'

export default function FileAssignPanel() {
  const { message } = App.useApp()
  const preview = useFileAssignPreview()
  const apply = useFileAssignApply()
  const { schedule, isLoading: scheduleLoading } = useFileAssignSchedule()
  const saveSchedule = useSaveFileAssignSchedule()
  const updateSchedule = useUpdateFileAssignSchedule()
  const runSchedule = useRunFileAssignSchedule()

  const [sourceDir, setSourceDir] = useState('')
  const [column, setColumn] = useState('文件地址')
  const [templateForm, setTemplateForm] = useState<TemplateForm>({ ...DEFAULT_TEMPLATE_FORM })
  const [plan, setPlan] = useState<FileAssignPreview | null>(null)
  const [scheduleForm] = Form.useForm()

  // 已有定时计划时回填频率表单（仅以 id 为依赖：计划每 15 秒轮询刷新会换对象引用，避免覆盖编辑中的表单）
  useEffect(() => {
    if (!schedule) return
    scheduleForm.setFieldsValue({
      mode: schedule.mode,
      everyHours: schedule.config.everyHours,
      weekdays: schedule.config.weekdays ?? [],
      days: schedule.config.days ?? [],
      times: (schedule.config.times ?? []).map((t) => dayjs(t, 'HH:mm')),
    })
  }, [schedule?.id])

  const doPreview = () => {
    if (!sourceDir.trim()) {
      message.warning('请先填写源文件夹路径')
      return
    }
    const built = buildTemplate(templateForm)
    if ('error' in built) {
      message.warning(built.error)
      return
    }
    preview.mutate(
      { sourceDir: sourceDir.trim(), column, template: built.template },
      { onSuccess: (data) => setPlan(data) },
    )
  }

  const doApply = () => {
    if (!plan) return
    apply.mutate(
      { sourceDir: sourceDir.trim(), column, plan: plan.plan },
      { onSuccess: () => setPlan(null) },
    )
  }

  /** 校验主表单并组装分配参数（源文件夹/目标列/模板）；失败提示并返回 null */
  const buildAssignConfig = () => {
    if (!sourceDir.trim()) {
      message.warning('请先填写源文件夹路径')
      return null
    }
    const built = buildTemplate(templateForm)
    if ('error' in built) {
      message.warning(built.error)
      return null
    }
    return { sourceDir: sourceDir.trim(), column, template: built.template }
  }

  /** 开关：开=无计划则按默认频率创建（参数固化），有计划则启用；关=停用（保留配置） */
  const toggleSchedule = (checked: boolean) => {
    if (!checked) {
      if (schedule?.id) updateSchedule.mutate({ id: schedule.id, enabled: false })
      return
    }
    const assign = buildAssignConfig()
    if (!assign) return
    if (schedule?.id) {
      updateSchedule.mutate({ id: schedule.id, enabled: true })
    } else {
      const values = scheduleForm.getFieldsValue(true)
      saveSchedule.mutate({
        id: null,
        payload: buildFileAssignSchedulePayload(
          { mode: values.mode ?? 'daily', everyHours: values.everyHours, weekdays: values.weekdays, days: values.days, times: values.times ?? [dayjs('09:00', 'HH:mm')] },
          assign,
        ),
      })
    }
  }

  /** 保存定时配置：校验频率表单与主表单后创建/更新计划 */
  const saveScheduleConfig = async () => {
    const assign = buildAssignConfig()
    if (!assign) return
    let values
    try {
      values = await scheduleForm.validateFields()
    } catch {
      return
    }
    saveSchedule.mutate({
      id: schedule?.id ?? null,
      payload: buildFileAssignSchedulePayload(
        { mode: values.mode, everyHours: values.everyHours, weekdays: values.weekdays, days: values.days, times: values.times },
        assign,
      ),
    })
  }

  return (
    <Card size="small" title="文件随机分配">
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Space wrap size={12}>
          <Typography.Text>源文件夹路径</Typography.Text>
          <Input
            style={{ width: 420 }}
            placeholder="C:\Users\PC\Desktop\空投文件\全部文件"
            value={sourceDir}
            onChange={(e) => {
              setSourceDir(e.target.value)
              setPlan(null)
            }}
          />
          <Button type="primary" loading={preview.isPending} onClick={doPreview}>
            生成预览
          </Button>
          {plan && (
            <Tag color="blue">
              已检测：{plan.filesCount} 个文件 / 账号 {plan.accountsCount} 行
            </Tag>
          )}
        </Space>

        <Space wrap size={12}>
          <Typography.Text>写入目标列</Typography.Text>
          <Select
            style={{ width: 160 }}
            value={column}
            onChange={(v) => {
              setColumn(v)
              setPlan(null)
            }}
            options={[
              { value: '图片地址', label: '图片地址' },
              { value: '文件地址', label: '文件地址' },
            ]}
          />
        </Space>

        <NameTemplateEditor value={templateForm} onChange={setTemplateForm} />

        <div>
          <Button type="primary" danger disabled={!plan} loading={apply.isPending} onClick={doApply}>
            执行分配
          </Button>
          <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
            执行前需先生成并确认预览
          </Typography.Text>
        </div>

        {plan && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Table
              size="small"
              rowKey="rowNumber"
              pagination={false}
              dataSource={plan.plan}
              columns={[
                { title: '窗口', dataIndex: 'window', width: 100 },
                {
                  title: '文件改名',
                  render: (_, r) => (
                    <span>
                      <Typography.Text delete type="secondary">{r.oldName}</Typography.Text>
                      <span style={{ margin: '0 8px', color: '#999' }}>→</span>
                      <Typography.Text style={{ color: '#1677ff' }}>{r.newName}</Typography.Text>
                    </span>
                  ),
                },
                { title: '目标路径', dataIndex: 'newPath', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
              ]}
            />
          </>
        )}

        <Divider style={{ margin: '8px 0' }} />
        <Space wrap size={12}>
          <Typography.Text strong>定时执行</Typography.Text>
          <Switch
            checked={!!schedule?.enabled}
            loading={scheduleLoading || saveSchedule.isPending || updateSchedule.isPending}
            onChange={toggleSchedule}
          />
          <Typography.Text type="secondary">
            到点自动分配一次（不触发任务、不开窗口），失败仅记日志、错过即跳过
          </Typography.Text>
        </Space>

        <Form
          form={scheduleForm}
          layout="vertical"
          initialValues={{ mode: 'daily', everyHours: 6, times: [dayjs('09:00', 'HH:mm')] }}
        >
          <ScheduleFields />
        </Form>

        <Space wrap size={12}>
          <Button type="primary" loading={saveSchedule.isPending} onClick={saveScheduleConfig}>
            保存定时配置
          </Button>
          <Button
            loading={runSchedule.isPending}
            disabled={!schedule || !schedule.enabled}
            onClick={() => schedule && runSchedule.mutate(schedule.id)}
          >
            立即执行一次
          </Button>
          <Typography.Text type="secondary">
            保存时把上方源文件夹/目标列/名称模板固化进计划；改参数后需重新保存才生效
          </Typography.Text>
        </Space>
      </Space>
    </Card>
  )
}

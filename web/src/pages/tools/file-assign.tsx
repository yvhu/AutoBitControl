import { useState } from 'react'
import { App, Button, Card, Divider, Input, Select, Space, Table, Tag, Typography } from 'antd'
import { useFileAssignApply, useFileAssignPreview } from './hooks'
import { buildTemplate, DEFAULT_TEMPLATE_FORM, type TemplateForm } from '../../components/name-template'
import { NameTemplateEditor } from '../../components/name-template-editor'
import type { FileAssignPreview } from '../../types'

export default function FileAssignPanel() {
  const { message } = App.useApp()
  const preview = useFileAssignPreview()
  const apply = useFileAssignApply()

  const [sourceDir, setSourceDir] = useState('')
  const [column, setColumn] = useState('文件地址')
  const [templateForm, setTemplateForm] = useState<TemplateForm>({ ...DEFAULT_TEMPLATE_FORM })
  const [plan, setPlan] = useState<FileAssignPreview | null>(null)

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
      </Space>
    </Card>
  )
}

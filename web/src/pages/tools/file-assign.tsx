import { useState } from 'react'
import { App, Button, Card, Checkbox, Divider, Input, InputNumber, Radio, Select, Space, Table, Tag, Typography } from 'antd'
import { buildTemplate, sampleName, useFileAssignApply, useFileAssignPreview } from './hooks'
import type { EnglishCase, FileAssignPreview, PositionType } from '../../types'

/** 示例文件名（名称模板实时示例用，固定值保证演示稳定） */
const SAMPLE_OLD = '4^orgn23.png'

export default function FileAssignPanel() {
  const { message } = App.useApp()
  const preview = useFileAssignPreview()
  const apply = useFileAssignApply()

  const [sourceDir, setSourceDir] = useState('')
  const [column, setColumn] = useState('文件地址')
  const [english, setEnglish] = useState(true)
  const [englishCount, setEnglishCount] = useState(4)
  const [caseMode, setCaseMode] = useState<EnglishCase>('lower')
  const [digits, setDigits] = useState(true)
  const [digitsCount, setDigitsCount] = useState(3)
  const [special, setSpecial] = useState(true)
  const [specialCount, setSpecialCount] = useState(2)
  const [charset, setCharset] = useState('!@$%^')
  const [position, setPosition] = useState<PositionType>('before')
  const [positionValue, setPositionValue] = useState('')
  const [plan, setPlan] = useState<FileAssignPreview | null>(null)

  const built = buildTemplate({ english, englishCount, caseMode, digits, digitsCount, special, specialCount, charset, position, positionValue })

  const doPreview = () => {
    if (!sourceDir.trim()) {
      message.warning('请先填写源文件夹路径')
      return
    }
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

  const sample = 'error' in built ? built.error : sampleName(SAMPLE_OLD, built.template)

  return (
    <Card size="small" title="文件随机分配">
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Space wrap size={12}>
          <Typography.Text>源文件夹路径</Typography.Text>
          <Input
            style={{ width: 420 }}
            placeholder="C:\Users\PC\Desktop\空投文件\全部文件"
            value={sourceDir}
            onChange={(e) => setSourceDir(e.target.value)}
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
            onChange={setColumn}
            options={[
              { value: '图片地址', label: '图片地址' },
              { value: '文件地址', label: '文件地址' },
            ]}
          />
        </Space>

        <Space wrap size={12}>
          <Typography.Text>名称生成组件</Typography.Text>
          <Checkbox checked={english} onChange={(e) => setEnglish(e.target.checked)}>
            英文(随机)
          </Checkbox>
          <InputNumber min={1} max={20} disabled={!english} value={englishCount} onChange={(v) => setEnglishCount(v ?? 0)} />
          <Select
            style={{ width: 120 }}
            disabled={!english}
            value={caseMode}
            onChange={setCaseMode}
            options={[
              { value: 'lower', label: '小写 a-z' },
              { value: 'upper', label: '大写 A-Z' },
              { value: 'mixed', label: '大小写混合' },
            ]}
          />
          <Checkbox checked={digits} onChange={(e) => setDigits(e.target.checked)}>
            数字(随机)
          </Checkbox>
          <InputNumber min={1} max={20} disabled={!digits} value={digitsCount} onChange={(v) => setDigitsCount(v ?? 0)} />
          <Checkbox checked={special} onChange={(e) => setSpecial(e.target.checked)}>
            特殊字符
          </Checkbox>
          <InputNumber min={1} max={20} disabled={!special} value={specialCount} onChange={(v) => setSpecialCount(v ?? 0)} />
          <Input style={{ width: 110 }} disabled={!special} value={charset} onChange={(e) => setCharset(e.target.value)} placeholder="字符集" />
        </Space>

        <Space wrap size={12}>
          <Typography.Text>插入位置</Typography.Text>
          <Radio.Group value={position} onChange={(e) => setPosition(e.target.value as PositionType)}>
            <Radio.Button value="replace">替换文件名</Radio.Button>
            <Radio.Button value="before">文件名前</Radio.Button>
            <Radio.Button value="after">文件名后</Radio.Button>
            <Radio.Button value="after-position">指定位置后</Radio.Button>
            <Radio.Button value="after-text">指定文本后</Radio.Button>
          </Radio.Group>
          {position === 'after-position' && (
            <InputNumber min={1} value={positionValue ? Number(positionValue) : undefined} onChange={(v) => setPositionValue(String(v ?? ''))} placeholder="位置" />
          )}
          {position === 'after-text' && (
            <Input style={{ width: 110 }} value={positionValue} onChange={(e) => setPositionValue(e.target.value)} placeholder="文本" />
          )}
        </Space>

        <Typography.Text type="secondary">
          示例：<Typography.Text code>{SAMPLE_OLD}</Typography.Text> →{' '}
          <Typography.Text code>{'error' in built ? built.error : sample}</Typography.Text>
          （扩展名始终保留；「指定文本后」未找到文本的行会在预览中报错）
        </Typography.Text>

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

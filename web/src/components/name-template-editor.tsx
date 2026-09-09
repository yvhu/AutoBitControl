/**
 * 名称模板编辑器（components 共享层）：文件随机分配工具页与定时计划弹窗复用
 * 受控组件：value/onChange 传 TemplateForm；内含实时示例预览
 */
import { Checkbox, Input, InputNumber, Radio, Select, Space, Typography } from 'antd'
import { buildTemplate, sampleName, type TemplateForm } from './name-template'
import type { PositionType } from '../types'

/** 示例文件名（实时示例用，固定值保证演示稳定） */
const SAMPLE_OLD = '4^orgn23.png'

export interface NameTemplateEditorProps {
  value: TemplateForm
  onChange: (v: TemplateForm) => void
}

export function NameTemplateEditor({ value, onChange }: NameTemplateEditorProps) {
  const set = (patch: Partial<TemplateForm>) => onChange({ ...value, ...patch })
  const built = buildTemplate(value)
  const sample = 'error' in built ? built.error : sampleName(SAMPLE_OLD, built.template)
  return (
    <Space direction="vertical" size={12} style={{ display: 'flex' }}>
      <Space wrap size={12}>
        <Typography.Text>名称生成组件</Typography.Text>
        <Checkbox checked={value.english} onChange={(e) => set({ english: e.target.checked })}>
          英文(随机)
        </Checkbox>
        <InputNumber min={1} max={20} disabled={!value.english} value={value.englishCount} onChange={(v) => set({ englishCount: v ?? 0 })} />
        <Select
          style={{ width: 120 }}
          disabled={!value.english}
          value={value.caseMode}
          onChange={(v) => set({ caseMode: v })}
          options={[
            { value: 'lower', label: '小写 a-z' },
            { value: 'upper', label: '大写 A-Z' },
            { value: 'mixed', label: '大小写混合' },
          ]}
        />
        <Checkbox checked={value.digits} onChange={(e) => set({ digits: e.target.checked })}>
          数字(随机)
        </Checkbox>
        <InputNumber min={1} max={20} disabled={!value.digits} value={value.digitsCount} onChange={(v) => set({ digitsCount: v ?? 0 })} />
        <Checkbox checked={value.special} onChange={(e) => set({ special: e.target.checked })}>
          特殊字符
        </Checkbox>
        <InputNumber min={1} max={20} disabled={!value.special} value={value.specialCount} onChange={(v) => set({ specialCount: v ?? 0 })} />
        <Input style={{ width: 110 }} disabled={!value.special} value={value.charset} onChange={(e) => set({ charset: e.target.value })} placeholder="字符集" />
      </Space>
      <Space wrap size={12}>
        <Typography.Text>插入位置</Typography.Text>
        <Radio.Group value={value.position} onChange={(e) => set({ position: e.target.value as PositionType })}>
          <Radio.Button value="replace">替换文件名</Radio.Button>
          <Radio.Button value="before">文件名前</Radio.Button>
          <Radio.Button value="after">文件名后</Radio.Button>
          <Radio.Button value="after-position">指定位置后</Radio.Button>
          <Radio.Button value="after-text">指定文本后</Radio.Button>
        </Radio.Group>
        {value.position === 'after-position' && (
          <InputNumber min={1} value={value.positionValue ? Number(value.positionValue) : undefined} onChange={(v) => set({ positionValue: String(v ?? '') })} placeholder="位置" />
        )}
        {value.position === 'after-text' && (
          <Input style={{ width: 110 }} value={value.positionValue} onChange={(e) => set({ positionValue: e.target.value })} placeholder="文本" />
        )}
      </Space>
      <Typography.Text type="secondary">
        示例：<Typography.Text code>{SAMPLE_OLD}</Typography.Text> →{' '}
        <Typography.Text code>{'error' in built ? built.error : sample}</Typography.Text>
        （扩展名始终保留）
      </Typography.Text>
    </Space>
  )
}

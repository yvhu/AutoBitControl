/**
 * 计划频率配置字段（components 共享层）：定时任务弹窗与工具页定时执行区复用
 * 依赖方向：仅依赖 antd/dayjs 与 ../types（不依赖 pages 层）；选项常量供 schedules/hooks 重导出
 * 须置于 Form 内使用；mode 经 Form.useWatch 驱动动态参数
 */
import { Button, Form, InputNumber, Segmented, Select, Space, TimePicker } from 'antd'
import dayjs from 'dayjs'
import type { ScheduleItem } from '../types'

export type ScheduleMode = ScheduleItem['mode']

/** 频率模式选项（Segmented 与摘要徽标共用） */
export const MODE_OPTIONS: Array<{ label: string; value: ScheduleMode }> = [
  { label: '每 N 小时', value: 'interval' },
  { label: '每日', value: 'daily' },
  { label: '每周', value: 'weekly' },
  { label: '每月', value: 'monthly' },
]

/** 模式徽标文案（未知模式回退原文） */
export function modeLabel(mode: ScheduleMode): string {
  return MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode
}

/** 星期选项（1=周一 … 7=周日，与后端一致） */
export const WEEKDAY_OPTIONS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 },
]

/** 几号选项（1–31） */
export const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ label: `${i + 1} 号`, value: i + 1 }))

/** 频率配置字段组：mode 切换显示对应动态参数 */
export function ScheduleFields() {
  const mode = Form.useWatch('mode') ?? 'daily'
  return (
    <>
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
    </>
  )
}

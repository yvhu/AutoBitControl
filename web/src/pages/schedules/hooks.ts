/**
 * 定时任务页数据 hooks 与纯函数（模式选项/星期/几号）
 * 依赖方向：web 页面 → api/endpoints（前端自顶向下），复用 tasks/hooks 的 useTasks 作任务数据源
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchSchedules, createSchedule, updateSchedule, deleteSchedule, runSchedule } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { Dayjs } from 'dayjs'
import type { ScheduleItem, ScheduleConfigInput, FileAssignTemplate } from '../../types'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

export type ScheduleMode = ScheduleItem['mode']

/** 频率模式选项（弹窗 Segmented 与摘要徽标共用；顺序即表单展示顺序） */
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

/** 弹窗表单值（times 为 dayjs 列表，提交时转 'HH:mm' 字符串；everyHours 可 null 与视图类型对齐） */
export interface FormValues {
  name: string
  mode: ScheduleMode
  everyHours?: number | null
  weekdays?: number[]
  days?: number[]
  times?: Dayjs[]
  taskKeys: string[]
  fileAssignEnabled?: boolean
  fileAssignSourceDir?: string
  fileAssignColumn?: string
}

/** 表单值 → 创建/更新请求体；开启自动分配时 config 携带 fileAssign（模板经 buildTemplate 校验后传入） */
export function buildPayload(values: FormValues, template: FileAssignTemplate | null): { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } {
  const base = { name: values.name, taskKeys: values.taskKeys, mode: values.mode }
  const config: ScheduleConfigInput = values.mode === 'interval'
    ? { everyHours: values.everyHours ?? 6 }
    : {
        times: (values.times ?? []).map((t) => t.format('HH:mm')).sort(),
        ...(values.mode === 'weekly' ? { weekdays: values.weekdays ?? [] } : {}),
        ...(values.mode === 'monthly' ? { days: values.days ?? [] } : {}),
      }
  if (values.fileAssignEnabled && template) {
    config.fileAssign = {
      sourceDir: values.fileAssignSourceDir ?? '',
      column: values.fileAssignColumn ?? '文件地址',
      template,
    }
  }
  return { ...base, config }
}

export function useSchedules() {
  return useQuery({
    queryKey: ['schedules'],
    queryFn: fetchSchedules,
    refetchInterval: 15000,
  })
}

export function useCreateSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createSchedule,
    onSuccess: (_res, body) => {
      message.success(`已创建计划「${body.name}」`)
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useUpdateSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<{ name: string; enabled: boolean; mode: ScheduleItem['mode']; config: ScheduleConfigInput; taskKeys: string[] }> }) => updateSchedule(id, body),
    onSuccess: () => {
      message.success('已更新计划')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteSchedule,
    onSuccess: () => {
      message.success('已删除计划')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useRunSchedule() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: runSchedule,
    onSuccess: (res) => {
      if (res.skipped.length > 0) {
        message.warning(`已触发 ${res.taskKeys.length} 个任务，跳过 ${res.skipped.length} 个（在途/停用）`)
      } else {
        message.success(`已触发 ${res.taskKeys.length} 个任务`)
      }
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

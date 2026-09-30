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
import type { TaskMetaView } from '../../types'
import { groupTasks } from '../tasks/hooks'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

import { MODE_OPTIONS, modeLabel, WEEKDAY_OPTIONS, DAY_OPTIONS, type ScheduleMode } from '../../components/schedule-fields'
export { MODE_OPTIONS, modeLabel, WEEKDAY_OPTIONS, DAY_OPTIONS, type ScheduleMode }

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
      if (res.fileAssign?.ran && res.taskKeys.length === 0) {
        if (res.fileAssign.ok) {
          message.success(`文件随机分配已完成：重命名 ${res.fileAssign.renamedCount ?? 0} 个文件`)
        } else {
          message.error(`文件随机分配失败：${res.fileAssign.error ?? '未知错误'}`)
        }
        return
      }
      if (res.skipped.length > 0) {
        message.warning(`已触发 ${res.taskKeys.length} 个任务，跳过 ${res.skipped.length} 个（在途/停用）`)
      } else {
        message.success(`已触发 ${res.taskKeys.length} 个任务`)
      }
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export type TaskSelectOption =
  | { label: string; value: string }
  | { label: string; options: Array<{ label: string; value: string }> }

/** 任务多选选项：有分组时按 optgroup 归类（未分组垫底），全部未分组时返回平铺数组（维持现状行为） */
export function buildTaskOptions(tasks: TaskMetaView[]): TaskSelectOption[] {
  const groups = groupTasks(tasks)
  if (groups.length === 1 && groups[0].key === '') {
    return groups[0].tasks.map((t) => ({ label: t.name, value: t.key }))
  }
  return groups.map((g) => ({
    label: g.name,
    options: g.tasks.map((t) => ({ label: t.name, value: t.key })),
  }))
}

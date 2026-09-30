import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { applyFileAssign, fetchSchedules, fetchTools, createSchedule, updateSchedule, runSchedule, previewFileAssign } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { FileAssignTemplate, FileAssignRow, FileAssignConfigInput, ScheduleItem, ScheduleConfigInput } from '../../types'
import type { ScheduleMode } from '../../components/schedule-fields'
import type { Dayjs } from 'dayjs'

/** 名称模板纯函数与表单类型（components 共享层；此处重导出保持既有引用） */
export { buildTemplate, sampleName, DEFAULT_TEMPLATE_FORM, templateToForm } from '../../components/name-template'
export type { TemplateForm } from '../../components/name-template'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

/** 工具清单（工具中心卡片数据源） */
export function useTools() {
  return useQuery({ queryKey: ['tools'], queryFn: fetchTools })
}

/** 文件随机分配预览 */
export function useFileAssignPreview() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: (body: { sourceDir: string; column: string; template: FileAssignTemplate }) => previewFileAssign(body),
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 文件随机分配执行（成功后失效 settings，让数据源状态刷新） */
export function useFileAssignApply() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { sourceDir: string; column: string; plan: FileAssignRow[] }) => applyFileAssign(body),
    onSuccess: (res) => {
      message.success(`已重命名 ${res.renamedCount} 个文件，写回 ${res.updatedRows} 行，数据源已重载（${res.reloadedRows} 行）`)
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

// ===== 定时执行（纯分配计划） =====

/** 文件随机分配定时计划（taskKeys 为空且 config.fileAssign 存在；约定至多一条，取 id 最小） */
export function useFileAssignSchedule(): { schedule: ScheduleItem | null; isLoading: boolean } {
  const { data, isLoading } = useQuery({ queryKey: ['schedules'], queryFn: fetchSchedules, refetchInterval: 15000 })
  const schedule = (data ?? []).filter((s) => s.taskKeys.length === 0 && !!s.config.fileAssign).sort((a, b) => a.id - b.id)[0] ?? null
  return { schedule, isLoading }
}

/** 定时区频率表单值 → 计划写入参数（纯分配计划 taskKeys 恒为空数组，名称固定） */
export function buildFileAssignSchedulePayload(
  values: { mode: ScheduleMode; everyHours?: number | null; weekdays?: number[]; days?: number[]; times?: Dayjs[] },
  fileAssign: { sourceDir: string; column: string; template: FileAssignTemplate },
): { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } {
  const config: ScheduleConfigInput = values.mode === 'interval'
    ? { everyHours: values.everyHours ?? 6 }
    : { times: (values.times ?? []).map((t) => t.format('HH:mm')).sort() }
  if (values.mode === 'weekly') config.weekdays = values.weekdays ?? []
  if (values.mode === 'monthly') config.days = values.days ?? []
  config.fileAssign = fileAssign as FileAssignConfigInput
  return { name: '文件随机分配（定时）', mode: values.mode, config, taskKeys: [] }
}

/** 保存定时配置：无计划则创建，有计划则整体更新（参数固化进 fileAssign） */
export function useSaveFileAssignSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number | null; payload: { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } }) =>
      input.id === null ? createSchedule(input.payload) : updateSchedule(input.id, input.payload),
    onSuccess: () => {
      message.success('定时分配配置已保存')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 启用/停用定时分配（开关） */
export function useUpdateFileAssignSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => updateSchedule(id, { enabled }),
    onSuccess: (_res, v) => {
      message.success(v.enabled ? '已开启定时分配' : '已关闭定时分配')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 立即执行一次（同步返回本次分配结果） */
export function useRunFileAssignSchedule() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: runSchedule,
    onSuccess: (res) => {
      if (res.fileAssign?.ran) {
        if (res.fileAssign.ok) message.success(`文件随机分配已完成：重命名 ${res.fileAssign.renamedCount ?? 0} 个文件`)
        else message.error(`文件随机分配失败：${res.fileAssign.error ?? '未知错误'}`)
      } else {
        message.warning('该计划未配置自动分配')
      }
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

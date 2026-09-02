import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchTasks, setTaskEnabled, triggerTask } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { TaskMetaView } from '../../types'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

export type TaskCategory = NonNullable<TaskMetaView['category']>

// 分类徽章颜色（与旧版 tasks.js 一致）：checkin 绿/faucet 蓝/mint 金/other 灰
const CATEGORY_COLORS: Record<TaskCategory, string> = {
  checkin: '#34D399',
  faucet: '#38BDF8',
  mint: '#FBBF24',
  other: '#BAC5D9',
}

const CATEGORY_LABELS: Record<TaskCategory, string> = {
  checkin: '签到',
  faucet: '领水',
  mint: '铸币',
  other: '其他',
}

export const DEFAULT_CATEGORY_COLOR = '#BAC5D9'
export const DEFAULT_CATEGORY_LABEL = '其他'

/** 分类徽章颜色：缺省/未知分类回退灰色 */
export function categoryColor(category: TaskMetaView['category']): string {
  return (category && CATEGORY_COLORS[category]) || DEFAULT_CATEGORY_COLOR
}

/** 分类徽章文案：缺省/未知分类回退「其他」 */
export function categoryLabel(category: TaskMetaView['category']): string {
  return (category && CATEGORY_LABELS[category]) || DEFAULT_CATEGORY_LABEL
}

/** 调度描述：字符串 → cron <值>；对象 → cron <a>-<b> 错峰；everyHours → 每 N 小时；null → 手动触发
 * 注：OpenAPI 注解以 object 声明（无法表达 string | object 联合），此处按运行时真实形态收窄 */
export function scheduleText(schedule: string | { [key: string]: unknown } | null): string {
  if (schedule === null) return '手动触发'
  if (typeof schedule === 'string') return `cron ${schedule}`
  const s = schedule as { stagger?: [string, string]; everyHours?: number }
  if (typeof s.everyHours === 'number') return `每 ${s.everyHours} 小时`
  return `cron ${s.stagger?.[0]}-${s.stagger?.[1]} 错峰`
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
    refetchInterval: 5000,
  })
}

export function useSetTaskEnabled() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => setTaskEnabled(key, enabled),
    onSuccess: (_res, { enabled }) => {
      message.success(enabled ? '已启用任务' : '已停用任务')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useTriggerTask() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (key: string) => triggerTask(key),
    onSuccess: () => {
      message.success('已触发')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

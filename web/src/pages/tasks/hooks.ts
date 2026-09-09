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

export interface TaskGroup {
  key: string
  name: string
  tasks: TaskMetaView[]
}

/** 按任务数组顺序派生分组：组顺序 = 组内第一个任务的出现顺序；未分组任务归入末尾伪分组（key 空串、name 未分组） */
export function groupTasks(tasks: TaskMetaView[]): TaskGroup[] {
  const groups: TaskGroup[] = []
  const index = new Map<string, number>()
  for (const t of tasks) {
    const key = t.group?.key ?? ''
    if (!index.has(key)) {
      index.set(key, groups.length)
      groups.push({ key, name: t.group?.name ?? '未分组', tasks: [] })
    }
    groups[index.get(key)!].tasks.push(t)
  }
  const ungrouped = groups.find((g) => g.key === '')
  return ungrouped ? [...groups.filter((g) => g.key !== ''), ungrouped] : groups
}

/** 分组图标配色：已知分组固定色（与面板 mockup 一致），未知分组按出现顺序回退 */
export const GROUP_COLOR_MAP: Record<string, string> = {
  shelby: '#1677FF',
  inception: '#52c41a',
  portal: '#faad14',
  arc: '#722ed1',
  example: '#8c8c8c',
}

const FALLBACK_GROUP_COLORS = ['#13c2c2', '#eb2f96', '#fa541c', '#2f54eb', '#a0d911', '#7cb305']

/** 分组图标底色：已知分组取固定色，未知分组按索引取模轮换回退色 */
export function groupColor(key: string, index: number): string {
  return GROUP_COLOR_MAP[key] ?? FALLBACK_GROUP_COLORS[index % FALLBACK_GROUP_COLORS.length]
}

/** 展开键集合切换：存在则移除，不存在则追加（其余顺序不变） */
export function toggleKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
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

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchBatches, fetchBatchDetail, fetchTasks, triggerTask } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { TaskMetaView } from '../../types'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

export function useBatches(range: string) {
  return useQuery({
    queryKey: ['batches', range],
    queryFn: () => fetchBatches(range),
    refetchInterval: 15000,
  })
}

export function useBatchDetail(id: number | null) {
  return useQuery({
    queryKey: ['batchDetail', id],
    queryFn: () => fetchBatchDetail(id as number),
    enabled: id !== null,
    refetchInterval: id !== null ? 15000 : false,
  })
}

export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, refetchInterval: 5000 })
}

export function useTriggerTask() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, bitbrowserId }: { key: string; bitbrowserId?: string }) => triggerTask(key, bitbrowserId),
    onSuccess: (res) => {
      message.success(res.scope === 'single' ? '已提交执行' : '已提交全部启用窗口执行')
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export type TaskInfoMap = Record<string, { name: string; groupName: string | null }>

/** 任务显示信息映射：key → { name, groupName }；无分组时 groupName 为 null */
export function buildTaskInfo(tasks: TaskMetaView[]): TaskInfoMap {
  const map: TaskInfoMap = {}
  for (const t of tasks) map[t.key] = { name: t.name, groupName: t.group?.name ?? null }
  return map
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchBatches, fetchBatchDetail, fetchRerunCandidates, rerunBatch, fetchTasks, triggerTask, stopBatch, stopRun } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { BatchItem, TaskMetaView } from '../../types'

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

export function useRerunCandidates(batchId: number | null) {
  return useQuery({
    queryKey: ['rerunCandidates', batchId],
    queryFn: () => fetchRerunCandidates(batchId as number),
    enabled: batchId !== null,
    staleTime: 0,
    retry: false,
  })
}

export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, refetchInterval: 5000 })
}

export function useTriggerTask() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, bitbrowserId }: { key: string; bitbrowserId?: string }) => triggerTask(key, { bitbrowserId }),
    onSuccess: (res) => {
      const labels = { single: '已提交执行', selected: '已提交选中窗口执行', all: '已提交全部启用窗口执行' } as const
      message.success(labels[res.scope])
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

/** 批次是否有在途运行（进行中/待执行/重试中任一 > 0） */
export function batchInFlight(b: BatchItem): boolean {
  const s = b.stats
  return s.running + s.pending + s.retryWait > 0
}

export function useStopBatch() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => stopBatch(id),
    onSuccess: (res) => {
      message.success(res.stopped > 0 ? `已停止 ${res.stopped} 个运行` : '无在途运行')
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['batchDetail'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useRerunBatch() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ batchId, runIds }: { batchId: number; runIds: number[] }) => rerunBatch(batchId, runIds),
    onSuccess: (res) => {
      message.success(`已提交 ${res.queued} 个窗口执行`)
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['batchDetail'] })
      queryClient.invalidateQueries({ queryKey: ['rerunCandidates'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useStopRun() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runId: number) => stopRun(runId),
    onSuccess: (res) => {
      message.success(res.stopped ? '已停止' : '该运行已结束')
      queryClient.invalidateQueries({ queryKey: ['batchDetail'] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

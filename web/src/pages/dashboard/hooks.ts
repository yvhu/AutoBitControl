import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchDashboard, fetchTasks, triggerTask, rerunFailed } from '../../api/endpoints'
import { HttpError } from '../../api/client'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

export function useDashboard(date: string) {
  return useQuery({
    queryKey: ['dashboard', date],
    queryFn: () => fetchDashboard(date),
    refetchInterval: 15000,
  })
}

export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: fetchTasks })
}

export function useTriggerTask() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, bitbrowserId }: { key: string; bitbrowserId?: string }) => triggerTask(key, bitbrowserId),
    onSuccess: (res) => {
      message.success(res.scope === 'single' ? '已提交执行' : '已提交全部启用窗口执行')
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useRerunFailed() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (date: string) => rerunFailed(date),
    onSuccess: (res) => {
      message.success(`已重新入队 ${res.count} 条失败记录`)
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
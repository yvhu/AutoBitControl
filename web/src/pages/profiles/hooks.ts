import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import {
  closeProfile,
  fetchProfiles,
  fetchSettings,
  openProfile,
  patchProfile,
  resetBreaker,
  syncProfiles,
} from '../../api/endpoints'
import { HttpError } from '../../api/client'
import { batchProfiles } from '../../api/endpoints'
import type { ProfileBatchAction } from '../../types'
import type { ProfileRow } from '../../types'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

/** 窗口搜索过滤：按名称 / bitbrowserId 包含匹配（大小写不敏感） */
export function filterProfiles(profiles: ProfileRow[], query: string): ProfileRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return profiles
  return profiles.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.bitbrowserId ?? '').toLowerCase().includes(q),
  )
}

/** 窗口表列排序比较器（antd Table sorter，返回负数 a 在前；名称按中文拼音序） */
export const profileSorters = {
  name: (a: ProfileRow, b: ProfileRow) => a.name.localeCompare(b.name, 'zh-CN'),
  breaker: (a: ProfileRow, b: ProfileRow) => a.circuitBreakerCount - b.circuitBreakerCount,
  enabled: (a: ProfileRow, b: ProfileRow) => a.enabled - b.enabled,
}

export function useProfiles() {
  return useQuery({
    queryKey: ['profiles'],
    queryFn: fetchProfiles,
    refetchInterval: 15000,
  })
}

/** 熔断阈值（来自公开设置，与设置页共用 settings 缓存） */
export function useBreakerThreshold() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    select: (s) => s.circuitBreakerThreshold,
  })
}

export function usePatchProfile() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => patchProfile(id, { enabled }),
    onSuccess: (_res, { enabled }) => {
      message.success(enabled ? '已启用窗口' : '已停用窗口')
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useOpenProfile() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => openProfile(id),
    onSuccess: (res) => {
      message.success(res.already ? '窗口已处于打开状态' : '已打开窗口')
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useCloseProfile() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => closeProfile(id),
    onSuccess: () => {
      message.success('已关闭窗口')
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useResetBreaker() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => resetBreaker(id),
    onSuccess: () => {
      message.success('已重置熔断计数')
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useSyncProfiles() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => syncProfiles(),
    onSuccess: (res) => {
      message.success(`已同步 ${res.count} 个窗口`)
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 按选中窗口 id 提取 bitbrowserId（保持入参顺序，忽略不存在项；复制 ID 与批量按钮共用） */
export function joinBitbrowserIds(profiles: ProfileRow[], ids: Array<string | number>): string[] {
  const byId = new Map(profiles.map((p) => [String(p.id), p.bitbrowserId]))
  return ids.map((id) => byId.get(String(id))).filter((v): v is string => v !== undefined)
}

/** 批量窗口操作（打开/关闭/重置熔断）；完成后按汇总弹消息并刷新窗口列表 */
export function useBatchProfiles() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ action, ids }: { action: ProfileBatchAction; ids: number[] }) => batchProfiles(action, ids),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      if (res.failed.length === 0) {
        message.success(`已完成 ${res.succeeded} 个窗口`)
        return
      }
      const sample = res.failed.slice(0, 3).map((f) => `#${f.id}: ${f.error}`).join('；')
      message.warning(`成功 ${res.succeeded}，失败 ${res.failed.length}（${sample}${res.failed.length > 3 ? ' 等' : ''}）`)
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

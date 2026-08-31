import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchBalance, fetchSettings, reloadDatasource, testBitbrowser } from '../../api/endpoints'
import { HttpError } from '../../api/client'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

export type BalanceInfo = { configured: boolean; points: number; yuan: number }

/** 余额展示文案：已配置 → `N 点（¥X）`；未配置 → 未配置 Key（与旧版 settings.js 一致） */
export function formatBalance(b: BalanceInfo): string {
  return b.configured ? `${b.points.toLocaleString()} 点（¥${b.yuan}）` : '未配置 Key'
}

/** 数据源状态文案：可用 → `N 行（列: a, b, c）`；不可用 → 未配置 */
export function datasourceText(ds: { available: boolean; rows: number; columns: string[] }): string {
  return ds.available ? `${ds.rows} 行（列: ${ds.columns.join(', ')}）` : '未配置'
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })
}

export function useReloadDatasource() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => reloadDatasource(),
    onSuccess: (res) => {
      message.success(`数据源已重载（${res.rows} 行）`)
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useTestBitbrowser() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: () => testBitbrowser(),
    onSuccess: (res) => {
      if (res.ok) message.success('比特浏览器已连接')
      else message.warning('比特浏览器连接失败')
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useBalance() {
  return useQuery({
    queryKey: ['balance'],
    queryFn: fetchBalance,
    enabled: false,
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { applyFileAssign, fetchTools, previewFileAssign, fetchClashStatus, testClash, optimizeClash } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { FileAssignTemplate, FileAssignRow, ClashNodeResult } from '../../types'

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

// ===== 代理网络工具 =====

/** 代理网络状态（15 秒轮询：探测/节奏/订阅实时性） */
export function useClashStatus() {
  return useQuery({ queryKey: ['clash-status'], queryFn: fetchClashStatus, refetchInterval: 15000 })
}

/** 节点测速（只测当前节点） */
export function useClashTest() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: () => testClash(),
    onSuccess: (res) => {
      if (!res.node) {
        message.info(res.currentNode ? `当前节点 ${res.currentNode} 不可测（直连或未选择节点）` : '当前无可测节点')
        return
      }
      const detail = res.node.urls.map((u) => (u.reachable ? `${u.delayMs}ms` : '超时')).join(' / ')
      message.success(`当前节点 ${res.node.name}：${detail}`)
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 选优并切换 */
export function useClashOptimize() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => optimizeClash(),
    onSuccess: (res) => {
      message.success(res.switched ? `已切换到 ${res.chosen}` : `未切换${res.switchNote ? `（${res.switchNote}）` : ''}`)
      queryClient.invalidateQueries({ queryKey: ['clash-status'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 节点汇总（纯函数，面板与单测共用）：nodes 需已按得分升序 */
export function summarizeNodes(nodes: ClashNodeResult[]): { usableCount: number; downCount: number; best: ClashNodeResult | null } {
  const usable = nodes.filter((n) => n.usable)
  return { usableCount: usable.length, downCount: nodes.length - usable.length, best: usable[0] ?? null }
}

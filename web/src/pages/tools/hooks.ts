import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { applyFileAssign, fetchTools, previewFileAssign } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { FileAssignTemplate, FileAssignRow } from '../../types'

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

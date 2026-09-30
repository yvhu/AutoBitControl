/**
 * 空投追踪数据层（web 层）：react-query hooks 与变更操作
 * 依赖方向：仅依赖 ../../api 与 ../types，被页面组件引用
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { HttpError } from '../../api/client'
import {
  createAirdropProject, createAirdropStatus, createAirdropTodo, deleteAirdropProject, deleteAirdropStatus, deleteAirdropTodo,
  fetchAirdropProjects, fetchAirdropReminders, fetchAirdropStatuses, fetchTasks, importAirdropProjects, updateAirdropProject, updateAirdropStatus, updateAirdropTodo,
} from '../../api/endpoints'
import type { AirdropImportItem, AirdropPriority, AirdropProjectInput, AirdropProjectPatch, AirdropProjectView } from '../../types'
import { diffTodos, type TodoDraft } from './board'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

/** 全部空投查询失效（任一变更后刷新看板/列/提醒） */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['airdrop-statuses'] })
  qc.invalidateQueries({ queryKey: ['airdrop-projects'] })
  qc.invalidateQueries({ queryKey: ['airdrop-reminders'] })
}

export function useAirdropStatuses() {
  return useQuery({ queryKey: ['airdrop-statuses'], queryFn: fetchAirdropStatuses })
}

export function useAirdropProjects() {
  return useQuery({ queryKey: ['airdrop-projects'], queryFn: fetchAirdropProjects })
}

/** 到期提醒：60 秒轮询（临近/过期提示横幅数据源） */
export function useAirdropReminders() {
  return useQuery({ queryKey: ['airdrop-reminders'], queryFn: fetchAirdropReminders, refetchInterval: 60_000 })
}

/** 项目更新（拖拽流转 statusId 用）：乐观更新 + 失败回滚 */
export function useUpdateProject() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AirdropProjectPatch & { id: number }) => updateAirdropProject(body.id, body),
    onMutate: async ({ id, statusId }) => {
      await qc.cancelQueries({ queryKey: ['airdrop-projects'] })
      const prev = qc.getQueryData<AirdropProjectView[]>(['airdrop-projects'])
      if (prev && statusId !== undefined) {
        qc.setQueryData<AirdropProjectView[]>(['airdrop-projects'], prev.map((p) => (p.id === id ? { ...p, statusId } : p)))
      }
      return { prev }
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['airdrop-projects'], ctx.prev)
      message.error(errMsg(e))
    },
    onSuccess: () => invalidateAll(qc),
  })
}

/** 保存项目（新建/编辑统一：项目字段 + 子项 diff 后增删改） */
export function useSaveProject() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: number | null; values: AirdropProjectInput; todos: TodoDraft[] }) => {
      const { id, values, todos } = input
      const saved = id === null ? await createAirdropProject(values) : await updateAirdropProject(id, values)
      const { toCreate, toUpdate, toDelete } = diffTodos(saved.todos, todos)
      await Promise.all([
        ...toCreate.map((t) => createAirdropTodo(saved.id, { content: t.content, dueDate: t.dueDate, priority: t.priority })),
        ...toUpdate.map((t) => updateAirdropTodo(t.id, { content: t.content, dueDate: t.dueDate, priority: t.priority })),
        ...toDelete.map((t) => deleteAirdropTodo(t)),
      ])
      return saved
    },
    onSuccess: () => { message.success('项目已保存'); invalidateAll(qc) },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteProject() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteAirdropProject(id),
    onSuccess: () => { message.success('项目已删除'); invalidateAll(qc) },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 子项勾选/修改（卡片上直接操作） */
export function useUpdateTodo() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; body: { done?: boolean; content?: string; dueDate?: string | null; priority?: AirdropPriority } }) => updateAirdropTodo(input.id, input.body),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteTodo() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteAirdropTodo(id),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useCreateStatus() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createAirdropStatus(name),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useUpdateStatus() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; body: { name?: string; sortOrder?: number } }) => updateAirdropStatus(input.id, input.body),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteStatus() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteAirdropStatus(id),
    onSuccess: () => invalidateAll(qc),
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 系统任务清单（导入弹窗与编辑弹窗关联下拉的数据源） */
export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, staleTime: 60_000 })
}

/** 从系统任务批量导入为项目（成功提示数量；部分失败列前 3 条原因） */
export function useImportProjects() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ items }: { items: AirdropImportItem[] }) => importAirdropProjects({ items }),
    onSuccess: (res) => {
      message.success(`已导入 ${res.imported} 个项目`)
      if (res.failed.length > 0) {
        message.warning(`导入失败 ${res.failed.length} 项：${res.failed.slice(0, 3).map((f) => `${f.taskKey}（${f.reason}）`).join('、')}`)
      }
      invalidateAll(qc)
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

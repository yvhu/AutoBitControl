import { get, post, patch, del } from './client'
import type { BatchesData, BatchDetailData, TaskMetaView, ProfileRow, SettingsData, DatasourceInfo, ScheduleItem, ScheduleConfigInput, ToolItem, FileAssignTemplate, FileAssignRow, FileAssignPreview, FileAssignApplyResult } from '../types'

export const fetchBatches = (range: string) => get<BatchesData>(`/api/batches?range=${range}`)
export const fetchBatchDetail = (id: number) => get<BatchDetailData>(`/api/batches/${id}`)
export const fetchTasks = () => get<TaskMetaView[]>('/api/tasks')
export const fetchProfiles = () => get<ProfileRow[]>('/api/profiles')
export const triggerTask = (key: string, bitbrowserId?: string) => post<{ scope: string }>(`/api/tasks/${encodeURIComponent(key)}/trigger`, bitbrowserId ? { bitbrowserId } : {})
export const setTaskEnabled = (key: string, enabled: boolean) => patch<{ key: string; enabled: boolean }>(`/api/tasks/${encodeURIComponent(key)}`, { enabled })
export const openProfile = (id: number) => post<{ already: boolean }>(`/api/profiles/${id}/open`, {})
export const closeProfile = (id: number) => post<null>(`/api/profiles/${id}/close`, {})
export const patchProfile = (id: number, body: { enabled?: boolean }) => patch<ProfileRow>(`/api/profiles/${id}`, body)
export const resetBreaker = (id: number) => post<null>(`/api/profiles/${id}/breaker/reset`, {})
export const testBitbrowser = () => post<{ ok: boolean }>('/api/bitbrowser/test', {})
export const syncProfiles = () => post<{ count: number }>('/api/bitbrowser/sync', {})
export const fetchBalance = () => get<{ configured: boolean; points: number; yuan: number }>('/api/captcha/balance')
export const fetchSettings = () => get<SettingsData>('/api/settings')
export const reloadDatasource = () => post<DatasourceInfo>('/api/datasource/reload', {})
export const fetchGuide = () => get<{ content: string }>('/api/docs/guide')
export const fetchExamples = () => get<{ name: string; label: string }[]>('/api/docs/examples')
export const fetchExampleSource = (name: string) => get<{ content: string }>(`/api/docs/examples/${encodeURIComponent(name)}`)

export const fetchSchedules = () => get<ScheduleItem[]>('/api/schedules')
export const createSchedule = (body: { name: string; mode: ScheduleItem['mode']; config: ScheduleConfigInput; taskKeys: string[] }) => post<ScheduleItem>('/api/schedules', body)
export const updateSchedule = (id: number, body: Partial<{ name: string; enabled: boolean; mode: ScheduleItem['mode']; config: ScheduleConfigInput; taskKeys: string[] }>) => patch<ScheduleItem>(`/api/schedules/${id}`, body)
export const deleteSchedule = (id: number) => del<null>(`/api/schedules/${id}`)
export const runSchedule = (id: number) => post<{ taskKeys: string[]; skipped: Array<{ taskKey: string; reason: string }> }>(`/api/schedules/${id}/run`, {})

// ===== 工具中心 =====
export const fetchTools = () => get<{ tools: ToolItem[] }>('/api/tools')
export const previewFileAssign = (body: { sourceDir: string; column: string; template: FileAssignTemplate }) => post<FileAssignPreview>('/api/tools/file-assign/preview', body)
export const applyFileAssign = (body: { sourceDir: string; column: string; plan: FileAssignRow[] }) => post<FileAssignApplyResult>('/api/tools/file-assign/apply', body)

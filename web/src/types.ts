/**
 * 前端常用类型别名：从 openapi-typescript 生成的 schema.d.ts 派生
 * 常用响应均为 envelope 的 data 字段，此处解出并收紧为必填（后端实际始终返回全部字段）
 */
import type { paths } from './api/schema'

// 去除属性可选标记（保留 `T | null` 的可空性）
type DeepRequired<T> = T extends (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T

type EnvelopeData<P extends keyof paths> = DeepRequired<
  NonNullable<
    Extract<paths[P]['get'], { responses: unknown }>['responses'] extends { 200: { content: { 'application/json': { data?: infer D } } } } ? D : never
  >
>

export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'captcha_failed' | 'retry_wait' | 'skipped'

export type ProfileRow = EnvelopeData<'/api/profiles'>[number]

/** 批量窗口操作类型（与后端 /api/profiles/batch 的 action 枚举一致） */
export type ProfileBatchAction = 'open' | 'close' | 'resetBreaker'

/** 批量操作结果（total=总数，succeeded=成功数，failed=逐项失败清单） */
export interface ProfileBatchResult {
  total: number
  succeeded: number
  failed: Array<{ id: number; error: string }>
}

export type BatchItem = EnvelopeData<'/api/batches'>['batches'][number]

export type BatchesData = EnvelopeData<'/api/batches'>

export type BatchDetailData = EnvelopeData<'/api/batches/{id}'>

export type RunRow = EnvelopeData<'/api/batches/{id}'>['runs'][number]

// 任务 meta 视图：与 /api/tasks envelope data 一致（retry 为对象或 null，见 server 注解）
export type TaskMetaView = EnvelopeData<'/api/tasks'>[number]

// 定时计划视图：与 /api/schedules envelope data 一致（config 已解析为对象）
export type ScheduleItem = EnvelopeData<'/api/schedules'>[number]

// 计划时间配置的写入形态（创建/更新接口入参；视图侧 config 因 DeepRequired 各字段必填可空）
export type ScheduleConfigInput = {
  everyHours?: number
  times?: string[]
  weekdays?: number[]
  days?: number[]
  fileAssign?: FileAssignConfigInput
}

/** 计划级自动文件分配配置（与后端 FileAssignConfig 同构） */
export interface FileAssignConfigInput {
  sourceDir: string
  column: string
  template: FileAssignTemplate
}

export type SettingsBase = EnvelopeData<'/api/settings'>

export type DatasourceInfo = EnvelopeData<'/api/settings'>['datasource']

export interface SettingsData extends Omit<SettingsBase, 'datasource'> {
  datasource: DatasourceInfo
}

// ===== 工具中心（手补类型：/api/tools 与 /api/tools/file-assign/*） =====

export type ToolItem = { key: string; name: string; description: string }

export type EnglishCase = 'lower' | 'upper' | 'mixed'

export type PositionType = 'replace' | 'before' | 'after' | 'after-position' | 'after-text'

/** 名称模板（与后端 src/tools/file-assign/types.ts 的 FileAssignTemplate 同构） */
export interface FileAssignTemplate {
  english: { count: number; caseMode: EnglishCase } | null
  digits: { count: number } | null
  special: { count: number; charset: string } | null
  position: { type: PositionType; value?: string | number }
}

export interface FileAssignRow {
  rowNumber: number
  window: string
  oldName: string
  newName: string
  newPath: string
}

export interface FileAssignPreview {
  accountsCount: number
  filesCount: number
  plan: FileAssignRow[]
}

export interface FileAssignApplyResult {
  renamedCount: number
  updatedRows: number
  reloadedRows: number
}

// ===== 空投追踪（手补类型：/api/airdrop/*） =====

export type AirdropPriority = 'high' | 'mid' | 'low'

/** 状态列视图（含列下项目数） */
export interface AirdropStatusItem {
  id: number
  name: string
  sortOrder: number
  createdAt: string
  projectCount: number
}

/** 待办子项（done 为 0/1，SQLite 无布尔） */
export interface AirdropTodoItem {
  id: number
  projectId: number
  content: string
  done: 0 | 1
  dueDate: string | null
  priority: AirdropPriority
  createdAt: string
}

/** 项目视图（含状态列名与子项数组；taskKey=绑定的系统任务，null=纯手动） */
export interface AirdropProjectView {
  id: number
  name: string
  statusId: number
  priority: AirdropPriority
  deadline: string | null
  link: string | null
  note: string | null
  taskKey: string | null
  createdAt: string
  updatedAt: string
  statusName: string
  todos: AirdropTodoItem[]
}

/** 新建项目入参 */
export interface AirdropProjectInput {
  name: string
  statusId: number
  priority?: AirdropPriority
  deadline?: string | null
  link?: string | null
  note?: string | null
  taskKey?: string | null
}

/** 项目部分更新入参（拖拽流转传 statusId；taskKey null=解绑） */
export interface AirdropProjectPatch {
  name?: string
  statusId?: number
  priority?: AirdropPriority
  deadline?: string | null
  link?: string | null
  note?: string | null
  taskKey?: string | null
}

/** 批量导入项 */
export interface AirdropImportItem {
  taskKey: string
  statusId: number
  priority?: AirdropPriority
}

/** 批量导入结果 */
export interface AirdropImportResult {
  imported: number
  failed: Array<{ taskKey: string; reason: string }>
}

/** 单条提醒 */
export interface AirdropReminderItem {
  type: 'project' | 'todo'
  id: number
  name: string
  date: string
  daysLeft: number
}

/** 提醒汇总 */
export interface AirdropReminders {
  upcoming: AirdropReminderItem[]
  overdue: AirdropReminderItem[]
}

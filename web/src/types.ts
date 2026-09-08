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

export type BatchItem = EnvelopeData<'/api/batches'>['batches'][number]

export type BatchesData = EnvelopeData<'/api/batches'>

export type BatchDetailData = EnvelopeData<'/api/batches/{id}'>

export type RunRow = EnvelopeData<'/api/batches/{id}'>['runs'][number]

// 任务 meta 视图：与 /api/tasks envelope data 一致（retry/captcha 均为对象或 null，见 server 注解）
export type TaskMetaView = EnvelopeData<'/api/tasks'>[number]

// 定时计划视图：与 /api/schedules envelope data 一致（config 已解析为对象）
export type ScheduleItem = EnvelopeData<'/api/schedules'>[number]

// 计划时间配置的写入形态（创建/更新接口入参；视图侧 config 因 DeepRequired 各字段必填可空）
export type ScheduleConfigInput = {
  everyHours?: number
  times?: string[]
  weekdays?: number[]
  days?: number[]
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

// ===== 代理网络工具（手补类型：/api/tools/clash/*，与后端 src/tools/clash/types.ts 同构） =====

export interface ClashUrlDelay {
  url: string
  delayMs: number
  reachable: boolean
}

export interface ClashNodeResult {
  name: string
  urls: ClashUrlDelay[]
  score: number
  usable: boolean
}

export interface ClashTestData {
  group: string
  currentNode: string | null
  currentUsable: boolean | null
  nodes: ClashNodeResult[]
}

export interface ClashOptimizeResult {
  chosen: string | null
  switched: boolean
  nodes: ClashNodeResult[]
  switchNote?: string
}

export interface ClashStatusData {
  detected: boolean
  kernel: string | null
  mixedPort: number | null
  apiBase: string
  delaySupported: boolean
  group: string
  currentNode: string | null
  groups: Array<{ name: string; now?: string }>
  auto: { pace: 'normal' | 'fast'; lastCheckAt: string | null; allDown: boolean; deferredSwitches: number }
  anyRunning: boolean
}

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

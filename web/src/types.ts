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

export type DashboardData = EnvelopeData<'/api/dashboard'>

// 任务 meta 视图：与 /api/tasks envelope data 一致（retry/captcha 均为对象或 null，见 server 注解）
export type TaskMetaView = EnvelopeData<'/api/tasks'>[number]

export type SettingsBase = EnvelopeData<'/api/settings'>

export type DatasourceInfo = EnvelopeData<'/api/settings'>['datasource']

export interface SettingsData extends Omit<SettingsBase, 'datasource'> {
  datasource: DatasourceInfo
}

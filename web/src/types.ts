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

export type RunRow = EnvelopeData<'/api/dashboard'>['runs'][number]

export type DashboardData = EnvelopeData<'/api/dashboard'>

// 任务 meta 的 schedule/retry/captcha 在 OpenAPI 里被简化成了标量（后端 spec 注释偏差），
// 此处按后端实际返回的对象结构声明
export interface TaskMetaView {
  key: string
  name: string
  url: string
  sourceUrl: string | null
  note: string | null
  category: 'checkin' | 'faucet' | 'mint' | 'other' | null
  lastUpdated: string | null
  deprecated: boolean
  enabled: boolean
  wallet: string | null
  schedule: string | { stagger: [string, string] } | null
  timeoutSec: number | null
  retry: { max: number; backoffSec: number } | null
  captcha: { auto?: boolean; maxCost?: number } | null
}

export type SettingsBase = EnvelopeData<'/api/settings'>

export type DatasourceInfo = EnvelopeData<'/api/settings'>['datasource']

export interface SettingsData extends Omit<SettingsBase, 'datasource'> {
  datasource: DatasourceInfo
}

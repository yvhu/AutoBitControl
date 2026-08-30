export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'captcha_failed' | 'retry_wait' | 'skipped'

export interface ProfileRow {
  id: number
  bitbrowserId: string
  name: string
  enabled: number
  circuitBreakerCount: number
}

export interface RunRow {
  id: number
  profileId: number
  taskKey: string
  date: string
  status: RunStatus
  attempts: number
  error: string | null
  screenshot: string | null
  startedAt: string | null
  finishedAt: string | null
  profileName: string
}

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

export interface DashboardData {
  date: string
  stats: { total: number; success: number; failed: number; captchaFailed: number; skipped: number; running: number; pending: number }
  runs: RunRow[]
  profiles: ProfileRow[]
  captcha: { count: number; totalCost: number }
  profilesTotal: number
  profilesEnabled: number
}

export interface PublicSettings {
  bitbrowserApiBase: string
  webPort: number
  timezone: string
  concurrency: number
  circuitBreakerThreshold: number
  probeUrl: string
  version: string
}

export interface DatasourceInfo {
  available: boolean
  error: string
  path: string
  rows: number
  columns: string[]
}

export interface SettingsData extends PublicSettings {
  datasource: DatasourceInfo
}

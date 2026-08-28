export interface TaskMeta {
  key: string
  name: string
  url: string
  sourceUrl?: string
  note?: string
  category?: 'checkin' | 'faucet' | 'mint' | 'other'
  lastUpdated?: string
  deprecated?: boolean
  schedule?: string | { stagger: [string, string] }
  wallet?: string
  timeoutSec?: number
  retry?: { max: number; backoffSec: number }
  captcha?: { auto?: boolean; maxCost?: number }
}

export interface TaskRef {
  meta: TaskMeta
}

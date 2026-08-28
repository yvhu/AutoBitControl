import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

export interface BitBrowserConfig {
  apiBase: string
  openTimeoutMs: number
  maxRetries: number
  retryBackoffMs: number[]
}

export interface ExecutionConfig {
  concurrency: number
  windowTimeoutMs: number
  taskTimeoutMs: number
  retryMax: number
  retryBackoffSec: number
  circuitBreakerThreshold: number
  probeUrl: string
  timezone: string
}

export interface CaptchaConfig {
  apiBase: string
  clientKey: string
  solveTimeoutMs: number
  pollIntervalMs: number
  maxCostPerTask: number
  taskTypes: Record<string, string>
}

export interface WebConfig {
  host: string
  port: number
}

export interface StorageConfig {
  dbPath: string
  screenshotDir: string
  logDir: string
  logLevel: string
}

export interface AppConfig {
  bitbrowser: BitBrowserConfig
  execution: ExecutionConfig
  captcha: CaptchaConfig
  web: WebConfig
  storage: StorageConfig
}

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const defaults: AppConfig = {
  bitbrowser: {
    apiBase: 'http://127.0.0.1:54345',
    openTimeoutMs: 30000,
    maxRetries: 3,
    retryBackoffMs: [5000, 30000, 120000],
  },
  execution: {
    concurrency: 6,
    windowTimeoutMs: 900000,
    taskTimeoutMs: 180000,
    retryMax: 2,
    retryBackoffSec: 600,
    circuitBreakerThreshold: 2,
    probeUrl: 'https://api.ipify.org',
    timezone: 'Asia/Shanghai',
  },
  captcha: {
    apiBase: 'https://api.yescaptcha.com',
    clientKey: '',
    solveTimeoutMs: 120000,
    pollIntervalMs: 3000,
    maxCostPerTask: 1500,
    taskTypes: {
      turnstile: 'TurnstileTaskProxyless',
      recaptcha_v2: 'NoCaptchaTaskProxyless',
      recaptcha_v3: 'RecaptchaV3TaskProxyless',
      hcaptcha: 'HCaptchaTaskProxyless',
      image: 'ImageToTextTask',
    },
  },
  web: { host: '127.0.0.1', port: 3000 },
  storage: {
    dbPath: join(DEFAULT_ROOT, 'data', 'app.db'),
    screenshotDir: join(DEFAULT_ROOT, 'data', 'screenshots'),
    logDir: join(DEFAULT_ROOT, 'data', 'logs'),
    logLevel: 'info',
  },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T
  }
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

export interface LoadConfigOptions {
  rootDir?: string
  env?: Record<string, string>
}

export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const root = opts.rootDir ?? DEFAULT_ROOT
  const env = opts.env ?? process.env
  loadDotenv({ path: join(root, 'config', '.env'), quiet: true })
  let cfg = structuredClone(defaults)
  const base = join(root, 'config', 'config.json')
  if (existsSync(base)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(base, 'utf-8')))
  }
  const local = join(root, 'config', 'config.local.json')
  if (existsSync(local)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(local, 'utf-8')))
  }
  if (env.CAPTCHA_CLIENT_KEY) cfg.captcha.clientKey = env.CAPTCHA_CLIENT_KEY
  if (env.BITBROWSER_API_BASE) cfg.bitbrowser.apiBase = env.BITBROWSER_API_BASE
  if (env.WEB_PORT) cfg.web.port = Number(env.WEB_PORT)
  return cfg
}

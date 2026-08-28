/**
 * 配置层（infrastructure）：加载并合并应用配置，是全应用唯一的配置入口
 * 依赖方向：仅依赖 node 内置模块与 dotenv，被上层各模块依赖
 * 合并顺序：代码默认值 → config/config.json → config/config.local.json → 环境变量覆盖
 * 设计思路：deepMerge 递归合并使本地配置只需写差异项；存储路径最后统一解析为项目根的绝对路径
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

/** 比特浏览器本地 API 配置 */
export interface BitBrowserConfig {
  /** 本地 API 地址（比特浏览器客户端监听 127.0.0.1:54345） */
  apiBase: string
  /** 单次开窗请求超时（毫秒） */
  openTimeoutMs: number
  /** 开窗失败最大重试次数 */
  maxRetries: number
  /** 开窗重试退避数列（与 maxRetries 长度对应） */
  retryBackoffMs: number[]
}

/** 执行引擎配置：并发、超时、重试与熔断的全局默认值（任务级可覆盖部分字段） */
export interface ExecutionConfig {
  concurrency: number
  windowTimeoutMs: number
  taskTimeoutMs: number
  retryMax: number
  retryBackoffSec: number
  circuitBreakerThreshold: number
  probeUrl: string
  timezone: string
  /** 拟人化交互延迟区间（点击前犹豫的随机停顿范围） */
  humanize: { minDelayMs: number; maxDelayMs: number }
}

/** 验证码打码服务配置 */
export interface CaptchaConfig {
  apiBase: string
  clientKey: string
  solveTimeoutMs: number
  pollIntervalMs: number
  maxCostPerTask: number
  taskTypes: Record<string, string>
}

/** Web 面板监听配置 */
export interface WebConfig {
  host: string
  port: number
}

/** 存储路径与日志级别配置（相对路径在 loadConfig 中解析为绝对路径） */
export interface StorageConfig {
  dbPath: string
  screenshotDir: string
  logDir: string
  logLevel: string
}

/** 钱包配置：窗口解锁密码映射（key 为比特窗口 ID，值环境变量 WALLET_PASSWORDS 优先） */
export interface WalletConfig {
  passwords: Record<string, string>
}

/** 全应用配置聚合 */
export interface AppConfig {
  bitbrowser: BitBrowserConfig
  execution: ExecutionConfig
  captcha: CaptchaConfig
  web: WebConfig
  storage: StorageConfig
  wallet: WalletConfig
}

// 项目根目录（src 上两级），用于解析数据目录与读取 config/ 下的配置
const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const defaults: AppConfig = {
  bitbrowser: {
    apiBase: 'http://127.0.0.1:54345',
    openTimeoutMs: 30000,
    maxRetries: 3,
    // 退避数列 5s/30s/120s：第一次快速重试瞬时抖动，第二次给本地服务恢复时间，第三次长等待留人工介入余地
    retryBackoffMs: [5000, 30000, 120000],
  },
  execution: {
    // 窗口级并发上限：p-queue 同时最多开 6 个窗口会话（比特浏览器 API 压力与单机负载的折中）
    concurrency: 6,
    // 单窗口会话超时 15 分钟（开窗+探活+全部任务），防止异常卡死占用并发槽位
    windowTimeoutMs: 900000,
    // 单任务默认超时 3 分钟（任务 meta.timeoutSec 可覆盖）
    taskTimeoutMs: 180000,
    retryMax: 2,
    // 失败重试退避 10 分钟：给站点限流窗口留出冷却时间
    retryBackoffSec: 600,
    // 连续失败该次数后本窗口当日熔断（后续任务直接 skipped）
    circuitBreakerThreshold: 2,
    // 开窗后的 IP 探活地址：校验代理 IP 已生效才跑任务，避免用错误 IP 触发风控
    probeUrl: 'https://api.ipify.org',
    // croner 解析调度时间的时区
    timezone: 'Asia/Shanghai',
    // 拟人点击前犹豫的随机停顿区间：太短像脚本，太长拖慢整体节奏
    humanize: { minDelayMs: 800, maxDelayMs: 3000 },
  },
  captcha: {
    apiBase: 'https://api.yescaptcha.com',
    clientKey: '',
    // 平台约束：识别 120 秒超时、结果 120 秒内有效
    solveTimeoutMs: 120000,
    // 轮询解题结果的间隔（太频繁会触发平台限流，太慢则拉长任务耗时）
    pollIntervalMs: 3000,
    // 单任务打码费用上限（点，1000 点 = ¥1）
    maxCostPerTask: 1500,
    // 平台任务类型精确拼写（按 yescaptcha 官方文档，改错会导致创建任务失败）
    taskTypes: {
      turnstile: 'TurnstileTaskProxyless',
      recaptcha_v2: 'NoCaptchaTaskProxyless',
      recaptcha_v3: 'RecaptchaV3TaskProxyless',
      hcaptcha: 'HCaptchaTaskProxyless',
      image: 'ImageToTextTask',
    },
  },
  // 仅监听本机：面板不对外网暴露
  web: { host: '127.0.0.1', port: 3000 },
  storage: {
    dbPath: join(DEFAULT_ROOT, 'data', 'app.db'),
    screenshotDir: join(DEFAULT_ROOT, 'data', 'screenshots'),
    logDir: join(DEFAULT_ROOT, 'data', 'logs'),
    logLevel: 'info',
  },
  // 钱包解锁密码不落默认值：由 config.json/config.local.json 的 wallet.passwords 或环境变量提供
  wallet: { passwords: {} },
}

/** 判定普通对象（非数组/非 null），作为递归合并的终止条件 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 递归深合并：override 可缺省任意层级，未提供的键保留 base 值
 * @param base 基准对象（默认配置）
 * @param override 覆盖对象（用户配置文件内容）
 * @returns 合并结果
 */
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
  /** 项目根目录（测试可传入临时目录隔离 config 与 data） */
  rootDir?: string
  /** 环境变量表（测试可注入，默认 process.env） */
  env?: Record<string, string>
}

/**
 * 加载最终配置：默认值 ← config.json ← config.local.json ← 环境变量，逐层覆盖
 * @param opts.rootDir 项目根目录，缺省为 src 上两级
 * @param opts.env 环境变量来源，缺省为 process.env
 * @returns 合并后的完整配置（存储路径已解析为绝对路径）
 */
export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const root = opts.rootDir ?? DEFAULT_ROOT
  const env = opts.env ?? process.env
  // 加载 config/.env（失败静默：.env 只是可选的密钥来源）
  loadDotenv({ path: join(root, 'config', '.env'), quiet: true })
  let cfg = structuredClone(defaults)
  // 用户配置文件缺失时不报错：直接用默认值运行
  const base = join(root, 'config', 'config.json')
  if (existsSync(base)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(base, 'utf-8')))
  }
  // local 覆盖 base：本地密钥/路径不进版本库
  const local = join(root, 'config', 'config.local.json')
  if (existsSync(local)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(local, 'utf-8')))
  }
  // 环境变量优先级最高：部署环境可注入密钥而不落盘
  if (env.CAPTCHA_CLIENT_KEY) cfg.captcha.clientKey = env.CAPTCHA_CLIENT_KEY
  if (env.BITBROWSER_API_BASE) cfg.bitbrowser.apiBase = env.BITBROWSER_API_BASE
  // WEB_PORT 非法值（NaN/非正数）静默忽略并保留默认端口（config 层无 logger，不做告警）
  if (env.WEB_PORT) {
    const port = Number(env.WEB_PORT)
    if (Number.isFinite(port) && port > 0) cfg.web.port = port
  }
  // 钱包密码：WALLET_PASSWORDS 为 JSON 映射字符串（{"窗口ID":"密码"}），解析成功时与配置文件值合并（env 覆盖同名 key）
  // 解析失败静默忽略并保留配置值（config 层无 logger，直接忽略非法 JSON）
  if (env.WALLET_PASSWORDS) {
    try {
      const parsed = JSON.parse(env.WALLET_PASSWORDS)
      if (isPlainObject(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') cfg.wallet.passwords[k] = v
        }
      }
    } catch {
      // 非法 JSON：忽略 env 值，保留配置文件中的密码
    }
  }
  // 存储路径统一解析为绝对路径，避免工作目录变化导致数据散落
  for (const key of ['dbPath', 'screenshotDir', 'logDir'] as const) {
    const p = cfg.storage[key]
    if (!isAbsolute(p)) cfg.storage[key] = resolve(root, p)
  }
  return cfg
}

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

/** 窗口池配置（Phase 2 启用；默认关闭，不改动现有调度行为）：按内存水位与任务数复用窗口会话 */
export interface WindowPoolConfig {
  /** 窗口池总开关（默认 false：窗口池调度未启用；Phase 1 的开/关窗串行与开窗冷却已生效） */
  enabled: boolean
  /** Phase 2 窗口池允许同时打开的窗口数上限（旧 maxConcurrentWindows 保留到 Phase 3 移除） */
  maxOpenWindows: number
  /** 系统内存保留余量（MB）：可用内存需高于该值才继续开窗 */
  memoryReserveMb: number
  /** 单窗口预估内存占用（MB）：用于预估剩余可开窗数 */
  perWindowMb: number
  /** 可用内存临界水位（MB）：低于该值不再开新窗口 */
  criticalFreeMb: number
  /** 可用内存恢复水位（MB）：低于临界值后可开窗时需回升到该值才恢复 */
  resumeFreeMb: number
  /** 内存与健康检查间隔（毫秒） */
  checkIntervalMs: number
  /** 两次开窗之间的冷却时长（毫秒） */
  openCooldownMs: number
  /** 空闲窗口关闭阈值（秒）：无任务窗口空闲超过该时长即关闭复用 */
  idleCloseSec: number
  /** 单窗口最多连续执行的任务数（达到后换窗，规避长会话内存膨胀） */
  windowMaxTasks: number
  /** 单窗口最长存活时长（秒）：超时后换窗 */
  windowMaxLifetimeSec: number
  /** 单窗口连续占用公平轮转上限（秒）：同一窗口连续占用超过该时长后有其它窗口排队则先轮转 */
  cohortMaxSec: number
}

/** 全局健康检查配置（Phase 2 启用；默认值即当前行为） */
export interface HealthConfig {
  /** 比特浏览器可用性探测间隔（毫秒） */
  bitbrowserProbeMs: number
  /** 全局环境级失败统计窗口（秒）：该窗口内累计失败达到阈值即判全局异常 */
  globalEnvFailureWindowSec: number
  /** 全局环境级失败阈值（次）：窗口内达到该次数后暂停开新窗 */
  globalEnvFailureThreshold: number
  /** 是否启用比特浏览器可用性探测（默认 true） */
  probeEnabled: boolean
  /** 全局异常退避数列（秒）：按失败级别递增取用 */
  backoffSec: number[]
}

/** 执行引擎配置：超时、重试与熔断的全局默认值（任务级可覆盖部分字段；并发为任务级 meta.concurrency + 全局窗口上限 maxConcurrentWindows 双闸门） */
export interface ExecutionConfig {
  windowTimeoutMs: number
  taskTimeoutMs: number
  retryMax: number
  retryBackoffSec: number
  circuitBreakerThreshold: number
  /** 熔断总开关（默认 true）：false 时窗口失败不计入熔断、不做健康门禁 */
  circuitBreakerEnabled: boolean
  /** 首次冷却时长（秒，默认 1800）：熔断后等待该时长再放行探测 */
  circuitBreakerCooldownSec: number
  /** 冷却上限（秒，默认 7200）：连续失败时冷却按级别递增，不超过该值 */
  circuitBreakerMaxCooldownSec: number
  /** 熔断每日重置时刻（本地 HH:mm，默认 23:59）：到点自动归零所有窗口的熔断计数；空字符串关闭自动重置 */
  circuitBreakerResetAt: string
  /** 全局窗口上限：同时最多开几个窗口会话（机器资源容度；与任务级 concurrency 双闸门取更严者） */
  maxConcurrentWindows: number
  /** 窗口池配置（Phase 2 使用；enabled=false 时不影响现有调度） */
  windowPool: WindowPoolConfig
  /** 全局健康检查配置（Phase 2 使用） */
  health: HealthConfig
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
  /** 终端日志颜色：true/false 强制开关，缺省按终端能力自动检测（Git Bash/WT 有色，老式 PowerShell 无色） */
  prettyColorize?: boolean
  /** 日志文件保留天数（按天滚动的历史文件保留 N 天，默认 7） */
  logRetainDays?: number
  /** 数据库历史数据保留天数（runs/batches 超期行启动时清理，默认 90） */
  dbRetainDays: number
  /** 截图目录按日期保留天数（默认 90；启动时删除早于截止日的日期目录） */
  screenshotRetainDays: number
}

/** 钱包配置：解锁密码映射（key 为钱包类型，如 metamask/petra，值环境变量 WALLET_PASSWORDS 优先） */
export interface WalletConfig {
  passwords: Record<string, string>
  /** WALLET_PASSWORDS 存在但解析失败时为 true（启动时告警提示检查 JSON 格式） */
  parseError?: boolean
}

/** 数据源配置：每个窗口按行领取账号/素材的 Excel 表格路径（相对路径在 loadConfig 中解析为绝对路径） */
export interface DataSourceConfig {
  path: string
}

/** 定时任务调度配置 */
export interface SchedulerConfig {
  /** 固定时区（IANA 名称）：面板显示与到点判断统一按此时区的墙上时钟 */
  timezone: string
}

/** AI 能力配置：OpenAI 兼容接口（默认 DeepSeek），供 AI 答题等能力调用 */
export interface AiConfig {
  /** provider 标识（当前仅 OpenAI 兼容） */
  provider: string
  /** OpenAI 兼容 API 根地址（如 https://api.deepseek.com） */
  apiBase: string
  /** 模型 id（如 deepseek-flash） */
  model: string
  /** API Key（来自 AI_API_KEY，仅本机 .env） */
  apiKey: string
  /** 请求超时毫秒 */
  timeoutMs: number
}

/** 全应用配置聚合 */
export interface AppConfig {
  bitbrowser: BitBrowserConfig
  execution: ExecutionConfig
  web: WebConfig
  storage: StorageConfig
  wallet: WalletConfig
  dataSource: DataSourceConfig
  scheduler: SchedulerConfig
  ai: AiConfig
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
    // 单窗口会话超时 15 分钟（开窗+全部任务），防止异常卡死占用并发槽位
    windowTimeoutMs: 900000,
    // 单任务默认超时 3 分钟（任务 meta.timeoutSec 可覆盖）
    taskTimeoutMs: 180000,
    retryMax: 2,
    // 失败重试退避 10 分钟：给站点限流窗口留出冷却时间
    retryBackoffSec: 600,
    // 连续失败该次数后本窗口进入熔断（后续任务按冷却时间放行探测）
    circuitBreakerThreshold: 2,
    // 熔断总开关：false 时不做健康门禁、不累计失败
    circuitBreakerEnabled: true,
    // 首次冷却 30 分钟：给站点限流/临时故障留恢复时间
    circuitBreakerCooldownSec: 1800,
    // 冷却上限 2 小时：连续失败时按级别递增，避免无限拉长
    circuitBreakerMaxCooldownSec: 7200,
    // 熔断每日重置时刻（本地墙钟 HH:mm）：到点归零所有窗口健康状态；"" 关闭自动重置
    circuitBreakerResetAt: '23:59',
    // 全局窗口上限：所有任务共享的同时开窗总数封顶（默认 4；与任务级 meta.concurrency 双闸门取更严者）
    maxConcurrentWindows: 4,
    // 窗口池：Phase 2 启用（默认关闭，保持现有调度行为）
    windowPool: {
      enabled: false,
      maxOpenWindows: 4,
      // 系统保留 100MB 余量，低于临界水位 1GB 停止开窗，回升到 2GB 才恢复
      memoryReserveMb: 100,
      perWindowMb: 1024,
      criticalFreeMb: 1024,
      resumeFreeMb: 2048,
      checkIntervalMs: 5000,
      openCooldownMs: 10000,
      // 空闲 3 分钟关闭；单窗最多 3 个任务 / 10 分钟；单窗口连续占用 30 分钟后轮转
      idleCloseSec: 180,
      windowMaxTasks: 3,
      windowMaxLifetimeSec: 600,
      cohortMaxSec: 1800,
    },
    // 全局健康：每 30 秒探测比特浏览器；5 分钟内累计 3 次环境级失败即判全局异常，退避 30s 起阶梯到 10 分钟
    health: {
      bitbrowserProbeMs: 30000,
      globalEnvFailureWindowSec: 300,
      globalEnvFailureThreshold: 3,
      probeEnabled: true,
      backoffSec: [30, 60, 120, 300, 600],
    },
  },
  // 仅监听本机：面板不对外网暴露
  web: { host: '127.0.0.1', port: 3000 },
  storage: {
    dbPath: join(DEFAULT_ROOT, 'data', 'app.db'),
    screenshotDir: join(DEFAULT_ROOT, 'data', 'screenshots'),
    logDir: join(DEFAULT_ROOT, 'data', 'logs'),
    logLevel: 'info',
    // 历史日志文件保留 7 天，到期由 log4js 自动清理
    logRetainDays: 7,
    // 数据库历史数据保留 90 天，超期行启动时清理（runs/batches）
    dbRetainDays: 90,
    // 截图目录按日期保留 90 天，早于截止日的日期目录启动时删除（grid-debug 等非日期目录不动）
    screenshotRetainDays: 90,
  },
  // 钱包解锁密码不落默认值：由 config.json/config.local.json 的 wallet.passwords 或环境变量提供（key 为钱包类型，如 metamask/petra，同类型钱包共用同一密码）
  wallet: { passwords: {} },
  // 账号数据源：默认 config/accounts.xlsx（文件不存在时仅告警，任务用 faker 兜底）
  dataSource: { path: join(DEFAULT_ROOT, 'config', 'accounts.xlsx') },
  // 定时任务固定时区：配置与展示统一按此时区（Asia/Shanghai 无 DST，一般无需改动）
  scheduler: { timezone: 'Asia/Shanghai' },
  // AI 能力：默认走 OpenAI 兼容接口（DeepSeek），apiKey 不落默认值，由 AI_API_KEY/.env 提供
  ai: {
    provider: 'openai-compatible',
    apiBase: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: '',
    timeoutMs: 30000,
  },
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
  /** 告警收集器（可选）：校验修正/废弃配置项时 push 中文告警，由调用方（app）统一输出 */
  warnings?: string[]
}

/**
 * 加载最终配置：默认值 ← config.json ← config.local.json ← 环境变量，逐层覆盖
 * @param opts.rootDir 项目根目录，缺省为 src 上两级
 * @param opts.env 环境变量来源，缺省为 process.env
 * @param opts.warnings 可选告警收集数组（非法值回退、越界截断、废弃项）
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
  if (env.BITBROWSER_API_BASE) cfg.bitbrowser.apiBase = env.BITBROWSER_API_BASE
  // WEB_PORT 非法值（NaN/小数/越界）静默忽略并保留默认端口（config 层无 logger，不做告警）
  if (env.WEB_PORT) {
    const port = Number(env.WEB_PORT)
    if (Number.isInteger(port) && port > 0 && port < 65536) cfg.web.port = port
  }
  // 钱包密码：WALLET_PASSWORDS 为 JSON 映射字符串（{"metamask":"密码"}，key 为钱包类型），解析成功时与配置文件值合并（env 覆盖同名 key）
  // 解析失败不抛错，保留配置值并置 parseError 标记（app 启动时告警提示检查 JSON 格式）
  if (env.WALLET_PASSWORDS) {
    try {
      const parsed = JSON.parse(env.WALLET_PASSWORDS)
      cfg.wallet.parseError = false
      if (isPlainObject(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') cfg.wallet.passwords[k] = v
        }
      }
    } catch {
      // 非法 JSON：忽略 env 值，保留配置文件中的密码，启动时告警
      cfg.wallet.parseError = true
    }
  }
  // AI 能力密钥与模型：AI_API_KEY/AI_API_BASE/AI_MODEL 优先级高于配置文件（密钥只走本机 .env）
  if (env.AI_API_KEY) cfg.ai.apiKey = env.AI_API_KEY
  if (env.AI_API_BASE) cfg.ai.apiBase = env.AI_API_BASE
  if (env.AI_MODEL) cfg.ai.model = env.AI_MODEL
  // 熔断每日重置时刻：CIRCUIT_BREAKER_RESET_AT 优先级高于配置文件（空串可显式关闭自动重置，与配置文件 "" 语义一致）
  if (env.CIRCUIT_BREAKER_RESET_AT !== undefined) cfg.execution.circuitBreakerResetAt = env.CIRCUIT_BREAKER_RESET_AT
  // 熔断参数校验：非法值回落默认，冷却上限不得小于首次冷却（配置层无 logger，告警交由调用方输出）
  const cb = cfg.execution
  const warnings = opts.warnings
  if (typeof cb.circuitBreakerEnabled !== 'boolean') cb.circuitBreakerEnabled = true
  if (!Number.isInteger(cb.circuitBreakerThreshold) || cb.circuitBreakerThreshold < 1) cb.circuitBreakerThreshold = 2
  if (!Number.isFinite(cb.circuitBreakerCooldownSec) || cb.circuitBreakerCooldownSec < 60) cb.circuitBreakerCooldownSec = 1800
  if (!Number.isFinite(cb.circuitBreakerMaxCooldownSec) || cb.circuitBreakerMaxCooldownSec < cb.circuitBreakerCooldownSec) {
    cb.circuitBreakerMaxCooldownSec = Math.max(cb.circuitBreakerCooldownSec, 7200)
  }
  // 全局窗口上限：必须是正整数（负数/0/小数/非数字 → 回退 4 并告警），避免并发闸门失效
  if (!Number.isInteger(cb.maxConcurrentWindows) || cb.maxConcurrentWindows < 1) {
    warnings?.push(`execution.maxConcurrentWindows=${String(cb.maxConcurrentWindows)} 非法（必须为正整数），已回退默认 4`)
    cb.maxConcurrentWindows = 4
  }
  // 窗口池参数校验：非法值逐项回落默认并告警（Phase 2 才消费，此处只保证配置始终合法）
  // 段级校验：配置写成 null/数字等非对象时整体回退默认，避免后续读字段直接抛 TypeError
  if (!isPlainObject(cfg.execution.windowPool)) {
    warnings?.push(`execution.windowPool=${JSON.stringify(cfg.execution.windowPool)} 非法（必须为对象），已回退默认配置`)
    cfg.execution.windowPool = structuredClone(defaults.execution.windowPool)
  }
  const pool = cfg.execution.windowPool
  if (typeof pool.enabled !== 'boolean') {
    warnings?.push(`execution.windowPool.enabled=${String(pool.enabled)} 非法（必须为布尔值），已回退默认 false`)
    pool.enabled = false
  }
  if (!Number.isInteger(pool.maxOpenWindows) || pool.maxOpenWindows < 1) {
    warnings?.push(`execution.windowPool.maxOpenWindows=${String(pool.maxOpenWindows)} 非法（必须为正整数），已回退默认 4`)
    pool.maxOpenWindows = 4
  }
  if (!Number.isFinite(pool.memoryReserveMb) || pool.memoryReserveMb < 0) {
    warnings?.push(`execution.windowPool.memoryReserveMb=${String(pool.memoryReserveMb)} 非法（必须 >= 0），已回退默认 100`)
    pool.memoryReserveMb = 100
  }
  if (!Number.isFinite(pool.perWindowMb) || pool.perWindowMb < 128) {
    warnings?.push(`execution.windowPool.perWindowMb=${String(pool.perWindowMb)} 非法（必须 >= 128），已回退默认 1024`)
    pool.perWindowMb = 1024
  }
  if (!Number.isFinite(pool.resumeFreeMb) || pool.resumeFreeMb < 0) {
    warnings?.push(`execution.windowPool.resumeFreeMb=${String(pool.resumeFreeMb)} 非法（必须 >= 0），已回退默认 2048`)
    pool.resumeFreeMb = 2048
  }
  // 临界水位下限校验（与恢复水位的相对关系由下方不变式统一保证）
  if (!Number.isFinite(pool.criticalFreeMb) || pool.criticalFreeMb < 0) {
    warnings?.push(`execution.windowPool.criticalFreeMb=${String(pool.criticalFreeMb)} 非法（必须 >= 0），已回退默认 1024`)
    pool.criticalFreeMb = 1024
  }
  if (!Number.isFinite(pool.checkIntervalMs) || pool.checkIntervalMs < 1000) {
    warnings?.push(`execution.windowPool.checkIntervalMs=${String(pool.checkIntervalMs)} 非法（必须 >= 1000），已回退默认 5000`)
    pool.checkIntervalMs = 5000
  }
  if (!Number.isFinite(pool.openCooldownMs) || pool.openCooldownMs < 0) {
    warnings?.push(`execution.windowPool.openCooldownMs=${String(pool.openCooldownMs)} 非法（必须 >= 0），已回退默认 10000`)
    pool.openCooldownMs = 10000
  }
  if (!Number.isFinite(pool.idleCloseSec) || pool.idleCloseSec < 0) {
    warnings?.push(`execution.windowPool.idleCloseSec=${String(pool.idleCloseSec)} 非法（必须 >= 0），已回退默认 180`)
    pool.idleCloseSec = 180
  }
  if (!Number.isInteger(pool.windowMaxTasks) || pool.windowMaxTasks < 0) {
    warnings?.push(`execution.windowPool.windowMaxTasks=${String(pool.windowMaxTasks)} 非法（必须为非负整数），已回退默认 3`)
    pool.windowMaxTasks = 3
  }
  if (!Number.isFinite(pool.windowMaxLifetimeSec) || pool.windowMaxLifetimeSec < 0) {
    warnings?.push(`execution.windowPool.windowMaxLifetimeSec=${String(pool.windowMaxLifetimeSec)} 非法（必须 >= 0），已回退默认 600`)
    pool.windowMaxLifetimeSec = 600
  }
  if (!Number.isFinite(pool.cohortMaxSec) || pool.cohortMaxSec < 0) {
    warnings?.push(`execution.windowPool.cohortMaxSec=${String(pool.cohortMaxSec)} 非法（必须 >= 0），已回退默认 1800`)
    pool.cohortMaxSec = 1800
  }
  // 滞回不变式：临界水位必须严格低于恢复水位（否则内存水位判断失效）
  // 用户把 resumeFreeMb 调得比默认临界还小时，逐项校验无法自动满足该关系，此处整体回退两项默认值
  if (pool.criticalFreeMb >= pool.resumeFreeMb) {
    warnings?.push(`execution.windowPool.criticalFreeMb=${String(pool.criticalFreeMb)} 必须小于 resumeFreeMb=${String(pool.resumeFreeMb)}（否则内存水位滞回失效），已回退默认 1024/2048`)
    pool.criticalFreeMb = defaults.execution.windowPool.criticalFreeMb
    pool.resumeFreeMb = defaults.execution.windowPool.resumeFreeMb
  }
  // 全局健康参数校验：非法值逐项回落默认并告警
  // 段级校验：非对象时整体回退默认，避免后续读字段直接抛 TypeError
  if (!isPlainObject(cfg.execution.health)) {
    warnings?.push(`execution.health=${JSON.stringify(cfg.execution.health)} 非法（必须为对象），已回退默认配置`)
    cfg.execution.health = structuredClone(defaults.execution.health)
  }
  const health = cfg.execution.health
  if (!Number.isFinite(health.bitbrowserProbeMs) || health.bitbrowserProbeMs < 1000) {
    warnings?.push(`execution.health.bitbrowserProbeMs=${String(health.bitbrowserProbeMs)} 非法（必须 >= 1000），已回退默认 30000`)
    health.bitbrowserProbeMs = 30000
  }
  if (!Number.isFinite(health.globalEnvFailureWindowSec) || health.globalEnvFailureWindowSec < 0) {
    warnings?.push(`execution.health.globalEnvFailureWindowSec=${String(health.globalEnvFailureWindowSec)} 非法（必须 >= 0），已回退默认 300`)
    health.globalEnvFailureWindowSec = 300
  }
  if (!Number.isInteger(health.globalEnvFailureThreshold) || health.globalEnvFailureThreshold < 1) {
    warnings?.push(`execution.health.globalEnvFailureThreshold=${String(health.globalEnvFailureThreshold)} 非法（必须 >= 1），已回退默认 3`)
    health.globalEnvFailureThreshold = 3
  }
  if (typeof health.probeEnabled !== 'boolean') {
    warnings?.push(`execution.health.probeEnabled=${String(health.probeEnabled)} 非法（必须为布尔值），已回退默认 true`)
    health.probeEnabled = true
  }
  // 退避数列必须是非空的正数数组（否则取不到退避时长）
  if (!Array.isArray(health.backoffSec) || health.backoffSec.length === 0 || health.backoffSec.some((s) => !Number.isFinite(s) || s <= 0)) {
    warnings?.push(`execution.health.backoffSec=${JSON.stringify(health.backoffSec)} 非法（必须为非空正数数组），已回退默认 [30,60,120,300,600]`)
    health.backoffSec = [30, 60, 120, 300, 600]
  }
  // 旧配置项 circuitBreakerResetEveryHours 已废弃：存在即告警（取值被忽略，由 circuitBreakerResetAt 取代）
  const legacyResetHours = (cb as unknown as Record<string, unknown>).circuitBreakerResetEveryHours
  if (legacyResetHours !== undefined) {
    warnings?.push(`execution.circuitBreakerResetEveryHours 已废弃并被忽略（请改用 execution.circuitBreakerResetAt 指定每日重置时刻，当前值 ${cb.circuitBreakerResetAt || '（已关闭）'}）`)
  }
  // 存储路径统一解析为绝对路径，避免工作目录变化导致数据散落
  for (const key of ['dbPath', 'screenshotDir', 'logDir'] as const) {
    const p = cfg.storage[key]
    if (!isAbsolute(p)) cfg.storage[key] = resolve(root, p)
  }
  // 数据源路径同样解析为绝对路径（与存储路径同法）
  if (!isAbsolute(cfg.dataSource.path)) cfg.dataSource.path = resolve(root, cfg.dataSource.path)
  return cfg
}

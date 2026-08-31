/**
 * 日志层（infrastructure）：基于 log4js 的终端 + 按天滚动文件双通道日志
 * 依赖方向：仅依赖 log4js 与 config 类型，被上层各模块依赖
 * 设计思路：
 * - 终端通道：自定义 appender 按 pattern 布局渲染后字符串直写——error 及以上走 stderr、其余走 stdout
 *   （直写字符串绕开 console appender 的 console.log 层，PowerShell 5.1 下无编码/格式风险），
 *   按终端能力自动开关颜色（显式配置优先）
 * - 文件通道：dateFile 按天滚动（app.log.2026-08-31 这种），纯文本无颜色，保留最近 N 天
 *   （启动时清理 + 滚动时 numBackups 清理双保险，久不滚动时启动清理兜底）
 * - 对外接口兼容 pino 时代的两种调用形态：logger.info('消息') 与 logger.info({ 字段 }, '消息')
 */
import log4js from 'log4js'
import type { AppenderFunction, LayoutsParam } from 'log4js'
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config'

/** 业务模块统一使用的日志接口：兼容两种调用——logger.info('消息') 与 logger.info({ 字段 }, '消息') */
export interface Logger {
  info(msg: string, ...args: unknown[]): void
  info(obj: Record<string, unknown>, msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  warn(obj: Record<string, unknown>, msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  error(obj: Record<string, unknown>, msg: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
  debug(obj: Record<string, unknown>, msg: string, ...args: unknown[]): void
}

/**
 * 检测当前终端是否支持 ANSI 颜色：
 * Git Bash 会设置 TERM，Windows Terminal 设置 WT_SESSION，老式 PowerShell 5.1 控制台两者皆无
 * （后者会把转义码渲染成 [39m 之类的乱码，必须关色）
 */
function terminalSupportsAnsi(): boolean {
  if (process.platform !== 'win32') return true
  return Boolean(process.env.WT_SESSION || process.env.TERM || process.env.ANSICON || process.env.ConEmuANSI)
}

/** 无颜色纯文本布局（文件与无色终端共用）：`[时间] 级别 消息` */
const PLAIN_PATTERN = '[%d{yyyy-MM-dd hh:mm:ss}] %p %m'

/** 滚动后文件名的正则（streamroller 把 yyyy-MM-dd pattern 拼到 app.log 后面）：app.log.2026-08-31 */
const ROLLED_LOG_RE = /^app\.log\.(\d{4}-\d{2}-\d{2})$/

/**
 * 对象安全序列化：嵌套的 Error 保留 message/stack（JSON.stringify 会把 Error 序列化成 {}），
 * 其余走 JSON.stringify，循环引用等失败时回退 String，绝不抛错。
 */
function safeSerialize(v: unknown): string {
  try {
    return (
      JSON.stringify(v, (_key, value) =>
        value instanceof Error ? { message: value.message, stack: value.stack } : value,
      ) ?? String(v)
    )
  } catch {
    try {
      return String(v)
    } catch {
      return '[unserializable]'
    }
  }
}

/**
 * 归一化日志参数（独立导出以便单元测试）：
 * - 首参为字符串：整体透传（logger.info('消息', 附加参数...)）
 * - 首参为对象且次参为字符串：合并为 `消息 <JSON>`（logger.info({ 字段 }, '消息')）
 * - 首参为对象但仅一个参数（或次参不是字符串）：只序列化对象本身——避免对象透传给 log4js 被渲染成 [object Object]
 * - 其余形态透传兜底
 */
export function formatArgs(args: unknown[]): [string, ...unknown[]] {
  if (typeof args[0] === 'string') return args as [string, ...unknown[]]
  if (typeof args[0] === 'object' && args[0] !== null) {
    if (typeof args[1] === 'string') {
      return [`${args[1]} ${safeSerialize(args[0])}`, ...args.slice(2)]
    }
    return [safeSerialize(args[0])]
  }
  return args as [string, ...unknown[]]
}

/**
 * 启动时清理过期日志文件：只处理 app.log.<yyyy-MM-dd> 滚动文件，早于「今天 - (retainDays - 1)」天的删除
 * （即保留今天在内的最近 retainDays 天）。与 dateFile 滚动时的 numBackups 清理互补——
 * 后者仅在翻天滚动时触发，进程长期不滚动时过期文件会滞留，启动清理兜底。
 * 失败静默：日志自身出问题时绝不能影响启动。
 */
function pruneExpiredLogs(logDir: string, retainDays: number): void {
  try {
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - (retainDays - 1))
    for (const name of readdirSync(logDir)) {
      const match = ROLLED_LOG_RE.exec(name)
      if (!match) continue
      const rolled = new Date(`${match[1]}T00:00:00`)
      if (!Number.isNaN(rolled.getTime()) && rolled < cutoff) {
        unlinkSync(join(logDir, name))
      }
    }
  } catch {
    /* 静默：清理失败不影响启动 */
  }
}

/**
 * 创建日志器（先递归创建日志目录，避免首次运行写文件失败）
 * @param cfg 应用配置（读取 logLevel/logDir；storage.prettyColorize 可强制开关颜色；logRetainDays 控制文件保留天数）
 * @returns 兼容旧调用形态的包装日志器
 */
export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.storage.logDir, { recursive: true })
  // 颜色策略：显式配置优先，否则按终端能力自动检测（Git Bash/WT 有色，老式 PowerShell 无色）
  const colorize = cfg.storage.prettyColorize ?? terminalSupportsAnsi()
  const patternStr = colorize ? `%[[%d{yyyy-MM-dd hh:mm:ss}]%] %[%p%] %m` : PLAIN_PATTERN
  const retainDays = cfg.storage.logRetainDays ?? 7
  // 每次调用都完整 configure：单进程单配置场景无并发问题；测试等多次 createLogger（不同临时目录）场景下也各自正确生效
  log4js.configure({
    appenders: {
      // 自定义 appender：pattern 布局渲染后按级别直写 stderr/stdout
      consoleOut: {
        type: {
          configure: (_config: unknown, layouts?: LayoutsParam): AppenderFunction => {
            const render = layouts!.layout('pattern', { pattern: patternStr, tokens: {} })
            return (event) => {
              const line = render(event) + '\n'
              if (event.level.level >= log4js.levels.ERROR.level) process.stderr.write(line)
              else process.stdout.write(line)
            }
          },
        },
        layout: { type: 'pattern', pattern: patternStr },
      },
      file: {
        type: 'dateFile',
        filename: join(cfg.storage.logDir, 'app.log'),
        // 每天按日期滚动：当天写 app.log，翻天后旧文件更名为 app.log.<日期>（如 app.log.2026-08-31）
        // 注意：pattern 不能带前导点——streamroller 3.x 会把它拼进文件名产生 app.log..2026-08-31 双点；
        // keepFileExt 也不能开——开了会产出 app.2026-08-31.log。均经实测确认。
        pattern: 'yyyy-MM-dd',
        // 保留 N 个历史归档（streamroller 已将 daysToKeep 弃用并 1:1 映射到 numBackups）：
        // numBackups=N 表示保留 N 个归档 + 当前文件（共 N+1 个）；启动清理见 pruneExpiredLogs
        numBackups: retainDays,
        layout: { type: 'pattern', pattern: PLAIN_PATTERN },
      },
    },
    categories: {
      default: { appenders: ['consoleOut', 'file'], level: cfg.storage.logLevel },
    },
  })
  pruneExpiredLogs(cfg.storage.logDir, retainDays)
  const log = log4js.getLogger()
  return {
    info: (...args: unknown[]) => log.info(...formatArgs(args)),
    warn: (...args: unknown[]) => log.warn(...formatArgs(args)),
    error: (...args: unknown[]) => log.error(...formatArgs(args)),
    debug: (...args: unknown[]) => log.debug(...formatArgs(args)),
  }
}

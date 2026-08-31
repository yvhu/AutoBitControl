/**
 * 日志层（infrastructure）：基于 log4js 的终端 + 按天滚动文件双通道日志
 * 依赖方向：仅依赖 log4js 与 config 类型，被上层各模块依赖
 * 设计思路：
 * - 终端通道：pattern 布局输出 `[时间] 级别 消息`，按终端能力自动开关颜色（显式配置优先）
 * - 文件通道：dateFile 按天滚动（app.log.2026-08-31 这种），纯文本无颜色，保留 daysToKeep 天
 * - 对外接口兼容 pino 时代的两种调用形态：logger.info('消息') 与 logger.info({ 字段 }, '消息')
 */
import log4js from 'log4js'
import { mkdirSync } from 'node:fs'
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
 * - 其余形态透传兜底
 */
export function formatArgs(args: unknown[]): [string, ...unknown[]] {
  if (typeof args[0] === 'string') return args as [string, ...unknown[]]
  if (args.length >= 2 && typeof args[0] === 'object' && args[0] !== null && typeof args[1] === 'string') {
    return [`${args[1]} ${safeSerialize(args[0])}`, ...args.slice(2)]
  }
  return args as [string, ...unknown[]]
}

/** log4js 全局只配置一次（模块级标志：应用/脚本/测试多实例场景下防重复 configure） */
let configured = false

/**
 * 创建日志器（先递归创建日志目录，避免首次运行写文件失败）
 * @param cfg 应用配置（读取 logLevel/logDir；storage.prettyColorize 可强制开关颜色；logRetainDays 控制文件保留天数）
 * @returns 兼容旧调用形态的包装日志器
 */
export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.storage.logDir, { recursive: true })
  if (!configured) {
    configured = true
    // 颜色策略：显式配置优先，否则按终端能力自动检测（Git Bash/WT 有色，老式 PowerShell 无色）
    const colorize = cfg.storage.prettyColorize ?? terminalSupportsAnsi()
    log4js.configure({
      appenders: {
        console: {
          type: 'console',
          layout: {
            type: 'pattern',
            pattern: colorize ? `%[[%d{yyyy-MM-dd hh:mm:ss}]%] %[%p%] %m` : PLAIN_PATTERN,
          },
        },
        file: {
          type: 'dateFile',
          filename: join(cfg.storage.logDir, 'app.log'),
          // 每天按日期滚动：当天写 app.log，翻天后旧文件更名为 app.log.<日期>（如 app.log.2026-08-31）
          // 注意：pattern 不能带前导点——streamroller 3.x 会把它拼进文件名产生 app.log..2026-08-31 双点；
          // keepFileExt 也不能开——开了会产出 app.2026-08-31.log。均经实测确认。
          pattern: 'yyyy-MM-dd',
          // 保留 N 个历史文件（streamroller 已将 daysToKeep 弃用并 1:1 映射到 numBackups）
          numBackups: cfg.storage.logRetainDays ?? 7,
          layout: { type: 'pattern', pattern: PLAIN_PATTERN },
        },
      },
      categories: {
        default: { appenders: ['console', 'file'], level: cfg.storage.logLevel },
      },
    })
  }
  const log = log4js.getLogger()
  return {
    info: (...args: unknown[]) => log.info(...formatArgs(args)),
    warn: (...args: unknown[]) => log.warn(...formatArgs(args)),
    error: (...args: unknown[]) => log.error(...formatArgs(args)),
    debug: (...args: unknown[]) => log.debug(...formatArgs(args)),
  }
}

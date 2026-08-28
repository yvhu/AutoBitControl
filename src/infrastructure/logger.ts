/**
 * 日志层（infrastructure）：创建 pino 日志器，同时输出文件与终端
 * 依赖方向：仅依赖 pino 与 config 类型，被上层各模块依赖
 * 设计思路：文件通道供排障留存（data/logs/app.log），pretty 通道供终端实时观察
 */
import pino from 'pino'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config'

export type Logger = pino.Logger

/**
 * 检测当前终端是否支持 ANSI 颜色：
 * Git Bash 会设置 TERM，Windows Terminal 设置 WT_SESSION，老式 PowerShell 5.1 控制台两者皆无
 * （后者会把转义码渲染成 [39m 之类的乱码，必须关色）
 */
function terminalSupportsAnsi(): boolean {
  if (process.platform !== 'win32') return true
  return Boolean(process.env.WT_SESSION || process.env.TERM || process.env.ANSICON || process.env.ConEmuANSI)
}

/**
 * 创建日志器（先递归创建日志目录，避免首次运行写文件失败）
 * @param cfg 应用配置（读取 logLevel 与 logDir；storage.prettyColorize 可强制开关颜色）
 * @returns pino 日志器（全局共用同一实例）
 */
export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.storage.logDir, { recursive: true })
  // 颜色策略：显式配置优先，否则按终端能力自动检测（Git Bash/WT 有色，老式 PowerShell 无色）
  const colorize = cfg.storage.prettyColorize ?? terminalSupportsAnsi()
  return pino({
    level: cfg.storage.logLevel,
    transport: {
      targets: [
        { target: 'pino/file', options: { destination: join(cfg.storage.logDir, 'app.log'), mkdir: true } },
        { target: 'pino-pretty', options: { translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', colorize } },
      ],
    },
  })
}

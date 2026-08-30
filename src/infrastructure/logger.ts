/**
 * 日志层（infrastructure）：创建 pino 日志器，同时输出文件与终端
 * 依赖方向：仅依赖 pino/pino-pretty 与 config 类型，被上层各模块依赖
 * 设计思路：
 * - 文件通道：原始 JSON 行写入 data/logs/app.log（字节级精确，UTF-8 无歧义，供排障留存）
 * - 终端通道：pino-pretty 在主线程格式化后，经 ConsoleUtf8 以【字符串】写入 stdout——
 *   Windows 上字符串直写走 WriteConsoleW（UTF-16），与 console.log 同一路径，天然免疫 GBK 代码页乱码；
 *   若按默认 sonic-boom 的字节流写，中文在 GBK 控制台会乱码（已实测证实）。
 */
import pino, { multistream } from 'pino'
import pretty from 'pino-pretty'
import { Writable } from 'node:stream'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config'

export type Logger = pino.Logger

/**
 * 字符串直写的控制台输出流：
 * 无论上游给 Buffer 还是字符串，都统一转成字符串后经 process.stdout.write 写出，
 * 保证走 Node 的 WriteConsoleW 路径（中文在任何代码页的控制台都不会乱码）。
 * 支持注入自定义 writer 以便单元测试。
 */
export class ConsoleUtf8 extends Writable {
  constructor(private writer: (s: string, cb: (err?: Error | null) => void) => void = (s, cb) => process.stdout.write(s, cb)) {
    super()
  }

  _write(chunk: unknown, _encoding: string, callback: (err?: Error | null) => void): void {
    this.writer(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'), callback)
  }
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

/**
 * 创建日志器（先递归创建日志目录，避免首次运行写文件失败）
 * @param cfg 应用配置（读取 logLevel 与 logDir；storage.prettyColorize 可强制开关颜色）
 * @returns pino 日志器（全局共用同一实例）
 */
export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.storage.logDir, { recursive: true })
  // 颜色策略：显式配置优先，否则按终端能力自动检测（Git Bash/WT 有色，老式 PowerShell 无色）
  const colorize = cfg.storage.prettyColorize ?? terminalSupportsAnsi()
  const consoleStream = pretty({
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
    colorize,
    destination: new ConsoleUtf8(),
  })
  const fileStream = pino.destination({ dest: join(cfg.storage.logDir, 'app.log'), mkdir: true })
  return pino(
    { level: cfg.storage.logLevel },
    multistream([
      { stream: consoleStream },
      { stream: fileStream },
    ]),
  )
}

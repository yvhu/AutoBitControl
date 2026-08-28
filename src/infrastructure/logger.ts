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
 * 创建日志器（先递归创建日志目录，避免首次运行写文件失败）
 * @param cfg 应用配置（读取 logLevel 与 logDir）
 * @returns pino 日志器（全局共用同一实例）
 */
export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.storage.logDir, { recursive: true })
  return pino({
    level: cfg.storage.logLevel,
    transport: {
      targets: [
        { target: 'pino/file', options: { destination: join(cfg.storage.logDir, 'app.log'), mkdir: true } },
        // colorize 关闭：Windows PowerShell 5.1 控制台不支持 ANSI 转义，会输出 [39m 之类的乱码
        { target: 'pino-pretty', options: { translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', colorize: false } },
      ],
    },
  })
}

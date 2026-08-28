import pino from 'pino'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config'

export type Logger = pino.Logger

export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.storage.logDir, { recursive: true })
  return pino({
    level: cfg.storage.logLevel,
    transport: {
      targets: [
        { target: 'pino/file', options: { destination: join(cfg.storage.logDir, 'app.log'), mkdir: true } },
        { target: 'pino-pretty', options: { translateTime: 'SYS:yyyy-mm-dd HH:MM:ss' } },
      ],
    },
  })
}

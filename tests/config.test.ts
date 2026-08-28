import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/infrastructure/config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'abc-config-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('loadConfig', () => {
  it('无配置文件时返回默认值', () => {
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.bitbrowser.apiBase).toBe('http://127.0.0.1:54345')
    expect(cfg.execution.concurrency).toBe(6)
    expect(cfg.captcha.clientKey).toBe('')
  })

  it('config.json 与 config.local.json 深度合并，local 覆盖', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      bitbrowser: { apiBase: 'http://127.0.0.1:9999' },
      execution: { concurrency: 3, probeUrl: 'https://base.example' },
    }))
    writeFileSync(join(configDir, 'config.local.json'), JSON.stringify({
      execution: { concurrency: 8 },
    }))
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.bitbrowser.apiBase).toBe('http://127.0.0.1:9999')
    expect(cfg.execution.concurrency).toBe(8)
    expect(cfg.execution.probeUrl).toBe('https://base.example')
    expect(cfg.web.port).toBe(3000)
  })

  it('环境变量覆盖 clientKey', () => {
    const cfg = loadConfig({ rootDir: dir, env: { CAPTCHA_CLIENT_KEY: 'abc123' } })
    expect(cfg.captcha.clientKey).toBe('abc123')
  })

  it('相对存储路径解析为 root 下的绝对路径', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storage: { dbPath: 'data/app.db' },
    }))
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.storage.dbPath).toBe(join(dir, 'data', 'app.db'))
  })
})

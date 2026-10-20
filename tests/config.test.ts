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
    expect(cfg.execution.staggerMaxSec).toBe(120)
    expect(cfg.execution.staggerJitterPct).toBe(15)
    expect(cfg.execution.maxConcurrentWindows).toBe(4)
  })

  it('staggerMaxSec 非法值（非有限数字或负数）回退 120', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { staggerMaxSec: 0 } }))
    expect(loadConfig({ rootDir: dir }).execution.staggerMaxSec).toBe(0)
    for (const value of [-1, '120', null]) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { staggerMaxSec: value } }))
      expect(loadConfig({ rootDir: dir }).execution.staggerMaxSec).toBe(120)
    }
  })

  it('staggerJitterPct 校验 0-50，非法值回退 15', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    for (const value of [0, 50]) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { staggerJitterPct: value } }))
      expect(loadConfig({ rootDir: dir }).execution.staggerJitterPct).toBe(value)
    }
    for (const value of [-1, 51, '15']) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { staggerJitterPct: value } }))
      expect(loadConfig({ rootDir: dir }).execution.staggerJitterPct).toBe(15)
    }
  })

  it('maxConcurrentWindows 非法或 0 回退 4 并产生告警', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    for (const value of [0, -1, 1.5, '4', null]) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { maxConcurrentWindows: value } }))
      const warnings: string[] = []
      const cfg = loadConfig({ rootDir: dir, warnings })
      expect(cfg.execution.maxConcurrentWindows).toBe(4)
      expect(warnings.some((w) => w.includes('maxConcurrentWindows'))).toBe(true)
    }
  })

  it('maxConcurrentWindows 正整数生效且无告警', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { maxConcurrentWindows: 6 } }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.maxConcurrentWindows).toBe(6)
    expect(warnings).toEqual([])
  })

  it('staggerMaxSec 超过 3600 截断为 3600 并告警', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { staggerMaxSec: 7200 } }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.staggerMaxSec).toBe(3600)
    expect(warnings.some((w) => w.includes('staggerMaxSec'))).toBe(true)
  })

  it('staggerMaxSec 非法值回退 120 并告警，0 合法不告警', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { staggerMaxSec: -1 } }))
    const badWarnings: string[] = []
    expect(loadConfig({ rootDir: dir, warnings: badWarnings }).execution.staggerMaxSec).toBe(120)
    expect(badWarnings.some((w) => w.includes('staggerMaxSec'))).toBe(true)
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { staggerMaxSec: 0 } }))
    const okWarnings: string[] = []
    expect(loadConfig({ rootDir: dir, warnings: okWarnings }).execution.staggerMaxSec).toBe(0)
    expect(okWarnings).toEqual([])
  })

  it('旧配置 circuitBreakerResetEveryHours 产生废弃告警且不影响新配置', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      execution: { circuitBreakerResetEveryHours: 24, circuitBreakerResetAt: '04:00' },
    }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.circuitBreakerResetAt).toBe('04:00')
    expect(warnings.some((w) => w.includes('circuitBreakerResetEveryHours'))).toBe(true)
  })

  it('无废弃配置项时不产生废弃告警', () => {
    const warnings: string[] = []
    loadConfig({ rootDir: dir, warnings })
    expect(warnings).toEqual([])
  })

  it('config.json 与 config.local.json 深度合并，local 覆盖', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      bitbrowser: { apiBase: 'http://127.0.0.1:9999' },
      execution: { windowTimeoutMs: 123000 },
    }))
    writeFileSync(join(configDir, 'config.local.json'), JSON.stringify({
      execution: { windowTimeoutMs: 999000 },
    }))
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.bitbrowser.apiBase).toBe('http://127.0.0.1:9999')
    expect(cfg.execution.windowTimeoutMs).toBe(999000)
    expect(cfg.web.port).toBe(3000)
  })

  it('WEB_PORT 合法值覆盖默认端口', () => {
    const cfg = loadConfig({ rootDir: dir, env: { WEB_PORT: '8080' } })
    expect(cfg.web.port).toBe(8080)
  })

  it('WEB_PORT 非法值静默忽略并保留默认端口', () => {
    for (const bad of ['not-a-number', '0', '-1', '', '3.5', '65536', '999999', 'Infinity']) {
      const cfg = loadConfig({ rootDir: dir, env: { WEB_PORT: bad } })
      expect(cfg.web.port).toBe(3000)
    }
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

  it('相对数据源路径解析为 root 下的绝对路径（默认 config/accounts.xlsx）', () => {
    // 默认值已是绝对路径（指向默认项目根，与 storage 默认值同法）
    expect(loadConfig({ rootDir: dir }).dataSource.path).toMatch(/accounts\.xlsx$/)
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      dataSource: { path: 'config/accounts.xlsx' },
    }))
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.dataSource.path).toBe(join(dir, 'config', 'accounts.xlsx'))
  })

  it('WALLET_PASSWORDS env JSON 解析并与配置文件 wallet.passwords 合并', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      wallet: { passwords: { 'bb-1': 'file-pw' } },
    }))
    const cfg = loadConfig({ rootDir: dir, env: { WALLET_PASSWORDS: '{"bb-2":"env-pw"}' } })
    expect(cfg.wallet.passwords).toEqual({ 'bb-1': 'file-pw', 'bb-2': 'env-pw' })
  })

  it('WALLET_PASSWORDS env 覆盖同名 key', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      wallet: { passwords: { 'bb-1': 'file-pw' } },
    }))
    const cfg = loadConfig({ rootDir: dir, env: { WALLET_PASSWORDS: '{"bb-1":"env-pw"}' } })
    expect(cfg.wallet.passwords['bb-1']).toBe('env-pw')
  })

  it('WALLET_PASSWORDS 非法 JSON 忽略不抛错并保留配置值', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      wallet: { passwords: { 'bb-1': 'file-pw' } },
    }))
    const cfg = loadConfig({ rootDir: dir, env: { WALLET_PASSWORDS: 'not-json' } })
    expect(cfg.wallet.passwords).toEqual({ 'bb-1': 'file-pw' })
  })

  it('WALLET_PASSWORDS 非法 JSON 置 parseError 标记，合法 JSON 不置', () => {
    const bad = loadConfig({ rootDir: dir, env: { WALLET_PASSWORDS: 'not-json' } })
    expect(bad.wallet.parseError).toBe(true)
    const ok = loadConfig({ rootDir: dir, env: { WALLET_PASSWORDS: '{"bb-2":"env-pw"}' } })
    expect(ok.wallet.parseError).toBe(false)
    const none = loadConfig({ rootDir: dir })
    expect(none.wallet.parseError).toBeUndefined()
  })

  it('storage.dbRetainDays 默认 90 且可被配置文件覆盖', () => {
    expect(loadConfig({ rootDir: dir }).storage.dbRetainDays).toBe(90)
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storage: { dbRetainDays: 30 },
    }))
    expect(loadConfig({ rootDir: dir }).storage.dbRetainDays).toBe(30)
  })

  it('scheduler.timezone 默认 Asia/Shanghai，可被 config.json 覆盖', () => {
    expect(loadConfig({ rootDir: dir }).scheduler.timezone).toBe('Asia/Shanghai')
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ scheduler: { timezone: 'UTC' } }))
    expect(loadConfig({ rootDir: dir }).scheduler.timezone).toBe('UTC')
  })

  it('ai 段默认值正确', () => {
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.ai.provider).toBe('openai-compatible')
    expect(cfg.ai.apiBase).toBe('https://api.deepseek.com')
    expect(cfg.ai.model).toBe('deepseek-flash')
    expect(cfg.ai.apiKey).toBe('')
    expect(cfg.ai.timeoutMs).toBe(30000)
  })

  it('环境变量覆盖 ai', () => {
    const cfg = loadConfig({ rootDir: dir, env: { AI_API_KEY: 'k', AI_MODEL: 'm', AI_API_BASE: 'https://x' } })
    expect(cfg.ai.apiKey).toBe('k')
    expect(cfg.ai.model).toBe('m')
    expect(cfg.ai.apiBase).toBe('https://x')
  })

  it('circuitBreakerResetAt 默认 23:59', () => {
    expect(loadConfig({ rootDir: dir }).execution.circuitBreakerResetAt).toBe('23:59')
  })

  it('CIRCUIT_BREAKER_RESET_AT env 覆盖熔断重置时刻', () => {
    const cfg = loadConfig({ rootDir: dir, env: { CIRCUIT_BREAKER_RESET_AT: '04:00' } })
    expect(cfg.execution.circuitBreakerResetAt).toBe('04:00')
  })

  it('CIRCUIT_BREAKER_RESET_AT 空串 env 可显式关闭自动重置', () => {
    const cfg = loadConfig({ rootDir: dir, env: { CIRCUIT_BREAKER_RESET_AT: '' } })
    expect(cfg.execution.circuitBreakerResetAt).toBe('')
  })

  it('熔断新配置默认值正确', () => {
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.execution.circuitBreakerEnabled).toBe(true)
    expect(cfg.execution.circuitBreakerThreshold).toBe(2)
    expect(cfg.execution.circuitBreakerCooldownSec).toBe(1800)
    expect(cfg.execution.circuitBreakerMaxCooldownSec).toBe(7200)
    expect(cfg.execution.circuitBreakerResetAt).toBe('23:59')
  })
})

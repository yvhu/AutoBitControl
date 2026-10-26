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
    expect(cfg.execution.windowPool.maxOpenWindows).toBe(4)
    // 批量错峰已移除：配置不再包含 stagger 字段
    const execution = cfg.execution as unknown as Record<string, unknown>
    expect(execution.staggerMaxSec).toBeUndefined()
    expect(execution.staggerJitterPct).toBeUndefined()
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

  it('storage.screenshotRetainDays 默认 3 且可被配置文件覆盖', () => {
    expect(loadConfig({ rootDir: dir }).storage.screenshotRetainDays).toBe(3)
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storage: { screenshotRetainDays: 7 },
    }))
    expect(loadConfig({ rootDir: dir }).storage.screenshotRetainDays).toBe(7)
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

  it('windowPool 默认值与覆盖', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { windowPool: { maxOpenWindows: 6 } } }))
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.execution.windowPool).toMatchObject({
      maxOpenWindows: 6,
      memoryReserveMb: 100,
      perWindowMb: 1024,
      criticalFreeMb: 1024,
      resumeFreeMb: 2048,
      checkIntervalMs: 5000,
      openCooldownMs: 10000,
      idleCloseSec: 180,
      windowMaxTasks: 3,
      windowMaxLifetimeSec: 600,
      cohortMaxSec: 1800,
    })
  })

  it('health 默认值与非法回退', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { health: { globalEnvFailureThreshold: 0 } } }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.health.globalEnvFailureThreshold).toBe(3)
    expect(cfg.execution.health.backoffSec).toEqual([30, 60, 120, 300, 600])
    expect(warnings.some((w) => w.includes('globalEnvFailureThreshold'))).toBe(true)
  })

  it('windowPool 无配置文件时返回默认值且不告警', () => {
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.windowPool.maxOpenWindows).toBe(4)
    expect(cfg.execution.windowPool.cohortMaxSec).toBe(1800)
    expect(warnings).toEqual([])
  })

  it('health 无配置文件时返回默认值且不告警', () => {
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.health.bitbrowserProbeMs).toBe(30000)
    expect(cfg.execution.health.globalEnvFailureWindowSec).toBe(300)
    expect(cfg.execution.health.globalEnvFailureThreshold).toBe(3)
    expect(cfg.execution.health.probeEnabled).toBe(true)
    expect(cfg.execution.health.backoffSec).toEqual([30, 60, 120, 300, 600])
    expect(warnings).toEqual([])
  })

  it('windowPool 非法值逐项回退默认并产生告警', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      execution: {
        windowPool: {
          maxOpenWindows: 0,
          memoryReserveMb: -1,
          perWindowMb: 64,
          criticalFreeMb: 4096,
          resumeFreeMb: 2048,
          checkIntervalMs: 500,
          openCooldownMs: -1,
          idleCloseSec: -1,
          windowMaxTasks: -1,
          windowMaxLifetimeSec: -1,
          cohortMaxSec: -1,
        },
      },
    }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.windowPool).toMatchObject({
      maxOpenWindows: 4,
      memoryReserveMb: 100,
      perWindowMb: 1024,
      criticalFreeMb: 1024,
      resumeFreeMb: 2048,
      checkIntervalMs: 5000,
      openCooldownMs: 10000,
      idleCloseSec: 180,
      windowMaxTasks: 3,
      windowMaxLifetimeSec: 600,
      cohortMaxSec: 1800,
    })
    for (const key of [
      'maxOpenWindows',
      'memoryReserveMb',
      'perWindowMb',
      'criticalFreeMb',
      'resumeFreeMb',
      'checkIntervalMs',
      'openCooldownMs',
      'idleCloseSec',
      'windowMaxTasks',
      'windowMaxLifetimeSec',
      'cohortMaxSec',
    ]) {
      expect(warnings.some((w) => w.includes(key))).toBe(true)
    }
  })

  it('health 非法 backoffSec（空数组/含非正数）回退默认并告警', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    for (const bad of [[], [0], [30, -1], [30, 60, 'x']]) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { health: { backoffSec: bad } } }))
      const warnings: string[] = []
      const cfg = loadConfig({ rootDir: dir, warnings })
      expect(cfg.execution.health.backoffSec).toEqual([30, 60, 120, 300, 600])
      expect(warnings.some((w) => w.includes('backoffSec'))).toBe(true)
    }
  })

  it('health probeEnabled 非布尔值回退 true 并告警', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { health: { probeEnabled: 1 } } }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.health.probeEnabled).toBe(true)
    expect(warnings.some((w) => w.includes('probeEnabled'))).toBe(true)
  })

  it('windowPool 段非对象（null/数字）回退默认并告警且不抛错', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    for (const value of [null, 5]) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { windowPool: value } }))
      const warnings: string[] = []
      const cfg = loadConfig({ rootDir: dir, warnings })
      expect(cfg.execution.windowPool).toMatchObject({
        maxOpenWindows: 4,
        memoryReserveMb: 100,
        perWindowMb: 1024,
        criticalFreeMb: 1024,
        resumeFreeMb: 2048,
        checkIntervalMs: 5000,
        openCooldownMs: 10000,
        idleCloseSec: 180,
        windowMaxTasks: 3,
        windowMaxLifetimeSec: 600,
        cohortMaxSec: 1800,
      })
      expect(warnings.some((w) => w.includes('windowPool'))).toBe(true)
    }
  })

  it('health 段非对象（null/数字）回退默认并告警且不抛错', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    for (const value of [null, 5]) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { health: value } }))
      const warnings: string[] = []
      const cfg = loadConfig({ rootDir: dir, warnings })
      expect(cfg.execution.health).toMatchObject({
        bitbrowserProbeMs: 30000,
        globalEnvFailureWindowSec: 300,
        globalEnvFailureThreshold: 3,
        probeEnabled: true,
        backoffSec: [30, 60, 120, 300, 600],
      })
      expect(warnings.some((w) => w.includes('health'))).toBe(true)
    }
  })

  it('resumeFreeMb 小于默认 criticalFreeMb 时最终仍满足 criticalFreeMb < resumeFreeMb', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ execution: { windowPool: { resumeFreeMb: 500 } } }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.windowPool.criticalFreeMb).toBeLessThan(cfg.execution.windowPool.resumeFreeMb)
    expect(warnings.some((w) => w.includes('criticalFreeMb'))).toBe(true)
  })

  it('criticalFreeMb 非法且大于恢复水位时回退后仍满足 criticalFreeMb < resumeFreeMb', () => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      execution: { windowPool: { criticalFreeMb: 4096, resumeFreeMb: 500 } },
    }))
    const warnings: string[] = []
    const cfg = loadConfig({ rootDir: dir, warnings })
    expect(cfg.execution.windowPool.criticalFreeMb).toBeLessThan(cfg.execution.windowPool.resumeFreeMb)
    expect(warnings.some((w) => w.includes('criticalFreeMb'))).toBe(true)
  })
})

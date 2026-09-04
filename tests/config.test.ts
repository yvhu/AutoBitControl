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
    expect(cfg.captcha.clientKey).toBe('')
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

  it('环境变量覆盖 clientKey', () => {
    const cfg = loadConfig({ rootDir: dir, env: { CAPTCHA_CLIENT_KEY: 'abc123' } })
    expect(cfg.captcha.clientKey).toBe('abc123')
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
})

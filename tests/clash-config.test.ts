import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, updateConfigFile } from '../src/infrastructure/config'

let dir: string
let cfgPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'clash-cfg-'))
  mkdirSync(join(dir, 'config'))
  cfgPath = join(dir, 'config', 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ execution: { staggerMaxSec: 60 } }, null, 2))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('clash 配置段', () => {
  it('缺省值齐备（apiBase 9090 / autoCheck 30-2 / 权重 2-1）', () => {
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.clash.apiBase).toBe('http://127.0.0.1:9090')
    expect(cfg.clash.autoCheck).toEqual({ enabled: true, normalIntervalMin: 30, fastIntervalMin: 2 })
    expect(cfg.clash.weights).toEqual([2, 1])
    expect(cfg.clash.testConcurrency).toBe(2)
    expect(cfg.clash.minGainMs).toBe(100)
  })

  it('config.json 的 clash.group 覆盖缺省值', () => {
    writeFileSync(cfgPath, JSON.stringify({ clash: { group: 'GLOBAL' } }, null, 2))
    expect(loadConfig({ rootDir: dir }).clash.group).toBe('GLOBAL')
  })
})

describe('updateConfigFile', () => {
  it('写回 group 且保留其他键', () => {
    updateConfigFile({ group: '🚀 节点选择' }, { rootDir: dir })
    const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(saved.clash.group).toBe('🚀 节点选择')
  })

  it('多次写回不丢历史键', () => {
    writeFileSync(cfgPath, JSON.stringify({ execution: { staggerMaxSec: 60 }, clash: { group: 'A' } }, null, 2))
    updateConfigFile({ group: 'B' }, { rootDir: dir })
    const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(saved.clash.group).toBe('B')
    expect(saved.execution.staggerMaxSec).toBe(60)
  })
})

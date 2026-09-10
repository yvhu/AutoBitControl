import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pruneScreenshots } from '../src/infrastructure/screenshot-cleanup'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'abc-screenshots-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('pruneScreenshots 截图目录日期清理', () => {
  /** 今天的 YYYY-MM-DD（本地时区，与 cutoff 同口径） */
  const today = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('删除早于保留期限的日期目录，保留期限内与 grid-debug 非日期目录不动', () => {
    const sub = join(dir, 'screenshots')
    for (const name of ['2026-01-01', '2026-09-09', today(), 'grid-debug']) {
      mkdirSync(join(sub, name), { recursive: true })
    }
    // 目录内有文件也能整目录删除（rm recursive）
    writeFileSync(join(sub, '2026-01-01', 'a.png'), 'x')
    const r = pruneScreenshots(sub, 90)
    expect(r.removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(sub, '2026-01-01'))).toBe(false)
    expect(existsSync(join(sub, '2026-09-09'))).toBe(true)
    expect(existsSync(join(sub, today()))).toBe(true)
    expect(existsSync(join(sub, 'grid-debug'))).toBe(true)
  })

  it('截图目录不存在返回 0', () => {
    expect(pruneScreenshots(join(dir, 'missing'), 90)).toEqual({ removed: 0 })
  })

  it('目录名为非日期格式（如 grid-2026-01-01）不删除', () => {
    const sub = join(dir, 'screenshots')
    for (const name of ['grid-2026-01-01', '2026-01-01x', '999-01-01']) {
      mkdirSync(join(sub, name), { recursive: true })
    }
    pruneScreenshots(sub, 90)
    for (const name of ['grid-2026-01-01', '2026-01-01x', '999-01-01']) {
      expect(existsSync(join(sub, name))).toBe(true)
    }
  })
})

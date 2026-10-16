/**
 * window-registry 单测：孤儿窗口甄别与回收（无归属 / 归属进程已死 → 关窗并清登记）
 * 注入假 db/bitbrowser，不连真库与真浏览器
 */
import { describe, it, expect, vi } from 'vitest'
import { reclaimOrphanWindows, isProcessAlive } from '../src/engine/window-registry'
import type { Logger } from '../src/infrastructure/logger'
import type { OpenWindowRow } from '../src/infrastructure/db'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

function makeDeps(opts: { alive: string[]; rows: OpenWindowRow[]; probeFails?: boolean }) {
  const closeBrowser = vi.fn().mockResolvedValue(undefined)
  const clearOpenWindow = vi.fn().mockResolvedValue(undefined)
  const db = {
    listProfiles: vi.fn().mockResolvedValue([{ bitbrowserId: 'a' }, { bitbrowserId: 'b' }, { bitbrowserId: 'c' }]),
    listOpenWindows: vi.fn().mockResolvedValue(opts.rows),
    clearOpenWindow,
  }
  const bitbrowser = {
    openPids: opts.probeFails ? vi.fn().mockRejectedValue(new Error('api down')) : vi.fn().mockResolvedValue(new Set(opts.alive)),
    closeBrowser,
  }
  return { deps: { db, bitbrowser } as never, closeBrowser, clearOpenWindow }
}

describe('reclaimOrphanWindows 孤儿回收', () => {
  it('存活但无登记行的窗口 → 关窗并清登记', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: ['a'], rows: [] })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(1)
    expect(closeBrowser).toHaveBeenCalledWith('a')
    expect(clearOpenWindow).toHaveBeenCalledWith('a')
  })

  it('归属进程已死 → 关窗并清登记', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: ['a'], rows: [{ bitbrowserId: 'a', http: 'x', ownerPid: 999999999 }] })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(1)
    expect(closeBrowser).toHaveBeenCalledWith('a')
    expect(clearOpenWindow).toHaveBeenCalledWith('a')
  })

  it('归属进程存活 → 不回收', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: ['a'], rows: [{ bitbrowserId: 'a', http: 'x', ownerPid: process.pid }] })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(clearOpenWindow).not.toHaveBeenCalled()
  })

  it('死登记行（pid 已不在存活集）只清登记、不误关', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: [], rows: [{ bitbrowserId: 'a', http: 'x', ownerPid: process.pid }] })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(clearOpenWindow).toHaveBeenCalledWith('a')
  })

  it('占用探测失败 → 不回收任何窗口', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: [], rows: [], probeFails: true })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(clearOpenWindow).not.toHaveBeenCalled()
  })

  it('isProcessAlive：当前进程存活 / 不存在的 pid 为假', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(999999999)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })
})

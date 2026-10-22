/**
 * window-registry 单测：孤儿窗口甄别与回收（仅回收 state=open 且归属进程已死的窗口）
 * 注入假 db/bitbrowser，不连真库与真浏览器
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { reclaimOrphanWindows, isProcessAlive, waitForWindowClosed } from '../src/engine/window-registry'
import type { Logger } from '../src/infrastructure/logger'
import type { OpenWindowRow, OpenWindowState } from '../src/infrastructure/db'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

function makeRow(over: Partial<OpenWindowRow> = {}): OpenWindowRow {
  return { bitbrowserId: 'a', http: 'x', ownerPid: process.pid, state: 'open', ...over }
}

function makeDeps(opts: {
  alive: string[]
  rows: OpenWindowRow[]
  aliveAfterClose?: string[]
  probeFails?: boolean
  closeFails?: boolean
}) {
  const closeBrowser = opts.closeFails
    ? vi.fn().mockRejectedValue(new Error('close boom'))
    : vi.fn().mockResolvedValue(undefined)
  const clearOpenWindow = vi.fn().mockResolvedValue(undefined)
  const setWindowState = vi.fn().mockResolvedValue(undefined)
  const db = {
    listProfiles: vi.fn().mockResolvedValue([{ bitbrowserId: 'a' }, { bitbrowserId: 'b' }, { bitbrowserId: 'c' }]),
    listOpenWindows: vi.fn().mockResolvedValue(opts.rows),
    setWindowState,
    clearOpenWindow,
  }
  let calls = 0
  const openPids = opts.probeFails
    ? vi.fn().mockRejectedValue(new Error('api down'))
    : vi.fn(async () => {
      calls++
      const ids = calls === 1 ? opts.alive : (opts.aliveAfterClose ?? [])
      return new Set(ids)
    })
  const bitbrowser = { openPids, closeBrowser }
  return { deps: { db, bitbrowser } as never, closeBrowser, clearOpenWindow, setWindowState, openPids }
}

describe('reclaimOrphanWindows 孤儿回收', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('存活但无登记行的窗口 → 本阶段不关闭（避免误关正在打开的窗口）', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: ['a'], rows: [] })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(clearOpenWindow).not.toHaveBeenCalled()
  })

  it('state=open 且归属进程已死 → 标记 closing、关窗、确认消失后清登记', async () => {
    const { deps, closeBrowser, clearOpenWindow, setWindowState, openPids } = makeDeps({
      alive: ['a'],
      rows: [makeRow({ ownerPid: 999999999 })],
    })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(1)
    expect(setWindowState).toHaveBeenCalledWith('a', 'closing')
    expect(closeBrowser).toHaveBeenCalledWith('a')
    expect(openPids).toHaveBeenCalledTimes(2)
    expect(clearOpenWindow).toHaveBeenCalledWith('a')
  })

  it.each(['opening', 'closing'] as OpenWindowState[])(
    'state=%s 且归属进程已死 → 跳过（不关窗、不清登记）',
    async (state) => {
      const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: ['a'], rows: [makeRow({ ownerPid: 999999999, state })] })
      expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
      expect(closeBrowser).not.toHaveBeenCalled()
      expect(clearOpenWindow).not.toHaveBeenCalled()
    },
  )

  it('归属进程存活 → 不回收', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: ['a'], rows: [makeRow({ ownerPid: process.pid })] })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(clearOpenWindow).not.toHaveBeenCalled()
  })

  it('关窗失败 → 保留 closing 登记、不清行', async () => {
    const { deps, closeBrowser, clearOpenWindow, setWindowState } = makeDeps({
      alive: ['a'],
      rows: [makeRow({ ownerPid: 999999999 })],
      closeFails: true,
    })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).toHaveBeenCalledWith('a')
    expect(setWindowState).toHaveBeenCalledWith('a', 'closing')
    expect(clearOpenWindow).not.toHaveBeenCalled()
  })

  it('关窗后 pids 仍存活（确认超时）→ 保留 closing 登记、不清行', async () => {
    vi.useFakeTimers()
    const { deps, closeBrowser, clearOpenWindow, setWindowState } = makeDeps({
      alive: ['a'],
      aliveAfterClose: ['a'],
      rows: [makeRow({ ownerPid: 999999999 })],
    })
    const p = reclaimOrphanWindows(deps, logger)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await p).toBe(0)
    expect(closeBrowser).toHaveBeenCalledWith('a')
    expect(setWindowState).toHaveBeenCalledWith('a', 'closing')
    expect(clearOpenWindow).not.toHaveBeenCalled()
  })

  it('state=open 的死登记行（pid 已不在存活集）只清登记、不误关', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: [], rows: [makeRow()] })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(clearOpenWindow).toHaveBeenCalledWith('a')
  })

  it.each(['opening', 'closing'] as OpenWindowState[])(
    'state=%s 的死登记行 → 跳过（交由关窗路径/后续对账处理）',
    async (state) => {
      const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: [], rows: [makeRow({ state })] })
      expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
      expect(closeBrowser).not.toHaveBeenCalled()
      expect(clearOpenWindow).not.toHaveBeenCalled()
    },
  )

  it('占用探测失败 → 不回收任何窗口', async () => {
    const { deps, closeBrowser, clearOpenWindow } = makeDeps({ alive: [], rows: [], probeFails: true })
    expect(await reclaimOrphanWindows(deps, logger)).toBe(0)
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(clearOpenWindow).not.toHaveBeenCalled()
  })

  it('waitForWindowClosed：探测异常按未确认处理', async () => {
    await expect(waitForWindowClosed(async () => { throw new Error('probe boom') }, { timeoutMs: 10 })).resolves.toBe(false)
  })

  it('isProcessAlive：当前进程存活 / 不存在的 pid 为假', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(999999999)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })
})

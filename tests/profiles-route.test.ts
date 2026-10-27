/**
 * 窗口路由单测：登记清理与手动开窗不得误改窗口归属/误清在用登记
 */
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { profilesRouter } from '../src/server/routes/profiles'
import { errorHandler } from '../src/server/http/error'
import type { Logger } from '../src/infrastructure/logger'
import type { AppDb, OpenWindowRow, ProfileRow } from '../src/infrastructure/db'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

function makeRow(over: Partial<OpenWindowRow> = {}): OpenWindowRow {
  return {
    bitbrowserId: 'bb-1',
    http: '127.0.0.1:61234',
    ownerPid: process.pid,
    state: 'open',
    ownerKind: 'pool',
    lastUsedAt: null,
    tasksDone: 0,
    ...over,
  }
}

function makeApp(opts: { row?: OpenWindowRow | null; openIds?: string[] } = {}) {
  const profile = {
    id: 1,
    bitbrowserId: 'bb-1',
    name: '窗口1',
    enabled: 1,
    circuitBreakerCount: 0,
  } as ProfileRow
  const clearOpenWindow = vi.fn().mockResolvedValue(undefined)
  const reserveOpenWindow = vi.fn().mockResolvedValue(undefined)
  const db = {
    listProfiles: vi.fn().mockResolvedValue([profile]),
    getOpenWindow: vi.fn().mockResolvedValue(opts.row ?? null),
    clearOpenWindow,
    reserveOpenWindow,
    setOpenWindow: vi.fn().mockResolvedValue(undefined),
    setWindowState: vi.fn().mockResolvedValue(undefined),
    setProfileEnabled: vi.fn().mockResolvedValue(undefined),
    resetWindowHealth: vi.fn().mockResolvedValue(undefined),
    hasRunningRun: vi.fn().mockResolvedValue(false),
  } as unknown as AppDb
  const openBrowser = vi.fn().mockResolvedValue({ http: '127.0.0.1:61234', ws: '' })
  const bitbrowser = {
    openPids: vi.fn().mockResolvedValue(new Set(opts.openIds ?? [])),
    isOpen: vi.fn().mockResolvedValue(false),
    openBrowser,
    closeBrowser: vi.fn().mockResolvedValue(undefined),
  }
  const app = express()
  app.use(express.json())
  app.use('/api', profilesRouter({ db, bitbrowser, maxOpenWindows: 4, cancelSession: vi.fn(), logger }))
  app.use(errorHandler(logger))
  return { app, clearOpenWindow, reserveOpenWindow, openBrowser }
}

describe('GET /api/profiles 登记清理', () => {
  it('pid 探测缺失但归属进程存活：不清理登记（交给调度器对账）', async () => {
    const h = makeApp({ row: makeRow() })
    const res = await request(h.app).get('/api/profiles')
    expect(res.status).toBe(200)
    expect(h.clearOpenWindow).not.toHaveBeenCalled()
  })

  it('归属进程已死且 pid 缺失：清理残留登记', async () => {
    const h = makeApp({ row: makeRow({ ownerPid: 999999999 }) })
    const res = await request(h.app).get('/api/profiles')
    expect(res.status).toBe(200)
    expect(h.clearOpenWindow).toHaveBeenCalledWith('bb-1')
  })
})

describe('POST /api/profiles/:id/open 归属保护', () => {
  it('开窗预留进行中：不重复开窗、不改写归属', async () => {
    const h = makeApp({ row: makeRow({ http: '', state: 'opening' }) })
    const res = await request(h.app).post('/api/profiles/1/open')
    expect(res.status).toBe(200)
    expect(h.reserveOpenWindow).not.toHaveBeenCalled()
    expect(h.openBrowser).not.toHaveBeenCalled()
  })
})

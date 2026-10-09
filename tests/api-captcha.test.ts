import { describe, it, expect, vi, beforeEach } from 'vitest'

// 捕获 api 层对 automation 的调用：无 waitMs 应走单次点击，有 waitMs 应走预算内轮询
const mocks = vi.hoisted(() => ({
  clickTurnstileBox: vi.fn(async (_deps: unknown, _opts?: unknown) => true),
  autoClickTurnstile: vi.fn(async (_deps: unknown, _budget?: number) => true),
}))

vi.mock('../src/automation', () => ({
  clickTurnstileBox: mocks.clickTurnstileBox,
  autoClickTurnstile: mocks.autoClickTurnstile,
}))

import { clickTurnstile } from '../src/api'

function makeCtx() {
  const page = { marker: 'page' }
  const log = { info: vi.fn(), warn: vi.fn() }
  return { page, log, profile: { name: '窗口1' } } as never
}

describe('api/captcha clickTurnstile', () => {
  beforeEach(() => {
    mocks.clickTurnstileBox.mockClear()
    mocks.autoClickTurnstile.mockClear()
  })

  it('无 waitMs：调用 clickTurnstileBox，透传 selectors/maxAttempts，不调 autoClickTurnstile', async () => {
    const ctx = makeCtx() as unknown as { page: unknown; log: unknown }
    await clickTurnstile(ctx as never, { selectors: ['#box'], maxAttempts: 2 })
    expect(mocks.clickTurnstileBox).toHaveBeenCalledTimes(1)
    expect(mocks.autoClickTurnstile).not.toHaveBeenCalled()
    const [deps, opts] = mocks.clickTurnstileBox.mock.calls[0]
    expect((deps as { page: unknown }).page).toBe(ctx.page)
    expect(opts).toEqual({ selectors: ['#box'], maxAttempts: 2 })
  })

  it('有 waitMs：调用 autoClickTurnstile 并传 waitMs，不调 clickTurnstileBox', async () => {
    const ctx = makeCtx() as unknown as { page: unknown; log: unknown }
    await clickTurnstile(ctx as never, { waitMs: 8000 })
    expect(mocks.autoClickTurnstile).toHaveBeenCalledTimes(1)
    expect(mocks.clickTurnstileBox).not.toHaveBeenCalled()
    const [deps, budget] = mocks.autoClickTurnstile.mock.calls[0]
    expect((deps as { page: unknown }).page).toBe(ctx.page)
    expect(budget).toBe(8000)
  })

  it('传给底层的是注入窗口名的日志器（对象日志合并 window、字符串日志透传）', async () => {
    const ctx = makeCtx() as unknown as { page: unknown; log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } }
    await clickTurnstile(ctx as never)
    const [deps] = mocks.clickTurnstileBox.mock.calls[0]
    const logger = (deps as { logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } }).logger
    logger.info({ step: 'turnstile' }, '检测到')
    logger.info('纯消息')
    logger.warn({ step: 'turnstile', err: 'x' }, '被拒')
    expect(ctx.log.info).toHaveBeenNthCalledWith(1, { step: 'turnstile', window: '窗口1' }, '检测到')
    expect(ctx.log.info).toHaveBeenNthCalledWith(2, '纯消息')
    expect(ctx.log.warn).toHaveBeenNthCalledWith(1, { step: 'turnstile', err: 'x', window: '窗口1' }, '被拒')
  })

  it('waitMs 为 0：视为未指定，走 clickTurnstileBox', async () => {
    await clickTurnstile(makeCtx(), { waitMs: 0 })
    expect(mocks.clickTurnstileBox).toHaveBeenCalledTimes(1)
    expect(mocks.autoClickTurnstile).not.toHaveBeenCalled()
  })

  it('透传底层返回值', async () => {
    mocks.clickTurnstileBox.mockResolvedValueOnce(false)
    expect(await clickTurnstile(makeCtx())).toBe(false)
    mocks.autoClickTurnstile.mockResolvedValueOnce(false)
    expect(await clickTurnstile(makeCtx(), { waitMs: 500 })).toBe(false)
  })
})

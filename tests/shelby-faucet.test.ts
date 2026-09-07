/**
 * Shelby 领水任务单测：判定函数与领取循环的纯逻辑分支（注入假 page/human，不连真浏览器）
 */
import { describe, it, expect, vi } from 'vitest'
import { judgeFundResponse, runClaimLoop, type FundResponse } from '../src/tasks/shelby-faucet'
import { TaskContext } from '../src/tasks/base'

/** 构造注入假依赖的 TaskContext（page/human 按需 mock，logger 用 vi.fn 可断言） */
function makeCtx(responses: FundResponse[] = []) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const queue = [...responses]
  const page = {
    locator: () => ({
      first: () => ({ inputValue: vi.fn().mockResolvedValue('0x1'), fill: vi.fn().mockResolvedValue(undefined) }),
    }),
    waitForResponse: vi.fn(() => Promise.resolve({ json: () => Promise.resolve(queue.shift() ?? null) })),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = new TaskContext({
    page: page as never,
    task: { meta: { key: 'shelby-apt-faucet', name: 'Shelby APT 领水', url: '' } },
    human: { click: vi.fn().mockResolvedValue(undefined) } as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: {},
  })
  return { ctx, log }
}

describe('judgeFundResponse 判定', () => {
  it('txn_hashes 非空 → success', () => {
    expect(judgeFundResponse({ txn_hashes: ['0xabc'] })).toBe('success')
  })

  it('UsageLimitExhausted → limit', () => {
    expect(
      judgeFundResponse({
        message: 'Request rejected by 1 checkers',
        error_code: 'Rejected',
        rejection_reasons: [{ reason: 'You have reached the maximum allowed number of requests per day: 10', code: 'UsageLimitExhausted' }],
        txn_hashes: [],
      }),
    ).toBe('limit')
  })

  it('其它拒绝原因 → rejected', () => {
    expect(judgeFundResponse({ error_code: 'Rejected', rejection_reasons: [{ code: 'SomeOtherReason' }], txn_hashes: [] })).toBe('rejected')
  })

  it('响应体为空 → rejected', () => {
    expect(judgeFundResponse(null)).toBe('rejected')
  })
})

describe('runClaimLoop 领取循环', () => {
  it('全部成功 → 领满 maxClaims 次，不抛错', async () => {
    const { ctx } = makeCtx(Array(5).fill({ txn_hashes: ['0xabc'] }))
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(5)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(5)
  })

  it('中途达上限 → 提前退出不抛错，claimed 为已成功次数', async () => {
    const { ctx, log } = makeCtx([
      { txn_hashes: ['0x1'] },
      { txn_hashes: ['0x2'] },
      { error_code: 'Rejected', rejection_reasons: [{ code: 'UsageLimitExhausted' }], txn_hashes: [] },
    ])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(2)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('上限'))).toBe(true)
  })

  it('首轮即达上限（0 次成功）→ 收敛为成功不抛错', async () => {
    const { ctx } = makeCtx([{ error_code: 'Rejected', rejection_reasons: [{ code: 'UsageLimitExhausted' }], txn_hashes: [] }])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(0)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(1)
  })

  it('其它拒绝 → 抛错（进失败重试）', async () => {
    const { ctx } = makeCtx([{ error_code: 'Rejected', rejection_reasons: [{ code: 'SomethingElse' }], txn_hashes: [] }])
    await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('被拒绝')
  })

  it('等待响应超时 → 抛错', async () => {
    const { ctx } = makeCtx([])
    ;(ctx.page.waitForResponse as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'))
    await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('等待 /fund 响应超时')
  })

  it('输入框为空时先回填地址再点击', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    let fillCount = 0
    const page = {
      locator: () => ({
        first: () => ({ inputValue: vi.fn().mockResolvedValue(''), fill: vi.fn().mockImplementation(() => { fillCount++ }) }),
      }),
      waitForResponse: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ txn_hashes: ['0x1'] }) })),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const ctx = new TaskContext({
      page: page as never,
      task: { meta: { key: 'shelby-apt-faucet', name: 'Shelby APT 领水', url: '' } },
      human: { click: vi.fn().mockResolvedValue(undefined) } as never,
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: log as never,
      artifactsDir: '',
      walletPasswords: {},
    })
    await runClaimLoop(ctx, '0x123', 1)
    expect(fillCount).toBe(1)
  })
})

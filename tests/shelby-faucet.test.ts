/**
 * Shelby 领水任务（合并版）单测与集成测试：
 * - 单测：judgeFundResponse 判定与 runClaimLoop 循环的纯逻辑分支（注入假 page/human，不连真浏览器）
 * - 集成：真实 chromium + 本地 fixture + page.route 拦截，验证 run() 跨两页全链路
 */
import { describe, it, expect, vi } from 'vitest'
import { judgeFundResponse, runClaimLoop, ShelbyFaucetTask, type FundResponse } from '../src/tasks/shelby-faucet'
import { TaskContext } from '../src/tasks/base'

/** 假响应：仅含判定所需字段 */
function resp(body: FundResponse | null): { json: () => Promise<FundResponse | null> } {
  return { json: () => Promise.resolve(body) }
}

const SUCCESS_BODY = { txn_hashes: ['0xabc'] }
const LIMIT_BODY = {
  message: 'Request rejected by 1 checkers',
  error_code: 'Rejected',
  rejection_reasons: [{ reason: 'You have reached the maximum allowed number of requests per day: 10', code: 'UsageLimitExhausted' }],
  txn_hashes: [],
}
const REJECT_BODY = { error_code: 'Rejected', rejection_reasons: [{ code: 'SomethingElse' }], txn_hashes: [] }

/** 构造注入假依赖的 TaskContext：waitForResponse 依次返回队列中的值（null 表示超时） */
function makeCtx(responses: Array<{ json: () => Promise<unknown> } | null>, opts: { inputValue?: string } = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const queue = [...responses]
  // 输入框 mock 只构造一次（locator/first 每次调用返回同一实例，供断言检查 fill 调用参数）
  const inputEl = {
    inputValue: vi.fn().mockResolvedValue(opts.inputValue ?? '0x1'),
    fill: vi.fn().mockResolvedValue(undefined),
  }
  const page = {
    locator: () => ({
      first: () => inputEl,
    }),
    waitForResponse: vi.fn(() => Promise.resolve(queue.shift() ?? null)),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = new TaskContext({
    page: page as never,
    task: { meta: { key: 'shelby-faucet', name: 'Shelby 领水', url: '' } },
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
    expect(judgeFundResponse(SUCCESS_BODY)).toBe('success')
  })

  it('UsageLimitExhausted → limit', () => {
    expect(judgeFundResponse(LIMIT_BODY)).toBe('limit')
  })

  it('其它拒绝原因 → rejected', () => {
    expect(judgeFundResponse(REJECT_BODY)).toBe('rejected')
  })

  it('响应体为空 → rejected', () => {
    expect(judgeFundResponse(null)).toBe('rejected')
  })
})

describe('runClaimLoop 领取循环', () => {
  it('全部成功 → 领满 maxClaims 次，不补点', async () => {
    const { ctx } = makeCtx(Array(5).fill(resp(SUCCESS_BODY)))
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(5)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(5)
    expect(ctx.human.click).toHaveBeenCalledTimes(5)
  })

  it('响应超时 → 补点一次后成功', async () => {
    const { ctx } = makeCtx([null, resp(SUCCESS_BODY)])
    const { claimed } = await runClaimLoop(ctx, '0x1', 1)
    expect(claimed).toBe(1)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(2)
    expect(ctx.human.click).toHaveBeenCalledTimes(2)
  })

  it('补点后仍超时 → 抛错（进失败重试）', async () => {
    const { ctx } = makeCtx([null, null])
    await expect(runClaimLoop(ctx, '0x1', 1)).rejects.toThrow('等待 /fund 响应超时')
    expect(ctx.human.click).toHaveBeenCalledTimes(2)
  })

  it('中途达上限 → 提前退出不抛错，claimed 为已成功次数', async () => {
    const { ctx, log } = makeCtx([resp(SUCCESS_BODY), resp(SUCCESS_BODY), resp(LIMIT_BODY)])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(2)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('上限'))).toBe(true)
  })

  it('首轮即达上限（0 次成功）→ 收敛为成功不抛错', async () => {
    const { ctx } = makeCtx([resp(LIMIT_BODY)])
    const { claimed } = await runClaimLoop(ctx, '0x1', 5)
    expect(claimed).toBe(0)
    expect(ctx.page.waitForResponse).toHaveBeenCalledTimes(1)
  })

  it('其它拒绝 → 抛错', async () => {
    const { ctx } = makeCtx([resp(REJECT_BODY)])
    await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('被拒绝')
  })

  it('输入框为空 → 先回填地址再点击', async () => {
    const { ctx } = makeCtx([resp(SUCCESS_BODY)], { inputValue: '' })
    await runClaimLoop(ctx, '0x123', 1)
    const fillCalls = (ctx.page.locator('x').first().fill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fillCalls).toContain('0x123')
  })
})

describe('点击失败不产生孤儿 unhandledRejection', () => {
  it('human.click 抛错 → 立即上抛且无未处理拒绝', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    // 注意：waitForResponse 必须是普通函数返回裸 promise（vi.fn 会因 tinyspy 隐式挂 .then 而遮蔽 unhandledRejection）
    const page = {
      locator: () => ({
        first: () => ({ inputValue: vi.fn().mockResolvedValue('0x1'), fill: vi.fn().mockResolvedValue(undefined) }),
      }),
      waitForResponse: () => new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 10000ms exceeded')), 50)),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const ctx = new TaskContext({
      page: page as never,
      task: { meta: { key: 'shelby-faucet', name: 'Shelby 领水', url: '' } },
      human: { click: vi.fn().mockRejectedValue(new Error('点击失败: 找不到元素 button:has-text("Fund")')) } as never,
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: log as never,
      artifactsDir: '',
      walletPasswords: {},
    })
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(runClaimLoop(ctx, '0x1', 5)).rejects.toThrow('点击失败')
      await new Promise((r) => setTimeout(r, 200))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('ShelbyFaucetTask 元信息', () => {
  it('合并任务 meta 契约正确', () => {
    const t = new ShelbyFaucetTask()
    expect(t.meta.key).toBe('shelby-faucet')
    expect(t.meta.name).toBe('Shelby 领水')
    expect(t.meta.concurrency).toBe(6)
    expect(t.meta.retry?.backoffSec).toBe(120)
    expect(t.usdUrl).toBe('https://docs.shelby.xyz/apis/faucet/shelbyusd')
    expect(t.meta.category).toBe('faucet')
    expect(t.meta.enabled).toBe(true)
  })
})

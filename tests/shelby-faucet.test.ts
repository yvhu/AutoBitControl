/**
 * Shelby 领水任务单测：判定函数与领取循环的纯逻辑分支（注入假 page/human，不连真浏览器）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { judgeFundResponse, runClaimLoop, ShelbyAptFaucetTask, type FundResponse } from '../src/tasks/shelby-faucet'
import { TaskContext } from '../src/tasks/base'
import { Humanizer } from '../src/automation/humanize'

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

describe('Shelby 领水任务集成（真实浏览器 + 本地 fixture + 路由拦截）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'shelby-faucet.html'), 'utf-8'))
    })
    await new Promise<void>((r) => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('run() 完整流程：填地址 → 循环领取 → 达上限提前退出视为成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      // 拦截领水接口：前 2 次成功、第 3 次达上限（验证提前退出收敛）
      let calls = 0
      await page.route('**/faucet.shelbynet.shelby.xyz/fund*', (route) => {
        calls++
        if (calls <= 2) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ txn_hashes: ['0xabc'] }) })
        }
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Request rejected by 1 checkers',
            error_code: 'Rejected',
            rejection_reasons: [{ reason: 'You have reached the maximum allowed number of requests per day: 10', code: 'UsageLimitExhausted' }],
            txn_hashes: [],
          }),
        })
      })
      const task = new ShelbyAptFaucetTask()
      task.meta.url = baseUrl
      const ctx = new TaskContext({
        page,
        task,
        human: new Humanizer(page),
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-faucet-test-artifacts'),
        walletPasswords: {},
        accountRow: { petra钱包地址: '0x835e' },
      })
      await task.run(ctx)
      expect(calls).toBe(3)
      expect(await page.locator('input[name="address"]').inputValue()).toBe('0x835e')
    } finally {
      await browser.close()
    }
  }, 90000)
})

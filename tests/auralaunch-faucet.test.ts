/**
 * AuraLaunch 领水任务（auralaunch-faucet）单测：响应判定/UI 兜底竞速/主流程分支（注入假 page/human，不连真浏览器）
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ADDRESS_SELECTOR,
  REQUEST_BTN_SELECTOR,
  judgeFaucetResponse,
  unwrapTrpcEnvelope,
  waitFaucetResponse,
  waitUiOutcome,
  waitInputReady,
  AuralaunchFaucetTask,
} from '../src/tasks/auralaunch-faucet'
import { TaskContext } from '../src/tasks/base'

/** 假领水响应候选：body 为 'json-error' 时 json() 抛错（模拟非 JSON 响应体） */
interface FakeRespCandidate {
  status: number
  method: string
  postData: string
  body: unknown
}

function makeFakeResponse(c: FakeRespCandidate) {
  return {
    status: () => c.status,
    json: async () => {
      if (c.body === 'json-error') throw new Error('not json')
      return c.body
    },
  }
}

/** 构造注入假依赖的 TaskContext：locator 按选择器路由，waitForResponse 按候选响应过滤 */
function makeCtx(opts: {
  btnVisible?: boolean
  texts?: Record<string, boolean>
  resp?: FakeRespCandidate | null
  /** 按 waitForResponse 调用次序返回的响应序列（补点重试场景：首次 null 再命中）；优先于 resp */
  respSeq?: Array<FakeRespCandidate | null>
  addressValue?: string
  bodyText?: string
  /** 首填不生效（模拟站点自动填覆盖失败），第二次 fill 才生效 */
  failFirstFill?: boolean
  /** 地址框是否可编辑（默认 true；false 模拟已领取限频的 disabled 状态） */
  addressEnabled?: boolean
  /** 地址框是否存在（默认 true；false 模拟页面未渲染出输入框） */
  addressExists?: boolean
}) {
  const state = {
    btnVisible: opts.btnVisible ?? true,
    texts: opts.texts ?? {},
    addressValue: opts.addressValue ?? '',
    fills: [] as string[],
    fillAttempts: 0,
    failFirstFill: opts.failFirstFill ?? false,
    addressEnabled: opts.addressEnabled ?? true,
    addressExists: opts.addressExists ?? true,
    resp: opts.resp === undefined ? null : opts.resp,
    respSeq: opts.respSeq ? [...opts.respSeq] : null,
    bodyText: opts.bodyText ?? '',
  }
  const clicks = vi.fn().mockResolvedValue(undefined)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const page = {
    locator: (sel: string) => ({
      first: () => {
        if (sel === ADDRESS_SELECTOR) {
          return {
            count: async () => (state.addressExists ? 1 : 0),
            isEnabled: async () => state.addressEnabled,
            fill: vi.fn().mockImplementation(async (v: string) => {
              state.fillAttempts++
              if (state.failFirstFill && state.fillAttempts === 1) return
              state.addressValue = v
              state.fills.push(v)
            }),
            inputValue: async () => state.addressValue,
          }
        }
        return {
          count: async () => (state.btnVisible ? 1 : 0),
          isVisible: async () => state.btnVisible,
        }
      },
    }),
    waitForResponse: (pred: (r: never) => boolean) => {
      const c = state.respSeq && state.respSeq.length > 0 ? (state.respSeq.shift() ?? null) : state.resp
      if (!c) return Promise.resolve(null)
      const ok = pred({
        request: () => ({ method: () => c.method, postData: () => c.postData }),
      } as never)
      if (!ok) return Promise.resolve(null)
      return Promise.resolve(makeFakeResponse(c))
    },
    getByText: (t: string) => ({ count: async () => (state.texts[t] ? 1 : 0) }),
    // 真实 setTimeout：假时钟测试里由 advanceTimersByTimeAsync 驱动，避免空转
    waitForTimeout: async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms))
    },
    reload: vi.fn().mockResolvedValue(undefined),
    evaluate: async () => state.bodyText,
  }
  const ctx = new TaskContext({
    page: page as never,
    task: new AuralaunchFaucetTask(),
    human: { click: clicks } as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: mkdtempSync(join(tmpdir(), 'auralaunch-faucet-test-')),
    walletPasswords: {},
    accountRow: { metamask钱包地址: '0xabc' },
  })
  return { ctx, clicks, log, state }
}

/** run 全流程所需引擎能力假实现（开页/断言/截图与站点判定逻辑无关） */
function stubRunCapabilities(ctx: TaskContext): void {
  ctx.closeOtherTabs = vi.fn().mockResolvedValue(undefined)
  ctx.goto = vi.fn().mockResolvedValue(undefined)
  ctx.assertVisible = vi.fn().mockResolvedValue(undefined)
  ctx.screenshot = vi.fn().mockResolvedValue('/tmp/x.png')
}

describe('unwrapTrpcEnvelope 信封解包', () => {
  it('成功信封 → success:true', () => {
    expect(unwrapTrpcEnvelope([{ result: { data: { json: { success: true } } } }])).toEqual({ success: true, message: '' })
  })

  it('失败信封 → success:false + message（真机：Failed to send transaction 也返回 200）', () => {
    const r = unwrapTrpcEnvelope([{ result: { data: { json: { success: false, message: 'Failed to send transaction' } } } }])
    expect(r).toEqual({ success: false, message: 'Failed to send transaction' })
  })

  it('限频错误信封（无 result）→ null（限频由关键词/状态码判定）', () => {
    expect(unwrapTrpcEnvelope([{ error: { json: { message: 'You can only request funds once every 24 hours' } } }])).toBeNull()
  })

  it('非批量信封 → null', () => {
    expect(unwrapTrpcEnvelope({ ok: true })).toBeNull()
  })
})

describe('judgeFaucetResponse 响应判定', () => {
  it('200 + tRPC 成功信封 success:true → success', async () => {
    const res = makeFakeResponse({ status: 200, method: 'POST', postData: '', body: [{ result: { data: { json: { success: true } } } }] }) as never
    expect(await judgeFaucetResponse(res)).toBe('success')
  })

  it('200 + tRPC 失败信封 success:false → rejected（真机：不能只看状态码）', async () => {
    const res = makeFakeResponse({ status: 200, method: 'POST', postData: '', body: [{ result: { data: { json: { success: false, message: 'Failed to send transaction' } } } }] }) as never
    expect(await judgeFaucetResponse(res)).toBe('rejected')
  })

  it('429 + 限频信封（TOO_MANY_REQUESTS）→ limit', async () => {
    const res = makeFakeResponse({ status: 429, method: 'POST', postData: '', body: [{ error: { json: { message: 'You can only request funds once every 24 hours. Please try again later.', code: -32029 } } }] }) as never
    expect(await judgeFaucetResponse(res)).toBe('limit')
  })

  it('429 非 JSON 响应体 → limit（状态码兜底）', async () => {
    const res = makeFakeResponse({ status: 429, method: 'POST', postData: '', body: 'json-error' }) as never
    expect(await judgeFaucetResponse(res)).toBe('limit')
  })

  it('200 无信封 → success（兜底）', async () => {
    const res = makeFakeResponse({ status: 200, method: 'POST', postData: '', body: { ok: true } }) as never
    expect(await judgeFaucetResponse(res)).toBe('success')
  })

  it('400 无信封 → rejected', async () => {
    const res = makeFakeResponse({ status: 400, method: 'POST', postData: '', body: { error: 'invalid address' } }) as never
    expect(await judgeFaucetResponse(res)).toBe('rejected')
  })
})

describe('waitFaucetResponse 响应捕获', () => {
  it('POST 且请求体含地址 → 返回响应', async () => {
    const { ctx } = makeCtx({ resp: { status: 200, method: 'POST', postData: '{"address":"0xabc"}', body: {} } })
    expect(await waitFaucetResponse(ctx, '0xabc')).not.toBeNull()
  })

  it('GET 请求 → 谓词不命中返回 null', async () => {
    const { ctx } = makeCtx({ resp: { status: 200, method: 'GET', postData: '', body: {} } })
    expect(await waitFaucetResponse(ctx, '0xabc')).toBeNull()
  })

  it('POST 请求体不含地址 → 谓词不命中返回 null（分析类请求自然排除）', async () => {
    const { ctx } = makeCtx({ resp: { status: 200, method: 'POST', postData: '{"event":"pageview"}', body: {} } })
    expect(await waitFaucetResponse(ctx, '0xabc')).toBeNull()
  })

  it('无任何响应 → null', async () => {
    const { ctx } = makeCtx({})
    expect(await waitFaucetResponse(ctx, '0xabc')).toBeNull()
  })
})

describe('waitUiOutcome UI 兜底竞速', () => {
  it('成功文案出现 → success', async () => {
    const { ctx } = makeCtx({ texts: { 'Successfully requested funds to your wallet': true } })
    expect(await waitUiOutcome(ctx, 500)).toBe('success')
  })

  it('限频文案出现 → limit', async () => {
    const { ctx } = makeCtx({ texts: { 'sorry, something went wrong': true } })
    expect(await waitUiOutcome(ctx, 500)).toBe('limit')
  })

  it('成功与限频均无 → none（超时）', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({})
      const assertion = expect(waitUiOutcome(ctx)).resolves.toBe('none')
      await vi.advanceTimersByTimeAsync(31_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('waitInputReady 地址框就绪等待', () => {
  it('输入框存在且可编辑 → ready', async () => {
    const { ctx } = makeCtx({ addressEnabled: true })
    expect(await waitInputReady(ctx, 200)).toBe('ready')
  })

  it('输入框存在但持续禁用 → disabled', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({ addressEnabled: false })
      const assertion = expect(waitInputReady(ctx, 500)).resolves.toBe('disabled')
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('输入框未出现 → 刷新兜底后仍无 → missing', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({ addressExists: false })
      const assertion = expect(waitInputReady(ctx, 500)).resolves.toBe('missing')
      // 首轮 poll 500ms + reload + 兜底 poll 30s：推进 31s 走完两条预算
      await vi.advanceTimersByTimeAsync(31_000)
      await assertion
      expect((ctx.page as unknown as { reload: ReturnType<typeof vi.fn> }).reload).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AuralaunchFaucetTask run 主流程', () => {
  it('填数据源地址 → 点 Request → tRPC 成功信封 → 成功截图', async () => {
    const { ctx, clicks, state } = makeCtx({ resp: { status: 200, method: 'POST', postData: '{"address":"0xabc"}', body: [{ result: { data: { json: { success: true } } } }] } })
    stubRunCapabilities(ctx)
    await new AuralaunchFaucetTask().run(ctx)
    expect(state.fills).toEqual(['0xabc'])
    expect(clicks).toHaveBeenCalledWith(REQUEST_BTN_SELECTOR)
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(ctx.screenshot).toHaveBeenCalledWith('auralaunch-faucet-success')
  })

  it('429 限频信封 → 视为已领取=成功（重跑幂等；真机 TOO_MANY_REQUESTS）', async () => {
    const { ctx, log } = makeCtx({
      resp: { status: 429, method: 'POST', postData: '{"address":"0xabc"}', body: [{ error: { json: { message: 'You can only request funds once every 24 hours. Please try again later.', code: -32029 } } }] },
    })
    stubRunCapabilities(ctx)
    await expect(new AuralaunchFaucetTask().run(ctx)).resolves.toBeUndefined()
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ step: 'faucet' }), expect.stringContaining('上限'))
  })

  it('200 + success:false 失败信封 → 抛错（带信封 message；真机：失败同样 200）', async () => {
    const { ctx } = makeCtx({
      resp: { status: 200, method: 'POST', postData: '{"address":"0xabc"}', body: [{ result: { data: { json: { success: false, message: 'Failed to send transaction' } } } }] },
    })
    stubRunCapabilities(ctx)
    await expect(new AuralaunchFaucetTask().run(ctx)).rejects.toThrow('领水请求被拒绝: Failed to send transaction')
  })

  it('首次点击未捕获请求（Turnstile 未就绪）→ 补点一次后捕获成功信封 → 成功', async () => {
    const { ctx, clicks } = makeCtx({
      respSeq: [
        null,
        { status: 200, method: 'POST', postData: '{"0":{"json":{"recipientAddress":"0xabc"}}}', body: [{ result: { data: { json: { success: true } } } }] },
      ],
    })
    stubRunCapabilities(ctx)
    await new AuralaunchFaucetTask().run(ctx)
    expect(clicks).toHaveBeenCalledTimes(2)
    expect(ctx.screenshot).toHaveBeenCalledWith('auralaunch-faucet-success')
  }, 15000)

  it('未捕获响应 + 成功文案 → 成功（UI 兜底 success）', async () => {
    const { ctx } = makeCtx({ texts: { 'Successfully requested funds to your wallet': true } })
    stubRunCapabilities(ctx)
    await expect(new AuralaunchFaucetTask().run(ctx)).resolves.toBeUndefined()
    expect(ctx.screenshot).toHaveBeenCalledWith('auralaunch-faucet-success')
  }, 15000)

  it('未捕获响应 + 限频文案 → 已领取=成功（UI 兜底 limit，截图带 limit 后缀）', async () => {
    const { ctx } = makeCtx({ texts: { 'sorry, something went wrong': true } })
    stubRunCapabilities(ctx)
    await expect(new AuralaunchFaucetTask().run(ctx)).resolves.toBeUndefined()
    expect(ctx.screenshot).toHaveBeenCalledWith('auralaunch-faucet-limit')
  }, 15000)

  it('未捕获响应 + 无任何信号 → 抛错（带页面文本辅助排障）', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({ btnVisible: true, bodyText: 'Request | LiteForge faucet' })
      stubRunCapabilities(ctx)
      const assertion = expect(new AuralaunchFaucetTask().run(ctx)).rejects.toThrow('点击 Request 后未出现成功/限频信号')
      // 补点等待 5s + UI 兜底竞速 30s + 余量
      await vi.advanceTimersByTimeAsync(36_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('首填后输入框值不一致（站点自动填覆盖失败）→ 重填一次', async () => {
    const { ctx, state } = makeCtx({ failFirstFill: true, resp: { status: 200, method: 'POST', postData: '{"address":"0xabc"}', body: {} } })
    stubRunCapabilities(ctx)
    await new AuralaunchFaucetTask().run(ctx)
    expect(state.fillAttempts).toBe(2)
    expect(state.fills).toEqual(['0xabc'])
    expect(ctx.screenshot).toHaveBeenCalledWith('auralaunch-faucet-success')
  })

  it('地址框禁用且页面出现限频提示 → 已领取=成功（真机：窗口99 已领后 disabled）', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({ addressEnabled: false, texts: { '24 hours': true } })
      stubRunCapabilities(ctx)
      const assertion = expect(new AuralaunchFaucetTask().run(ctx)).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(46_000)
      await assertion
      expect(ctx.screenshot).toHaveBeenCalledWith('auralaunch-faucet-limit')
    } finally {
      vi.useRealTimers()
    }
  })

  it('地址框禁用且无限频提示 → 抛错（带页面文本排障）', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({ addressEnabled: false, bodyText: 'LiteForge faucet loading...' })
      stubRunCapabilities(ctx)
      const assertion = expect(new AuralaunchFaucetTask().run(ctx)).rejects.toThrow('地址输入框持续禁用且无限频提示')
      await vi.advanceTimersByTimeAsync(46_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('地址框未出现（刷新兜底后）→ 抛错', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({ addressExists: false })
      stubRunCapabilities(ctx)
      const assertion = expect(new AuralaunchFaucetTask().run(ctx)).rejects.toThrow('地址输入框未出现')
      await vi.advanceTimersByTimeAsync(80_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('meta：key/url/分类/无钱包/重试并发正确', () => {
    const t = new AuralaunchFaucetTask()
    expect(t.meta.key).toBe('auralaunch-faucet')
    expect(t.meta.name).toBe('AuraLaunch 领水')
    expect(t.meta.group).toEqual({ key: 'auralaunch', name: 'AuraLaunch' })
    expect(t.meta.url).toBe('https://liteforge.hub.caldera.xyz/')
    expect(t.meta.category).toBe('faucet')
    expect(t.meta.enabled).toBe(true)
    expect(t.meta.wallet).toBeUndefined()
    expect(t.meta.timeoutSec).toBe(300)
    expect(t.meta.retry).toEqual({ max: 2, backoffSec: 120 })
    expect(t.meta.concurrency).toBe(3)
  })
})

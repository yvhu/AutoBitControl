import { describe, it, expect, afterEach, vi } from 'vitest'
import { YesCaptchaClient, CaptchaService, detectCaptcha, CaptchaFailure } from '../src/integrations/yescaptcha'

afterEach(() => { vi.unstubAllGlobals() })

const cfg = {
  apiBase: 'https://api.yescaptcha.com',
  clientKey: 'test-key',
  solveTimeoutMs: 5000,
  pollIntervalMs: 100,
}

describe('YesCaptchaClient', () => {
  it('solveCaptcha 创建任务并轮询到 turnstile token', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (String(url).includes('createTask')) {
        expect(body.task.type).toBe('TurnstileTaskProxyless')
        expect(body.task.websiteKey).toBe('sk123')
        expect(body.task.websiteURL).toBe('https://x.io')
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      polls++
      return new Response(JSON.stringify(
        polls === 1
          ? { errorId: 0, status: 'processing' }
          : { errorId: 0, status: 'ready', solution: { token: 'tok-abc' } }
      ), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { turnstile: 'TurnstileTaskProxyless' })
    const token = await client.solveCaptcha('turnstile', 'sk123', 'https://x.io')
    expect(token).toBe('tok-abc')
  })

  it('reCAPTCHA 类任务从 solution.gRecaptchaResponse 取结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'resp-abc' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { recaptcha_v2: 'NoCaptchaTaskProxyless' })
    const token = await client.solveCaptcha('recaptcha_v2', 'sk', 'https://x.io')
    expect(token).toBe('resp-abc')
  })

  it('同时两个 solveCaptcha 串行执行（每账号 1 并发限制）', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 50))
        inFlight--
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 't' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { turnstile: 'TurnstileTaskProxyless' })
    await Promise.all([
      client.solveCaptcha('turnstile', 'sk1', 'https://x.io'),
      client.solveCaptcha('turnstile', 'sk2', 'https://x.io'),
    ])
    expect(peak).toBe(1)
  })

  it('超时抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'processing' }), { status: 200 })
    }))
    const client = new YesCaptchaClient({ ...cfg, solveTimeoutMs: 200 }, { turnstile: 'TurnstileTaskProxyless' })
    await expect(client.solveCaptcha('turnstile', 'sk', 'https://x.io')).rejects.toThrow(/超时/)
  })

  it('余额不足抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errorId: 0, balance: 100 }), { status: 200 })))
    const client = new YesCaptchaClient(cfg, { turnstile: 'TurnstileTaskProxyless' })
    await expect(client.ensureBalance(500)).rejects.toThrow(/余额不足/)
  })

  it('extra 参数透传（isInvisible）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        expect(JSON.parse(String(init.body)).task.isInvisible).toBe(true)
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'r' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { recaptcha_v2: 'NoCaptchaTaskProxyless' })
    await client.solveCaptcha('recaptcha_v2', 'sk', 'https://x.io', { isInvisible: true })
  })

  it('轮询返回 errorId!==0 时立即失败（fail fast，不等超时）', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      polls++
      return new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST' }), { status: 200 })
    }))
    const client = new YesCaptchaClient({ ...cfg, solveTimeoutMs: 3000 }, { turnstile: 'TurnstileTaskProxyless' })
    await expect(client.solveCaptcha('turnstile', 'sk', 'https://x.io')).rejects.toThrow(/ERROR_KEY_DOES_NOT_EXIST/)
    expect(polls).toBe(1)
  })

  it('平台省略 errorId 字段时按成功处理（不误判失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ status: 'ready', solution: { gRecaptchaResponse: 'resp-ok' } }), { status: 200 })
    }))
    const client = new YesCaptchaClient(cfg, { recaptcha_v2: 'NoCaptchaTaskProxyless' })
    await expect(client.solveCaptcha('recaptcha_v2', 'sk', 'https://x.io')).resolves.toBe('resp-ok')
  })
})

/** 最小 fake page：locator 按选择器分派 count/getAttribute，evaluate 仅记录调用不执行 DOM */
function makeFakePage(behaviors: Record<string, { count: number; attrs?: Record<string, string | null> }>) {
  const evaluate = vi.fn()
  const page = {
    locator: (selector: string) => {
      const b = behaviors[selector] ?? { count: 0, attrs: {} }
      const fake = {
        first: () => fake,
        count: vi.fn().mockResolvedValue(b.count),
        getAttribute: vi.fn().mockImplementation(async (name: string) => b.attrs?.[name] ?? null),
      }
      return fake
    },
    url: vi.fn().mockReturnValue('https://x.io'),
    evaluate,
  }
  return { page, evaluate }
}

describe('detectCaptcha', () => {
  it('检测到 turnstile iframe 并从 src 提取 sitekey', async () => {
    const { page } = makeFakePage({
      'iframe[src*="challenges.cloudflare.com"]': { count: 1, attrs: { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?k=0x4AAAAAAADnpidROrmt1Wwj' } },
    })
    await expect(detectCaptcha(page as never)).resolves.toEqual({ kind: 'turnstile', sitekey: '0x4AAAAAAADnpidROrmt1Wwj' })
  })

  it('检测到 recaptcha v3 脚本并提取 render sitekey', async () => {
    const { page } = makeFakePage({
      'script[src*="recaptcha/api.js"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api.js?render=6LcV3abcXYZ' } },
    })
    await expect(detectCaptcha(page as never)).resolves.toEqual({ kind: 'recaptcha_v3', sitekey: '6LcV3abcXYZ' })
  })

  it('render=explicit 是 v2 显式渲染模式，不误判为 v3（落到底返回 null）', async () => {
    const { page } = makeFakePage({
      'script[src*="recaptcha/api.js"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api.js?render=explicit' } },
    })
    await expect(detectCaptcha(page as never, 50)).resolves.toBeNull()
  })

  it('超时窗口内未检测到返回 null', async () => {
    const { page } = makeFakePage({})
    await expect(detectCaptcha(page as never, 0)).resolves.toBeNull()
  })
})

describe('CaptchaService.applyToken', () => {
  it('turnstile 回填：evaluate 用 isolatedContext=false 且选择器正确', async () => {
    const { page, evaluate } = makeFakePage({
      'iframe[src*="challenges.cloudflare.com"]': { count: 1, attrs: { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?k=sk-t' } },
    })
    const client = { ensureBalance: vi.fn().mockResolvedValue(undefined), solveCaptcha: vi.fn().mockResolvedValue('tok-1') }
    const onLog = vi.fn()
    const service = new CaptchaService(client as never, { maxCostPerTask: 1500 })
    await expect(service.autoSolve(page as never, { enabled: true, profileId: null, taskKey: null, onLog })).resolves.toBe('solved')
    const call = evaluate.mock.calls[0]
    expect(call[1]).toBe('tok-1')
    expect(call[2]).toEqual({})
    expect(call[3]).toBe(false)
    const qs = vi.fn().mockReturnValue(null)
    vi.stubGlobal('document', { querySelector: qs })
    call[0]('tok-1')
    expect(qs).toHaveBeenCalledWith('[name="cf-turnstile-response"]')
    expect(onLog).toHaveBeenCalledWith('turnstile', true, expect.any(Number))
  })

  it('hcaptcha 回填同时写两个 textarea', async () => {
    const { page, evaluate } = makeFakePage({
      'iframe[src*="hcaptcha.com/captcha"]': { count: 1, attrs: { src: 'https://hcaptcha.com/captcha/v1/abc' } },
    })
    const client = { ensureBalance: vi.fn().mockResolvedValue(undefined), solveCaptcha: vi.fn().mockResolvedValue('tok-h') }
    const service = new CaptchaService(client as never, { maxCostPerTask: 1500 })
    await service.autoSolve(page as never, { enabled: true, profileId: null, taskKey: null, onLog: vi.fn() })
    const call = evaluate.mock.calls[0]
    expect(call[3]).toBe(false)
    const qs = vi.fn().mockReturnValue(null)
    vi.stubGlobal('document', { querySelector: qs })
    call[0]('tok-h')
    expect(qs).toHaveBeenCalledWith('textarea[name="h-captcha-response"]')
    expect(qs).toHaveBeenCalledWith('textarea[name="g-recaptcha-response"]')
  })

  it('recaptcha_v2 回填 g-recaptcha-response', async () => {
    const { page, evaluate } = makeFakePage({
      'iframe[src*="recaptcha/api2/anchor"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api2/anchor?k=6LcR2' } },
    })
    const client = { ensureBalance: vi.fn().mockResolvedValue(undefined), solveCaptcha: vi.fn().mockResolvedValue('tok-r') }
    const service = new CaptchaService(client as never, { maxCostPerTask: 1500 })
    await service.autoSolve(page as never, { enabled: true, profileId: null, taskKey: null, onLog: vi.fn() })
    const call = evaluate.mock.calls[0]
    expect(call[3]).toBe(false)
    const qs = vi.fn().mockReturnValue(null)
    vi.stubGlobal('document', { querySelector: qs })
    call[0]('tok-r')
    expect(qs).toHaveBeenCalledWith('textarea[name="g-recaptcha-response"]')
  })

  it('recaptcha_v3 检测后回填 g-recaptcha-response 并透传类型解题', async () => {
    const { page, evaluate } = makeFakePage({
      'script[src*="recaptcha/api.js"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api.js?render=6LcV3' } },
    })
    const client = { ensureBalance: vi.fn().mockResolvedValue(undefined), solveCaptcha: vi.fn().mockResolvedValue('tok-v3') }
    const service = new CaptchaService(client as never, { maxCostPerTask: 1500 })
    await service.autoSolve(page as never, { enabled: true, profileId: null, taskKey: null, onLog: vi.fn() })
    expect(client.solveCaptcha).toHaveBeenCalledWith('recaptcha_v3', '6LcV3', 'https://x.io')
    const call = evaluate.mock.calls[0]
    expect(call[3]).toBe(false)
    const qs = vi.fn().mockReturnValue(null)
    vi.stubGlobal('document', { querySelector: qs })
    call[0]('tok-v3')
    expect(qs).toHaveBeenCalledWith('textarea[name="g-recaptcha-response"]')
  })

  it('解题失败包装为 CaptchaFailure 并记失败日志', async () => {
    const { page } = makeFakePage({
      'iframe[src*="challenges.cloudflare.com"]': { count: 1, attrs: { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?k=sk-t' } },
    })
    const client = { ensureBalance: vi.fn().mockResolvedValue(undefined), solveCaptcha: vi.fn().mockRejectedValue(new CaptchaFailure('余额不足')) }
    const onLog = vi.fn()
    const service = new CaptchaService(client as never, { maxCostPerTask: 1500 })
    await expect(service.autoSolve(page as never, { enabled: true, profileId: null, taskKey: null, onLog })).rejects.toThrow(CaptchaFailure)
    expect(onLog).toHaveBeenCalledWith('turnstile', false, expect.any(Number))
  })
})

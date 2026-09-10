import { describe, it, expect, afterEach, vi } from 'vitest'
import { YesCaptchaApiClient } from '../src/integrations/captcha/yescaptcha/client'
import { YesCaptchaProvider } from '../src/integrations/captcha/yescaptcha/provider'
import { CaptchaFailure } from '../src/integrations/captcha/provider'
import { createCaptchaProvider } from '../src/integrations/captcha'

afterEach(() => { vi.unstubAllGlobals() })

const provider = () => new YesCaptchaProvider(
  new YesCaptchaApiClient({ apiBase: 'https://api.yescaptcha.com', clientKey: 'test-key' }),
  { solveTimeoutMs: 5000, pollIntervalMs: 100 },
)

describe('YesCaptchaProvider.solveToken', () => {
  it('创建任务并轮询到 turnstile token（透传类型名与 websiteURL/websiteKey）', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (String(url).includes('createTask')) {
        expect(body.clientKey).toBe('test-key')
        expect(body.task.type).toBe('TurnstileTaskProxyless')
        expect(body.task.websiteKey).toBe('sk123')
        expect(body.task.websiteURL).toBe('https://x.io')
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      polls++
      return new Response(JSON.stringify(
        polls === 1 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution: { token: 'tok-abc' } },
      ), { status: 200 })
    }))
    await expect(provider().solveToken('turnstile', 'sk123', 'https://x.io')).resolves.toBe('tok-abc')
  })

  it('reCAPTCHA 类任务从 solution.gRecaptchaResponse 取结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'resp-abc' } }), { status: 200 })
    }))
    await expect(provider().solveToken('recaptcha_v2', 'sk', 'https://x.io')).resolves.toBe('resp-abc')
  })

  it('无 sitekey 直接抛 CaptchaFailure', async () => {
    await expect(provider().solveToken('turnstile', null, 'https://x.io')).rejects.toBeInstanceOf(CaptchaFailure)
  })

  it('extra 参数透传（isInvisible）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        expect(JSON.parse(String(init.body)).task.isInvisible).toBe(true)
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'r' } }), { status: 200 })
    }))
    await provider().solveToken('recaptcha_v2', 'sk', 'https://x.io', { isInvisible: true })
  })

  it('超时抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'processing' }), { status: 200 })
    }))
    const fast = new YesCaptchaProvider(new YesCaptchaApiClient({ apiBase: 'https://api.yescaptcha.com', clientKey: 'k' }), { solveTimeoutMs: 200, pollIntervalMs: 50 })
    await expect(fast.solveToken('turnstile', 'sk', 'https://x.io')).rejects.toThrow(/超时/)
  })

  it('轮询返回 errorId!==0 立即失败（fail fast）', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      polls++
      return new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST' }), { status: 200 })
    }))
    await expect(provider().solveToken('turnstile', 'sk', 'https://x.io')).rejects.toThrow(/ERROR_KEY_DOES_NOT_EXIST/)
    expect(polls).toBe(1)
  })

  it('平台省略 errorId 字段时按成功处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ status: 'ready', solution: { gRecaptchaResponse: 'resp-ok' } }), { status: 200 })
    }))
    await expect(provider().solveToken('recaptcha_v2', 'sk', 'https://x.io')).resolves.toBe('resp-ok')
  })

  it('两个 solveToken 串行执行（平台每账号 1 并发硬限制）', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 50))
        inFlight--
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 't' } }), { status: 200 })
    }))
    const p = provider()
    await Promise.all([p.solveToken('turnstile', 'sk1', 'https://x.io'), p.solveToken('turnstile', 'sk2', 'https://x.io')])
    expect(peak).toBe(1)
  })
})

describe('YesCaptchaProvider.classifyGrid 九宫格分类', () => {
  it('multi：请求体含 image/question，返回 objects', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        const body = JSON.parse(String(init.body))
        expect(body.task.type).toBe('ReCaptchaV2Classification')
        expect(body.task.image).toBe('b64-img')
        expect(body.task.question).toBe('/m/015qbp')
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { type: 'multi', objects: [1, 5, 8] } }), { status: 200 })
    }))
    await expect(provider().classifyGrid('b64-img', '/m/015qbp')).resolves.toEqual({ type: 'multi', objects: [1, 5, 8] })
  })

  it('single：hasObject 解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { type: 'single', hasObject: true } }), { status: 200 })
    }))
    await expect(provider().classifyGrid('b64', '/m/0k4j')).resolves.toEqual({ type: 'single', hasObject: true })
  })

  it('confidence 可选透传', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('createTask')) {
        expect(JSON.parse(String(init.body)).task.confidence).toBe(0.3)
        return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { objects: [1] } }), { status: 200 })
    }))
    await provider().classifyGrid('b64', '/m/0k4j', 0.3)
  })

  it('创建失败抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_ILLEGAL_IMAGE' }), { status: 200 })))
    await expect(provider().classifyGrid('b64', '/m/0k4j')).rejects.toThrow(/ERROR_ILLEGAL_IMAGE/)
  })

  it('分类超时抛 CaptchaFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('createTask')) return new Response(JSON.stringify({ errorId: 0, taskId: 't-1' }), { status: 200 })
      return new Response(JSON.stringify({ errorId: 0, status: 'processing' }), { status: 200 })
    }))
    const fast = new YesCaptchaProvider(new YesCaptchaApiClient({ apiBase: 'https://api.yescaptcha.com', clientKey: 'k' }), { solveTimeoutMs: 200, pollIntervalMs: 50 })
    await expect(fast.classifyGrid('b64', '/m/0k4j')).rejects.toThrow(/超时/)
  })
})

describe('createCaptchaProvider 工厂', () => {
  it('未配置 clientKey 返回 null（无 Key 也能跑）', () => {
    expect(createCaptchaProvider({ provider: 'yescaptcha', yescaptcha: { apiBase: 'https://api.yescaptcha.com', clientKey: '' } } as never)).toBeNull()
  })

  it('yescaptcha + clientKey 返回 provider（platform 为 yescaptcha）', () => {
    const p = createCaptchaProvider({ provider: 'yescaptcha', solveTimeoutMs: 120000, pollIntervalMs: 3000, maxCostPerTask: 1500, yescaptcha: { apiBase: 'https://api.yescaptcha.com', clientKey: 'k' } } as never)
    expect(p?.platform).toBe('yescaptcha')
  })

  it('未知 provider 返回 null', () => {
    expect(createCaptchaProvider({ provider: 'capsolver', yescaptcha: { apiBase: '', clientKey: 'k' } } as never)).toBeNull()
  })
})

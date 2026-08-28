import { describe, it, expect, afterEach, vi } from 'vitest'
import { YesCaptchaClient } from '../src/integrations/yescaptcha'

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
})

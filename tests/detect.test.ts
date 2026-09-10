import { describe, it, expect, vi } from 'vitest'
import { detectCaptcha } from '../src/automation/captcha/detect'

/** 最小 fake page：locator(selector) 返回 count/getAttribute */
function makePage(selectors: Record<string, { count: number; attrs?: Record<string, string | null> }>) {
  return {
    locator: (sel: string) => ({
      first: () => ({
        count: async () => selectors[sel]?.count ?? 0,
        getAttribute: async (name: string) => selectors[sel]?.attrs?.[name] ?? null,
      }),
    }),
  }
}

describe('detectCaptcha', () => {
  it('普通版 v2 anchor（recaptcha/api2/anchor）识别为 recaptcha_v2，sitekey 从 k= 提取', async () => {
    const page = makePage({
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api2/anchor?k=6LcAAA&co=xxx' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v2', sitekey: '6LcAAA' })
  })

  it('Enterprise v2 anchor（recaptcha/enterprise/anchor）同样识别为 recaptcha_v2（rev2 修复点：此前从未命中）', async () => {
    const page = makePage({
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcENT&co=xxx' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v2', sitekey: '6LcENT' })
  })

  it('turnstile 优先于 recaptcha（DETECTORS 顺序）', async () => {
    const page = makePage({
      'iframe[src*="challenges.cloudflare.com"]': { count: 1, attrs: { src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv0/0/x/0x4AAAA?sitekey=cf-sk' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'turnstile', sitekey: 'cf-sk' })
  })

  it('iframe 无 sitekey 时回退 data-sitekey 属性', async () => {
    const page = makePage({
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api2/anchor' } },
      '[data-sitekey]': { count: 1, attrs: { 'data-sitekey': '6LcFALLBACK' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v2', sitekey: '6LcFALLBACK' })
  })

  it('v3：api.js render 参数提取 sitekey（render=explicit 不视为 v3）', async () => {
    const page = makePage({
      'script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/api.js?render=6LcV3' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v3', sitekey: '6LcV3' })
  })

  it('Enterprise v3（enterprise.js）识别为 recaptcha_v3', async () => {
    const page = makePage({
      'script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]': { count: 1, attrs: { src: 'https://www.google.com/recaptcha/enterprise.js?render=6LcEV3' } },
    })
    await expect(detectCaptcha(page as never, 200)).resolves.toEqual({ kind: 'recaptcha_v3', sitekey: '6LcEV3' })
  })

  it('超时无验证码返回 null', async () => {
    const page = makePage({})
    await expect(detectCaptcha(page as never, 100)).resolves.toBeNull()
  })
})

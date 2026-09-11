/**
 * 打码平台装配工厂与 yescaptcha 余额查询单测：
 * - 工厂：无 clientKey → null；yescaptcha + Key → 平台实例（platform 标识）；未知 provider → null
 * - getBalance：fetch stub 正常返回 balance / errorId≠0 抛错 / balance 缺省为 0（不连真实平台）
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createCaptchaPlatform } from '../src/integrations/captcha'
import { createYesCaptchaPlatform } from '../src/integrations/captcha/yescaptcha'

afterEach(() => { vi.unstubAllGlobals() })

const cfg = (provider: string, clientKey: string) => ({
  provider,
  yescaptcha: { apiBase: 'https://api.yescaptcha.com', clientKey },
})

describe('createCaptchaPlatform 装配工厂', () => {
  it('yescaptcha 无 clientKey → null（无 Key 也能跑，面板显示未配置）', () => {
    expect(createCaptchaPlatform(cfg('yescaptcha', ''))).toBeNull()
  })

  it('yescaptcha 有 clientKey → 平台实例（platform 标识为 yescaptcha）', () => {
    const p = createCaptchaPlatform(cfg('yescaptcha', 'k-1'))
    expect(p).not.toBeNull()
    expect(p!.platform).toBe('yescaptcha')
  })

  it('未知 provider → null', () => {
    expect(createCaptchaPlatform(cfg('capsolver', 'k-1'))).toBeNull()
  })
})

describe('yescaptcha getBalance 余额查询', () => {
  it('正常响应返回 balance 点数（透传 clientKey）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ clientKey: 'test-key' })
      return new Response(JSON.stringify({ errorId: 0, balance: 98210 }), { status: 200 })
    }))
    const platform = createYesCaptchaPlatform({ apiBase: 'https://api.yescaptcha.com', clientKey: 'test-key' })
    await expect(platform.getBalance()).resolves.toBe(98210)
  })

  it('errorId ≠ 0 → 抛错（携带 errorCode）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ errorId: 1002, errorCode: 'ERROR_KEY_DOES_NOT_EXIST' }), { status: 200 }),
    ))
    const platform = createYesCaptchaPlatform({ apiBase: 'https://api.yescaptcha.com', clientKey: 'bad-key' })
    await expect(platform.getBalance()).rejects.toThrow('yescaptcha 查询余额失败: ERROR_KEY_DOES_NOT_EXIST')
  })

  it('balance 缺省 → 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ errorId: 0 }), { status: 200 }),
    ))
    const platform = createYesCaptchaPlatform({ apiBase: 'https://api.yescaptcha.com', clientKey: 'test-key' })
    await expect(platform.getBalance()).resolves.toBe(0)
  })
})

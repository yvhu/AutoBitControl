import { describe, it, expect, vi } from 'vitest'
import { autoSolve } from '../src/automation/captcha/token-solve'
import { CaptchaFailure } from '../src/integrations/captcha/provider'

/** 假 provider：记录调用；detectCaptcha 通过 vi.mock 控制 */
const makeProvider = () => ({
  platform: 'test',
  solveToken: vi.fn().mockResolvedValue('tok-1'),
  classifyGrid: vi.fn(),
  getBalance: vi.fn().mockResolvedValue(100000),
})

vi.mock('../src/automation/captcha/detect', () => ({ detectCaptcha: vi.fn() }))
import { detectCaptcha } from '../src/automation/captcha/detect'

const makePage = (writes: Array<Record<string, unknown>> = []) => ({
  url: () => 'https://x.io',
  locator: () => ({ first: () => ({ count: async () => 1 }) }),
  // evaluate(fn, arg, {}, false)：回填目标存在返回 'INPUT'；写入值记录到 writes
  evaluate: vi.fn(async (fn: (v: unknown) => unknown, v: unknown) => {
    if (v !== undefined && typeof v === 'object' && v !== null) writes.push(v as Record<string, unknown>)
    return 'INPUT'
  }),
})

describe('autoSolve', () => {
  it('enabled=false 返回 none 且不检测不打码', async () => {
    const provider = makeProvider()
    await expect(autoSolve(makePage() as never, provider as never, {
      enabled: false, maxCostPerTask: 1500, onLog: vi.fn(),
    })).resolves.toBe('none')
    expect(detectCaptcha).not.toHaveBeenCalled()
    expect(provider.solveToken).not.toHaveBeenCalled()
  })

  it('未检测到验证码返回 none', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce(null)
    await expect(autoSolve(makePage() as never, makeProvider() as never, {
      enabled: true, maxCostPerTask: 1500, onLog: vi.fn(),
    })).resolves.toBe('none')
  })

  it('检测到 turnstile：余额校验 → solveToken → 回填 token → 成功记账', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce({ kind: 'turnstile', sitekey: 'sk' })
    const provider = makeProvider()
    const writes: Array<Record<string, unknown>> = []
    const page = makePage(writes)
    const onLog = vi.fn()
    await expect(autoSolve(page as never, provider as never, {
      enabled: true, maxCostPerTask: 1500, onLog,
    })).resolves.toBe('solved')
    expect(provider.solveToken).toHaveBeenCalledWith('turnstile', 'sk', 'https://x.io', undefined)
    expect(onLog).toHaveBeenCalledWith('test', 'turnstile', true, 25)
    expect((writes[writes.length - 1] as { t: string }).t).toBe('tok-1')
  })

  it('余额低于上限抛 CaptchaFailure 并记失败账', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce({ kind: 'turnstile', sitekey: 'sk' })
    const provider = makeProvider()
    provider.getBalance.mockResolvedValue(10)
    const onLog = vi.fn()
    await expect(autoSolve(makePage() as never, provider as never, {
      enabled: true, maxCostPerTask: 1500, onLog,
    })).rejects.toBeInstanceOf(CaptchaFailure)
    expect(provider.solveToken).not.toHaveBeenCalled()
    expect(onLog).toHaveBeenCalledWith('test', 'turnstile', false, 25)
  })

  it('解题失败抛 CaptchaFailure 并记失败账', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce({ kind: 'turnstile', sitekey: 'sk' })
    const provider = makeProvider()
    provider.solveToken.mockRejectedValue(new CaptchaFailure('超时'))
    const onLog = vi.fn()
    await expect(autoSolve(makePage() as never, provider as never, {
      enabled: true, maxCostPerTask: 1500, onLog,
    })).rejects.toBeInstanceOf(CaptchaFailure)
    expect(onLog).toHaveBeenCalledWith('test', 'turnstile', false, 25)
  })
})

/**
 * 插件自动解题等待（plugin-wait）单测：假 page（anchor frame + aria-checked 状态可控）驱动三态
 * - false→true → passed；无锚点 frame → none；恒 false + 小 timeoutMs → timeout
 * waitForTimeout 用假实现加速（真实轮询间隔不在测试中等待）
 */
import { describe, it, expect, vi } from 'vitest'
import { waitCaptchaPassed, PLUGIN_WAIT_TIMEOUT_MS } from '../src/automation/captcha/plugin-wait'

const V2 = '6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve'
const ANCHOR_URL = `https://www.google.com/recaptcha/enterprise/anchor?k=${V2}`

/** 构造锚点 frame 假实现：getAttribute 按读取次序返回 values（读尽后恒为最后一个值） */
function anchorFrame(values: Array<string | null>) {
  let reads = 0
  return {
    url: () => ANCHOR_URL,
    locator: () => ({
      first: () => ({
        getAttribute: async () => {
          const v = values[Math.min(reads, values.length - 1)]
          reads++
          return v
        },
      }),
    }),
  }
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() })

describe('waitCaptchaPassed 插件等待', () => {
  it('官方 DEMO 默认口径常量：90s 超时', () => {
    expect(PLUGIN_WAIT_TIMEOUT_MS).toBe(90000)
  })

  it('aria-checked false→true → passed（记录解题日志）', async () => {
    const log = logger()
    const page = { frames: () => [anchorFrame(['false', 'true'])], waitForTimeout: vi.fn().mockResolvedValue(undefined) }
    await expect(waitCaptchaPassed({ page: page as never, logger: log }, { pollMs: 50 })).resolves.toBe('passed')
    expect(log.info).toHaveBeenCalledWith('验证码插件已完成解题（aria-checked=true）')
  })

  it('无锚点 frame → none', async () => {
    const page = { frames: () => [], waitForTimeout: vi.fn().mockResolvedValue(undefined) }
    await expect(waitCaptchaPassed({ page: page as never, logger: logger() })).resolves.toBe('none')
  })

  it('恒 false 且小 timeoutMs → timeout（记录超时告警）', async () => {
    const log = logger()
    const page = { frames: () => [anchorFrame(['false'])], waitForTimeout: vi.fn().mockResolvedValue(undefined) }
    await expect(waitCaptchaPassed({ page: page as never, logger: log }, { timeoutMs: 200, pollMs: 50 })).resolves.toBe('timeout')
    expect(log.warn).toHaveBeenCalled()
  })

  it('siteKeyExclude：锚点为常驻 sitekey 时不匹配 → none', async () => {
    const page = { frames: () => [anchorFrame(['true'])], waitForTimeout: vi.fn().mockResolvedValue(undefined) }
    await expect(waitCaptchaPassed({ page: page as never, logger: logger() }, { siteKeyExclude: V2 })).resolves.toBe('none')
  })
})

/**
 * reCAPTCHA frame 查找单测：extractSiteKey 解析 / findAnchorFrame / findChallengeFrame
 * （enterprise 与 api2 双 URL 识别、excludeSiteKey 排除常驻 sitekey；假 page 注入 frames 数组）
 */
import { describe, it, expect } from 'vitest'
import { extractSiteKey, findAnchorFrame, findChallengeFrame } from '../src/automation/captcha/frame-find'

const V3 = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'
const V2 = '6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve'

/** 构造只含 frames() 的假 page（frame 只暴露 url()） */
function fakePage(urls: string[]) {
  return { frames: () => urls.map((url) => ({ url: () => url })) } as never
}

describe('extractSiteKey', () => {
  it('提取 k 参数并解码', () => {
    expect(extractSiteKey(`https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=${V2}&co=aHR0cHM`)).toBe(V2)
  })

  it('编码的 sitekey 解码为原文', () => {
    expect(extractSiteKey('https://x/anchor?k=%E2%9C%93ab')).toBe('✓ab')
  })

  it('无 k 参数 → null', () => {
    expect(extractSiteKey('https://www.google.com/recaptcha/enterprise/anchor?ar=1')).toBeNull()
  })
})

describe('findAnchorFrame 锚点 frame', () => {
  it('enterprise anchor URL 命中', () => {
    const page = fakePage([`https://www.google.com/recaptcha/enterprise/anchor?k=${V2}`])
    expect(findAnchorFrame(page)).not.toBeNull()
  })

  it('api2 anchor URL 命中', () => {
    const page = fakePage([`https://www.google.com/recaptcha/api2/anchor?k=${V2}`])
    expect(findAnchorFrame(page)).not.toBeNull()
  })

  it('excludeSiteKey：跳过常驻 v3 锚点，命中 v2 锚点', () => {
    const page = fakePage([
      `https://www.google.com/recaptcha/enterprise/anchor?k=${V3}`,
      `https://www.google.com/recaptcha/enterprise/anchor?k=${V2}`,
    ])
    const found = findAnchorFrame(page, V3)
    expect(found).not.toBeNull()
    expect(extractSiteKey((found as { url: () => string }).url())).toBe(V2)
  })

  it('excludeSiteKey：全部是常驻 sitekey → null', () => {
    const page = fakePage([`https://www.google.com/recaptcha/enterprise/anchor?k=${V3}`])
    expect(findAnchorFrame(page, V3)).toBeNull()
  })

  it('非锚点 frame → null', () => {
    const page = fakePage(['https://www.google.com/recaptcha/enterprise/bframe?k=x', 'https://example.com/'])
    expect(findAnchorFrame(page)).toBeNull()
  })
})

describe('findChallengeFrame 挑战 frame', () => {
  it('enterprise bframe URL 命中', () => {
    const page = fakePage([`https://www.google.com/recaptcha/enterprise/bframe?hl=zh-CN&k=${V2}`])
    expect(findChallengeFrame(page)).not.toBeNull()
  })

  it('api2 bframe URL 命中', () => {
    const page = fakePage([`https://www.google.com/recaptcha/api2/bframe?hl=zh-CN&k=${V2}`])
    expect(findChallengeFrame(page)).not.toBeNull()
  })

  it('excludeSiteKey：跳过常驻 v3 bframe，命中 v2 bframe', () => {
    const page = fakePage([
      `https://www.google.com/recaptcha/enterprise/bframe?k=${V3}`,
      `https://www.google.com/recaptcha/api2/bframe?k=${V2}`,
    ])
    const found = findChallengeFrame(page, V3)
    expect(found).not.toBeNull()
    expect(extractSiteKey((found as { url: () => string }).url())).toBe(V2)
  })

  it('非 bframe frame → null', () => {
    const page = fakePage(['https://www.google.com/recaptcha/enterprise/anchor?k=x'])
    expect(findChallengeFrame(page)).toBeNull()
  })
})

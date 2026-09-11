/**
 * reCAPTCHA 验证码 frame 查找（automation/captcha 层）：插件路线共用的锚点/挑战 frame 定位
 * 依赖方向：仅依赖 patchright，被 plugin-wait 与任务层使用
 */
import type { Page, Frame } from 'patchright'

/** 从 frame URL 提取 reCAPTCHA sitekey（k 参数；无则 null） */
export function extractSiteKey(url: string): string | null {
  const m = url.match(/[?&]k=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

/** 找锚点 frame（兼容 enterprise/api2 两种 URL；excludeSiteKey 跳过常驻 sitekey 如页面常驻 v3） */
export function findAnchorFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    const u = f.url()
    if (!u.includes('recaptcha/enterprise/anchor') && !u.includes('recaptcha/api2/anchor')) return false
    return !excludeSiteKey || extractSiteKey(u) !== excludeSiteKey
  }) ?? null
}

/** 找挑战（九宫格）frame；excludeSiteKey 语义同 findAnchorFrame */
export function findChallengeFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    const u = f.url()
    if (!u.includes('recaptcha/enterprise/bframe') && !u.includes('recaptcha/api2/bframe')) return false
    return !excludeSiteKey || extractSiteKey(u) !== excludeSiteKey
  }) ?? null
}

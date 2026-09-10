/**
 * 验证码自动检测（automation/captcha 层）：轮询页面 iframe/脚本识别验证码类型与 sitekey
 * 依赖方向：依赖 provider 的类型与 patchright，被 token-solve 与任务层使用
 * 设计思路：rev2 教训——enterprise 版 reCAPTCHA 的 anchor/bframe URL 含 recaptcha/enterprise 段，
 * 检测必须同时匹配 api2 与 enterprise，否则 enterprise 站点检测永不命中
 */
import type { Page } from 'patchright'
import type { TokenCaptchaKind, CaptchaDetected } from '../../integrations/captcha/provider'

/** iframe 型验证码识别选择器（按出现频率排序：Turnstile 最常用） */
const DETECTORS: Array<{ kind: TokenCaptchaKind; selector: string; sitekeyAttr: string }> = [
  { kind: 'turnstile', selector: 'iframe[src*="challenges.cloudflare.com"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'recaptcha_v2', selector: 'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'hcaptcha', selector: 'iframe[src*="hcaptcha.com/captcha"]', sitekeyAttr: 'data-sitekey' },
]

/**
 * 轮询检测页面上的验证码 iframe（直到超时）
 * @param timeoutMs 检测窗口时长，默认 5 秒
 * @returns 检测到返回类型与 sitekey；未检测到返回 null
 * 设计权衡：sitekey 优先从 iframe src 的 k=/sitekey= 参数提取（最可靠），失败再查 data-sitekey 属性
 */
export async function detectCaptcha(page: Page, timeoutMs = 5000): Promise<CaptchaDetected | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const d of DETECTORS) {
      const iframe = page.locator(d.selector).first()
      if (await iframe.count() > 0) {
        const src = (await iframe.getAttribute('src')) ?? ''
        const sitekeyMatch = src.match(/[?&]k=([^&]+)/) ?? src.match(/[?&]sitekey=([^&]+)/)
        let sitekey = sitekeyMatch ? sitekeyMatch[1] : null
        if (!sitekey) {
          const container = page.locator(`[${d.sitekeyAttr}]`).first()
          if (await container.count() > 0) sitekey = await container.getAttribute(d.sitekeyAttr)
        }
        return { kind: d.kind, sitekey }
      }
    }
    // v3 无可见 iframe：靠 api.js / enterprise.js 脚本的 render 参数识别 sitekey
    // render=explicit 是 v2 显式渲染模式（非 v3），不视为 v3 检测结果
    const script = page.locator('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]').first()
    if (await script.count() > 0) {
      const src = (await script.getAttribute('src')) ?? ''
      const sitekey = src.match(/[?&]render=([^&]+)/)?.[1] ?? null
      if (sitekey && sitekey !== 'explicit') {
        return { kind: 'recaptcha_v3', sitekey }
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

/**
 * token 类验证码自动求解编排（automation/captcha 层）：检测 → 余额校验 → 平台解题 → 回填 → 记账
 * 依赖方向：依赖 provider 接口与 detect 模块，被 engine/task-context 委托
 * 设计思路：语义对齐旧 CaptchaService.autoSolve——失败抛 CaptchaFailure（归 captcha_failed 终态不重试）
 */
import type { Page } from 'patchright'
import { CaptchaFailure, ESTIMATED_COST_POINTS, type CaptchaProvider, type CaptchaLogFn } from '../../integrations/captcha/provider'
import { detectCaptcha } from './detect'

export interface AutoSolveOpts {
  /** 是否启用（任务 meta.captcha.auto） */
  enabled: boolean
  /** 单任务打码费用上限（点）；余额低于它视为余额不足直接失败 */
  maxCostPerTask: number
  onLog: CaptchaLogFn
}

/**
 * 自动打码主入口
 * @returns 'none' 未启用或未检测到；'solved' 解题并回填成功；'failed' 检测到但回填目标缺失
 * @throws CaptchaFailure 余额不足/解题失败（先记失败日志再抛出）
 */
export async function autoSolve(page: Page, provider: CaptchaProvider, opts: AutoSolveOpts): Promise<'none' | 'solved' | 'failed'> {
  if (!opts.enabled) return 'none'
  const detected = await detectCaptcha(page)
  if (!detected) return 'none'
  try {
    const balance = await provider.getBalance()
    if (balance < opts.maxCostPerTask) throw new CaptchaFailure(`打码余额不足: ${balance} 点 < ${opts.maxCostPerTask} 点`)
    const token = await provider.solveToken(detected.kind, detected.sitekey, page.url(), undefined)
    const applied = await applyToken(page, detected.kind, token)
    if (!applied) {
      opts.onLog(provider.platform, detected.kind, false, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
      return 'failed'
    }
    opts.onLog(provider.platform, detected.kind, true, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
    return 'solved'
  } catch (e) {
    opts.onLog(provider.platform, detected.kind, false, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
    if (e instanceof CaptchaFailure) throw e
    throw new CaptchaFailure(`验证码处理失败: ${(e as Error).message}`)
  }
}

/**
 * 把 token 回填到站点表单并派发 input 事件（触发站点 JS 校验）
 * 关键设计：evaluate 第三参 {}、第四参 false（isolatedContext: false）是 patchright 扩展，
 * 把值写进站点主世界——默认隔离世界写的值站点 JS 读不到
 * @returns 回填目标存在并写入 true / 目标元素缺失 false
 */
async function applyToken(page: Page, kind: string, token: string): Promise<boolean> {
  const selectors = kind === 'turnstile'
    ? ['[name="cf-turnstile-response"]']
    : kind === 'hcaptcha'
      ? ['textarea[name="h-captcha-response"]', 'textarea[name="g-recaptcha-response"]']
      : ['textarea[name="g-recaptcha-response"]']
  const found = await page.evaluate((sels) => {
    const el = sels.map((s: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(s)).find(Boolean)
    return el ? el.tagName : null
  }, selectors, {}, false)
  if (!found) return false
  await page.evaluate(({ t, sels }) => {
    for (const s of sels) {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(s)
      if (el) {
        el.value = t
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }, { t: token, sels: selectors }, {}, false)
  return true
}

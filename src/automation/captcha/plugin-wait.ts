/**
 * 打码平台浏览器插件自动解题等待（automation/captcha 层）：插件在浏览器内自动识别并完成验证，
 * 任务侧只需等待验证通过信号。官方 DEMO（wiki 64194741）：切到 anchor iframe，
 * 轮询 #recaptcha-anchor 的 aria-checked=true（30 次 × 3s = 90s）
 * 平台无关：装哪家插件（yescaptcha/capsolver/2captcha）代码都一样，换平台 = 换插件
 * 依赖方向：依赖 frame-find 与 infrastructure/logger，被 engine/task-context 委托
 */
import type { Page, Frame } from 'patchright'
import type { Logger } from '../../infrastructure/logger'
import { findAnchorFrame } from './frame-find'

export interface PluginWaitOpts {
  /** 超时预算（官方 DEMO：30×3s=90s） */
  timeoutMs?: number
  /** 轮询间隔（官方 DEMO 3s） */
  pollMs?: number
  /** 跳过的常驻 sitekey（页面常驻 v3 锚点排除） */
  siteKeyExclude?: string
}

/** 官方 DEMO 超时口径：30 次 × 3s */
export const PLUGIN_WAIT_TIMEOUT_MS = 90000
const PLUGIN_WAIT_POLL_MS = 3000

/**
 * 等待插件自动完成验证码解题
 * @returns 'passed' 插件已完成（aria-checked=true）；'none' 无锚点 frame；'timeout' 预算内未完成
 */
export async function waitCaptchaPassed(
  deps: { page: Page; logger: Pick<Logger, 'info' | 'warn'> },
  opts: PluginWaitOpts = {},
): Promise<'passed' | 'none' | 'timeout'> {
  const timeoutMs = opts.timeoutMs ?? PLUGIN_WAIT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? PLUGIN_WAIT_POLL_MS
  // iframe 元素已插入 DOM 但 CDP frame 可能未附着：轮询等附着
  let anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !anchor; i++) {
    await deps.page.waitForTimeout(500)
    anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  }
  if (!anchor) return 'none'
  const anchorRef: Frame = anchor
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const checked = await anchorRef.locator('#recaptcha-anchor').first().getAttribute('aria-checked').catch(() => null)
    if (checked === 'true') {
      deps.logger.info('验证码插件已完成解题（aria-checked=true）')
      return 'passed'
    }
    await deps.page.waitForTimeout(pollMs)
  }
  deps.logger.warn({ timeoutMs }, '等待验证码插件解题超时（检查插件 ClientKey/余额/扩展是否启用）')
  return 'timeout'
}

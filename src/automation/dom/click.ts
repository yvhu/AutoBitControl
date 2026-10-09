/**
 * 坐标点击原语（automation/dom 层）：用于无选择器场景（验证码方框、遮罩空白处）
 * 依赖方向：仅依赖 patchright
 * 设计思路：经 CDP Input.dispatchMouseEvent 派发 mousePressed/mouseReleased。
 * 真机实测教训：patchright 的 page.mouse.click 在跨域 iframe 里的 Turnstile 方框上点击不生效
 * （方框不消失、验证不通过），必须用 CDP 直接派发（与旧 humanize.clickAt 同机制）。
 */
import type { Page, CDPSession } from 'patchright'

/**
 * 在页面视口坐标 (x, y) 派发一次左键点击（按下 + 抬起）。
 * 用途：没有可用选择器的目标——验证码方框（内容在跨域 iframe，选择器穿不透）、遮罩空白处。
 * @param page 目标页面
 * @param x 点击点横坐标（视口像素坐标，非文档坐标）
 * @param y 点击点纵坐标（视口像素坐标）
 */
export async function clickPoint(page: Page, x: number, y: number): Promise<void> {
  let session: CDPSession | null = null
  try {
    session = await page.context().newCDPSession(page)
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } finally {
    await session?.detach?.().catch(() => {})
  }
}

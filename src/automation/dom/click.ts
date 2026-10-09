/**
 * 坐标点击原语（automation/dom 层）：用于无选择器场景（验证码方框、遮罩空白处）
 * 依赖方向：仅依赖 patchright
 * 设计思路：经 CDP Input.dispatchMouseEvent 派发。真机实测：Turnstile 方框是跨域 iframe，
 *   patchright 的 page.mouse.click 直跳单点不生效；必须像旧 humanize.clickAt 一样——
 *   有「移动过程」再按下/抬起（目标元素能感知 mousemove/hover），事件之间留间隔。
 */
import type { Page, CDPSession } from 'patchright'

/**
 * 在页面视口坐标 (x, y) 派发一次左键点击（分步移动 → 停顿 → 按下 → 停顿 → 抬起）。
 * 用途：没有可用选择器的目标——验证码方框（内容在跨域 iframe，选择器穿不透）、遮罩空白处。
 * @param page 目标页面
 * @param x 点击点横坐标（视口像素坐标，非文档坐标）
 * @param y 点击点纵坐标（视口像素坐标）
 */
export async function clickPoint(page: Page, x: number, y: number): Promise<void> {
  let session: CDPSession | null = null
  try {
    session = await page.context().newCDPSession(page)
    // 分步移动到位：产生真实 mousemove 过程（避免直跳单点被目标忽略）
    const steps = 5
    for (let i = 1; i <= steps; i++) {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((x * i) / steps), y: Math.round((y * i) / steps) })
      await page.waitForTimeout(12)
    }
    await page.waitForTimeout(50)
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await page.waitForTimeout(60)
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } finally {
    await session?.detach?.().catch(() => {})
  }
}

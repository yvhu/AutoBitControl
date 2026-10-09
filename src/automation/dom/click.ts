/**
 * 坐标点击原语（automation/dom 层）：用于无选择器场景（验证码方框、遮罩空白处）
 * 依赖方向：仅依赖 patchright；派发 patchright 原生可信鼠标事件（不拟人）
 */
import type { Page } from 'patchright'

/** 在视口坐标 (x,y) 派发一次原生左键点击 */
export async function clickPoint(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y)
}

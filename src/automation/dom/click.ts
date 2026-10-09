/**
 * 坐标点击原语（automation/dom 层）：用于无选择器场景（验证码方框、遮罩空白处）
 * 依赖方向：仅依赖 patchright；派发 patchright 原生可信鼠标事件（不拟人）
 */
import type { Page } from 'patchright'

/**
 * 在视口坐标处派发一次原生左键点击。
 * 用于「没有可用选择器」的场景：验证码方框（内容在跨域 iframe 里，无法用选择器穿透）、
 * 遮罩空白处等。执行流程即直接调用 patchright 的 mouse.click，派发的是浏览器可信鼠标事件，
 * 不含拟人化轨迹（拟人操作见 automation/humanize.ts）。
 * @param page 目标页面
 * @param x 点击点横坐标（页面视口像素坐标，非文档坐标）
 * @param y 点击点纵坐标（页面视口像素坐标）
 */
export async function clickPoint(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y)
}

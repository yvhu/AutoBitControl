/**
 * 钱包弹窗等待原语（automation/wallet 层）：统一「轮询条件」与「弹窗关闭判定」的时序
 * 依赖方向：仅依赖 ./types；被 metamask / petra 适配器共用
 * 设计思路：原来两个适配器各自 sleep(2000)、各自等 close 事件 15s，慢且不一致；
 *           这里统一为 200ms 轮询 + close 事件与 isClosed 并行判定，新适配器直接复用
 */
import type { PopupPage } from './types'

/** 弹窗内状态轮询间隔（毫秒）：密码框/确认按钮渲染后立即处理 */
export const POPUP_POLL_MS = 200

/** 点击确认后等弹窗关闭的上限（毫秒）：事件漏收时靠 isClosed 轮询兜底，不再空等 15 秒 */
export const POPUP_CLOSE_WAIT_MS = 3000

/** 通用 sleep（毫秒） */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询直到条件为真或超时。
 * @param check 异步条件（返回 true 即结束）
 * @param timeoutMs 最长等待毫秒数
 * @param intervalMs 轮询间隔（缺省 POPUP_POLL_MS）
 * @returns 条件是否在预算内命中
 */
export async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = POPUP_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(intervalMs)
  }
  return false
}

/**
 * 等弹窗关闭：close 事件与 isClosed() 轮询并行，任一命中即返回。
 * close 事件可能漏收（弹窗在监听注册前就关闭），因此 must 同时轮询窗口状态。
 * @param popup 钱包弹窗页
 * @param timeoutMs 最长等待毫秒数（缺省 POPUP_CLOSE_WAIT_MS）
 * @returns 是否确认关闭（事件命中或 isClosed 为 true）
 */
export async function waitForPopupClose(popup: PopupPage, timeoutMs = POPUP_CLOSE_WAIT_MS): Promise<boolean> {
  if (popup.isClosed?.()) return true
  const eventPromise = popup.waitForEvent('close', { timeout: timeoutMs }).then(() => true).catch(() => false)
  const pollPromise = (async (): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return true
      await sleep(100)
    }
    return false
  })()
  return Promise.race([eventPromise, pollPromise])
}

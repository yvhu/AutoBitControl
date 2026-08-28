/**
 * MetaMask 钱包适配器（automation 层）：解锁 + 连接确认
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：解锁用官方 data-testid 定位（版本升级后仍稳定）；
 * 连接确认按文案正则连点至弹窗关闭（最多 3 轮，覆盖多步骤授权流程）
 */
import type { WalletAdapter, PopupPage } from './types'

export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
  // 弹窗 URL 模式：home（解锁页）/ notification（连接确认页）/ metamask://（协议唤起）
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html', 'metamask://']

  /** 解锁：填密码 → 提交 → 等弹窗关闭（15s 超时；弹窗关闭即解锁成功） */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    await popup.getByTestId('unlock-password').fill(password)
    await popup.getByTestId('unlock-submit').click()
    await popup.waitForEvent('close', { timeout: 15000 })
  }

  /**
   * 连接确认：点 connect/next/confirm 等按钮，弹窗关闭即完成；
   * 最多 3 轮（部分站点唤起多步确认：连接 → 签名 → 批准）
   */
  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = popup.getByRole('button', { name: /connect|next|confirm|approve|sign/i })
      await btn.first().click({ timeout: 8000 })
      const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
      if (closed) return
    }
  }
}

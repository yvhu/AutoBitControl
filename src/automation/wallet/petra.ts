/**
 * Petra 钱包适配器（automation 层）：解锁 + 连接确认
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：Petra 无稳定 data-testid，用密码输入框 + 回车解锁（回车等效确认键）；
 * 连接确认与 MetaMask 相同的连点策略
 */
import type { WalletAdapter, PopupPage } from './types'

export class PetraAdapter implements WalletAdapter {
  key = 'petra'
  // 弹窗 URL 模式：index.html（解锁页）/ popup.html（确认页）
  extensionUrlPatterns = ['chrome-extension://.*/index.html', 'chrome-extension://.*/popup.html']

  /** 解锁：填密码 → 回车（press 可选调用，测试 mock 可不实现） */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    await popup.locator('input[type="password"]').fill(password)
    await popup.locator('input[type="password"]').press?.('Enter')
  }

  /** 连接确认：点 connect/approve 等按钮至弹窗关闭（最多 3 轮） */
  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = popup.getByRole('button', { name: /connect|approve|confirm|sign|unlock/i })
      await btn.first().click({ timeout: 8000 })
      const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
      if (closed) return
    }
  }
}

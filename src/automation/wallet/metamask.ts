/**
 * MetaMask 钱包适配器（automation 层）：解锁 + 连接确认
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：全部用官方 data-testid 定位（与 UI 语言无关——实测中文版 MetaMask
 * 按钮文案为「登录/连接/取消」，英文正则匹配不到）；
 * 解锁成功判定 = 弹窗关闭 或 解锁页消失（新版 MetaMask 解锁后弹窗不关闭，
 * 原地切到连接确认页）；连接确认最多 3 轮连点至弹窗关闭
 */
import type { WalletAdapter, PopupPage } from './types'

/** 连接确认按钮 testid 候选（多版本兼容，与 UI 语言无关） */
const CONFIRM_TESTIDS = ['confirm-btn', 'confirm-footer-button', 'permissions-connect-button', 'signature-request-sign-button']

export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
  // 弹窗 URL 模式：home（解锁页）/ notification（解锁 + 连接确认页）/ metamask://（协议唤起）
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html', 'metamask://']

  /**
   * 解锁：填密码 → 提交；成功判定 = 弹窗关闭 或 解锁页消失（15s）
   * 钱包已解锁时（弹窗直接是连接确认页）跳过解锁
   * @throws 密码错误等导致解锁页未离开
   */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    const pw = popup.getByTestId('unlock-password').first()
    if (pw.count && (await pw.count()) === 0) return
    await pw.fill(password)
    await popup.getByTestId('unlock-submit').first().click()
    const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
    if (closed) return
    const unlockPage = popup.getByTestId('unlock-page').first()
    if (!unlockPage.waitFor) return
    try {
      await unlockPage.waitFor({ state: 'detached', timeout: 15000 })
    } catch {
      throw new Error('MetaMask 解锁失败（密码错误或解锁页未离开）')
    }
  }

  /**
   * 连接确认：优先按 testid 连点（confirm-btn 等），兜底按按钮文案（英文/中文双覆盖）；
   * 弹窗关闭即完成，最多 3 轮（覆盖连接 → 签名等多步授权流程）
   * @throws 3 轮后弹窗仍未关闭
   */
  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      let clicked = false
      for (const tid of CONFIRM_TESTIDS) {
        const loc = popup.getByTestId(tid).first()
        try {
          if (loc.count && (await loc.count()) === 0) continue
          await loc.click({ timeout: 2500 })
          clicked = true
          break
        } catch {
          // 该候选不存在/不可点，尝试下一个
        }
      }
      if (!clicked) {
        try {
          const btn = popup.getByRole('button', { name: /connect|next|confirm|approve|sign|unlock|连接|确认|签名|下一步|批准|登录/i })
          await btn.first().click({ timeout: 2500 })
          clicked = true
        } catch {
          // 无匹配按钮，结束本轮
        }
      }
      if (!clicked) break
      const closed = await popup.waitForEvent('close', { timeout: 6000 }).then(() => true).catch(() => false)
      if (closed) return
    }
    throw new Error('MetaMask 连接确认未完成（弹窗未关闭）')
  }
}

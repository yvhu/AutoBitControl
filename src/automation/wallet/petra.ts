/**
 * Petra 钱包适配器（automation 层）：解锁 + Sign In 签名确认
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：真机核实（2026-09-02，portal.rhuna.io）——Petra 弹窗为 prompt.html：
 *   锁屏页（输密码 + Unlock）→ Sign In Request 页（Cancel / Sign In，Aptos signMessage）；
 *   getByRole 匹配不到 Sign In 按钮（Petra UI 无障碍名异常），必须用 has-text 定位；
 *   Petra 在本环境不注入页面 provider（window.petra 恒不存在），扩展就绪判定只靠 CDP 扩展页探测
 */
import type { WalletAdapter, PopupPage } from './types'

/** 确认按钮文案候选（Petra UI 无稳定 testid，按文案匹配；Sign In 为签名确认主按钮） */
const CONFIRM_TEXTS = ['Sign In', 'Connect', 'Approve', 'Confirm', 'Sign']

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class PetraAdapter implements WalletAdapter {
  key = 'petra'
  extensionId = 'ejjladinnckdgjemekebdpeokbikhfci'
  probePath = 'index.html'
  providerFlag = 'isPetra'
  /** Petra 不注入页面 provider（真机实测 window.petra 恒不存在）：跳过 provider 轮询，仅 CDP 探测 */
  expectsProvider = false
  // 弹窗 URL 模式：prompt.html（站点请求签名/解锁弹窗，真机实证）/ index.html（解锁页）/ popup.html（确认页）
  extensionUrlPatterns = ['chrome-extension://.*/prompt.html', 'chrome-extension://.*/index.html', 'chrome-extension://.*/popup.html']

  /**
   * 解锁：轮询等密码框 → 填密码 → 点 Unlock 按钮（兜底回车）；密码框消失即解锁完成；
   * 弹窗已解锁直显确认页（Sign In/Connect 等按钮存在）时直接返回（真机实测重登场景
   * 弹窗可能不带解锁框）；弹窗关闭也返回
   */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return
      // 已解锁直显确认页：跳过解锁（交给 ensureConnected 点确认）
      for (const text of CONFIRM_TEXTS) {
        try {
          if (((await popup.locator(`button:has-text("${text}")`).first().count?.()) ?? 0) > 0) return
        } catch {
          if (popup.isClosed?.()) return
        }
      }
      const pw = popup.locator('input[type="password"]').first()
      let pwCount = 0
      try {
        pwCount = (await pw.count?.()) ?? 0
      } catch {
        if (popup.isClosed?.()) return
      }
      if (pwCount > 0) {
        await pw.fill(password)
        const unlockBtn = popup.locator('button:has-text("Unlock")').first()
        try {
          if (((await unlockBtn.count?.()) ?? 0) > 0) {
            await unlockBtn.click()
          } else {
            await pw.press?.('Enter')
          }
        } catch {
          await pw.press?.('Enter').catch(() => {})
        }
        // 等密码框消失（waitFor detached 对从未出现的元素立即成功——密码框已确认存在，此判定安全）
        try {
          await pw.waitFor?.({ state: 'detached', timeout: 30000 })
        } catch {
          throw new Error('Petra 解锁失败（密码错误或解锁页未离开）')
        }
        return
      }
      await sleep(500)
    }
    throw new Error('Petra 弹窗状态未出现（解锁框轮询超时未渲染）')
  }

  /** 确认步：等 Sign In/Connect 等按钮出现（has-text，最多 10s） */
  private async waitConfirmBtn(popup: PopupPage, timeoutMs: number): Promise<ReturnType<PopupPage['locator']> | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return null
      try {
        for (const text of CONFIRM_TEXTS) {
          const loc = popup.locator(`button:has-text("${text}")`).first()
          if (((await loc.count?.()) ?? 0) > 0) return loc
        }
      } catch {
        if (popup.isClosed?.()) return null
      }
      await sleep(500)
    }
    return null
  }

  /**
   * Sign In 签名确认：点确认按钮至弹窗关闭（最多 3 轮，覆盖解锁→签名等多步）；
   * 成功判定 = 弹窗 close 事件；真机实测点 Sign In 后弹窗 1-5s 内关闭
   */
  async ensureConnected(popup: PopupPage): Promise<void> {
    await sleep(2000)
    for (let i = 0; i < 3; i++) {
      if (popup.isClosed?.()) return
      const btn = await this.waitConfirmBtn(popup, 10000)
      if (!btn) break
      await btn.click()
      const closed = await popup.waitForEvent('close', { timeout: 15000 }).then(() => true).catch(() => false)
      if (closed) return
      if (popup.isClosed?.()) return
    }
    throw new Error('Petra 连接确认未完成（弹窗未关闭）')
  }
}

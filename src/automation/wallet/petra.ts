/**
 * Petra 钱包适配器（automation 层）：解锁 unlock + 连接 connect / 签名 sign / 交易确认 confirmTx
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

/**
 * Petra 钱包适配器：与 MetaMask 同构的四类交互（解锁/连接/签名/交易确认），但定位方式不同。
 * Petra 弹窗没有稳定 testid，只能按按钮文案 has-text 匹配；且 getByRole 匹配不到 Sign In
 * （其无障碍名异常），所以必须用 has-text。另一个真机事实是 Petra 不注入页面 provider，
 * 扩展就绪判定只能靠 CDP 扩展页探测（见 types.ts 的 expectsProvider）。
 */
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
   * 解锁 Petra 弹窗。
   * 执行流程：最多等 45s，循环内每 500ms 检查——先看是否已直接渲染出确认按钮
   * （Sign In/Connect 等，说明弹窗本就已解锁，重登场景常见，直接返回）；
   * 再看密码框，出现则填入密码并点 Unlock（找不到按钮就回退按回车），
   * 随后等密码框 detached 消失即视为解锁成功；弹窗中途关闭也返回。
   * @param popup 钱包弹窗页
   * @param password 解锁密码
   * @throws 预算内密码框始终未渲染，或密码错误/解锁页迟迟不离开
   */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return
      // 已解锁直显确认页：跳过解锁（交给 connect 点确认）
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

  /**
   * 轮询等待确认按钮出现。
   * 每 500ms 一轮，按 CONFIRM_TEXTS 文案逐个用 button:has-text 定位；弹窗关闭或超时返回 null。
   * @param popup 钱包弹窗页
   * @param timeoutMs 最长等待毫秒数
   * @returns 命中的确认按钮定位器；未找到返回 null
   */
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

  /** 处理「站点请求连接钱包」的弹窗：三种意图按钮布局一致，统一委托 confirm */
  async connect(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /** 处理「站点请求消息签名」的弹窗（Petra 的 Sign In）：同样委托 confirm */
  async sign(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /** 处理「站点请求交易确认」的弹窗：同样委托 confirm */
  async confirmTx(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /**
   * 点击确认按钮至弹窗关闭。
   * 执行流程：先等 2s 让弹窗沉降，然后最多 3 轮——每轮等确认按钮出现并点击，
   * 成功判定为弹窗 close 事件（真机实测点 Sign In 后弹窗 1-5s 内关闭），
   * 若事件没来但弹窗已关闭也返回；3 轮仍未关闭则抛错。
   * @param popup 钱包弹窗页
   * @throws 3 轮后弹窗仍未关闭
   */
  private async confirm(popup: PopupPage): Promise<void> {
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

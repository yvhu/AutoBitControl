/**
 * Petra 钱包适配器（automation 层）：解锁 unlock + 连接 connect / 签名 sign / 交易确认 confirmTx
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：真机核实（2026-09-02，portal.rhuna.io）——Petra 弹窗为 prompt.html：
 *   锁屏页（输密码 + Unlock）→ Sign In Request 页（Cancel / Sign In，Aptos signMessage）；
 *   getByRole 匹配不到 Sign In 按钮（Petra UI 无障碍名异常），必须用 has-text 定位；
 *   Petra 在本环境不注入页面 provider（window.petra 恒不存在），扩展就绪判定只靠 CDP 扩展页探测
 */
import type { WalletAdapter, PopupPage } from './types'
import { POPUP_POLL_MS, sleep, waitForPopupClose } from './popup-wait'

/** 确认按钮文案候选（Petra UI 无稳定 testid，按文案匹配；Sign In 为签名确认主按钮） */
const CONFIRM_TEXTS = ['Sign In', 'Connect', 'Approve', 'Confirm', 'Sign']

/**
 * Petra 钱包适配器：与 MetaMask 同构的四类交互（解锁/连接/签名/交易确认），但定位方式不同。
 * Petra 弹窗没有稳定 testid，只能按按钮文案 has-text 匹配；且 getByRole 匹配不到 Sign In
 * （其无障碍名异常），所以必须用 has-text。另一个真机事实是 Petra 不注入页面 provider，
 * 扩展就绪判定只能靠 CDP 扩展页探测（见 types.ts 的 expectsProvider）。
 */
export class PetraAdapter implements WalletAdapter {
  key = 'petra'
  displayName = 'Petra'
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
        // 等密码框消失；若没 detach 但已切到确认页（Sign In/Connect 等可见），也视为解锁成功
        try {
          await pw.waitFor?.({ state: 'detached', timeout: 30000 })
        } catch {
          if (await this.locatorVisible(popup, 'input[type="password"]')) {
            throw new Error('Petra 解锁失败（密码错误或解锁页未离开）')
          }
          let ready = false
          for (const text of CONFIRM_TEXTS) {
            if (await this.locatorVisible(popup, `button:has-text("${text}")`)) { ready = true; break }
          }
          if (!ready) throw new Error('Petra 解锁失败（密码错误或解锁页未离开）')
        }
        return
      }
      await sleep(POPUP_POLL_MS)
    }
    throw new Error('Petra 弹窗状态未出现（解锁框轮询超时未渲染）')
  }

  /**
   * 轮询等待确认按钮出现。
   * 每 200ms 一轮，按 CONFIRM_TEXTS 文案逐个用 button:has-text 定位；弹窗关闭或超时返回 null。
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
      await sleep(POPUP_POLL_MS)
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
   * 分类 Petra 弹窗：按可见文案判定（Petra 无稳定 testid，只能用 has-text）。
   * 顺序：unlock → connect → tx → sign。'Approve'/'Confirm' → 交易，交易类保守且提前于签名，
   * 保证「隐藏签名文案 + 可见确认文案」不会被误判为 sign 自动点击。
   * @param popup 钱包弹窗页
   * @returns 弹窗意图类别；无法判定返回 'unknown'
   */
  async classifyPopup(popup: PopupPage): Promise<'unlock' | 'connect' | 'sign' | 'tx' | 'unknown'> {
    if (await this.locatorVisible(popup, 'input[type="password"]')) return 'unlock'
    if (await this.locatorVisible(popup, 'button:has-text("Connect")')) return 'connect'
    if (await this.locatorVisible(popup, 'button:has-text("Approve")') || await this.locatorVisible(popup, 'button:has-text("Confirm")')) return 'tx'
    if (await this.locatorVisible(popup, 'button:has-text("Sign In")') || await this.locatorVisible(popup, 'button:has-text("Sign")')) return 'sign'
    return 'unknown'
  }

  /** 弹窗 UI 是否已渲染到可操作状态：密码框或任一确认按钮可见（登录流程分类前短轮询用） */
  async isPopupReady(popup: PopupPage): Promise<boolean> {
    if (popup.isClosed?.()) return true
    if (await this.locatorVisible(popup, 'input[type="password"]')) return true
    for (const text of CONFIRM_TEXTS) {
      if (await this.locatorVisible(popup, `button:has-text("${text}")`)) return true
    }
    return false
  }

  /**
   * 登录自适应：unlock 复用 unlock（需密码），connect/sign 复用 confirm；tx 绝不处理（返回 false）。
   * @param popup 钱包弹窗页
   * @param password 解锁密码（unlock 分类时需要）
   * @returns 是否已处理（tx/unknown/缺密码返回 false）
   */
  async handleLoginPopup(popup: PopupPage, password?: string): Promise<boolean> {
    const kind = await this.classifyPopup(popup)
    if (kind === 'tx' || kind === 'unknown') return false
    if (kind === 'unlock') {
      if (!password) return false
      await this.unlock(popup, password)
      return true
    }
    if (kind === 'connect') { await this.connect(popup); return true }
    await this.sign(popup)
    return true
  }

  /** 某选择器当前是否可见：优先 isVisible（区分存在但隐藏），mock 无 isVisible 时回退 count>0 */
  private async locatorVisible(popup: PopupPage, selector: string): Promise<boolean> {
    const loc = popup.locator(selector).first()
    try {
      if (loc.isVisible) return await loc.isVisible()
      return ((await loc.count?.()) ?? 0) > 0
    } catch {
      return false
    }
  }

  /**
   * 点击确认按钮至弹窗关闭。
   * 执行流程：最多 3 轮——每轮等确认按钮出现并点击，
   * 成功判定为弹窗关闭（close 事件与 isClosed 轮询并行，事件漏收也不会空等）；
   * 3 轮仍未关闭则抛错。
   * @param popup 钱包弹窗页
   * @throws 3 轮后弹窗仍未关闭
   */
  private async confirm(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (popup.isClosed?.()) return
      // 不再固定等 2 秒：按钮已渲染就立刻点（waitConfirmBtn 内部 200ms 轮询）
      const btn = await this.waitConfirmBtn(popup, 10000)
      if (!btn) break
      await btn.click()
      if (await waitForPopupClose(popup)) return
    }
    throw new Error('Petra 连接确认未完成（弹窗未关闭）')
  }
}

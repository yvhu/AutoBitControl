/**
 * SubWallet 钱包适配器（automation 层）：解锁 unlock + 连接 connect / 签名 sign / 交易确认 confirmTx
 * 依赖方向：仅依赖 ./types、./labels、./popup-wait，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：SubWallet 弹窗走 notification.html，没有稳定 data-testid，只能按可见文案定位；
 *   解锁页是密码框 + Unlock，授权页是 Connect，签名/交易页共用 Approve 按钮。
 *   因此分类顺序为：密码框 → 签名标题 → 交易标题 → Connect → Approve；
 *   标题缺失时 Approve 保守归为 tx，绝不把可能的交易确认误当签名自动点击。
 *   SubWallet 把 provider 挂在 window.SubWallet（isSubWallet），不是固定 window.ethereum，
 *   通过 providerGlobal 显式指定，避免与 MetaMask 同时注入时误判扩展未加载。
 */
import type { PopupKind, PopupLocator, PopupPage, WalletAdapter } from './types'
import { POPUP_POLL_MS, sleep, waitForPopupClose } from './popup-wait'
import { buttonSelectors, uniqueTexts, WALLET_BUTTON_LABELS } from './labels'

/** SubWallet 扩展 ID（用户提供，1.3.90 实测） */
const SUBWALLET_EXTENSION_ID = 'onhogfjeacnfoofkfgppdlbmlmnplgbn'

/** 解锁按钮文案（多语言共享） */
const UNLOCK_TEXTS = WALLET_BUTTON_LABELS.unlock
/** 连接/授权按钮文案（多语言共享） */
const CONNECT_TEXTS = WALLET_BUTTON_LABELS.connect
/** 签名/交易确认按钮文案：SubWallet 两者都用 Approve，另收 Sign/Confirm 与多语言候选 */
const APPROVE_TEXTS = uniqueTexts([...WALLET_BUTTON_LABELS.approve, ...WALLET_BUTTON_LABELS.sign, ...WALLET_BUTTON_LABELS.confirm])

/** 签名页标题文案（SubWallet 用标题区分签名与交易，两者按钮都叫 Approve） */
const SIGNATURE_TITLE_TEXTS = [
  'Signature request',
  '签名请求',
  '簽名請求',
  '署名リクエスト',
  'Запрос на подпись',
  'Yêu cầu ký',
  'Demande de signature',
  'Signaturanfrage',
]

/** 交易页标题文案 */
const TRANSACTION_TITLE_TEXTS = [
  'Transaction request',
  '交易请求',
  '交易請求',
  '取引リクエスト',
  'Запрос на транзакцию',
  'Yêu cầu giao dịch',
  'Demande de transaction',
  'Transaktionsanfrage',
]

/** 把标题文案转成精确文本选择器，避免匹配到描述段落里的同一单词 */
function titleSelectors(texts: string[]): string[] {
  return texts.map((text) => `text="${text}"`)
}

/** SubWallet 钱包适配器：解锁 / 连接 / 签名 / 交易确认 */
export class SubWalletAdapter implements WalletAdapter {
  key = 'subwallet'
  displayName = 'SubWallet'
  extensionId = SUBWALLET_EXTENSION_ID
  probePath = 'index.html'
  providerFlag = 'isSubWallet'
  /** SubWallet 的 EVM provider 固定挂在 window.SubWallet，不保证占用 window.ethereum */
  providerGlobal = 'SubWallet'
  /** 站点请求弹窗走 notification.html；side-panel/index 作为不同版本的兜底 */
  extensionUrlPatterns = [
    `chrome-extension://${SUBWALLET_EXTENSION_ID}/notification.html`,
    `chrome-extension://${SUBWALLET_EXTENSION_ID}/side-panel.html`,
    `chrome-extension://${SUBWALLET_EXTENSION_ID}/index.html`,
  ]

  /**
   * 解锁 SubWallet 弹窗。
   * 执行流程：最多等 45s，循环内每 200ms 检查——已解锁（授权/签名/交易页可见）直接返回；
   * 密码框出现则填入密码并点 Unlock（找不到按钮回退回车），随后等密码框消失即视为解锁成功。
   * @param popup 钱包弹窗页
   * @param password 解锁密码
   * @throws 预算内密码框始终未渲染，或密码错误/解锁页迟迟不离开
   */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return
      if (await this.isActionReady(popup)) return
      const pw = popup.locator('input[type="password"]').first()
      let pwCount = 0
      try {
        pwCount = (await pw.count?.()) ?? 0
      } catch {
        if (popup.isClosed?.()) return
      }
      if (pwCount > 0) {
        await pw.fill(password)
        let submitted = false
        for (const sel of buttonSelectors(UNLOCK_TEXTS)) {
          const btn = popup.locator(sel).first()
          try {
            if (((await btn.count?.()) ?? 0) > 0) {
              await btn.click()
              submitted = true
              break
            }
          } catch {
            // 单个候选探测/点击失败时继续试下一个，最后回退回车
          }
        }
        if (!submitted) await pw.press?.('Enter').catch(() => {})
        try {
          await pw.waitFor?.({ state: 'detached', timeout: 30000 })
        } catch {
          if (await this.locatorVisible(popup, 'input[type="password"]')) {
            throw new Error('SubWallet 解锁失败（密码错误或解锁页未离开）')
          }
          if (!(await this.isActionReady(popup))) {
            throw new Error('SubWallet 解锁失败（密码错误或解锁页未离开）')
          }
        }
        return
      }
      await sleep(POPUP_POLL_MS)
    }
    throw new Error('SubWallet 弹窗状态未出现（解锁框轮询超时未渲染）')
  }

  /** 弹窗 UI 是否已渲染到可操作状态：密码框或任一授权/签名/交易元素可见 */
  async isPopupReady(popup: PopupPage): Promise<boolean> {
    if (popup.isClosed?.()) return true
    if (await this.locatorVisible(popup, 'input[type="password"]')) return true
    return this.isActionReady(popup)
  }

  /** 处理「站点请求连接钱包」：点 Connect 直到弹窗关闭 */
  async connect(popup: PopupPage): Promise<void> {
    await this.confirmWith(popup, CONNECT_TEXTS, '连接')
  }

  /** 处理「站点请求消息签名」：点 Approve 直到弹窗关闭 */
  async sign(popup: PopupPage): Promise<void> {
    await this.confirmWith(popup, APPROVE_TEXTS, '签名')
  }

  /** 处理「站点请求交易确认」：点 Approve 直到弹窗关闭 */
  async confirmTx(popup: PopupPage): Promise<void> {
    await this.confirmWith(popup, APPROVE_TEXTS, '交易确认')
  }

  /**
   * 分类弹窗：密码框 → 签名标题 → 交易标题 → Connect → Approve。
   * 签名/交易共用 Approve，所以标题优先；标题判不出来时保守归为 tx（登录流程不会误当签名自动点）。
   */
  async classifyPopup(popup: PopupPage): Promise<PopupKind> {
    if (await this.locatorVisible(popup, 'input[type="password"]')) return 'unlock'
    if (await this.anySelectorVisible(popup, titleSelectors(SIGNATURE_TITLE_TEXTS))) return 'sign'
    if (await this.anySelectorVisible(popup, titleSelectors(TRANSACTION_TITLE_TEXTS))) return 'tx'
    if (await this.anySelectorVisible(popup, buttonSelectors(CONNECT_TEXTS))) return 'connect'
    if (await this.anySelectorVisible(popup, buttonSelectors(APPROVE_TEXTS))) return 'tx'
    return 'unknown'
  }

  /**
   * 登录自适应：unlock 需密码；connect/sign 直接点；tx 不处理（返回 false）。
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
    if (kind === 'connect') {
      await this.connect(popup)
      return true
    }
    await this.sign(popup)
    return true
  }

  /** 已解锁且处于授权/签名/交易页：用于 unlock 提前返回，避免空等密码框 */
  private async isActionReady(popup: PopupPage): Promise<boolean> {
    if (await this.anySelectorVisible(popup, titleSelectors(SIGNATURE_TITLE_TEXTS))) return true
    if (await this.anySelectorVisible(popup, titleSelectors(TRANSACTION_TITLE_TEXTS))) return true
    if (await this.anySelectorVisible(popup, buttonSelectors(CONNECT_TEXTS))) return true
    return this.anySelectorVisible(popup, buttonSelectors(APPROVE_TEXTS))
  }

  /**
   * 点击确认按钮直到弹窗关闭。
   * 最多 3 轮：每轮等按钮出现并点击，成功判定为弹窗关闭（close 事件与 isClosed 轮询并行）。
   * @throws 钱包已锁定但未配密码；或 3 轮后弹窗仍未关闭
   */
  private async confirmWith(popup: PopupPage, texts: string[], label: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (popup.isClosed?.()) return
      if (await this.locatorVisible(popup, 'input[type="password"]')) {
        throw new Error('SubWallet 已锁定且未配置解锁密码（请在 config/.env 配置 WALLET_PASSWORDS 或 config.local.json 的 wallet.passwords）')
      }
      const btn = await this.waitButton(popup, texts, 10000)
      if (!btn) break
      await btn.click()
      if (await waitForPopupClose(popup, 5000)) return
    }
    throw new Error(`SubWallet ${label}未完成（弹窗未关闭）`)
  }

  /** 轮询等待某组按钮文案中出现首个可见者 */
  private async waitButton(popup: PopupPage, texts: string[], timeoutMs: number): Promise<PopupLocator | null> {
    const deadline = Date.now() + timeoutMs
    const selectors = buttonSelectors(texts)
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return null
      const found = await this.firstVisible(popup, selectors)
      if (found) return found
      await sleep(POPUP_POLL_MS)
    }
    return null
  }

  /** 一组选择器中首个可见的定位器 */
  private async firstVisible(popup: PopupPage, selectors: string[]): Promise<PopupLocator | null> {
    for (const sel of selectors) {
      const loc = popup.locator(sel).first()
      try {
        if (await this.locatorIsVisible(loc)) return loc
      } catch {
        // 单次探测失败视为该候选不可见，继续试下一个
      }
    }
    return null
  }

  /** 一组选择器中是否至少有一个可见 */
  private async anySelectorVisible(popup: PopupPage, selectors: string[]): Promise<boolean> {
    return (await this.firstVisible(popup, selectors)) !== null
  }

  /** 单一定位器是否可见：优先 isVisible，mock 无可见性 API 时回退 count>0 */
  private async locatorIsVisible(loc: PopupLocator): Promise<boolean> {
    if (loc.isVisible) return loc.isVisible().catch(() => false)
    return ((await loc.count?.()) ?? 0) > 0
  }

  /** 某选择器当前是否可见 */
  private async locatorVisible(popup: PopupPage, selector: string): Promise<boolean> {
    return this.locatorIsVisible(popup.locator(selector).first())
  }
}

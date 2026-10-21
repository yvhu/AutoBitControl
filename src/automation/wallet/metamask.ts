/**
 * MetaMask 钱包适配器（automation 层）：解锁 + 连接/签名/交易确认
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：全部用官方 data-testid 定位（与 UI 语言无关——实测中文版 MetaMask
 * 按钮文案为「登录/连接/取消」，英文正则匹配不到）；
 * 弹窗 UI 渲染有延迟（多窗口并发时尤甚），解锁与连接确认均改为轮询等待状态出现，
 * 不能单次 count 判「已解锁」；连接确认成功判定 = 弹窗关闭 或 连接页先存在后消失
 */
import type { WalletAdapter, PopupPage } from './types'
import { POPUP_POLL_MS, sleep, waitForPopupClose } from './popup-wait'

/** 连接确认按钮 testid 候选（多版本兼容，与 UI 语言无关） */
const CONFIRM_TESTIDS = ['confirm-btn', 'confirm-footer-button', 'permissions-connect-button', 'signature-request-sign-button']

/**
 * “已解锁/可操作”判定：除了解锁页，连接/授权/签名页的任一元素都说明钱包已经解锁。
 * 旧实现只认 confirm-btn，解锁后的签名/交易弹窗会被误判成“还没解锁”而空轮询满预算。
 */
const UNLOCKED_TESTIDS = [...CONFIRM_TESTIDS, 'connect-page', 'signature-request']

/** close 不可靠时的兜底：确认连接页消失（先 count 确认存在） */
const CONNECT_PAGE_GONE_MS = 5000

/** 确认按钮角色名回退（英文/中文双覆盖） */
const CONFIRM_ROLE = /connect|next|confirm|approve|sign|unlock|连接|确认|签名|下一步|批准|登录/i

/**
 * MetaMask 钱包适配器：把「解锁 / 连接 / 签名 / 交易确认」四类交互翻译成对 MetaMask 弹窗的操作。
 * 定位一律优先用官方 data-testid（与界面语言无关，避免中文版文案匹配不到的问题），
 * 确认按钮再用角色名正则兜底。核心难点是弹窗 UI 渲染有延迟（多窗口并发时尤甚），
 * 因此所有等待都改成轮询状态，而不是单次判断。
 */
export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
  displayName = 'MetaMask'
  extensionId = 'nkbihfbeogaeaoehlefnkodbefgpgknn'
  probePath = 'home.html'
  providerFlag = 'isMetaMask'
  // 弹窗 URL 模式：home（解锁页）/ notification（解锁 + 连接确认页）/ metamask://（协议唤起）
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html', 'metamask://']
  /** 解锁状态轮询预算：弹窗 UI 渲染有延迟（多窗口并发高负载时尤甚，真机实测可 >20s），默认 45s */
  private readonly unlockWaitMs: number

  /**
   * @param opts.unlockWaitMs 解锁状态轮询的总预算毫秒数；缺省 45000
   * （多窗口并发高负载时弹窗渲染慢，真机实测可能超过 20s，故放宽）
   */
  constructor(opts: { unlockWaitMs?: number } = {}) {
    this.unlockWaitMs = opts.unlockWaitMs ?? 45000
  }

  /**
   * 解锁钱包弹窗。
   * 之所以要轮询而不是单次判断，是因为弹窗 UI 渲染有延迟（多窗口并发时尤其明显），
   * 一开始可能既没有解锁框也没有连接/授权元素。循环内每 200ms 检查状态：
   * ① 出现密码框 → 填入密码、点提交，再等解锁页消失后返回；
   * ② 出现连接/授权/签名元素 → 说明弹窗本就已解锁，直接返回；
   * ③ 弹窗已被关闭 → 直接返回。直到预算用尽仍无任何状态则抛错。
   * @param popup 钱包弹窗页
   * @param password 解锁密码
   * @throws 预算内解锁框/连接确认始终未渲染，或密码错误/解锁页迟迟不离开
   */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    const deadline = Date.now() + this.unlockWaitMs
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return
      const pw = popup.getByTestId('unlock-password').first()
      let pwCount = 0
      try {
        pwCount = (await pw.count?.()) ?? 0
      } catch {
        if (popup.isClosed?.()) return
      }
      if (pwCount > 0) {
        await pw.fill(password)
        await popup.getByTestId('unlock-submit').first().click()
        // 等解锁页消失；若解锁页没 detach 但已切到确认页（仍留在 DOM 里），也视为解锁成功
        try {
          await popup.getByTestId('unlock-page').first().waitFor?.({ state: 'detached', timeout: 30000 })
        } catch {
          const unlockStillVisible = await this.testIdVisible(popup, ['unlock-page', 'unlock-password'])
          if (!unlockStillVisible && (await this.testIdVisible(popup, UNLOCKED_TESTIDS))) return
          throw new Error('MetaMask 解锁失败（密码错误或解锁页未离开）')
        }
        return
      }
      // 已解锁：连接/授权/签名页任一可见即返回（不再只认 confirm-btn）
      if (await this.testIdVisible(popup, UNLOCKED_TESTIDS)) return
      await sleep(POPUP_POLL_MS)
    }
    throw new Error('MetaMask 弹窗状态未出现（解锁框/连接确认轮询超时均未渲染）')
  }

  /**
   * 弹窗 UI 是否已渲染到可操作状态：密码框、解锁页或任一授权/签名元素可见。
   * 登录流程会先等它就绪再分类，避免弹窗窗口已出现、DOM 还没渲染时被误判成 unknown 再空跑一轮竞速。
   */
  async isPopupReady(popup: PopupPage): Promise<boolean> {
    if (popup.isClosed?.()) return true
    return this.testIdVisible(popup, ['unlock-password', 'unlock-page', ...UNLOCKED_TESTIDS])
  }

  /** 处理「站点请求连接钱包」的弹窗：三种意图在 MetaMask 里按钮布局一致，统一委托 confirm */
  async connect(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /** 处理「站点请求消息签名」的弹窗：同样委托 confirm */
  async sign(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /** 处理「站点请求交易确认」的弹窗：同样委托 confirm */
  async confirmTx(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /**
   * 分类 MetaMask 弹窗：按稳定 data-testid 判定意图。
   * 顺序：unlock → connect → tx → sign。之所以 tx 先于 sign：二者可能共享 confirm 按钮，
   * 且 mock/旧定位器只提供 count（存在即命中）时，隐藏的签名标记会被误判为可见——
   * 把保守的 tx 提前，保证「隐藏 sign + 可见 confirm」不会误自动点击交易确认。
   * @param popup 钱包弹窗页
   * @returns 弹窗意图类别；无法判定返回 'unknown'
   */
  async classifyPopup(popup: PopupPage): Promise<'unlock' | 'connect' | 'sign' | 'tx' | 'unknown'> {
    if (await this.testIdVisible(popup, ['unlock-password', 'unlock-page'])) return 'unlock'
    if (await this.testIdVisible(popup, ['connect-page', 'permissions-connect-button'])) return 'connect'
    if (await this.testIdVisible(popup, ['confirm-footer-button', 'confirm-btn'])) return 'tx'
    if (await this.testIdVisible(popup, ['signature-request', 'signature-request-sign-button'])) return 'sign'
    return 'unknown'
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

  /** 一组 testid 中是否至少有一个当前可见：优先 isVisible（区分存在但隐藏），mock 无 isVisible 时回退 count>0 */
  private async testIdVisible(popup: PopupPage, testids: string[]): Promise<boolean> {
    for (const tid of testids) {
      const loc = popup.getByTestId(tid).first()
      try {
        if (loc.isVisible) {
          if (await loc.isVisible()) return true
        } else if (((await loc.count?.()) ?? 0) > 0) {
          return true
        }
      } catch {
        if (popup.isClosed?.()) return false
      }
    }
    return false
  }

  /**
   * 点击确认按钮完成一次授权（连接/签名/交易共用）。
   * 执行流程：入场先等 2s 让弹窗 UI 沉降（新窗口/并发下未渲染完就点会导致点击丢失、弹窗不关）；
   * 然后最多 3 轮——每轮先探一下解锁框，若存在说明钱包已锁定且没配密码（配了的话 unlock 已提前解锁），
   * 立即抛明确错误，避免角色名回退误点到「解锁」按钮而空转；否则等确认按钮出现并点击，
   * 再等「弹窗 close 事件」或「连接页先存在后消失」作为成功信号（比特浏览器后台/最小化时 close 事件不可靠，
   * 故用 isClosed 轮询与连接页消失兜底）。任一步成功即返回；3 轮结束仍未完成则抛错。
   * @param popup 钱包弹窗页
   * @throws 钱包已锁定但未配置解锁密码；或 3 轮后弹窗仍未关闭
   */
  private async confirm(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (popup.isClosed?.()) break
      const lockLoc = popup.getByTestId('unlock-password').first()
      let locked = false
      try {
        locked = ((await lockLoc.count?.()) ?? 0) > 0
      } catch {
        if (popup.isClosed?.()) break
      }
      if (locked) throw new Error('MetaMask 已锁定且未配置解锁密码（请在 config/.env 配置 WALLET_PASSWORDS 或 config.local.json 的 wallet.passwords）')
      // 不再固定等 2 秒：按钮已渲染就立刻点（waitConfirmBtn 内部 200ms 轮询）
      const btn = await this.waitConfirmBtn(popup, 10000)
      if (!btn) break
      await btn.click()
      if (popup.isClosed?.()) return
      // close 事件与 isClosed 轮询并行：事件漏收时 100ms 内也能发现窗口已关
      if (await waitForPopupClose(popup)) return
      // 弹窗未关但连接页已消失也判成功（先 count 确认存在——detached 对从未出现的元素立即成功）
      const cp = popup.getByTestId('connect-page').first()
      try {
        if (cp.count && (await cp.count()) > 0) {
          await cp.waitFor?.({ state: 'detached', timeout: CONNECT_PAGE_GONE_MS })
          return
        }
      } catch {
        // 连接页仍在（可能进入下一步确认），继续下一轮
      }
    }
    throw new Error('MetaMask 连接确认未完成（弹窗未关闭）')
  }

  /**
   * 轮询等待确认按钮渲染出来。
   * 每 200ms 检查一轮：先按一组 data-testid 候选找（多版本兼容、与语言无关），
   * 找不到再用按钮角色名正则兜底；弹窗中途关闭或超时则返回 null。
   * @param popup 钱包弹窗页
   * @param timeoutMs 最长等待毫秒数
   * @returns 命中的确认按钮定位器；未找到返回 null
   */
  private async waitConfirmBtn(popup: PopupPage, timeoutMs: number): Promise<ReturnType<PopupPage['getByTestId']> | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return null
      try {
        for (const tid of CONFIRM_TESTIDS) {
          const loc = popup.getByTestId(tid).first()
          if (((await loc.count?.()) ?? 0) > 0) return loc
        }
        const role = popup.getByRole('button', { name: CONFIRM_ROLE }).first()
        if (((await role.count?.()) ?? 0) > 0) return role
      } catch {
        if (popup.isClosed?.()) return null
      }
      await sleep(POPUP_POLL_MS)
    }
    return null
  }
}

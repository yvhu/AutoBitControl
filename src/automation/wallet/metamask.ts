/**
 * MetaMask 钱包适配器（automation 层）：解锁 + 连接/签名/交易确认
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：全部用官方 data-testid 定位（与 UI 语言无关——实测中文版 MetaMask
 * 按钮文案为「登录/连接/取消」，英文正则匹配不到）；
 * 弹窗 UI 渲染有延迟（多窗口并发时尤甚），解锁与连接确认均改为轮询等待状态出现，
 * 不能单次 count 判「已解锁」；连接确认成功判定 = close 事件 或 连接页先存在后消失
 */
import type { WalletAdapter, PopupPage } from './types'

/** 连接确认按钮 testid 候选（多版本兼容，与 UI 语言无关） */
const CONFIRM_TESTIDS = ['confirm-btn', 'confirm-footer-button', 'permissions-connect-button', 'signature-request-sign-button']

/** 确认按钮角色名回退（英文/中文双覆盖） */
const CONFIRM_ROLE = /connect|next|confirm|approve|sign|unlock|连接|确认|签名|下一步|批准|登录/i

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * MetaMask 钱包适配器：把「解锁 / 连接 / 签名 / 交易确认」四类交互翻译成对 MetaMask 弹窗的操作。
 * 定位一律优先用官方 data-testid（与界面语言无关，避免中文版文案匹配不到的问题），
 * 确认按钮再用角色名正则兜底。核心难点是弹窗 UI 渲染有延迟（多窗口并发时尤甚），
 * 因此所有等待都改成轮询状态，而不是单次判断。
 */
export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
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
   * 一开始可能既没有解锁框也没有连接按钮。循环内每 500ms 检查三种状态：
   * ① 出现密码框 → 填入密码、点提交，再等解锁页 detached 消失后返回；
   * ② 出现连接确认按钮 → 说明弹窗本就已解锁，直接返回；
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
        // 等解锁页消失（waitFor detached 对从未出现的元素立即成功——解锁框已确认存在，此判定安全）；
        // 30s 预算：正确密码下解锁页通常秒离，慢渲染（多窗口并发）时放宽
        try {
          await popup.getByTestId('unlock-page').first().waitFor?.({ state: 'detached', timeout: 30000 })
        } catch {
          throw new Error('MetaMask 解锁失败（密码错误或解锁页未离开）')
        }
        return
      }
      const confirm = popup.getByTestId('confirm-btn').first()
      try {
        if (((await confirm.count?.()) ?? 0) > 0) return
      } catch {
        if (popup.isClosed?.()) return
      }
      await sleep(500)
    }
    throw new Error('MetaMask 弹窗状态未出现（解锁框/连接确认轮询超时均未渲染）')
  }

  /** 处理「站点请求连接钱包」的弹窗：三种意图在 MetaMask 里按钮布局一致，统一委托 confirm */
  async connect(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /** 处理「站点请求消息签名」的弹窗：同样委托 confirm */
  async sign(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /** 处理「站点请求交易确认」的弹窗：同样委托 confirm */
  async confirmTx(popup: PopupPage): Promise<void> { await this.confirm(popup) }

  /**
   * 点击确认按钮完成一次授权（连接/签名/交易共用）。
   * 执行流程：入场先等 2s 让弹窗 UI 沉降（新窗口/并发下未渲染完就点会导致点击丢失、弹窗不关）；
   * 然后最多 3 轮——每轮先探一下解锁框，若存在说明钱包已锁定且没配密码（配了的话 unlock 已提前解锁），
   * 立即抛明确错误，避免角色名回退误点到「解锁」按钮而空转；否则等确认按钮出现并点击，
   * 再等「弹窗 close 事件」或「连接页先存在后消失」作为成功信号（比特浏览器后台/最小化时 close 事件不可靠，
   * 故用连接页消失兜底）。任一步成功即返回；3 轮结束仍未完成则抛错。
   * @param popup 钱包弹窗页
   * @throws 钱包已锁定但未配置解锁密码；或 3 轮后弹窗仍未关闭
   */
  private async confirm(popup: PopupPage): Promise<void> {
    // 弹窗 UI 沉降：等初始渲染完成再开始交互，避免点击落在未挂载完成的界面上被吞掉
    await sleep(2000)
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
      const btn = await this.waitConfirmBtn(popup, 10000)
      if (!btn) break
      await btn.click()
      const closed = await popup.waitForEvent('close', { timeout: 15000 }).then(() => true).catch(() => false)
      if (closed) return
      // close 事件没来：连接页若已消失（先确认过存在——detached 对从未出现的元素立即成功，必须 count 校验）
      const cp = popup.getByTestId('connect-page').first()
      try {
        if (cp.count && (await cp.count()) > 0) {
          await cp.waitFor?.({ state: 'detached', timeout: 15000 })
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
   * 每 500ms 检查一轮：先按一组 data-testid 候选找（多版本兼容、与语言无关），
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
      await sleep(500)
    }
    return null
  }
}

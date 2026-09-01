/**
 * MetaMask 钱包适配器（automation 层）：解锁 + 连接确认
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

export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
  extensionId = 'nkbihfbeogaeaoehlefnkodbefgpgknn'
  probePath = 'home.html'
  providerFlag = 'isMetaMask'
  // 弹窗 URL 模式：home（解锁页）/ notification（解锁 + 连接确认页）/ metamask://（协议唤起）
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html', 'metamask://']
  /** 解锁状态轮询预算：弹窗 UI 渲染有延迟（多窗口并发高负载时尤甚，真机实测可 >20s），默认 45s */
  private readonly unlockWaitMs: number

  constructor(opts: { unlockWaitMs?: number } = {}) {
    this.unlockWaitMs = opts.unlockWaitMs ?? 45000
  }

  /**
   * 解锁：弹窗 UI 渲染有延迟（尤其多窗口并发时），不能单次 count 判「已解锁」——
   * 轮询等三态：解锁框出现 → 填密码提交、等解锁页消失；连接按钮出现 → 已解锁直接返回；弹窗关闭 → 返回
   * @throws 轮询预算内无任何状态（解锁框/连接确认均未渲染）
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

  /**
   * 连接确认：先等确认按钮渲染（testid 候选 → 角色名回退），点击后成功判定 =
   * 弹窗 close 事件 或 连接页「先存在后消失」（比特浏览器后台/最小化时 close 事件不可靠）；
   * 最多 3 轮（覆盖连接 → 签名等多步授权）
   * 每轮先检测解锁框：存在说明钱包已锁定且未配置密码（配置密码时 unlock 已先行解锁），
   * 立即抛明确错误，避免角色名回退误点「解锁」按钮后 3 轮空转
   * 弹窗加载沉降：新开窗口/并发下弹窗 UI 渲染慢（真机实测：未加载完成就点连接会点击丢失、
   * 弹窗不关闭），入场先等 2s，点击后的关闭判定放宽到 15s（MetaMask 处理连接请求可能较慢）
   * @throws 钱包锁定未配密码 / 3 轮后仍未完成
   */
  async ensureConnected(popup: PopupPage): Promise<void> {
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

  /** 轮询等确认按钮出现（testid 候选优先，角色名兜底；弹窗关闭或超时返回 null） */
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

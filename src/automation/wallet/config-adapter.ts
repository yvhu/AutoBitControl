/**
 * 配置驱动的通用钱包适配器（automation/wallet 层）：新钱包首选实现方式——填一条配置即得适配器
 * 依赖方向：仅依赖 ./types，经 WalletRegistry 注册后供任务侧按 key 使用
 * 设计思路：内置一套多语言按钮候选（Connect/连接、Sign/签名、Confirm/确认、Approve、Unlock/解锁、Next/下一步），
 *   classifyPopup 只按「哪些候选可见」判定意图，handleLoginPopup 按分类点按钮；
 *   安全边界：分类为 tx 的弹窗绝不自动处理（返回 false），交易由任务显式 confirmTx。
 *   多数新钱包只需 key + displayName + extensionId。
 */
import type { PopupKind, PopupLocator, PopupPage, WalletAdapter } from './types'

/** 配置驱动适配器的按钮候选配置：每类意图一组选择器，按数组顺序取首个可见者 */
export interface WalletAdapterConfig {
  /** 钱包类型标识（全局唯一，与 WalletRegistry/任务 wallet 对应） */
  key: string
  /** 钱包显示名（站内钱包列表匹配用） */
  displayName: string
  /** 扩展 ID（可缺省：缺省则不做 CDP 扩展页探测） */
  extensionId?: string
  /** 扩展页探测路径（缺省 'index.html'） */
  probePath?: string
  /** 页面 provider 标识字段（缺省空串：不按 provider 判定，交给 expectsProvider 降级） */
  providerFlag?: string
  /** 覆盖内置按钮候选（可选，只覆盖显式给出的类别） */
  buttons?: { unlock?: string[]; connect?: string[]; sign?: string[]; confirmTx?: string[] }
}

/**
 * 内置多语言按钮候选。注意「确认/Confirm」在 sign 与 confirmTx 中都出现——
 * classifyPopup 通过「先判 confirmTx 再判 sign」保证共享文案落入更保守的 tx 分类，
 * 从而绝不把可能的交易确认误当签名自动点击。
 */
const DEFAULT_BUTTONS = {
  unlock: ['button:has-text("Unlock")', 'button:has-text("解锁")', 'button:has-text("确认")'],
  connect: ['button:has-text("Connect")', 'button:has-text("连接")', 'button:has-text("下一步")', 'button:has-text("Next")'],
  sign: ['button:has-text("Sign")', 'button:has-text("签名")', 'button:has-text("确认")', 'button:has-text("Confirm")'],
  confirmTx: ['button:has-text("Confirm")', 'button:has-text("确认")', 'button:has-text("Approve")'],
}

/**
 * 创建配置驱动的通用钱包适配器。
 * @param config 钱包配置（key/displayName 必填，其余可缺省）
 * @returns 实现 WalletAdapter 的适配器实例
 */
export function createConfigWalletAdapter(config: WalletAdapterConfig): WalletAdapter {
  const buttons = {
    unlock: config.buttons?.unlock ?? DEFAULT_BUTTONS.unlock,
    connect: config.buttons?.connect ?? DEFAULT_BUTTONS.connect,
    sign: config.buttons?.sign ?? DEFAULT_BUTTONS.sign,
    confirmTx: config.buttons?.confirmTx ?? DEFAULT_BUTTONS.confirmTx,
  }
  const extensionId = config.extensionId
  // 有扩展 ID 就按该扩展页 URL 匹配弹窗；否则退化为「任意扩展页」，由调用方兜住误匹配风险
  const extensionUrlPatterns = extensionId
    ? [`chrome-extension://${extensionId}/`]
    : ['chrome-extension://.*/']

  /** 单一定位器是否可见：优先 isVisible（区分存在但隐藏），mock 无 isVisible 时回退 count>0 */
  const locatorVisible = async (loc: PopupLocator): Promise<boolean> => {
    if (loc.isVisible) return loc.isVisible().catch(() => false)
    return ((await loc.count?.()) ?? 0) > 0
  }

  /** 取候选选择器中首个可见的定位器；都不可见返回 null */
  const firstVisible = async (popup: PopupPage, selectors: string[]): Promise<PopupLocator | null> => {
    for (const sel of selectors) {
      const loc = popup.locator(sel).first()
      try {
        if (await locatorVisible(loc)) return loc
      } catch {
        // 单次探测失败视为该候选不可见，继续试下一个
      }
    }
    return null
  }

  /** 密码框是否可见（unlock 的可靠信号，优先于按钮文案） */
  const passwordVisible = async (popup: PopupPage): Promise<boolean> => {
    for (const sel of ['input[type=password]', 'input[type="password"]']) {
      const loc = popup.locator(sel).first()
      try {
        if (await locatorVisible(loc)) return true
      } catch {
        // 忽略单次失败
      }
    }
    return false
  }

  const classifyPopup = async (popup: PopupPage): Promise<PopupKind> => {
    if (await passwordVisible(popup)) return 'unlock'
    // 先判 tx：与 sign 共享的「确认/Confirm」文案保守归入交易，绝不自动点击
    if (await firstVisible(popup, buttons.confirmTx)) return 'tx'
    if (await firstVisible(popup, buttons.sign)) return 'sign'
    if (await firstVisible(popup, buttons.connect)) return 'connect'
    return 'unknown'
  }

  return {
    key: config.key,
    displayName: config.displayName,
    extensionUrlPatterns,
    extensionId,
    probePath: config.probePath ?? 'index.html',
    providerFlag: config.providerFlag ?? '',
    // 未配 providerFlag 时不按 provider 判定（避免轮询 window.ethereum[''] 恒 false 误判）
    expectsProvider: config.providerFlag ? undefined : false,

    classifyPopup,

    /** 登录自适应：unlock 填密码并提交，connect/sign 点候选；tx/unknown/缺密码一律返回 false */
    async handleLoginPopup(popup: PopupPage, password?: string): Promise<boolean> {
      const kind = await classifyPopup(popup)
      if (kind === 'tx' || kind === 'unknown') return false
      if (kind === 'unlock') {
        if (!password) return false
        const pw = popup.locator('input[type=password]').first()
        await pw.fill(password)
        const submit = await firstVisible(popup, buttons.unlock)
        if (submit) await submit.click()
        else await pw.press?.('Enter')
        return true
      }
      const candidates = kind === 'connect' ? buttons.connect : buttons.sign
      const btn = await firstVisible(popup, candidates)
      if (!btn) return false
      await btn.click()
      return true
    },

    /** 解锁：等密码框出现后填密码提交（配置驱动版的 unlock 意图，供 connectWallet 复用） */
    async unlock(popup: PopupPage, password: string): Promise<void> {
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        if (popup.isClosed?.()) return
        if (await passwordVisible(popup)) {
          const pw = popup.locator('input[type=password]').first()
          await pw.fill(password)
          const submit = await firstVisible(popup, buttons.unlock)
          if (submit) await submit.click()
          else await pw.press?.('Enter')
          return
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`${config.displayName} 弹窗解锁框未出现（轮询超时）`)
    },

    /** 连接授权：点 connect 候选 */
    async connect(popup: PopupPage): Promise<void> {
      const btn = await firstVisible(popup, buttons.connect)
      if (!btn) throw new Error(`${config.displayName} 连接按钮未出现`)
      await btn.click()
    },

    /** 消息签名：点 sign 候选 */
    async sign(popup: PopupPage): Promise<void> {
      const btn = await firstVisible(popup, buttons.sign)
      if (!btn) throw new Error(`${config.displayName} 签名按钮未出现`)
      await btn.click()
    },

    /** 交易确认：点 confirmTx 候选（仅任务显式调用时执行，登录流程不会走到这里） */
    async confirmTx(popup: PopupPage): Promise<void> {
      const btn = await firstVisible(popup, buttons.confirmTx)
      if (!btn) throw new Error(`${config.displayName} 交易确认按钮未出现`)
      await btn.click()
    },
  }
}

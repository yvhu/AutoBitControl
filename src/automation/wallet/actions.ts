/**
 * 钱包动作门面（automation/wallet 层）：ready/login/sign/confirmTx —— 一次弹窗一次意图
 * 依赖方向：依赖 ./types、./popup、./session、./login-flow 类型
 */
import type { Page } from 'patchright'
import type { Logger } from '../../infrastructure/logger'
import type { RecoverOpts, Probe } from '../dom'
import type { WalletRegistry, PopupPage } from './types'
import type { WalletSession } from './session'
import { waitForPopup } from './popup'

/** 钱包意图：一次弹窗要处理的三种授权之一（连接 / 签名 / 交易确认） */
export type WalletIntent = 'connect' | 'sign' | 'confirmTx'

/**
 * WalletActions 的依赖集：由 engine 层（window-runner → TaskContext）装配注入，
 * 把「页面、当前钱包、注册表、密码、会话检测、日志、恢复能力」集中打包。
 */
export interface WalletActionsDeps {
  /** 当前任务页面（钱包弹窗将在其所在浏览器上下文中出现） */
  page: Page
  /** 当前任务配置的钱包类型；未配置时钱包相关操作按「无钱包」处理 */
  walletKey?: string
  /** 钱包适配器注册表（按 walletKey 取适配器），未注入时调用相关方法会抛错 */
  wallets?: WalletRegistry
  /** 钱包解锁密码映射（key 为钱包类型；同类型钱包共用同一密码） */
  walletPasswords: Record<string, string>
  /** 会话级扩展就绪检测器；未注入时 ready 检查会被跳过 */
  walletSession?: WalletSession
  /** 日志器 */
  log: Logger
  /** 刷新恢复等待能力（透传到 TaskContext.recover），登录编排用它等「已登录」标志 */
  recover(probe: Probe, opts: RecoverOpts): Promise<boolean>
}

/** 弹窗交互的可选参数 */
export interface PopupLoginOpts {
  /** 补点配置：等待 afterMs 毫秒若弹窗仍未出现，就点一下 selector 重新触发（应对慢渲染/点击落空） */
  reclick?: { selector: string; afterMs: number }
}

/**
 * 钱包动作门面：把「等待弹窗 → 解锁 → 执行某个意图」打包成一次调用，
 * 任务侧只表达「我要连接/签名/确认交易」，不关心底层插件 UI 的差异。
 */
export class WalletActions {
  constructor(readonly deps: WalletActionsDeps) {}

  /**
   * 会话级扩展就绪检查：确认当前窗口里该钱包扩展确实加载了。
   * 未配置 walletKey 或未注入 walletSession 时直接跳过（视为无需检查）；
   * 否则从注册表取适配器、委托 walletSession 探测，结果为 missing 时抛错——
   * 这种错误重试会重启浏览器窗口，属于可利用的重试信号。
   * @throws 未注入钱包注册表；或扩展未加载（missing）
   */
  async ready(): Promise<void> {
    const key = this.deps.walletKey
    if (!key) return
    const session = this.deps.walletSession
    if (!session) return
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(key)
    const state = await session.ensureReady(key, adapter)
    if (state === 'missing') throw new Error(`窗口 ${key} 钱包扩展未加载（重试将重启浏览器窗口）`)
  }

  /**
   * 执行一次钱包意图：等弹窗 → 解锁 → 执行意图。
   * 执行流程：先按适配器的弹窗 URL 模式发起最长 60s 的等待；若传了 reclick，
   * 则在 afterMs 内每 500ms 探测一次弹窗是否提前出现，若始终没出现就点一下补点选择器
   * （应对慢渲染或首次点击落空），然后继续等同一个弹窗。等不到弹窗就返回 popupFailed=true
   * ——这是「静默连接」场景，站点可能已悄悄连上，调用方据此改用登录态判定。
   * 拿到弹窗后，若有配置密码且适配器支持解锁，先解锁，再调用对应意图方法。
   * @param intent 要执行的意图（connect/sign/confirmTx）
   * @param opts 可选的补点参数
   * @returns popupFailed=true 表示弹窗根本没出现；false 表示弹窗出现且已处理
   * @throws 任务未配置钱包；未注入注册表；或解锁/意图执行失败
   */
  async runIntent(intent: WalletIntent, opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> {
    const key = this.deps.walletKey
    if (!key) throw new Error('任务未配置钱包')
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(key)
    const popupPromise = waitForPopup(this.deps.page.context(), adapter.extensionUrlPatterns, 60000)
    if (opts.reclick) {
      const start = Date.now()
      let appeared = false
      while (Date.now() - start < opts.reclick.afterMs) {
        const r = await Promise.race([
          popupPromise.then((p): 'popup' | 'timeout' => (p ? 'popup' : 'timeout')).catch(() => 'timeout' as const),
          new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 500)),
        ])
        if (r === 'popup') { appeared = true; break }
      }
      if (!appeared) await this.deps.page.locator(opts.reclick.selector).first().click({ timeout: 5000 }).catch(() => {})
    }
    const popup = (await popupPromise) as PopupPage | null
    if (!popup) return { popupFailed: true }
    const password = this.deps.walletPasswords[key]
    if (password && adapter.unlock) await adapter.unlock(popup, password)
    await adapter[intent](popup)
    return { popupFailed: false }
  }

  /** 连接钱包（下发 connect 意图的便捷入口） */
  async login(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('connect', opts) }
  /** 消息签名（下发 sign 意图的便捷入口） */
  async sign(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('sign', opts) }
  /** 交易确认（下发 confirmTx 意图的便捷入口） */
  async confirmTx(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('confirmTx', opts) }

  /**
   * 完整登录编排：动态载入 login-flow.ts 的 ensureLoggedIn 执行，
   * 因为登录编排需要用到本类实例，放外部以避免模块循环依赖。
   * @param spec 登录规格（探针、入口、意图序列等，见 LoginSpec）
   * @returns skipped=true 表示进页面时就已是登录态；false 表示本次实际完成了登录
   */
  async ensureLoggedIn(spec: import('./login-flow').LoginSpec): Promise<{ skipped: boolean }> {
    const { ensureLoggedIn } = await import('./login-flow')
    return ensureLoggedIn(this, spec)
  }
}

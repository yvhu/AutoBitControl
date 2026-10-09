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

export type WalletIntent = 'connect' | 'sign' | 'confirmTx'

export interface WalletActionsDeps {
  page: Page
  walletKey?: string
  wallets?: WalletRegistry
  walletPasswords: Record<string, string>
  walletSession?: WalletSession
  log: Logger
  human: { click(selector: string): Promise<void> }
  recover(probe: Probe, opts: RecoverOpts): Promise<boolean>
}

export interface PopupLoginOpts {
  reclick?: { selector: string; afterMs: number }
}

export class WalletActions {
  constructor(readonly deps: WalletActionsDeps) {}

  /** 会话级扩展就绪检查（未配置 wallet / 未注入会话时跳过） */
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

  /** 等一次钱包弹窗 → 解锁 → 指定意图；弹窗未出现返回 popupFailed=true（静默连接容忍） */
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
      if (!appeared) await this.deps.human.click(opts.reclick.selector).catch(() => {})
    }
    const popup = (await popupPromise) as PopupPage | null
    if (!popup) return { popupFailed: true }
    const password = this.deps.walletPasswords[key]
    if (password && adapter.unlock) await adapter.unlock(popup, password)
    await adapter[intent](popup)
    return { popupFailed: false }
  }

  async login(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('connect', opts) }
  async sign(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('sign', opts) }
  async confirmTx(opts: PopupLoginOpts = {}): Promise<{ popupFailed: boolean }> { return this.runIntent('confirmTx', opts) }

  /** 完整登录编排，见 login-flow.ts */
  async ensureLoggedIn(spec: import('./login-flow').LoginSpec): Promise<{ skipped: boolean }> {
    const { ensureLoggedIn } = await import('./login-flow')
    return ensureLoggedIn(this, spec)
  }
}

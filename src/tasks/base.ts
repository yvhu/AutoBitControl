import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'patchright'
import type { AppConfig } from '../core/config'
import type { Logger } from '../core/logger'
import type { ProfileRow } from '../core/db'
import { Humanizer } from '../core/humanize'
import { CaptchaService } from '../core/captcha'
import { WalletRegistry, type PopupPage } from '../core/wallet/types'

export interface TaskMeta {
  key: string
  name: string
  url: string
  schedule?: string | { stagger: [string, string] }
  wallet?: string
  timeoutSec?: number
  retry?: { max: number; backoffSec: number }
  captcha?: { auto?: boolean; maxCost?: number }
}

export interface TaskContextDeps {
  page: Page
  task: SiteTask
  human: Humanizer
  profile: ProfileRow
  cfg: AppConfig
  logger: Logger
  artifactsDir: string
  captcha?: CaptchaService
  wallets?: WalletRegistry
  onCaptchaLog?: (kind: string, ok: boolean, costPoints: number) => void
}

export abstract class SiteTask {
  abstract meta: TaskMeta
  abstract run(ctx: TaskContext): Promise<void>
}

export class TaskContext {
  constructor(private deps: TaskContextDeps) {}

  get page(): Page {
    return this.deps.page
  }

  get human(): Humanizer {
    return this.deps.human
  }

  get profile(): ProfileRow {
    return this.deps.profile
  }

  async goto(url?: string): Promise<void> {
    const target = url ?? this.deps.task.meta.url
    if (!target) throw new Error('任务未配置 url')
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.page.goto(target, { timeout: 45000, waitUntil: 'domcontentloaded' })
        await Humanizer.sleep(800, 3000)
        return
      } catch (e) {
        this.deps.logger.warn({ url: target, attempt }, `页面加载失败，重试 ${attempt}/3`)
        if (attempt === 3) throw e
        await Humanizer.sleep(2000, 5000)
      }
    }
  }

  async clickCheckin(selector: string, opts: { assert?: string; assertTimeoutMs?: number } = {}): Promise<void> {
    await this.human.click(selector)
    if (opts.assert) {
      await this.assertVisible(opts.assert, opts.assertTimeoutMs ?? 10000)
    }
  }

  async assertVisible(selector: string, timeoutMs = 10000): Promise<void> {
    try {
      await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
    } catch {
      throw new Error(`断言超时: 元素 ${selector} 未出现`)
    }
  }

  async typeInto(selector: string, text: string): Promise<void> {
    await this.human.type(selector, text)
  }

  async solveCaptcha(): Promise<'none' | 'solved' | 'failed'> {
    if (!this.deps.captcha) return 'none'
    const taskCfg = this.deps.task.meta.captcha ?? { auto: true }
    return this.deps.captcha.autoSolve(this.page, {
      enabled: taskCfg.auto ?? true,
      profileId: this.deps.profile.id,
      taskKey: this.deps.task.meta.key,
      onLog: (kind, ok, costPoints) => {
        this.deps.onCaptchaLog?.(kind, ok, costPoints)
      },
    })
  }

  async screenshot(name: string): Promise<string> {
    mkdirSync(this.deps.artifactsDir, { recursive: true })
    const file = join(this.deps.artifactsDir, `${name}.png`)
    await this.page.screenshot({ path: file, fullPage: false })
    return file
  }

  async loginByWallet(): Promise<void> {
    const walletKey = this.deps.task.meta.wallet
    if (!walletKey) throw new Error('任务未配置钱包')
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(walletKey)
    const popup = await waitForWalletPopup(this.page, adapter.extensionUrlPatterns, 15000)
    if (!popup) throw new Error('钱包弹窗未出现')
    if (this.deps.profile.walletPassword && adapter.unlock) {
      await adapter.unlock(popup, this.deps.profile.walletPassword)
    }
    await adapter.ensureConnected(popup)
  }

  async textPresent(text: string): Promise<boolean> {
    const count = await this.page.getByText(text, { exact: false }).count()
    return count > 0
  }

  async urlIncludes(part: string): Promise<boolean> {
    return this.page.url().includes(part)
  }
}

export async function waitForWalletPopup(page: Page, patterns: string[], timeoutMs: number): Promise<PopupPage | null> {
  const context = page.context()
  const match = (p: Page) => patterns.some(pat => new RegExp(pat).test(p.url()))
  const existing = context.pages().find(match)
  if (existing) return existing as unknown as PopupPage
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      context.off('page', handler)
      resolve(null)
    }, timeoutMs)
    const handler = (p: Page) => {
      if (match(p)) {
        clearTimeout(timer)
        context.off('page', handler)
        resolve(p as unknown as PopupPage)
      }
    }
    context.on('page', handler)
  })
}

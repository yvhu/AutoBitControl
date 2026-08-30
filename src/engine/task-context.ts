/**
 * 任务上下文（engine 层）：任务编写者唯一接触的运行环境接口
 * 依赖方向：依赖 automation/integrations/infrastructure，被 tasks 层依赖
 * 设计思路：把页面/拟人/钱包/验证码/截图封装成语义化方法，
 * 任务代码不直接碰 patchright 细节（选择器查找等见 docs/API-GUIDE.md）
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'patchright'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { ProfileRow } from '../infrastructure/db'
import { Humanizer } from '../automation/humanize'
import type { CaptchaService } from '../integrations/yescaptcha'
import type { WalletRegistry, PopupPage } from '../automation/wallet/types'
import { waitForPopup } from '../automation/wallet/popup'
import type { TaskRef } from './task'

/** TaskContext 依赖集（window-runner 创建并注入） */
export interface TaskContextDeps {
  page: Page
  task: TaskRef
  human: Humanizer
  profile: ProfileRow
  cfg: AppConfig
  logger: Logger
  artifactsDir: string
  /** 钱包解锁密码映射（key 为比特窗口 ID，来自配置 wallet.passwords 与环境变量 WALLET_PASSWORDS） */
  walletPasswords: Record<string, string>
  captcha?: CaptchaService
  wallets?: WalletRegistry
  onCaptchaLog?: (kind: string, ok: boolean, costPoints: number) => void
}

export class TaskContext {
  constructor(private deps: TaskContextDeps) {}

  /** 当前页面（任务侧只读使用） */
  get page(): Page {
    return this.deps.page
  }

  /** 拟人操作器（移动/点击/键入统一走它） */
  get human(): Humanizer {
    return this.deps.human
  }

  /** 当前窗口记录（熔断计数等） */
  get profile(): ProfileRow {
    return this.deps.profile
  }

  /**
   * 打开任务页面（默认 meta.url，可覆盖）
   * @throws 无 url 配置；3 次重试（2-5s 随机退避）后仍失败抛出最后一次错误
   */
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

  /**
   * 拟人点击签到按钮，可选断言后续元素出现
   * @param opts.assert 成功后应出现的标志元素（徽章/成功文案），宁严勿松
   * @param opts.assertTimeoutMs 断言超时（默认 10s）
   * @throws 断言超时抛错（任务失败进入重试）
   */
  async clickCheckin(selector: string, opts: { assert?: string; assertTimeoutMs?: number } = {}): Promise<void> {
    await this.human.click(selector)
    if (opts.assert) {
      await this.assertVisible(opts.assert, opts.assertTimeoutMs ?? 10000)
    }
  }

  /** 等待元素可见；超时抛错（失败原因带上选择器便于排障） */
  async assertVisible(selector: string, timeoutMs = 10000): Promise<void> {
    try {
      await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
    } catch {
      throw new Error(`断言超时: 元素 ${selector} 未出现`)
    }
  }

  /** 拟人键入文本（邮箱/数量等表单字段） */
  async typeInto(selector: string, text: string): Promise<void> {
    await this.human.type(selector, text)
  }

  /**
   * 在当前页面检测并处理验证码（调用处即检测点）
   * @returns 'none' 未注入服务或任务关闭自动处理；'solved' 成功；失败抛 CaptchaFailure
   */
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

  /** 截图存到产物目录，返回文件绝对路径（面板按路径取图） */
  async screenshot(name: string): Promise<string> {
    mkdirSync(this.deps.artifactsDir, { recursive: true })
    const file = join(this.deps.artifactsDir, `${name}.png`)
    await this.page.screenshot({ path: file, fullPage: false })
    return file
  }

  /**
   * 钱包登录全流程：等钱包弹窗 → 有密码则解锁 → 点连接确认
   * @throws 任务未配置 wallet / 钱包注册表未注入 / 弹窗 15s 内未出现
   */
  async loginByWallet(): Promise<void> {
    const walletKey = this.deps.task.meta.wallet
    if (!walletKey) throw new Error('任务未配置钱包')
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(walletKey)
    const popup = (await waitForPopup(this.page.context(), adapter.extensionUrlPatterns, 15000)) as PopupPage | null
    if (!popup) throw new Error('钱包弹窗未出现')
    const unlockPassword = this.deps.walletPasswords[this.deps.profile.bitbrowserId]
    if (unlockPassword && adapter.unlock) {
      await adapter.unlock(popup, unlockPassword)
    }
    await adapter.ensureConnected(popup)
  }

  /** 页面上是否出现某文案（模糊匹配，任务里做状态判断） */
  async textPresent(text: string): Promise<boolean> {
    const count = await this.page.getByText(text, { exact: false }).count()
    return count > 0
  }

  /** 当前 URL 是否包含某片段（判断登录跳转结果用） */
  async urlIncludes(part: string): Promise<boolean> {
    return this.page.url().includes(part)
  }

  /**
   * 等待文案出现在页面（区别于 textPresent 的即时判断，这里会持续等到出现）
   * @throws 超时抛 `等待文案超时: <text>`
   */
  async waitForText(text: string, timeoutMs = 10000): Promise<void> {
    try {
      await this.page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    } catch {
      throw new Error(`等待文案超时: ${text}`)
    }
  }

  /**
   * 等待匹配 url 片段的网络响应并解析 JSON（解析失败返回 null）
   * @returns 响应体 JSON；非 JSON 响应返回 null
   * @throws 超时抛 `等待接口超时: <urlPart>（<原始错误>）`
   */
  async waitForApi(urlPart: string, timeoutMs = 10000): Promise<unknown> {
    try {
      const res = await this.page.waitForResponse(r => r.url().includes(urlPart), { timeout: timeoutMs })
      return await res.json().catch(() => null)
    } catch (e) {
      throw new Error(`等待接口超时: ${urlPart}（${(e as Error).message}）`)
    }
  }

  /**
   * 等待当前 URL 包含某片段（跳转等待，hash 变化同样有效）
   * @throws 超时抛 `等待跳转超时: <part>`
   */
  async waitForUrl(part: string, timeoutMs = 10000): Promise<void> {
    try {
      await this.page.waitForURL((u) => u.href.includes(part), { timeout: timeoutMs })
    } catch {
      throw new Error(`等待跳转超时: ${part}`)
    }
  }

  /**
   * 在页面主世界执行 JS 并返回结果（自动处理 patchright 隔离世界参数）
   * 读站点全局状态（window 上的变量）必须用主世界——默认隔离世界看不到站点注入的全局变量
   */
  async js<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn, undefined, {}, false) as Promise<T>
  }

  /**
   * 等待元素消失（如 loading 遮罩）；元素从未出现视为已消失
   * @throws 超时抛 `元素未消失: <selector>`
   */
  async waitForGone(selector: string, timeoutMs = 10000): Promise<void> {
    try {
      await this.page.locator(selector).first().waitFor({ state: 'detached', timeout: timeoutMs })
    } catch {
      throw new Error(`元素未消失: ${selector}`)
    }
  }
}

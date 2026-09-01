/**
 * 任务上下文（engine 层）：任务编写者唯一接触的运行环境接口
 * 依赖方向：依赖 automation/integrations/infrastructure，被 tasks 层依赖
 * 设计思路：把页面/拟人/钱包/验证码/截图封装成语义化方法，
 * 任务代码不直接碰 patchright 细节（选择器查找等见 docs/API-GUIDE.md）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from 'patchright'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { ProfileRow } from '../infrastructure/db'
import { Humanizer } from '../automation/humanize'
import type { CaptchaService } from '../integrations/yescaptcha'
import type { WalletRegistry, PopupPage } from '../automation/wallet/types'
import type { WalletSession } from '../automation/wallet/session'
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
  /** 钱包解锁密码映射（key 为钱包类型，如 metamask/petra，来自配置 wallet.passwords 与环境变量 WALLET_PASSWORDS；同类型钱包共用同一密码） */
  walletPasswords: Record<string, string>
  captcha?: CaptchaService
  wallets?: WalletRegistry
  onCaptchaLog?: (kind: string, ok: boolean, costPoints: number) => void
  /** 当前窗口在数据源中的行（列名 -> 值）；无映射为 null（任务可用 faker 兜底） */
  accountRow?: Record<string, string> | null
  /** 窗口会话级钱包扩展检测（window-runner 每轮会话创建注入；未注入时 ensureWalletReady 跳过） */
  walletSession?: WalletSession
}

export class TaskContext {
  constructor(private deps: TaskContextDeps) {}

  /** 当前页面（任务侧只读使用） */
  get page(): Page {
    return this.deps.page
  }

  /** 日志器（任务内步骤日志，大批量运行排障用） */
  get log(): Logger {
    return this.deps.logger
  }

  /** 拟人操作器（移动/点击/键入统一走它） */
  get human(): Humanizer {
    return this.deps.human
  }

  /** 当前窗口记录（熔断计数等） */
  get profile(): ProfileRow {
    return this.deps.profile
  }

  /** 当前窗口在数据源中的行（列名 -> 值；无映射为 null，任务可 `ctx.accountRow?.['邮箱'] ?? faker...` 兜底） */
  get accountRow(): Record<string, string> | null {
    return this.deps.accountRow ?? null
  }

  /**
   * 从数据源取当前窗口对应行的列值（严格模式：行不存在/列缺失/值为空都会抛错，错误带窗口名与列名提示）
   * 例：const email = await ctx.account('邮箱')
   */
  async account(key: string): Promise<string> {
    const row = this.deps.accountRow
    if (!row) throw new Error(`数据源无当前窗口对应的行（窗口: ${this.deps.profile.name}）`)
    const v = row[key]
    if (v === undefined) throw new Error(`数据源缺少列: ${key}（可用列: ${Object.keys(row).join(', ')}）`)
    if (v === '') throw new Error(`数据源列 ${key} 在窗口 ${this.deps.profile.name} 的行为空`)
    return v
  }

  /**
   * 上传文件到 file 输入框（头像等）：值支持 http(s) URL（自动下载到临时文件）或本地路径
   * 例：await ctx.uploadFile('input[type="file"]', await ctx.account('图片地址'))
   */
  async uploadFile(selector: string, value: string): Promise<void> {
    const loc = this.page.locator(selector).first()
    if (/^https?:\/\//i.test(value)) {
      const res = await fetch(value)
      if (!res.ok) throw new Error(`图片下载失败: ${value.split('?')[0]} (HTTP ${res.status})`)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = (value.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'png').slice(0, 10)
      mkdirSync(join(tmpdir(), 'abc-uploads'), { recursive: true })
      const file = join(tmpdir(), 'abc-uploads', `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
      writeFileSync(file, buf)
      await loc.setInputFiles(file)
      return
    }
    await loc.setInputFiles(value)
  }

  /**
   * 关闭当前浏览器上下文中的其它标签页（保留当前页）
   * 任务开始前调用：清掉上一次会话残留的标签页，再从干净状态打开任务网址
   */
  async closeOtherTabs(): Promise<void> {
    for (const p of this.page.context().pages()) {
      if (p === this.page) continue
      await p.close().catch(() => {})
    }
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

  /** 按键（单键如 'Enter'/'Escape'/'Tab'，或组合键如 'Control+A'/'Shift+Tab'，用加号连接；纯键盘操作，往输入框打字请用 typeInto） */
  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key)
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
   * 钱包扩展就绪检查（会话级缓存）：任务登录流程前调用，扩展未加载时快速失败
   * （重试会重启浏览器窗口，扩展随之重载——真机实测重启即恢复）
   * 无 wallet 配置 / 未注入会话时跳过（脚本与测试兼容）
   * @throws 钱包注册表未注入 / 该类型钱包扩展未加载
   */
  async ensureWalletReady(): Promise<void> {
    const walletKey = this.deps.task.meta.wallet
    if (!walletKey) return
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const session = this.deps.walletSession
    if (!session) return
    const adapter = this.deps.wallets.get(walletKey)
    const state = await session.ensureReady(walletKey, adapter)
    if (state === 'missing') {
      throw new Error(`窗口 ${walletKey} 钱包扩展未加载（重试将重启浏览器窗口）`)
    }
  }

  /**
   * 钱包登录全流程：等钱包弹窗 → 有密码则解锁 → 点连接确认
   * 弹窗等待 60s：多窗口并发高负载下弹窗出现可超过 30s（真机实测），且静默连接时
   * 弹窗永不出现由任务侧容忍（不影响最终登录判定）
   * @param opts.reclick 可选补点：弹窗 afterMs 内未出现时再点一次触发按钮
   *   （AppKit 动画未稳定时首次点击可能不注册；已触发的弹窗被聚焦而非重复打开，安全）
   * @throws 任务未配置 wallet / 钱包注册表未注入 / 弹窗 60s 内未出现
   */
  async loginByWallet(opts: { reclick?: { selector: string; afterMs: number } } = {}): Promise<void> {
    const walletKey = this.deps.task.meta.wallet
    if (!walletKey) throw new Error('任务未配置钱包')
    if (!this.deps.wallets) throw new Error('钱包注册表未注入')
    const adapter = this.deps.wallets.get(walletKey)
    const popupPromise = waitForPopup(this.page.context(), adapter.extensionUrlPatterns, 60000)
    if (opts.reclick) {
      const start = Date.now()
      let appeared = false
      while (Date.now() - start < opts.reclick.afterMs) {
        const r = await Promise.race([
          popupPromise.then(() => 'popup' as const).catch(() => 'timeout' as const),
          new Promise<'tick'>(resolve => setTimeout(() => resolve('tick'), 500)),
        ])
        if (r === 'popup') { appeared = true; break }
      }
      if (!appeared) await this.human.click(opts.reclick.selector).catch(() => {})
    }
    const popup = (await popupPromise) as PopupPage | null
    if (!popup) throw new Error('钱包弹窗未出现')
    const unlockPassword = this.deps.walletPasswords[walletKey]
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

  /**
   * 关闭页面弹窗/遮罩（公告、通知、引导层等挡路弹窗）
   * 策略按顺序尝试：候选关闭按钮 → 点遮罩空白处 → 按 Esc；
   * 每次尝试后若配置了 gone 则快速验证是否已消失，最终用完整超时兜底验证
   * @param opts.close 关闭按钮候选选择器（依次尝试，存在才点）
   * @param opts.mask 遮罩层选择器（点击其左上角内侧空白区域，避开居中弹窗主体）
   * @param opts.gone 弹窗容器选择器，用于验证关闭成功（不传则只尝试不验证）
   * @param opts.timeoutMs 最终验证超时（默认 10000）
   */
  async closeModal(opts: { close?: string[]; mask?: string; gone?: string; timeoutMs?: number } = {}): Promise<void> {
    const goneSel = opts.gone
    const attempts: Array<() => Promise<void>> = []
    for (const sel of opts.close ?? []) {
      attempts.push(async () => {
        if (await this.page.locator(sel).first().count() > 0) await this.human.click(sel)
      })
    }
    const maskSel = opts.mask
    if (maskSel) {
      attempts.push(async () => {
        const box = await this.page.locator(maskSel).first().boundingBox()
        if (box) await this.human.clickAt(box.x + 12, box.y + 12)
      })
    }
    attempts.push(async () => { await this.page.keyboard.press('Escape') })
    for (const attempt of attempts) {
      try {
        await attempt()
      } catch {
        // 单策略失败（按钮存在但不可点等）不阻断回退链，继续下一个策略
      }
      if (!goneSel) continue
      const gone = await this.waitForGone(goneSel, 600).then(() => true).catch(() => false)
      if (gone) return
    }
    if (!goneSel) return
    if (goneSel) await this.waitForGone(goneSel, opts.timeoutMs ?? 10000)
  }
}

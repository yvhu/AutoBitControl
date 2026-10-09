/**
 * 任务上下文（engine 层）：任务编写者唯一接触的运行环境接口
 * 依赖方向：依赖 automation/integrations/infrastructure，被 tasks 层依赖
 * 设计思路：把页面/钱包/截图/验证码封装成语义化命名空间，
 * 任务代码不直接碰 patchright 细节（选择器查找等见 docs/API-GUIDE.md）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from 'patchright'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { ProfileRow } from '../infrastructure/db'
import {
  WalletActions,
  StepRecorder,
  raceProbes,
  recoverProbe,
  clickTurnstileBox as runTurnstileClick,
  autoClickTurnstile as runTurnstileAutoClick,
  turnstileVisible as isTurnstileVisible,
  type Probe,
  type RecoverOpts,
  type WalletRegistry,
  type WalletSession,
} from '../automation'
import type { TaskRef } from './task'

/** TaskContext 依赖集（window-runner 创建并注入） */
export interface TaskContextDeps {
  page: Page
  task: TaskRef
  profile: ProfileRow
  cfg: AppConfig
  logger: Logger
  artifactsDir: string
  /** 钱包解锁密码映射（key 为钱包类型，如 metamask/petra，来自配置 wallet.passwords 与环境变量 WALLET_PASSWORDS；同类型钱包共用同一密码） */
  walletPasswords: Record<string, string>
  wallets?: WalletRegistry
  /** 当前窗口在数据源中的行（列名 -> 值）；无映射为 null（任务可用 faker 兜底） */
  accountRow?: Record<string, string> | null
  /** 窗口会话级钱包扩展检测（window-runner 每轮会话创建注入；未注入时 wallet.ready 跳过） */
  walletSession?: WalletSession
}

/** 验证码能力命名空间（get captcha 返回值） */
export interface CaptchaActions {
  turnstile: (opts?: { selectors?: string[]; maxAttempts?: number }) => Promise<boolean>
  visible: (selectors?: string[]) => Promise<boolean>
  autoClick: (budgetMs?: number) => Promise<boolean>
}

export class TaskContext {
  constructor(private deps: TaskContextDeps) {}

  private recorder = new StepRecorder()
  private walletActionsInstance: WalletActions | null = null
  private captchaActionsInstance: CaptchaActions | null = null

  /** 钱包动作命名空间（ready/login/sign/confirmTx/ensureLoggedIn） */
  get wallet(): WalletActions {
    if (!this.walletActionsInstance) {
      this.walletActionsInstance = new WalletActions({
        page: this.page,
        walletKey: this.deps.task.meta.wallet,
        wallets: this.deps.wallets,
        walletPasswords: this.deps.walletPasswords,
        walletSession: this.deps.walletSession,
        log: this.log,
        recover: (probe: Probe, opts: RecoverOpts) => this.recover(probe, opts),
      })
    }
    return this.walletActionsInstance
  }

  /** 多探针竞速 */
  async race<K extends string>(entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null> {
    return raceProbes(this.page, entries, timeoutMs)
  }

  /** 刷新恢复等待（错误文案立即刷 + 周期刷 + 心跳） */
  async recover(probe: Probe, opts: RecoverOpts): Promise<boolean> {
    return recoverProbe(this.page, probe, this.log, opts)
  }

  /** 记录任务步骤（诊断时间线） */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.recorder.run(name, fn, this.log)
  }

  /** 已记录步骤 */
  steps() { return this.recorder.steps() }

  /** 验证码能力命名空间（仅 Turnstile 交互式方框） */
  get captcha(): CaptchaActions {
    if (!this.captchaActionsInstance) {
      this.captchaActionsInstance = {
        turnstile: (opts?: { selectors?: string[]; maxAttempts?: number }) => this.clickTurnstileBox(opts),
        visible: (selectors?: string[]) => this.turnstileVisible(selectors),
        autoClick: (budgetMs?: number) => this.autoClickTurnstile(budgetMs),
      }
    }
    return this.captchaActionsInstance
  }

  /** 当前页面（任务侧只读使用） */
  get page(): Page {
    return this.deps.page
  }

  /** 日志器（任务内步骤日志，大批量运行排障用） */
  get log(): Logger {
    return this.deps.logger
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

  /** 截图存到产物目录，返回文件绝对路径（面板按路径取图） */
  async screenshot(name: string): Promise<string> {
    mkdirSync(this.deps.artifactsDir, { recursive: true })
    const file = join(this.deps.artifactsDir, `${name}.png`)
    await this.page.screenshot({ path: file, fullPage: false })
    return file
  }

  /**
   * 容错截图：截图失败只告警不判任务失败（站点持续动画时 CDP 截图偶发挂起，真机教训）
   * @returns 成功返回路径；失败返回空串
   */
  async safeScreenshot(name: string): Promise<string> {
    try {
      return await this.screenshot(name)
    } catch (e) {
      this.log.warn({ step: 'screenshot', window: this.deps.profile.name, err: (e as Error).message }, '截图失败（不影响任务结果）')
      return ''
    }
  }

  /**
   * 在页面主世界执行 JS 并返回结果（自动处理 patchright 隔离世界参数）
   * 读站点全局状态（window 上的变量）必须用主世界——默认隔离世界看不到站点注入的全局变量
   */
  async js<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn, undefined, {}, false) as Promise<T>
  }

  /** Turnstile 模块日志包装：注入窗口名（模块消息为通用措辞）；兼容单参字符串与对象+消息两种调用形态 */
  private turnstileLogger(): Pick<Logger, 'info' | 'warn'> {
    return {
      info: (...args: unknown[]) => {
        if (typeof args[0] === 'string') return this.log.info(args[0] as string)
        return this.log.info({ ...(args[0] as Record<string, unknown>), window: this.deps.profile.name }, args[1] as string)
      },
      warn: (...args: unknown[]) => {
        if (typeof args[0] === 'string') return this.log.warn(args[0] as string)
        return this.log.warn({ ...(args[0] as Record<string, unknown>), window: this.deps.profile.name }, args[1] as string)
      },
    } as Pick<Logger, 'info' | 'warn'>
  }

  /**
   * 交互式 Turnstile 人机验证方框：检测到即拟人点击（ISP IP 一点即过），
   * 点击被浏览器拒绝（iframe 重渲染瞬时态）自动重新取盒重试（最多 3 次，非瞬时错误直接抛）
   * @returns 执行了点击 true / 方框未出现 false
   */
  async clickTurnstileBox(opts?: { selectors?: string[]; maxAttempts?: number }): Promise<boolean> {
    return runTurnstileClick({ page: this.page, logger: this.turnstileLogger() }, opts)
  }

  /** Turnstile 方框当前是否可见（轻量检查，低频追踪用） */
  async turnstileVisible(selectors?: string[]): Promise<boolean> {
    return isTurnstileVisible(this.page, selectors)
  }

  /** 等 Turnstile 方框出现并点击（方框在触发动作后 1-3s 渲染，最多等 budgetMs） */
  async autoClickTurnstile(budgetMs = 10000): Promise<boolean> {
    return runTurnstileAutoClick({ page: this.page, logger: this.turnstileLogger() }, budgetMs)
  }
}

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

/** TaskContext 依赖集：由 window-runner 在开窗接管后创建并注入，任务通过 TaskContext 间接使用这些能力 */
export interface TaskContextDeps {
  /** 当前窗口的页面（patchright Page） */
  page: Page
  /** 当前正在跑的任务引用（提供 meta 元信息等） */
  task: TaskRef
  /** 当前窗口的数据行（profiles 表记录，含 ID/名称等） */
  profile: ProfileRow
  /** 全局配置（execution/scheduler 等各段参数） */
  cfg: AppConfig
  /** 日志器 */
  logger: Logger
  /** 本任务产物目录（截图等写入此处） */
  artifactsDir: string
  /** 钱包解锁密码映射（key 为钱包类型，如 metamask/petra，来自配置 wallet.passwords 与环境变量 WALLET_PASSWORDS；同类型钱包共用同一密码） */
  walletPasswords: Record<string, string>
  /** 钱包适配器注册表；未注入时钱包相关能力不可用 */
  wallets?: WalletRegistry
  /** 当前窗口在数据源中的行（列名 -> 值）；无映射为 null（任务可用 faker 兜底） */
  accountRow?: Record<string, string> | null
  /** 窗口会话级钱包扩展检测（window-runner 每轮会话创建注入；未注入时 wallet.ready 跳过） */
  walletSession?: WalletSession
}

/** 验证码能力命名空间（get captcha 返回值），仅覆盖 Turnstile 交互式方框 */
export interface CaptchaActions {
  /** 检测到 Turnstile 方框即点击一次；opts.selectors 自定义候选选择器、opts.maxAttempts 点击重试上限 */
  turnstile: (opts?: { selectors?: string[]; maxAttempts?: number }) => Promise<boolean>
  /** 方框当前是否可见；selectors 可自定义候选选择器 */
  visible: (selectors?: string[]) => Promise<boolean>
  /** 在 budgetMs 预算内等方框出现并点击；默认 10000 毫秒 */
  autoClick: (budgetMs?: number) => Promise<boolean>
}

/**
 * 任务上下文：任务编写者唯一接触的运行环境接口。
 * 它把页面、钱包、验证码、截图、数据源列等能力封装成语义化属性/方法，任务代码因此不必直接碰
 * patchright 的细节（选择器等底层操作见 docs/API-GUIDE.md）。所有能力都从构造时注入的 deps 派生。
 */
export class TaskContext {
  /** @param deps 运行时依赖集（页面、任务、窗口、配置、日志、产物目录、钱包相关等） */
  constructor(private deps: TaskContextDeps) {}

  /** 本任务的步骤记录器（step() 写入，steps() 读出） */
  private recorder = new StepRecorder()
  /** 钱包动作门面懒加载实例（首次访问 wallet 时创建） */
  private walletActionsInstance: WalletActions | null = null
  /** 验证码能力懒加载实例（首次访问 captcha 时创建） */
  private captchaActionsInstance: CaptchaActions | null = null

  /**
   * 钱包动作命名空间（懒加载）。
   * 把 task.meta.wallet 作为钱包类型、连同注册表/密码/会话检测/日志，以及本类的 recover 能力
   * 一起装配进 WalletActions，对外提供 ready/login/sign/confirmTx/ensureLoggedIn。
   * @returns 绑定当前任务的钱包动作门面
   */
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

  /**
   * 多探针竞速：同时等若干目标，谁先可见返回谁的键。
   * @param entries 键与探针的配对数组
   * @param timeoutMs 最长等待毫秒数
   * @returns 最先可见探针的键；都未出现返回 null
   */
  async race<K extends string>(entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null> {
    return raceProbes(this.page, entries, timeoutMs)
  }

  /**
   * 刷新恢复等待：等目标探针出现，期间遇错误文案立即刷新、可选周期刷新、定期打心跳。
   * @param probe 等待出现的目标探针
   * @param opts 恢复参数（预算、刷新策略、心跳间隔等）
   * @returns 预算内出现 true / 超时 false
   */
  async recover(probe: Probe, opts: RecoverOpts): Promise<boolean> {
    return recoverProbe(this.page, probe, this.log, opts)
  }

  /**
   * 记录一个任务步骤到诊断时间线：包裹 fn 执行，自动记录耗时与成败并写日志。
   * @param name 步骤名
   * @param fn 要执行的异步函数
   * @returns fn 的返回值
   * @throws fn 抛出的错误（记录后重抛）
   */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.recorder.run(name, fn, this.log)
  }

  /** 取本任务已记录的步骤时间线（浅拷贝） */
  steps() { return this.recorder.steps() }

  /**
   * 验证码能力命名空间（懒加载，仅 Turnstile 交互式方框）。
   * 三个方法分别对应点击一次、查可见性、预算内自动等框点击。
   * @returns 绑定当前页面的验证码能力对象
   */
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

  /** 当前页面（patchright Page，任务侧只读使用，用于自定义选择器操作） */
  get page(): Page {
    return this.deps.page
  }

  /** 日志器：任务内打步骤日志，大批量运行时排障用 */
  get log(): Logger {
    return this.deps.logger
  }

  /** 当前窗口记录（profiles 表行，含 ID/名称等；熔断计数等也基于它） */
  get profile(): ProfileRow {
    return this.deps.profile
  }

  /** 当前窗口在数据源中的行（列名 -> 值；无映射为 null，任务可 `ctx.accountRow?.['邮箱'] ?? faker...` 兜底） */
  get accountRow(): Record<string, string> | null {
    return this.deps.accountRow ?? null
  }

  /**
   * 从数据源取当前窗口对应行的列值（严格模式）。
   * 例：const email = await ctx.account('邮箱')
   * @param key 数据源列名
   * @returns 该列的值
   * @throws 无当前窗口对应的行；或列缺失；或该行该列为空（错误信息会带窗口名与可用列名提示）
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
   * 向 file 输入框上传文件（头像等）。
   * 例：await ctx.uploadFile('input[type="file"]', await ctx.account('图片地址'))
   * 执行流程：定位选择器首个元素；若 value 是 http(s) URL，先 fetch 下载（失败抛错），
   * 按 URL 扩展名（缺省 png）写到系统临时目录的 abc-uploads 下再 setInputFiles；
   * 否则把 value 当本地路径直接 setInputFiles。
   * @param selector 目标 file input 的 CSS 选择器
   * @param value 图片地址（http/https URL）或本地文件路径
   * @throws URL 下载失败（HTTP 非 2xx）
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
   * 截图并保存到本任务产物目录。
   * @param name 文件名（不含扩展名，实际写为 <name>.png；目录不存在会创建）
   * @returns 截图文件的绝对路径（面板按路径取图）
   */
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
   * 在页面主世界执行 JS 并返回结果（自动处理 patchright 的隔离世界参数）。
   * 读站点全局状态（window 上的变量）必须用主世界——默认隔离世界看不到站点注入的全局变量。
   * @param fn 在浏览器主世界执行的函数（不能引用 Node 侧闭包变量）
   * @returns 函数的返回值
   */
  async js<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn, undefined, {}, false) as Promise<T>
  }

  /**
   * 给 Turnstile 模块用的日志包装器：模块内部消息是通用措辞，这里统一补上窗口名。
   * 同时兼容两种调用形态——单参字符串，或对象 + 消息（把 window 字段合并进对象）。
   * @returns 仅暴露 info/warn 的日志器
   */
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
   * 交互式 Turnstile 人机验证方框：检测到即拟人点击（ISP IP 一点即过）。
   * 委托 automation 的 clickTurnstileBox，本方法只负责注入带窗口名的日志器。
   * @param opts.selectors 自定义候选 iframe 选择器
   * @param opts.maxAttempts 点击重试上限
   * @returns 执行了点击 true / 方框未出现 false
   */
  async clickTurnstileBox(opts?: { selectors?: string[]; maxAttempts?: number }): Promise<boolean> {
    return runTurnstileClick({ page: this.page, logger: this.turnstileLogger() }, opts)
  }

  /**
   * Turnstile 方框当前是否可见（轻量检查，低频追踪用）。
   * @param selectors 自定义候选 iframe 选择器
   * @returns 是否可见
   */
  async turnstileVisible(selectors?: string[]): Promise<boolean> {
    return isTurnstileVisible(this.page, selectors)
  }

  /**
   * 等 Turnstile 方框出现并点击。
   * @param budgetMs 最长等待毫秒数（缺省 10000；方框通常在触发动作后 1-3s 渲染）
   * @returns 预算内点到 true / 未出现 false
   */
  async autoClickTurnstile(budgetMs = 10000): Promise<boolean> {
    return runTurnstileAutoClick({ page: this.page, logger: this.turnstileLogger() }, budgetMs)
  }
}

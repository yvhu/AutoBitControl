/**
 * 任务上下文（engine 层）：任务运行期的数据袋子
 * 依赖方向：仅依赖 automation 的类型与 infrastructure 的类型，被 engine/tasks/api 依赖
 * 设计思路：TaskContext 只承载运行时数据（页面/窗口/数据源行/任务引用/钱包依赖/产物目录/步骤记录器），
 * 不再暴露任何方法或命名空间——任务经 src/api 的能力函数操作 ctx（见 docs/API-GUIDE.md）
 */
import type { Page } from 'patchright'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { ProfileRow } from '../infrastructure/db'
import { StepRecorder, type WalletRegistry, type WalletSession } from '../automation'
import type { TaskRef } from './task'

/** TaskContext 依赖集：由 window-runner 在开窗接管后创建并注入，api 函数通过 TaskContext 取这些运行时数据 */
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

/**
 * 任务上下文：任务运行期的数据袋子，所有字段都从构造时注入的 deps 派生。
 * 任务侧只读这些运行时数据，能力（加载页面/等待/登录/截图/验证码等）经 src/api 的能力函数获得。
 */
export class TaskContext {
  /** @param deps 运行时依赖集（页面、任务、窗口、配置、日志、产物目录、钱包相关等） */
  constructor(private deps: TaskContextDeps) {}

  /** 本任务的步骤记录器（api/diag 经 recorder getter 读写运行时间线） */
  private recorderInstance = new StepRecorder()

  /** 当前页面（patchright Page，任务侧只读使用，用于自定义选择器操作） */
  get page(): Page {
    return this.deps.page
  }

  /** 日志器：任务内打步骤日志，大批量运行时排障用 */
  get log(): Logger {
    return this.deps.logger
  }

  /** 钱包适配器注册表（api/wallet 使用） */
  get wallets(): WalletRegistry | undefined {
    return this.deps.wallets
  }

  /** 钱包解锁密码映射（api/wallet 使用） */
  get walletPasswords(): Record<string, string> {
    return this.deps.walletPasswords
  }

  /** 窗口会话级钱包扩展探测（api/wallet 使用） */
  get walletSession(): WalletSession | undefined {
    return this.deps.walletSession
  }

  /** 当前任务引用（api 使用） */
  get task(): TaskRef {
    return this.deps.task
  }

  /** 截图产物目录（api/data 使用） */
  get artifactsDir(): string {
    return this.deps.artifactsDir
  }

  /** 步骤记录器（api/diag 使用） */
  get recorder(): StepRecorder {
    return this.recorderInstance
  }

  /** 当前窗口记录（profiles 表行，含 ID/名称等；熔断计数等也基于它） */
  get profile(): ProfileRow {
    return this.deps.profile
  }

  /** 当前窗口在数据源中的行（列名 -> 值；无映射为 null，任务可 `ctx.accountRow?.['邮箱'] ?? faker...` 兜底） */
  get accountRow(): Record<string, string> | null {
    return this.deps.accountRow ?? null
  }
}

/**
 * 钱包登录函数（api 层）：按 wallet 类型 + scenario 场景自适应完成登录
 * 依赖方向：engine 的 TaskContext 类型、automation barrel（WalletActions 与登录相关类型）
 * 设计思路：把「wallet + scenario」声明映射为 automation 的 LoginSpec（entry/walletEntry），
 * 复用 automation/wallet 的 ensureLoggedIn 编排，任务侧只需描述登录标志与站点入口形态。
 */
import type { TaskContext } from '../engine/task-context'
import { WalletActions } from '../automation'
import type { WalletIntent, LoginProbe } from '../automation'
import { waitFor } from './wait'

export type { WalletIntent }

/** 支持的钱包类型（与 automation/wallet 注册表 key 一致） */
export type WalletType = 'metamask' | 'petra'
/** 站点连接入口形态：direct 直接点 connect；appkit 走 AppKit 归一化；dialog 先开站点对话框 */
export type WalletScenario = 'direct' | 'appkit' | 'dialog'

/** 登录规格公共字段（三个场景共享；scenario 之外的部分全部透传给 automation 的 LoginSpec） */
interface LoginSpecBase {
  /** 钱包类型，作为 WalletActions 的 walletKey */
  wallet: WalletType
  /** 已登录标志探针（出现即认定已登录，字符串等价于 `{ text }`） */
  loggedIn: LoginProbe
  /** 未登录标志探针（出现即需要走登录流程） */
  loggedOut: LoginProbe
  /** 站点「连接钱包」按钮选择器（可省略） */
  connect?: string
  /** 要依次处理的钱包意图序列，缺省 ['connect'] */
  intents?: WalletIntent[]
  /** 等「已登录」标志出现的最长毫秒数（缺省 90000） */
  waitLoggedInMs?: number
  /** 自定义可恢复错误文案（透传 recover） */
  recoverTexts?: string[]
  /** 等待登录期间周期刷新间隔毫秒（缺省 25000） */
  refreshEveryMs?: number
  /** 整体重试轮数（缺省 2） */
  attempts?: number
  /** 弹窗未按时出现时补点入口前的等待毫秒数（缺省 8000） */
  reclickAfterMs?: number
}

/** 登录规格（按 scenario 判别）：三个场景各自携带入口相关字段 */
export type LoginSpec =
  | (LoginSpecBase & { scenario: 'direct' })
  | (LoginSpecBase & { scenario: 'appkit'; entryTestId: string; open?: string; modalTestId?: string })
  | (LoginSpecBase & { scenario: 'dialog'; confirm?: string; walletEntry?: string })

/**
 * 站点入口形态 → automation 编排用的 entry。
 * appkit 缺省 open 用通用「Connect Wallet」按钮；dialog 透传 confirm；direct 无额外字段。
 */
function toEntry(spec: LoginSpec) {
  if (spec.scenario === 'appkit') {
    return {
      kind: 'appkit' as const,
      open: spec.open ?? 'button:has-text("Connect Wallet")',
      entryTestId: spec.entryTestId,
      modalTestId: spec.modalTestId,
    }
  }
  if (spec.scenario === 'dialog') return { kind: 'dialog' as const, confirm: spec.confirm }
  return { kind: 'direct' as const }
}

/**
 * 钱包登录全流程：竞速判登录态 → 点连接 → 露出钱包入口 → 解锁/签名/确认 → 等登录完成（静默连接容忍 + 刷新恢复）。
 * 把 api 的「wallet + scenario」声明映射为 automation 的 LoginSpec，并装配 WalletActions 依赖执行。
 * @param ctx 任务上下文（提供 page/wallets/walletPasswords/walletSession/log 与 recover）
 * @param spec 登录规格（按 scenario 判别）
 * @throws 登录未完成（所有轮次等待已登录标志超时）
 */
export async function loginWallet(ctx: TaskContext, spec: LoginSpec): Promise<void> {
  const actions = new WalletActions({
    page: ctx.page,
    walletKey: spec.wallet,
    wallets: ctx.wallets,
    walletPasswords: ctx.walletPasswords,
    walletSession: ctx.walletSession,
    log: ctx.log,
    recover: (probe, opts) => waitFor(ctx, probe, { ...opts }),
  })
  await actions.ensureLoggedIn({
    loggedIn: spec.loggedIn,
    loggedOut: spec.loggedOut,
    connect: spec.connect,
    walletEntry: spec.scenario === 'dialog' ? spec.walletEntry : undefined,
    entry: toEntry(spec),
    intents: spec.intents,
    waitLoggedInMs: spec.waitLoggedInMs,
    recoverTexts: spec.recoverTexts,
    refreshEveryMs: spec.refreshEveryMs,
    attempts: spec.attempts,
    reclickAfterMs: spec.reclickAfterMs,
  })
}

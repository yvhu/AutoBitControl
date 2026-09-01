/**
 * AppKit 钱包登录流程封装（engine 层）：站点页面内 AppKit（Reown）弹窗的打开、
 * 视图归一化与钱包入口点击。真机实测沉淀：AppKit 弹窗初始视图不固定
 * （钱包列表 / 上次钱包 QR 页 / 列表收起），直接等入口会误判失败。
 * 依赖方向：仅 import type TaskContext（运行时无环），被 task-context 委托调用
 */
import type { TaskContext } from './task-context'

export interface AppKitLoginOptions {
  /** 钱包类型（与 WalletAdapter.key 对应，弹窗连接时取适配器） */
  walletKey: string
  /** 站点页面上「打开 AppKit 弹窗」的按钮（如 button:has-text("WALLET")） */
  openSelector: string
  /** 钱包入口 data-testid（如 wallet-selector-io.metamask） */
  entryTestId: string
  /** 弹窗容器 testid（默认 w3m-modal-card） */
  modalTestId?: string
  /** 弹窗出现等待（默认 45000，高负载渲染慢放宽） */
  modalWaitMs?: number
  /** 视图归一化轮数（默认 5） */
  normalizeRounds?: number
  /** 每轮归一化后停顿（默认 3000） */
  roundSleepMs?: number
  /** 弹窗未出现时补点入口的间隔（默认 8000） */
  reclickAfterMs?: number
}

/**
 * 打开站点 AppKit 弹窗 → 视图归一化 → 点钱包入口 → 钱包弹窗解锁/连接
 * @returns popupFailed：钱包弹窗未出现（静默连接容忍，调用方结合登录态判定）
 * @throws 弹窗未出现 / 归一化轮数耗尽未找到入口 / 钱包连接其它错误
 */
export async function openAppKitWallet(ctx: TaskContext, opts: AppKitLoginOptions): Promise<boolean> {
  await ctx.human.click(opts.openSelector)
  await ctx.assertVisible(`[data-testid="${opts.modalTestId ?? 'w3m-modal-card'}"]`, opts.modalWaitMs ?? 45000)
  const entry = `[data-testid="${opts.entryTestId}"]`
  let found = false
  for (let i = 0; i < (opts.normalizeRounds ?? 5) && !found; i++) {
    if (await ctx.visible(entry)) {
      found = true
      break
    }
    if (await ctx.visible('[data-testid="header-back"]')) {
      await ctx.human.click('[data-testid="header-back"]')
    } else if (await ctx.visible('[data-testid="all-wallets"]')) {
      await ctx.human.click('[data-testid="all-wallets"]')
    } else if (await ctx.visible('[data-testid="tab-browser"]')) {
      await ctx.human.click('[data-testid="tab-browser"]')
    }
    await ctx.page.waitForTimeout(opts.roundSleepMs ?? 3000)
  }
  if (!found) throw new Error(`AppKit 弹窗未出现 ${opts.walletKey} 钱包入口（弹窗视图异常，归一化未命中）`)
  await ctx.human.click(entry)
  try {
    await ctx.loginByWallet({ reclick: { selector: entry, afterMs: opts.reclickAfterMs ?? 8000 } })
    return false
  } catch (e) {
    if ((e as Error).message.includes('钱包弹窗未出现')) return true
    throw e
  }
}

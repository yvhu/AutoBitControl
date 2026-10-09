/**
 * 登录编排（automation/wallet 层）：竞速判登录态 → 点连接入口 → 露出钱包入口 → 按 intents 处理弹窗 → 等登录完成
 * 真机沉淀：静默连接容忍、AppKit 视图归一化、弹窗慢补点、token localStorage 刷新恢复
 * 依赖方向：依赖 ./actions、../dom、./appkit（静态导入，无运行时环）
 */
import { openAppKitWallet } from './appkit'
import type { Probe } from '../dom'
import type { WalletActions, WalletIntent } from './actions'

/** 探针简写：字符串等价于 `{ text }`（设计示例与测试用 `loggedOut: 'Connect Wallet'`） */
export type LoginProbe = Probe | string

export interface LoginSpec {
  loggedIn: LoginProbe
  loggedOut: LoginProbe
  connect?: string
  entry?:
    | { kind: 'direct' }
    | { kind: 'dialog'; confirm?: string }
    | { kind: 'appkit'; open: string; entryTestId: string; modalTestId?: string }
  intents?: WalletIntent[]
  waitLoggedInMs?: number
  recoverTexts?: string[]
  refreshEveryMs?: number
  attempts?: number
  reclickAfterMs?: number
}

export async function ensureLoggedIn(wallet: WalletActions, spec: LoginSpec): Promise<{ skipped: boolean }> {
  const deps = wallet.deps
  const { page } = deps
  const clickSoft = async (sel: string): Promise<void> => {
    await deps.page.locator(sel).first().click({ timeout: 5000 }).catch(() => {})
  }
  await wallet.ready()
  const state0 = await raceState(wallet, spec, 20000)
  if (state0 === 'loggedIn') return { skipped: true }
  const attempts = spec.attempts ?? 2
  const reclickAfterMs = spec.reclickAfterMs ?? 8000
  for (let round = 0; round < attempts; round++) {
    if (round > 0) {
      await page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(5000)
    }
    if (spec.connect) await clickSoft(spec.connect)
    const entry = spec.entry
    if (entry?.kind === 'dialog' && entry.confirm) await clickSoft(entry.confirm)
    if (entry?.kind === 'appkit') {
      await openAppKitWallet(deps, entry)
    }
    const intents = spec.intents ?? ['connect']
    const reclickSelector = entry?.kind === 'appkit'
      ? `[data-testid="${entry.entryTestId}"]`
      : spec.connect
    for (const intent of intents) {
      const { popupFailed } = await wallet.runIntent(intent, reclickSelector
        ? { reclick: { selector: reclickSelector, afterMs: reclickAfterMs } }
        : undefined)
      if (popupFailed) deps.log.info({ step: 'login' }, '钱包弹窗未出现（可能静默连接），以登录态判定')
    }
    const ok = await deps.recover(toProbe(spec.loggedIn), {
      budgetMs: spec.waitLoggedInMs ?? 90000,
      refreshEveryMs: spec.refreshEveryMs ?? 25000,
      recoverTexts: spec.recoverTexts,
    })
    if (ok) return { skipped: false }
    const st = await raceState(wallet, spec, 15000)
    if (st === 'loggedIn') return { skipped: false }
  }
  throw new Error('登录未完成（等待已登录标志超时）')
}

/** 字符串简写归一为文案探针 */
function toProbe(p: LoginProbe): Probe {
  return typeof p === 'string' ? { text: p } : p
}

/** 双探针竞速：loggedIn / loggedOut 谁先可见；都等不到返回 null */
async function raceState(wallet: WalletActions, spec: LoginSpec, timeoutMs: number): Promise<'loggedIn' | 'loggedOut' | null> {
  const deps = wallet.deps
  const { raceProbes } = await import('../dom')
  return raceProbes(deps.page, [['loggedIn', toProbe(spec.loggedIn)], ['loggedOut', toProbe(spec.loggedOut)]], timeoutMs) as Promise<'loggedIn' | 'loggedOut' | null>
}

/**
 * AppKit 钱包登录归一化（automation/wallet 层）：站点页内 AppKit（Reown）弹窗的打开、
 * 视图归一化与钱包入口点击。真机实测沉淀：AppKit 弹窗初始视图不固定
 * （钱包列表 / 上次钱包 QR 页 / 列表收起），直接等入口会误判失败。
 * 弹窗连接（解锁 + connect）不在此处，由调用方 WalletActions.runIntent 负责。
 * 依赖方向：仅依赖 ../dom 探针原语与 ./actions 的 WalletActionsDeps 类型，不反向依赖 engine
 */
import { probeVisible } from '../dom'
import type { WalletActionsDeps } from './actions'

/** AppKit 归一化入参：打开按钮 + 钱包入口 testid + 可选弹窗 testid */
export interface AppKitEntry {
  /** 站点页面上「打开 AppKit 弹窗」的按钮（如 button:has-text("WALLET")） */
  open: string
  /** 钱包入口 data-testid（如 wallet-selector-io.metamask） */
  entryTestId: string
  /** 弹窗容器 testid（默认 w3m-modal-card） */
  modalTestId?: string
}

/** AppKit 登录入参（对应 login-flow.ts 的 ensureLoggedIn 展开 entry 后传入 openAppKitWallet 的形状） */
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

/** 归一化可调参数（缺省用真机实测值） */
export interface AppKitNormalizeOpts {
  modalWaitMs?: number
  normalizeRounds?: number
  roundSleepMs?: number
}

/**
 * 打开站点 AppKit 弹窗 → 视图归一化 → 点钱包入口（不含钱包弹窗连接，连接由调用方 runIntent 负责）
 * @throws 弹窗未出现 / 归一化轮数耗尽未找到入口
 */
export async function openAppKitWallet(
  deps: WalletActionsDeps,
  entry: AppKitEntry,
  opts: AppKitNormalizeOpts = {},
): Promise<void> {
  const click = (sel: string) => deps.page.locator(sel).first().click({ timeout: 5000 })
  // 入口控件可能晚于站点初始渲染出现，先等可见再点，避免 5s 单击落空（不重试）
  const openSel = entry.open
  await deps.page.locator(openSel).first().waitFor({ state: 'visible', timeout: opts.modalWaitMs ?? 45000 })
  await deps.page.locator(openSel).first().click({ timeout: 5000 })
  const modalSel = `[data-testid="${entry.modalTestId ?? 'w3m-modal-card'}"]`
  await deps.page.locator(modalSel).first().waitFor({ state: 'visible', timeout: opts.modalWaitMs ?? 45000 })
  const walletEntry = `[data-testid="${entry.entryTestId}"]`
  let found = false
  for (let i = 0; i < (opts.normalizeRounds ?? 5) && !found; i++) {
    if (await probeVisible(deps.page, { selector: walletEntry })) {
      found = true
      break
    }
    if (await probeVisible(deps.page, { selector: '[data-testid="header-back"]' })) {
      await click('[data-testid="header-back"]').catch(() => {})
    } else if (await probeVisible(deps.page, { selector: '[data-testid="all-wallets"]' })) {
      await click('[data-testid="all-wallets"]').catch(() => {})
    } else if (await probeVisible(deps.page, { selector: '[data-testid="tab-browser"]' })) {
      await click('[data-testid="tab-browser"]').catch(() => {})
    }
    await deps.page.waitForTimeout(opts.roundSleepMs ?? 3000)
  }
  if (!found) {
    const who = deps.walletKey ? ` ${deps.walletKey} ` : ''
    throw new Error(`AppKit 弹窗未出现${who}钱包入口（弹窗视图异常，归一化未命中）`)
  }
  await click(walletEntry)
}

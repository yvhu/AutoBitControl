/**
 * AppKit 钱包登录归一化（automation/wallet 层）：站点页内 AppKit（Reown）弹窗的打开、
 * 视图归一化与钱包入口点击。真机实测沉淀：AppKit 弹窗初始视图不固定
 * （钱包列表 / 上次钱包 QR 页 / 列表收起），直接等入口会误判失败。
 * 弹窗连接（解锁 + connect）不在此处，由调用方 WalletActions.runIntent 负责。
 * 依赖方向：仅依赖 ../dom 探针原语与 ./actions 的 WalletActionsDeps 类型，不反向依赖 engine
 */
import { probeVisible } from '../dom'
import type { WalletActionsDeps } from './actions'

/** AppKit 归一化入参：定位「打开弹窗的按钮」与「弹窗内的钱包入口」所需的三个选择器 */
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

/** 归一化可调参数：控制等待弹窗与把弹窗视图「拨回钱包列表」的重试节奏，缺省均为真机实测值 */
export interface AppKitNormalizeOpts {
  /** 打开按钮/弹窗容器可见的最长等待毫秒数（缺省 45000） */
  modalWaitMs?: number
  /** 视图归一化最多尝试轮数（缺省 5）：每轮找不到入口就点一次「返回/全部钱包」把视图拨回列表 */
  normalizeRounds?: number
  /** 每轮归一化后的停顿毫秒数（缺省 3000），给弹窗视图切换留时间 */
  roundSleepMs?: number
}

/**
 * 打开站点 AppKit（Reown）弹窗 → 把弹窗视图归一化到钱包列表 → 点目标钱包入口。
 * 执行流程：先等「打开按钮」可见再点它，等弹窗容器可见；随后在 normalizeRounds 轮内循环——
 * 若目标钱包入口已可见即命中；否则依次尝试点 header-back / all-wallets / tab-browser
 * 把弹窗从 QR 页或收起态拨回列表，每轮停顿片刻再试；找到入口后点它。
 * 注意：这里只负责「露出钱包入口」，真正的钱包扩展弹窗连接由调用方 runIntent 负责。
 * 之所以做归一化，是因为 AppKit 初始视图不固定（钱包列表 / 上次钱包 QR 页 / 列表收起），直接等入口会误判失败。
 * @param deps 任务依赖集（提供页面与 walletKey，仅用于页面操作与报错提示）
 * @param entry 打开按钮、钱包入口 testid、弹窗容器 testid
 * @param opts 归一化可调参数（等待时长、轮数、停顿）
 * @throws 打开按钮/弹窗未出现；或归一化轮数耗尽仍未找到钱包入口
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

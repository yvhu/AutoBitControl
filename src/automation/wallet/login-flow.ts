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

/**
 * 登录规格：用声明式方式描述「怎么判断登录态、从哪个入口发起、要过哪些钱包弹窗」，
 * 默认骨架任务直接把它交给 TaskContext.wallet.ensureLoggedIn 执行。
 */
export interface LoginSpec {
  /** 已登录标志探针（如 `{ text: 'Connected' }` 或 'Logout'）：出现即认定已登录 */
  loggedIn: LoginProbe
  /** 未登录标志探针（如 'Connect Wallet'）：出现即认定需要走登录流程 */
  loggedOut: LoginProbe
  /** 站点上「连接钱包」按钮选择器（可省略：有些站点进页面就自动弹连接框） */
  connect?: string
  /**
   * 连接入口类型：
   * direct 直接点 connect；dialog 先点 confirm 打开站点对话框；appkit 走 AppKit（Reown）归一化流程
   */
  entry?:
    | { kind: 'direct' }
    | { kind: 'dialog'; confirm?: string }
    | { kind: 'appkit'; open: string; entryTestId: string; modalTestId?: string }
  /** 站点弹窗内「钱包选择入口」（如 MetaMask）；在 connect/dialog/appkit 之后、等扩展弹窗之前点击，并作为补点选择器 */
  walletEntry?: string
  /** 要依次处理的钱包意图序列；缺省 ['connect']（登录通常只需连接） */
  intents?: WalletIntent[]
  /** 等「已登录」标志出现的最长毫秒数（缺省 90000） */
  waitLoggedInMs?: number
  /** 自定义可恢复错误文案（透传给 recover，出现即刷新页面） */
  recoverTexts?: string[]
  /** 等待登录期间周期刷新间隔毫秒（缺省 25000） */
  refreshEveryMs?: number
  /** 整体重试轮数（缺省 2）：从第二轮的刷新页面开始，覆盖网络抖动/控件晚渲染 */
  attempts?: number
  /** 弹窗未按时出现时，补点入口前的等待毫秒数（缺省 8000） */
  reclickAfterMs?: number
}

/**
 * 完整登录编排：竞速判登录态 → 点连接入口 → 露出钱包入口 → 按 intents 依次处理弹窗 → 等登录完成。
 * 执行流程：先花 20s 竞速 loggedIn/loggedOut 两探针——若登录态直接返回 skipped=true；
 * 否则先 ready() 确认扩展就绪，然后最多 attempts 轮（第二轮起先刷新页面）：
 * 依次点 connect、按 entry 类型（dialog 点 confirm / appkit 走归一化）开入口、点 walletEntry，
 * 再逐个执行 intents（每次 runIntent 等弹窗、解锁、确认）；随后用 recover 等 loggedIn 标志出现，
 * 出现即 finished；若一开始就能竞速到 loggedIn 也算成功。全部轮次失败则抛错。
 * @param wallet WalletActions 门面（提供 ready/runIntent 与依赖）
 * @param spec 登录规格
 * @returns skipped=true 进页面即已登录；false 本次实际完成了登录
 * @throws 等待已登录标志超时（所有轮次均未成功）
 */
export async function ensureLoggedIn(wallet: WalletActions, spec: LoginSpec): Promise<{ skipped: boolean }> {
  const deps = wallet.deps
  const { page } = deps
  const clickSoft = async (sel: string): Promise<void> => {
    await deps.page.locator(sel).first().click({ timeout: 5000 }).catch(() => {})
  }
  // 慢渲染容忍：先等控件可见再点，等不到也照点（软失败不阻断），避免弹窗/钱包列表晚渲染时单击落空
  const clickWhenReady = async (sel: string, timeoutMs: number): Promise<void> => {
    await deps.page.locator(sel).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {})
    await deps.page.locator(sel).first().click({ timeout: 5000 }).catch(() => {})
  }
  const state0 = await raceState(wallet, spec, 20000)
  if (state0 === 'loggedIn') return { skipped: true }
  await wallet.ready()
  const attempts = spec.attempts ?? 2
  const reclickAfterMs = spec.reclickAfterMs ?? 8000
  for (let round = 0; round < attempts; round++) {
    if (round > 0) {
      await page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(5000)
    }
    if (spec.connect) await clickSoft(spec.connect)
    const entry = spec.entry
    if (entry?.kind === 'dialog' && entry.confirm) await clickWhenReady(entry.confirm, 45000)
    if (entry?.kind === 'appkit') {
      await openAppKitWallet(deps, entry)
    }
    if (spec.walletEntry) await clickWhenReady(spec.walletEntry, 45000)
    const intents = spec.intents ?? ['connect']
    const reclickSelector = entry?.kind === 'appkit'
      ? `[data-testid="${entry.entryTestId}"]`
      : (spec.walletEntry
        ?? (entry?.kind === 'dialog' && entry.confirm ? entry.confirm : spec.connect))
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

/**
 * 把探针简写归一为完整探针：字符串按文案匹配，已结构化对象原样返回。
 * @param p 字符串或探针对象
 * @returns 结构化探针
 */
function toProbe(p: LoginProbe): Probe {
  return typeof p === 'string' ? { text: p } : p
}

/**
 * 双探针竞速：判断当前处于已登录还是未登录，谁先可见就是谁。
 * @param wallet WalletActions 门面（取其页面依赖）
 * @param spec 登录规格（提供两个探针）
 * @param timeoutMs 竞速等待毫秒数
 * @returns 'loggedIn'/'loggedOut'；预算内都没出现返回 null
 */
async function raceState(wallet: WalletActions, spec: LoginSpec, timeoutMs: number): Promise<'loggedIn' | 'loggedOut' | null> {
  const deps = wallet.deps
  const { raceProbes } = await import('../dom')
  return raceProbes(deps.page, [['loggedIn', toProbe(spec.loggedIn)], ['loggedOut', toProbe(spec.loggedOut)]], timeoutMs) as Promise<'loggedIn' | 'loggedOut' | null>
}

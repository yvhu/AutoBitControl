/**
 * Konnex Testnet 周任务：Testnet Onchain Onboarding (Weekly)（+500 KP，每周一次）
 * 流程：Hub 登录 MetaMask → Testnet 按钮开新标签 → Quest 页 Connect/Reconnect EVM wallet
 *       → Verify Snag account（首次账户需再签一次 MetaMask）→ KNX Wallet（连接 SubWallet，RPC URL 出现）
 *       → Next → Get testnet KNX → Submit drone request（SubWallet 签名）→ Buy Alpha
 *       → 关闭 Quest 标签回 Hub 刷新，卡片出现 Great job! 即成功
 * 依赖方向：依赖 ./base（任务基类）、./konnex-hub（共享 Hub 登录）与 ../api（能力函数）
 * 设计思路：Quest 页用 target=_blank 打开，主页面仍保留 Hub；新标签由 api/tab 接管，
 *   钱包动作通过 page/wallet 覆盖参数在 Quest 页操作，不改 ctx.page、也不改 meta.wallet
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import {
  openPage, click, connectWallet, signMessage, waitFor, takeScreenshot, takeElementScreenshot, closeWalletPopups,
  openTab, waitInTab, raceInTab, clickInTab, focusTab, closeTab,
} from '../api'
import { ensureKonnexHubLogin, KONNEX_HUB_URL, KONNEX_SIGN_IN_BTN } from './konnex-hub'

const CARD = '#loyalty-quest-root-external_rule' // Testnet 任务卡片根节点（与签到卡片 check_in 区分）
const CARD_DONE_TEXT = 'Great job!' // 完成态横幅文案
const CARD_DONE = `${CARD}:has-text("${CARD_DONE_TEXT}")` // 卡片内的完成态
const TESTNET_LINK = `${CARD} a[href*="/quest?walletAddress="]` // 卡片内 Testnet 入口（href 带钱包地址）
const HUB_READY = `${TESTNET_LINK}, ${CARD_DONE}` // 登录完成的任一状态：可进任务 / 本周已完成

const QUEST_PAGE_PATH = 'https://subnets.testnet.konnex.world/quest' // Quest 页固定 origin + path
const QUEST_URL_INCLUDES = '/quest?walletAddress=' // 新标签 URL 过滤片段（不校验地址具体值）
const EVM_CONNECT_BTN = 'button:has-text("Connect EVM wallet"):visible' // 未连接态
const EVM_RECONNECT_BTN = 'button:has-text("Reconnect EVM wallet"):visible' // 已连接态（缓存会话也会显示）
const VERIFY_SNAG_BTN = 'button:has-text("Verify Snag account"):not([disabled]):visible' // EVM 连接后才可点（首次账户需要验证 Snag）
const KNX_WALLET_ACTIVE = 'button:has-text("KNX Wallet"):not([disabled]):visible' // Verify Snag 完成后进入 KNX Wallet 步骤
const KNX_CONNECT_BTN = 'section button:has-text("Connect wallet"):visible' // KNX Wallet 步骤内容区的连接按钮（区别于页头）
const RPC_VISIBLE = 'div:has-text("RPC URL"):visible' // KNX Wallet 连接 SubWallet 后出现（真机核实）
const NEXT_BTN = 'button:has-text("Next"):visible' // 步骤下一步按钮（连接前也存在，不能当连接判据）
const GET_KNX_BTN = 'button:has-text("Get testnet KNX"):visible'
const SUBMIT_DRONE_BTN = 'button:has-text("Submit drone request"):visible'
const BUY_ALPHA_BTN = 'button:has-text("Buy Alpha"):visible' // SubWallet 签名完成后出现的入口（按可见判定）

const CARD_WAIT_MS = 45000 // 等 Hub 卡片/登录状态出现的预算（SPA 异步渲染）
const QUEST_PAGE_WAIT_MS = 30000 // 点 Testnet 后等新标签页的预算
const EVM_CONNECT_WAIT_MS = 60000 // 等 Quest 页出现连接按钮或 RPC URL 的预算
const QUEST_STEP_WAIT_MS = 120000 // 单步按钮/完成态等待预算（链上/钱包交互较慢）
const SIGN_IN_STABLE_POLLS = 3 // 站内 Sign in 连续可见轮数（约 6 秒）才判定未登录

export class KonnexTestnetWeeklyTask extends SiteTask {
  meta: TaskMeta = {
    key: 'konnex-testnet-weekly',
    name: 'Konnex Testnet 周任务',
    group: { key: 'konnex', name: 'Konnex' },
    url: KONNEX_HUB_URL,
    sourceUrl: ['https://cryptorank.io/zh/drophunting/konnex-activity1071', 'https://airdrops.io/konnex/'],
    note: '每周 Testnet Onchain Onboarding（+500 KP）：Hub 用 MetaMask 登录 → 卡片 Testnet 按钮开新标签 → Quest 页 Connect/Reconnect EVM wallet（文案变 Reconnect）→ Verify Snag account（首次账户需再签一次 MetaMask；已验证账户按钮不可点则跳过）→ KNX Wallet 步骤连接 SubWallet（已授权时静默，内容区 Connect wallet，成功后出现 RPC URL）→ Next → Get testnet KNX → Submit drone request（SubWallet 弹窗输密码 + 签名 Approve）→ Buy Alpha → 回 Hub 刷新出现 Great job! 即成功；不校验 walletAddress 具体值，只确认 Quest 页地址；SubWallet 密码 key 为 subwallet',
    category: 'other',
    lastUpdated: '2026-11-11',
    enabled: true,
    wallet: 'metamask',
    timeoutSec: 900,
    retry: { max: 2, backoffSec: 600 },
  }

  /**
   * 执行流程：打开 Hub → 判已完/可进/需登录 → 需要时登录 → 开 Quest 新标签完成双钱包流程
   * → 关闭 Quest 标签回 Hub 刷新，断言卡片出现 Great job!。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    const state = await this.waitHubState(ctx)
    if (state === 'done') {
      ctx.log.info({ step: 'konnex-weekly', window: ctx.profile.name }, '本周 Testnet 任务已完成（Hub 卡片 Great job!）')
      await takeElementScreenshot(ctx, 'konnex-testnet-weekly-success', CARD)
      return
    }
    if (state === 'needLogin') {
      await ensureKonnexHubLogin(ctx, { connected: { selector: HUB_READY } })
    }
    // 登录后卡片可能直接变成完成态（本周已完成）；否则必须出现 Testnet 入口
    if (await this.isVisible(ctx, CARD_DONE)) {
      ctx.log.info({ step: 'konnex-weekly', window: ctx.profile.name }, '本周 Testnet 任务已完成（登录后卡片为 Great job!）')
      await takeElementScreenshot(ctx, 'konnex-testnet-weekly-success', CARD)
      return
    }
    if (!(await waitFor(ctx, { selector: TESTNET_LINK }, { budgetMs: CARD_WAIT_MS }))) {
      throw new Error('Hub 未出现 Testnet 任务入口（登录未完成、活动未开放或站点改版）')
    }

    let questPage: TaskContext['page']
    try {
      questPage = await this.openQuestTab(ctx)
    } catch (e) {
      // 站点可能判定已完成、点击后直接切换卡片而不开新标签页（完成态可能稍晚渲染）
      if (await waitFor(ctx, { selector: CARD_DONE }, { budgetMs: 15000 })) {
        ctx.log.info({ step: 'konnex-weekly', window: ctx.profile.name }, '点击 Testnet 后卡片直接变为已完成（未打开新标签页）')
        await takeElementScreenshot(ctx, 'konnex-testnet-weekly-success', CARD)
        return
      }
      throw e
    }

    try {
      this.assertQuestUrl(questPage.url())
      await focusTab(questPage)
      await this.completeQuest(ctx, questPage)
      await takeScreenshot(ctx, 'konnex-testnet-weekly-quest', questPage)
    } catch (e) {
      await takeScreenshot(ctx, 'konnex-testnet-weekly-quest-failed', questPage)
      throw e
    }

    await closeTab(ctx, questPage)
    await this.refreshHubAndWaitDone(ctx)
    ctx.log.info({ step: 'konnex-weekly', window: ctx.profile.name }, 'Testnet 周任务完成（Hub 卡片 Great job!）')
    await takeElementScreenshot(ctx, 'konnex-testnet-weekly-success', CARD)
  }

  /**
   * 等 Hub 进入可操作状态：已完成 / 可进任务 / 需要登录。
   * Sign in 需连续可见若干轮才判定未登录，避开会话加载时的闪现。
   * @param ctx 任务上下文
   * @returns done=本周已完成；ready=可点 Testnet；needLogin=需要走登录流程
   */
  private async waitHubState(ctx: TaskContext): Promise<'done' | 'ready' | 'needLogin'> {
    const deadline = Date.now() + CARD_WAIT_MS
    let signInPolls = 0
    while (Date.now() < deadline) {
      if (await this.isVisible(ctx, CARD_DONE)) return 'done'
      if (await this.isVisible(ctx, TESTNET_LINK)) return 'ready'
      signInPolls = (await this.isVisible(ctx, KONNEX_SIGN_IN_BTN)) ? signInPolls + 1 : 0
      if (signInPolls >= SIGN_IN_STABLE_POLLS) return 'needLogin'
      await ctx.page.waitForTimeout(2000)
    }
    return 'ready'
  }

  /**
   * 点击卡片里的 Testnet 链接，等新标签页出现并返回。
   * @param ctx 任务上下文
   * @returns Quest 页
   * @throws 新标签页未出现（调用方会再判一次卡片是否已完成）
   */
  private async openQuestTab(ctx: TaskContext): Promise<TaskContext['page']> {
    return openTab(ctx, () => click(ctx, TESTNET_LINK), {
      urlIncludes: QUEST_URL_INCLUDES,
      timeoutMs: QUEST_PAGE_WAIT_MS,
    })
  }

  /**
   * 校验新标签页确实是 Konnex Testnet Quest 页（只认 origin + path，不校验 walletAddress 具体值）。
   * @param raw 新标签页地址
   * @throws 地址无效或不是 Quest 页
   */
  private assertQuestUrl(raw: string): void {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`Quest 页地址无效: ${raw}`)
    }
    if (`${url.origin}${url.pathname}` !== QUEST_PAGE_PATH) {
      throw new Error(`Quest 页地址不符（期望 ${QUEST_PAGE_PATH}，实际 ${raw}）`)
    }
  }

  /**
   * Quest 页完整流程：EVM 钱包连接（MetaMask）→ Next → Get testnet KNX
   * → Submit drone request（SubWallet 签名）→ 等 Buy Alpha。
   * @param ctx 任务上下文
   * @param page Quest 标签页
   */
  private async completeQuest(ctx: TaskContext, page: TaskContext['page']): Promise<void> {
    const evmState = await raceInTab(page, [
      ['ready', { selector: EVM_RECONNECT_BTN }],
      ['connect', { selector: EVM_CONNECT_BTN }],
    ], EVM_CONNECT_WAIT_MS)
    if (evmState === null) {
      throw new Error('Quest 页未出现 Connect EVM wallet / Reconnect EVM wallet（页面加载失败或站点改版）')
    }
    if (evmState === 'connect') {
      ctx.log.info({ step: 'quest-evm', window: ctx.profile.name }, 'Quest 页连接 EVM 钱包（MetaMask）')
      await connectWallet(ctx, {
        wallet: 'metamask',
        page,
        connected: { selector: EVM_RECONNECT_BTN },
        disconnected: { selector: EVM_CONNECT_BTN },
        connect: EVM_CONNECT_BTN,
        waitConnectedMs: QUEST_STEP_WAIT_MS,
        attempts: 2,
      })
    }

    // 首次账户连接 EVM 后还需验证 Snag 账户（按钮由 disabled 变为可点），会再弹一次 MetaMask 签名；
    // 已验证过的账户按钮不可点，直接跳过。
    if (await waitInTab(ctx, page, { selector: VERIFY_SNAG_BTN }, { budgetMs: 30000 })) {
      await this.verifySnagAccount(ctx, page)
    } else {
      ctx.log.info({ step: 'quest-verify-snag', window: ctx.profile.name }, 'Verify Snag account 不可点（可能已验证），跳过')
    }

    // Verify Snag 完成后页面进入 KNX Wallet 步骤；该步骤需要连接 SubWallet（已授权时静默连接），
    // 连接成功后才出现 RPC URL（真机核实：RPC URL 是 KNX Wallet 的连接结果，不是 EVM 签名结果）。
    if (!(await waitInTab(ctx, page, { selector: KNX_WALLET_ACTIVE }, { budgetMs: 60000 }))) {
      throw new Error('Verify Snag 完成后未进入 KNX Wallet 步骤（页面未推进或站点改版）')
    }
    if (!(await waitInTab(ctx, page, { selector: RPC_VISIBLE }, { budgetMs: 5000 }))) {
      ctx.log.info({ step: 'quest-knx-wallet', window: ctx.profile.name }, 'KNX Wallet 连接 SubWallet')
      await connectWallet(ctx, {
        wallet: 'subwallet',
        page,
        connected: { selector: RPC_VISIBLE },
        disconnected: { selector: KNX_CONNECT_BTN },
        connect: KNX_CONNECT_BTN,
        waitConnectedMs: QUEST_STEP_WAIT_MS,
        attempts: 2,
      })
    }

    await this.clickQuestStep(ctx, page, NEXT_BTN, 'Next')
    await this.clickQuestStep(ctx, page, GET_KNX_BTN, 'Get testnet KNX')
    await this.clickQuestStep(ctx, page, SUBMIT_DRONE_BTN, 'Submit drone request')

    const { popupFailed } = await signMessage(ctx, {
      wallet: 'subwallet',
      page,
      reclick: { selector: SUBMIT_DRONE_BTN, afterMs: 15000 },
    })
    if (popupFailed) {
      ctx.log.info({ step: 'quest-subwallet', window: ctx.profile.name }, 'SubWallet 弹窗未出现（可能站点已静默完成），继续等页面完成态')
    }
    if (!(await waitInTab(ctx, page, { selector: BUY_ALPHA_BTN }, { budgetMs: QUEST_STEP_WAIT_MS }))) {
      throw new Error('SubWallet 签名后未出现 Buy Alpha（签名未完成、SubWallet 未安装/未配置密码或站点改版）')
    }
  }

  /**
   * 验证 Snag 账户：清理残留弹窗 → 点按钮 → MetaMask 签名；失败时先看页面是否已推进，
   * 未推进则清理残留弹窗后最多重试 1 次。真机偶发 MetaMask 弹窗未关闭，但页面已进入下一步。
   * @param ctx 任务上下文
   * @param page Quest 标签页
   */
  private async verifySnagAccount(ctx: TaskContext, page: TaskContext['page']): Promise<void> {
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const closed = await closeWalletPopups(ctx, { wallet: 'metamask', page })
      if (closed > 0) ctx.log.info({ step: 'quest-verify-snag', window: ctx.profile.name, attempt, closed }, '已清理残留 MetaMask 弹窗')
      ctx.log.info({ step: 'quest-verify-snag', window: ctx.profile.name, attempt }, 'Quest 页验证 Snag 账户（MetaMask 签名）')
      await clickInTab(page, VERIFY_SNAG_BTN)

      let signError: Error | null = null
      try {
        const { popupFailed } = await signMessage(ctx, {
          wallet: 'metamask',
          page,
          reclick: { selector: VERIFY_SNAG_BTN, afterMs: 15000 },
        })
        if (popupFailed) {
          ctx.log.info({ step: 'quest-verify-snag', window: ctx.profile.name, attempt }, 'Verify Snag account 钱包弹窗未出现（可能已静默完成），检查页面是否推进')
        }
      } catch (e) {
        signError = e as Error
        ctx.log.warn({ step: 'quest-verify-snag', window: ctx.profile.name, attempt, err: signError.message }, 'Verify Snag 签名失败，先检查页面是否已推进')
      }

      // 弹窗 close 事件/页面推进不同步时，页面可能已经进入 KNX Wallet；按成功继续
      if (await this.waitForSnagAdvanced(ctx, page, 30000)) return

      if (attempt >= maxAttempts) {
        if (signError) throw signError
        throw new Error('Verify Snag account 签名后未进入 KNX Wallet 步骤（重试后仍未推进）')
      }
      ctx.log.warn({ step: 'quest-verify-snag', window: ctx.profile.name, attempt }, 'Verify Snag 未推进，清理残留弹窗后重试')
    }
  }

  /**
   * 等 Verify Snag 步骤推进：KNX Wallet 变为可点，或已出现 KNX Wallet 的 RPC URL。
   * @param ctx 任务上下文
   * @param page Quest 标签页
   * @param budgetMs 等待预算
   */
  private async waitForSnagAdvanced(ctx: TaskContext, page: TaskContext['page'], budgetMs: number): Promise<boolean> {
    const outcome = await raceInTab(page, [
      ['knx', { selector: KNX_WALLET_ACTIVE }],
      ['rpc', { selector: RPC_VISIBLE }],
    ], budgetMs)
    return outcome !== null
  }

  /**
   * 等 Quest 页按钮出现后点击。
   * @param ctx 任务上下文
   * @param page Quest 标签页
   * @param selector 按钮选择器（已限定 :visible）
   * @param label 日志/报错用的按钮名
   */
  private async clickQuestStep(ctx: TaskContext, page: TaskContext['page'], selector: string, label: string): Promise<void> {
    if (!(await waitInTab(ctx, page, { selector }, { budgetMs: QUEST_STEP_WAIT_MS }))) {
      throw new Error(`Quest 页未出现「${label}」按钮（等待超时或站点改版）`)
    }
    await clickInTab(page, selector)
    ctx.log.info({ step: 'quest', window: ctx.profile.name, button: label }, '已点击 Quest 页按钮')
  }

  /**
   * 关闭 Quest 标签后重新打开 Hub，等卡片出现 Great job!（同步可能延迟，周期刷新）。
   * @param ctx 任务上下文
   * @throws 预算内 Hub 卡片仍未变为完成态
   */
  private async refreshHubAndWaitDone(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url)
    if (!(await waitFor(ctx, { selector: CARD_DONE }, { budgetMs: 90000, refreshEveryMs: 15000 }))) {
      throw new Error('Testnet 周任务完成后，Hub 卡片未出现 Great job!（同步延迟或站点改版）')
    }
  }

  /**
   * 判断某选择器的首个匹配元素当前是否可见（元素不存在或查询异常一律按不可见处理）。
   * @param ctx 任务上下文
   * @param selector CSS 选择器
   */
  private async isVisible(ctx: TaskContext, selector: string): Promise<boolean> {
    try {
      const loc = ctx.page.locator(selector).first()
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    } catch {
      return false
    }
  }
}

/**
 * Shelby Explorer 上传任务（xyz-shelbynet）：Petra 登录 + 账号页上传文件（数据源「文件地址」列）
 * 站内 Petra Web 弹窗：点弹窗内 Connect（Aptos 默认=Petra）后静默连接；登录结果以 header 0x 地址为准
 * 上传：隐藏 file input → 选文件（站点立即查重：已上传直接 Blob name already taken 视为成功）→ Upload → 两次签名
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）
 */
import { SiteTask, RECOVER_TEXTS, type TaskContext, type TaskMeta } from './base'
import { openPage, loginWallet, click, waitFor, elementState, hasText, getAccount, uploadFile, takeScreenshot, signMessage } from '../api'

const ADDRESS_SELECTOR = 'header button:has-text("0x")'
const CONNECT_SELECTOR = 'header button:has-text("Connect Wallet")'
const DIALOG_CONNECT_SELECTOR = '[role="dialog"] button:has-text("Connect")'
const UPLOAD_FILES_SELECTOR = 'button:has-text("Upload Files")'
const FILE_INPUT_SELECTOR = '[role="dialog"] input[type="file"]'
const UPLOAD_BUTTON_SELECTOR = '[role="dialog"] button:has-text("Upload")'
const UPLOADING_TEXT = 'Uploading files'
const SUCCESS_TEXT = 'All files uploaded successfully'
export const ALREADY_DONE_TEXT = 'Blob name already taken'

const REFRESH_EVERY_MS = 30000

export class ShelbyExplorerTask extends SiteTask {
  successWaitMs = 180000 // 点 Upload 后等终态（成功/已上传）的预算
  loginWaitMs = 120000 // 等登录完成的预算（账号页会话失效时兜底重登复用）
  uploadEntryWaitMs = 120000 // 账号页等 Upload Files 入口出现的预算（含刷新恢复）
  uploadEnabledWaitMs = 30000 // 选文件后等 Upload 启用/已上传提示的预算
  uploadDialogWaitMs = 20000 // 点 Upload Files 后等弹窗 file input 挂载的预算
  walletDialogWaitMs = 45000 // 预留：等钱包弹窗的预算（当前未使用）
  walletDialogReclickMs = 8000 // 预留：钱包弹窗补点间隔（当前未使用）
  accountBaseUrl = 'https://explorer.shelby.xyz' // 账号页基址（拼接 /shelbynet/account/<地址>/blobs）

  meta: TaskMeta = {
    key: 'xyz-shelbynet',
    name: 'shelbynet 上传任务',
    group: { key: 'shelby', name: 'Shelby' },
    url: 'https://explorer.shelby.xyz/shelbynet',
    sourceUrl: 'https://cryptorank.io/zh/drophunting/shelby-activity1120',
    note: '真机核实（2026-09-07）：站内 Petra Web 弹窗（非 AppKit），点弹窗内 Connect 后静默连接（扩展已授权无钱包弹窗），登录态以 header 0x 地址按钮为准（首页表格全是 0x 不能全页判定）；上传入口在账号页 Upload Files；file input 隐藏；选文件后站点立即查重——已上传直接 Blob name already taken 且 Upload 永不启用→短路视为成功；未上传则点 Upload 触发两次签名（register_multiple_blobs → commit_object）；成功文案 All files uploaded successfully；上传中不刷新防打断在途请求',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: true,
    wallet: 'petra',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 60 },
    concurrency: 4,
    requiresFileAssign: true,
  }

  /**
   * 执行流程：打开任务页 → 声明式钱包登录（站内弹窗 Petra 静默连接）→ 账号页上传。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    await this.walletLogin(ctx)
    await this.action(ctx)
  }

  /** 钱包登录声明（复用给初始登录与账号页会话失效时的兜底重登） */
  private walletLogin(ctx: TaskContext): Promise<void> {
    return loginWallet(ctx, {
      wallet: 'petra',
      scenario: 'dialog',
      loggedIn: { selector: ADDRESS_SELECTOR },
      loggedOut: { selector: CONNECT_SELECTOR },
      connect: CONNECT_SELECTOR,
      confirm: DIALOG_CONNECT_SELECTOR,
      intents: ['connect'],
      waitLoggedInMs: this.loginWaitMs,
    })
  }

  /**
   * 站点动作：确保登录 → 进入账号页上传数据源指定的文件。
   * @param ctx 任务上下文
   */
  async action(ctx: TaskContext): Promise<void> {
    await this.doLoginIfNeeded(ctx)
    await this.upload(ctx)
  }

  /** 账号页会话未恢复时的重新登录（复用登录声明） */
  private async doLoginIfNeeded(ctx: TaskContext): Promise<void> {
    // 初始登录已由 run 完成；此处仅在账号页会话失效时兜底重登
    if ((await elementState(ctx, ADDRESS_SELECTOR)) === 'visible') return
    await this.walletLogin(ctx)
  }

  /**
   * 上传流程：进账号页 → （会话失效则重登）→ 点 Upload Files 打开弹窗
   * → 选数据源「文件地址」指定文件 → 站点查重（已上传直接成功）→ 点 Upload → 两次签名 → 等终态。
   * @param ctx 任务上下文
   */
  private async upload(ctx: TaskContext): Promise<void> {
    const address = await getAccount(ctx, 'petra钱包地址')
    const accountUrl = `${this.accountBaseUrl}/shelbynet/account/${address}/blobs`
    await openPage(ctx, accountUrl)
    if (!(await this.waitSelectorRecover(ctx, UPLOAD_FILES_SELECTOR, this.uploadEntryWaitMs))) {
      await this.doLoginIfNeeded(ctx)
      await openPage(ctx, accountUrl)
      if (!(await this.waitSelectorRecover(ctx, UPLOAD_FILES_SELECTOR, this.uploadEntryWaitMs))) {
        throw new Error('账号页未出现 Upload Files（页面改版或登录态未恢复）')
      }
    }
    let inputAttached = false
    for (let round = 0; round < 2 && !inputAttached; round++) {
      if (round > 0) ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传弹窗未出现，补点 Upload Files')
      await click(ctx, UPLOAD_FILES_SELECTOR).catch(() => {})
      inputAttached = await this.waitAttached(ctx, FILE_INPUT_SELECTOR, this.uploadDialogWaitMs)
    }
    if (!inputAttached) throw new Error('上传弹窗未出现 file input（弹窗结构异常或点击落空）')
    await uploadFile(ctx, FILE_INPUT_SELECTOR, await getAccount(ctx, '文件地址'))
    const settle = await this.waitSettle(ctx)
    if (settle === 'alreadyDone') {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '文件已上传过（Blob name already taken），视为成功')
      await takeScreenshot(ctx, 'shelby-explorer-success')
      return
    }
    await click(ctx, UPLOAD_BUTTON_SELECTOR)
    // 双签名：register_multiple_blobs → commit_object（各一次钱包弹窗）
    for (let i = 0; i < 2; i++) {
      const { popupFailed } = await signMessage(ctx)
      if (popupFailed) ctx.log.info({ step: 'upload', window: ctx.profile.name }, '钱包弹窗未出现（可能文件已上传不再发起签名），继续等待终态')
    }
    const outcome = await this.waitSuccess(ctx)
    if (outcome === 'alreadyDone') {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '文件已上传过（Blob name already taken），视为成功')
    } else {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传完成（All files uploaded successfully）')
    }
    await takeScreenshot(ctx, 'shelby-explorer-success')
  }

  /** 选文件后终态分叉：已上传 → alreadyDone；未上传 → Upload 启用 → enabled */
  private async waitSettle(ctx: TaskContext): Promise<'alreadyDone' | 'enabled'> {
    const end = Date.now() + this.uploadEnabledWaitMs
    while (Date.now() < end) {
      if (await hasText(ctx, ALREADY_DONE_TEXT)) return 'alreadyDone'
      const disabled = await ctx.page.locator(UPLOAD_BUTTON_SELECTOR).first().isDisabled().catch(() => true)
      if (!disabled) return 'enabled'
      await ctx.page.waitForTimeout(1000)
    }
    throw new Error('选文件后 Upload 按钮未启用且无已上传提示（文件过大或上传弹窗状态异常）')
  }

  /** 等元素挂载（hidden 的 file input 不能用可见性判定） */
  private async waitAttached(ctx: TaskContext, selector: string, budgetMs: number): Promise<boolean> {
    const end = Date.now() + budgetMs
    while (Date.now() < end) {
      if ((await elementState(ctx, selector)) !== 'absent') return true
      await ctx.page.waitForTimeout(1000)
    }
    return false
  }

  /** 等选择器可见（刷新恢复导向：错误立即刷 + 每 30s 周期刷） */
  private async waitSelectorRecover(ctx: TaskContext, selector: string, budgetMs: number): Promise<boolean> {
    return waitFor(ctx, { selector }, { budgetMs, refreshEveryMs: REFRESH_EVERY_MS, recoverTexts: RECOVER_TEXTS })
  }

  /** 等终态：上传成功 / 已上传过；错误且不在上传中才刷新 */
  private async waitSuccess(ctx: TaskContext): Promise<'uploaded' | 'alreadyDone'> {
    const end = Date.now() + this.successWaitMs
    while (Date.now() < end) {
      if (await hasText(ctx, SUCCESS_TEXT)) return 'uploaded'
      if (await hasText(ctx, ALREADY_DONE_TEXT)) return 'alreadyDone'
      let errText = ''
      for (const t of RECOVER_TEXTS) {
        if (await hasText(ctx, t)) {
          errText = t
          break
        }
      }
      const uploading = await hasText(ctx, UPLOADING_TEXT)
      if (errText !== '' && !uploading) {
        ctx.log.info({ step: 'upload', window: ctx.profile.name, errText }, '上传等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    throw new Error(`上传未完成（等待 ${SUCCESS_TEXT} 或 ${ALREADY_DONE_TEXT} 超时）`)
  }
}

/**
 * Shelby Explorer 上传任务（xyz-shelbynet）：Petra 登录 + 上传文件（数据源「文件地址」列）
 * 依赖方向：仅依赖 ./base 与 infrastructure/constants，经 index.ts 登记
 * 流程（按用户操作步骤 + 最佳猜测选择器，真机核实后修正）：
 *   打开 explorer.shelby.xyz/shelbynet → 竞速判定登录态（header 0x 地址 / Connect Wallet）
 *   → 未登录：点 header Connect Wallet → 站内弹窗选 Petra → Petra 扩展弹窗（密码 Unlock → Approve）
 *   → 等 0x 地址出现（登录完成）→ 点 0x 地址 → 页面出现 Upload Files
 *   → 点 Upload Files 打开上传弹窗 → setInputFiles 选数据源文件 → 点 Upload
 *   → 两次 Petra Approve 弹窗（loginByWallet ×2）→ 等 All files uploaded successfully
 * 可重复任务：无「已领取」短路，每次执行都走完整上传流程
 * 待真机核实（task:run 单窗口验证，见实施计划 Task 3）：
 *   1. 站内钱包弹窗结构（AppKit 还是自定义；Petra 入口选择器与 Connect 按钮）
 *   2. 登录是否自动切换网络到 Shelbynet；不切换则补 Petra 扩展内切链步骤
 *   3. 上传弹窗是否有 input[type="file"]（拖拽区则换 CDP 方案）
 *   4. 首页是否还有其它 0x 文案干扰登录态判定
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '../infrastructure/constants'

// —— 站点文案（真机核实后修正）——
/** 已登录标志：header 出现 0x 开头钱包地址 */
const ADDRESS_TEXT = '0x'
/** 未登录落地页按钮文案 */
const CONNECT_TEXT = 'Connect Wallet'
/** 上传任务入口按钮文案（点 0x 地址后出现） */
const UPLOAD_FILES_TEXT = 'Upload Files'
/** 上传中弹窗文案（上传中不刷新页面，防打断在途请求） */
const UPLOADING_TEXT = 'Uploading files'
/** 成功判定文案 */
const SUCCESS_TEXT = 'All files uploaded successfully'
/** 可恢复错误文案（刷新恢复，沿用 portal-rhuna 真机经验） */
const RECOVER_ERROR_TEXTS = ['Network Error', 'Turnstile token request timed out']

// —— 时间配置（真机实测后校准）——
/** 登录态竞速首轮等待（SPA 渲染有延迟，真机经验放宽到 20s） */
const STATE_WAIT_MS = 20000
/** 登录完成等待预算（0x 地址出现，后端链路约 5s，放宽到 60s） */
const LOGIN_WAIT_MS = 60000
/** 上传入口等待预算（点 0x 地址后 Upload Files 出现） */
const UPLOAD_ENTRY_WAIT_MS = 60000

export class ShelbyExplorerTask extends SiteTask {
  /** 上传成功等待预算毫秒（测试覆盖缩短；上传大文件 + 双签名耗时，放宽到 180s） */
  successWaitMs = 180000

  meta: TaskMeta = {
    key: 'xyz-shelbynet',
    name: 'shelbynet 领水和任务',
    url: 'https://explorer.shelby.xyz/shelbynet',
    sourceUrl: 'https://cryptorank.io/zh/drophunting/shelby-activity1120',
    note: '可重复任务（每次全流程上传，无已领取短路）；登录 Petra；成功判定 All files uploaded successfully；上传文件取自数据源「文件地址」列（严格模式，缺列/空值即失败）；上传后两次钱包 Approve 弹窗（loginByWallet ×2）；上传中不刷新防打断在途请求；选择器为最佳猜测，待真机核实（站内钱包弹窗结构/网络是否自动切 Shelbynet/上传弹窗 file input/首页 0x 文案干扰）',
    category: 'checkin',
    lastUpdated: '2026-09-07',
    enabled: true,
    wallet: 'petra',
    // 上传大文件 + 双签名耗时，放宽单次超时
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 120 },
    captcha: { auto: true },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
    await ctx.closeOtherTabs()
    await ctx.goto()

    // 登录状态竞速判定：SPA 渲染有延迟，已登录窗口误入登录分支会假报失败；
    // 状态不明时反复刷新（每轮两种状态都认，已登录窗口刷新后直接走已登录分支）
    const state = await ctx.detectPageState({
      loggedInText: ADDRESS_TEXT,
      landingText: CONNECT_TEXT,
      waitMs: STATE_WAIT_MS,
      rounds: 10,
      roundWaitMs: 15000,
      reloadTimeoutMs: DEFAULT_RELOAD_TIMEOUT_MS,
    })
    if (state === 'landing') {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '未登录，进入 Petra 登录流程')
      await this.login(ctx)
    } else {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '已登录（cookie 有效），跳过登录')
    }

    await this.upload(ctx)
  }

  /** Petra 登录：Connect Wallet → 站内弹窗选 Petra → 扩展弹窗（密码 Unlock → Approve）→ 等 0x 出现 */
  private async login(ctx: TaskContext): Promise<void> {
    await ctx.ensureWalletReady()
    const connectBtn = 'header button:has-text("Connect Wallet")'
    await ctx.human.click(connectBtn)
    // 站内钱包弹窗：Aptos 分区下的 Petra 入口（结构真机核实；若为 AppKit 弹窗改用 openAppKitWallet）
    const petraEntry = 'button:has-text("Petra")'
    await ctx.assertVisible(petraEntry, 20000)
    await ctx.human.click(petraEntry)
    await ctx.loginByWallet({ reclick: { selector: petraEntry, afterMs: 8000 } })
    // 等登录完成（header 出现 0x 地址）；站点 token 存 localStorage：每 25s 主动刷新恢复
    if (!(await ctx.waitForTextRecover(ADDRESS_TEXT, { budgetMs: LOGIN_WAIT_MS, refreshEveryMs: 25000, recoverTexts: RECOVER_ERROR_TEXTS }))) {
      throw new Error('钱包签名后登录未完成（等待 0x 地址出现超时，站点登录接口慢或该窗口账号异常）')
    }
  }

  /** 上传流程：点 0x 地址 → Upload Files → 选文件 → Upload → 双 Approve → 等成功文案 */
  private async upload(ctx: TaskContext): Promise<void> {
    await ctx.human.click('header button:has-text("0x")')
    if (!(await ctx.waitForTextRecover(UPLOAD_FILES_TEXT, { budgetMs: UPLOAD_ENTRY_WAIT_MS, refreshEveryMs: 25000, recoverTexts: RECOVER_ERROR_TEXTS }))) {
      throw new Error('点击 0x 地址后未出现 Upload Files（页面改版或入口变化）')
    }
    await ctx.human.click(`button:has-text("${UPLOAD_FILES_TEXT}")`)
    // 上传弹窗 → 选文件（严格模式：缺列/空值即失败，数据没备齐不该硬跑）
    const fileInput = '[role="dialog"] input[type="file"]'
    await ctx.assertVisible(fileInput, 20000)
    await ctx.uploadFile(fileInput, await ctx.account('文件地址'))
    await ctx.human.click('[role="dialog"] button:text-is("Upload")')
    // 双钱包确认：第一个 Approve 弹窗关闭后再等第二个（Petra 适配器自动点 Approve 至弹窗关闭）
    await ctx.loginByWallet()
    await ctx.loginByWallet()
    await this.waitSuccess(ctx)
    ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传完成（All files uploaded successfully）')
    await ctx.screenshot('shelby-explorer-success')
  }

  /** 等成功文案：可恢复错误且不在上传中才刷新（上传中刷新会打断在途请求） */
  private async waitSuccess(ctx: TaskContext): Promise<void> {
    const end = Date.now() + this.successWaitMs
    while (Date.now() < end) {
      if (await ctx.textPresent(SUCCESS_TEXT)) return
      const errText = await ctx.recoverErrorText(RECOVER_ERROR_TEXTS)
      const uploading = await ctx.textPresent(UPLOADING_TEXT)
      if (errText !== '' && !uploading) {
        ctx.log.info({ step: 'upload', window: ctx.profile.name, errText }, '上传等待中出现可恢复错误，刷新')
        await ctx.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    throw new Error(`上传未完成（等待 ${SUCCESS_TEXT} 超时）`)
  }
}

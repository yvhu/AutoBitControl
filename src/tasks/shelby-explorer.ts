/**
 * Shelby Explorer 上传任务（xyz-shelbynet）：Petra 登录 + 账号页上传文件（数据源「文件地址」列）
 * 依赖方向：仅依赖 ./base 与 infrastructure/constants，经 index.ts 登记
 * 真机核实（2026-09-07，窗口 4e6bc67b83a840c7b665d2723c4837f0 全流程跑通）：
 *   站内钱包弹窗为 Petra Web（Aptos Labs）自定义弹窗（非 AppKit）：[role="dialog"] 标题
 *   "Log in or sign up with Social + Petra Web"，Aptos/Solana/Ethereum 标签 + Connect 按钮
 *   （Aptos 标签默认激活 = Petra 入口）；点 Connect 后本窗口静默连接完成登录（扩展已授权，
 *   无钱包弹窗）——登录态判定靠 header 出现 0x 地址按钮，不能用全页 0x 文案（首页表格全是 0x）
 *   高并发/慢代理下弹窗渲染慢：真机批量实测窗口 91 首跑弹窗 >15s 未渲染、窗口 33 两轮 30s 均未出
 *   ——等弹窗改为 45s 预算 + Connect 按钮仍可见即补点（点击未注册自愈，遮罩已出现不补点防误关）
 *   登录态不跨浏览器会话（sessionStorage）：每次开窗均为未登录；会话恢复靠站点自身 + 周期刷新
 *   上传入口在账号页 https://explorer.shelby.xyz/shelbynet/account/<petra钱包地址>/blobs
 *   的 Upload Files 按钮（点 header 地址是下拉菜单，无上传入口）
 *   上传弹窗：隐藏 input[type="file"]（class=hidden，setInputFiles 可用）+ 拖拽区；
 *   选文件后显示 1 chunkset + 费用明细，Upload 按钮才启用
 *   选文件后站点立即做 blob 名查重（真机核实 2026-09-07）：已上传的文件弹窗内直接显示
 *   Error: Blob name already taken 且 Upload 按钮永不启用、也不发起签名 → 短路视为成功（不点 Upload）
 *   未上传过才启用 Upload：点后两次 Petra prompt.html 签名弹窗先后出现：第一次可能锁屏
 *   （输密码 + Unlock → Approve，register_multiple_blobs），第二次直接 Approve（commit_object）；
 *   钱包网络已是 Shelbynet，无需切链步骤
 *   成功判定：弹窗出现 All files uploaded successfully（Uploaded 1 file to the Shelby network.）
 *   文件一次性（blob name 唯一）：重复上传报 Blob name already taken，视为成功幂等收敛
 *   截图等字体加载偶发超时（真机实测）：失败只告警不判任务失败
 */
import { SiteTask, TaskContext, type TaskMeta } from './base'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '../infrastructure/constants'

// —— 站点元素（真机核实）——
/** 已登录标志：header 出现 0x 开头地址按钮（首页表格全是 0x 文案，必须 header 范围限定） */
const ADDRESS_SELECTOR = 'header button:has-text("0x")'
/** 未登录 header 按钮 */
const CONNECT_SELECTOR = 'header button:has-text("Connect Wallet")'
/** 站内钱包弹窗（Petra Web / Aptos Labs） */
const DIALOG_SELECTOR = '[role="dialog"]'
/** 弹窗内 Connect 按钮（Aptos 标签默认激活 = Petra 入口） */
const DIALOG_CONNECT_SELECTOR = '[role="dialog"] button:has-text("Connect")'
/** 账号页上传入口按钮 */
const UPLOAD_FILES_SELECTOR = 'button:has-text("Upload Files")'
/** 上传弹窗隐藏 file input（拖拽区背后的隐藏输入，setInputFiles 可用） */
const FILE_INPUT_SELECTOR = '[role="dialog"] input[type="file"]'
/** 上传弹窗 Upload 按钮（选文件后才启用） */
const UPLOAD_BUTTON_SELECTOR = '[role="dialog"] button:has-text("Upload")'
/** 上传中弹窗文案（上传中不刷新页面，防打断在途请求） */
const UPLOADING_TEXT = 'Uploading files'
/** 成功判定文案 */
const SUCCESS_TEXT = 'All files uploaded successfully'
/** 已上传判定文案（文件 blob name 唯一，重复上传即报此错误，视为成功幂等收敛） */
export const ALREADY_DONE_TEXT = 'Blob name already taken'
/** 可恢复错误文案（刷新恢复，沿用 portal-rhuna 真机经验） */
const RECOVER_ERROR_TEXTS = ['Network Error', 'Turnstile token request timed out']

// —— 时间配置（真机实测校准）——
/** 登录态竞速首轮等待（SPA 渲染有延迟，真机经验放宽到 20s） */
const STATE_WAIT_MS = 20000
/** 登录态竞速刷新轮数与轮等待（状态不明时反复刷新，已登录窗口刷新后走已登录分支；每轮刷新打日志，静默卡死可定位） */
const STATE_ROUNDS = 4
const STATE_ROUND_WAIT_MS = 10000
/** 登录完成等待预算（header 0x 地址出现，真机 30-60s，放宽到 120s） */
const LOGIN_WAIT_MS = 120000
/** 账号页登录态恢复等待预算（会话恢复真机 30-90s，放宽到 120s） */
const UPLOAD_ENTRY_WAIT_MS = 120000
/** 选文件后等 Upload 按钮启用 / 已上传提示出现预算（真机实测几秒；测试覆盖缩短） */
const UPLOAD_ENABLED_WAIT_MS = 30000
/** 周期刷新间隔（登录态/会话恢复卡住时刷新兜底） */
const REFRESH_EVERY_MS = 30000

export class ShelbyExplorerTask extends SiteTask {
  /** 上传成功等待预算毫秒（测试覆盖缩短；上传大文件 + 双签名耗时，放宽到 180s） */
  successWaitMs = 180000

  /** 登录完成等待预算毫秒（测试覆盖缩短；真机 30-60s） */
  loginWaitMs = LOGIN_WAIT_MS

  /** 账号页登录态恢复等待预算毫秒（测试覆盖缩短；真机 30-90s） */
  uploadEntryWaitMs = UPLOAD_ENTRY_WAIT_MS

  /** 选文件后终态分叉等待预算毫秒（测试覆盖缩短） */
  uploadEnabledWaitMs = UPLOAD_ENABLED_WAIT_MS

  /** 上传弹窗 file input 挂载等待预算毫秒（测试覆盖缩短） */
  uploadDialogWaitMs = 20000

  /** 站内钱包弹窗出现等待预算毫秒（真机批量实测：高并发/慢代理下渲染可 >30s，窗口 33 两轮 30s 均未出） */
  walletDialogWaitMs = 45000

  /** 弹窗未出现且 Connect 按钮仍可见时的补点间隔毫秒（点击未注册场景自愈；测试覆盖缩短为 0） */
  walletDialogReclickMs = 8000

  /** 站点根地址（集成测试覆盖为本地 fixture 服务） */
  accountBaseUrl = 'https://explorer.shelby.xyz'

  meta: TaskMeta = {
    key: 'xyz-shelbynet',
    name: 'shelbynet 上传任务',
    url: 'https://explorer.shelby.xyz/shelbynet',
    sourceUrl: 'https://cryptorank.io/zh/drophunting/shelby-activity1120',
    note: '真机核实（2026-09-07）：站内钱包弹窗为 Petra Web（Aptos Labs）自定义弹窗非 AppKit，点弹窗内 Connect（Aptos 标签默认=Petra 入口）后静默连接登录（扩展已授权无钱包弹窗），登录结果以 header 0x 地址按钮为准（首页表格全是 0x 文案，不能用全页文本判定）；登录态不跨浏览器会话，每次开窗重新登录；上传入口在账号页 /shelbynet/account/<petra钱包地址>/blobs 的 Upload Files 按钮（点 header 地址是下拉菜单）；上传弹窗 file input 为隐藏元素（setInputFiles 可用）；选文件后站点立即做 blob 名查重（真机核实 2026-09-07）：已上传 → 弹窗内直接显示 Error: Blob name already taken 且 Upload 按钮永不启用、无签名弹窗 → 短路视为成功（不点 Upload）；未上传 → chunkset 结算渲染后 Upload 按钮才启用，点后两次 prompt.html 签名弹窗先后出现（第一次可能锁屏输密码+Unlock→Approve，第二次直接 Approve），钱包网络已是 Shelbynet 无需切链；成功判定 All files uploaded successfully；文件一次性（blob name 唯一）：重复上传报 Blob name already taken 视为成功；上传文件取自数据源「文件地址」列、账号页地址取自「petra钱包地址」列（严格模式，缺列/空值即失败）；上传中不刷新防打断在途请求；成功截图等字体加载偶发超时已非致命化',
    category: 'checkin',
    lastUpdated: '2026-09-07',
    enabled: true,
    wallet: 'petra',
    // 静默连接 + 会话恢复慢（真机 30-90s）+ 上传大文件 + 双签名；真机最慢完整路径约 4min，
    // 600s 足够覆盖；卡死窗口（代理/会话坏）占并发槽时间从 15min 压到 10min
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 60 },
    captcha: { auto: true },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    // 开始前清理：关闭其它标签页（上次会话残留），再从干净状态打开任务网址
    await ctx.closeOtherTabs()
    await ctx.goto()

    // 登录状态竞速判定：header 范围选择器（首页表格大量 0x 文案，全页文本判定必误判）；
    // SPA 渲染有延迟，状态不明时反复刷新（每轮两种状态都认）
    const state = await this.detectHeaderState(ctx)
    if (state === 'landing') {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '未登录，进入 Petra 登录流程')
      await this.login(ctx)
    } else {
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '已登录（会话有效），跳过登录')
    }

    await this.upload(ctx)
  }

  /** 登录态竞速：header 地址按钮 / Connect Wallet 按钮谁先可见；都不出现则刷新重试 */
  private async detectHeaderState(ctx: TaskContext): Promise<'loggedIn' | 'landing'> {
    const race = async (ms: number): Promise<'loggedIn' | 'landing' | null> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await ctx.visible(ADDRESS_SELECTOR)) return 'loggedIn'
        if (await ctx.visible(CONNECT_SELECTOR)) return 'landing'
        await ctx.page.waitForTimeout(1000)
      }
      return null
    }
    let state = await race(STATE_WAIT_MS)
    for (let i = 0; i < STATE_ROUNDS && !state; i++) {
      ctx.log.info({ step: 'recover', window: ctx.profile.name, round: i + 1 }, '登录态未判定，刷新页面重试')
      await ctx.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      state = await race(STATE_ROUND_WAIT_MS)
    }
    if (!state) throw new Error('多次刷新后 header 仍未出现钱包地址或 Connect Wallet（网络异常）')
    return state
  }

  /**
   * Petra 登录：Connect Wallet → 站内弹窗点 Connect（Aptos 标签 = Petra 入口）→ 等 header 0x 出现
   * 真机核实：本窗口扩展已授权，点 Connect 后静默连接（无钱包弹窗）——弹窗未出现不视为失败；
   * 登录结果以 header 0x 地址为准
   */
  private async login(ctx: TaskContext): Promise<void> {
    await ctx.ensureWalletReady()
    await ctx.human.click(CONNECT_SELECTOR)
    // 等站内钱包弹窗（真机批量实测：高并发/慢代理下渲染可 >30s）：
    // Connect 按钮仍可见（弹窗遮罩未出现）说明点击未注册 → 定期补点；
    // 遮罩已出现则绝不补点（避免误点遮罩关掉已开弹窗）
    const end = Date.now() + this.walletDialogWaitMs
    let lastReclick = 0
    while (Date.now() < end) {
      if (await ctx.visible(DIALOG_SELECTOR)) break
      if (Date.now() - lastReclick >= this.walletDialogReclickMs && (await ctx.visible(CONNECT_SELECTOR))) {
        await ctx.human.click(CONNECT_SELECTOR).catch(() => {})
        lastReclick = Date.now()
      }
      await ctx.page.waitForTimeout(2000)
    }
    if (!(await ctx.visible(DIALOG_SELECTOR))) {
      throw new Error('点击 Connect Wallet 后钱包弹窗未出现（渲染慢或点击未注册）')
    }
    await ctx.human.click(DIALOG_CONNECT_SELECTOR)
    try {
      await ctx.loginByWallet({ reclick: { selector: DIALOG_CONNECT_SELECTOR, afterMs: 8000 } })
    } catch (e) {
      if (!(e as Error).message.includes('钱包弹窗未出现')) throw e
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '钱包弹窗未出现（静默连接），等待登录完成')
    }
    if (!(await this.waitForSelectorRecover(ctx, ADDRESS_SELECTOR, this.loginWaitMs))) {
      throw new Error('钱包连接后登录未完成（等待 header 0x 地址出现超时，站点登录接口慢或该窗口账号异常）')
    }
  }

  /** 上传流程：账号页 → Upload Files → 选文件 → （已上传短路视为成功 | Upload → 双签名）→ 等成功文案 */
  private async upload(ctx: TaskContext): Promise<void> {
    const address = await ctx.account('petra钱包地址')
    const accountUrl = `${this.accountBaseUrl}/shelbynet/account/${address}/blobs`
    await ctx.goto(accountUrl)
    // 等账号页登录态恢复（Upload Files 出现）；会话恢复慢（真机 30-90s），期间周期刷新
    if (!(await this.waitForSelectorRecover(ctx, UPLOAD_FILES_SELECTOR, this.uploadEntryWaitMs))) {
      // 会话恢复失败（首次连接/扩展重启）：在账号页上重新登录后重等
      ctx.log.info({ step: 'login', window: ctx.profile.name }, '账号页会话未恢复，重新登录')
      await this.login(ctx)
      await ctx.goto(accountUrl)
      if (!(await this.waitForSelectorRecover(ctx, UPLOAD_FILES_SELECTOR, this.uploadEntryWaitMs))) {
        throw new Error('账号页未出现 Upload Files（页面改版或登录态未恢复）')
      }
    }
    // 点 Upload Files 打开上传弹窗（SPA 渲染未稳点击可能落空，最多 2 轮补点）
    // 注意：file input 为隐藏元素（display:none），不能用可见性判定，只能判 DOM 挂载
    let inputAttached = false
    for (let round = 0; round < 2 && !inputAttached; round++) {
      if (round > 0) ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传弹窗未出现，补点 Upload Files')
      await ctx.human.click(UPLOAD_FILES_SELECTOR).catch(() => {})
      inputAttached = await this.waitAttached(ctx, FILE_INPUT_SELECTOR, this.uploadDialogWaitMs)
    }
    if (!inputAttached) {
      throw new Error('上传弹窗未出现 file input（弹窗结构异常或点击落空）')
    }
    await ctx.uploadFile(FILE_INPUT_SELECTOR, await ctx.account('文件地址'))
    // 选文件后终态分叉（真机核实 2026-09-07）：站点立即做 blob 名查重——
    // 已上传：弹窗内直接显示 Error: Blob name already taken 且 Upload 按钮永不启用
    // （不发起签名）→ 无需点击，直接视为成功幂等收敛；
    // 未上传：chunkset 结算渲染后 Upload 按钮启用 → 走上传 + 双签名流程
    const settle = await this.waitSettle(ctx)
    if (settle === 'alreadyDone') {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '文件已上传过（Blob name already taken），视为成功')
      await this.safeScreenshot(ctx)
      return
    }
    await ctx.human.click(UPLOAD_BUTTON_SELECTOR)
    // 双钱包签名：register_multiple_blobs → commit_object（真机核实两次 prompt.html 弹窗先后出现；
    // 第一个可能锁屏：Petra 适配器自动输密码 + Unlock 后点 Approve）
    // 弹窗未出现容忍：上传途中服务端查重报已上传时站点可能不再发起签名请求，
    // 弹窗不出现不能提前判失败——终态交给 waitSuccess 裁定（幂等收敛路径可达）
    for (let i = 0; i < 2; i++) {
      try {
        await ctx.loginByWallet()
      } catch (e) {
        if (!(e as Error).message.includes('钱包弹窗未出现')) throw e
        ctx.log.info({ step: 'upload', window: ctx.profile.name }, '钱包弹窗未出现（可能文件已上传不再发起签名），继续等待终态')
      }
    }
    const outcome = await this.waitSuccess(ctx)
    if (outcome === 'alreadyDone') {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '文件已上传过（Blob name already taken），视为成功')
    } else {
      ctx.log.info({ step: 'upload', window: ctx.profile.name }, '上传完成（All files uploaded successfully）')
    }
    await this.safeScreenshot(ctx)
  }

  /** 成功截图：字体加载偶发超时只告警（真机实测），不判任务失败 */
  private async safeScreenshot(ctx: TaskContext): Promise<void> {
    try {
      await ctx.screenshot('shelby-explorer-success')
    } catch (e) {
      ctx.log.warn({ step: 'upload', window: ctx.profile.name, err: (e as Error).message }, '成功截图失败（不影响任务结果）')
    }
  }

  /**
   * 选文件后等终态分叉（真机核实 2026-09-07）：
   * 已上传 → 弹窗内出现 Error: Blob name already taken（Upload 按钮永不启用）→ 'alreadyDone'
   * 未上传 → chunkset 结算渲染后 Upload 按钮启用 → 'enabled'
   * 预算内两者都没出现 → 抛错（文件过大或上传弹窗状态异常）
   */
  private async waitSettle(ctx: TaskContext): Promise<'alreadyDone' | 'enabled'> {
    const end = Date.now() + this.uploadEnabledWaitMs
    while (Date.now() < end) {
      if (await ctx.textPresent(ALREADY_DONE_TEXT)) return 'alreadyDone'
      const disabled = await ctx.page.locator(UPLOAD_BUTTON_SELECTOR).first().isDisabled().catch(() => true)
      if (!disabled) return 'enabled'
      await ctx.page.waitForTimeout(1000)
    }
    throw new Error('选文件后 Upload 按钮未启用且无已上传提示（文件过大或上传弹窗状态异常）')
  }

  /** 等元素挂载（DOM 存在即可；hidden 的 file input 不能用可见性判定） */
  private async waitAttached(ctx: TaskContext, selector: string, budgetMs: number): Promise<boolean> {
    const end = Date.now() + budgetMs
    while (Date.now() < end) {
      const n = await ctx.page.locator(selector).count().catch(() => 0)
      if (n > 0) return true
      await ctx.page.waitForTimeout(1000)
    }
    return false
  }

  /**
   * 等选择器可见（刷新恢复导向）：可恢复错误文案立即刷新 + 每 30s 周期刷新
   * （站点会话恢复慢/页面 JS 状态坏了刷新即恢复）
   * @returns 预算内可见 true / 超时 false
   */
  private async waitForSelectorRecover(ctx: TaskContext, selector: string, budgetMs: number): Promise<boolean> {
    const end = Date.now() + budgetMs
    let lastRefresh = Date.now()
    while (Date.now() < end) {
      if (await ctx.visible(selector)) return true
      const stale = Date.now() - lastRefresh >= REFRESH_EVERY_MS
      const errText = await ctx.recoverErrorText(RECOVER_ERROR_TEXTS)
      if (stale || errText !== '') {
        ctx.log.info({ step: 'recover', window: ctx.profile.name, errText }, '刷新页面恢复（错误提示或周期刷新）')
        await ctx.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
        await ctx.page.waitForTimeout(5000)
        lastRefresh = Date.now()
        continue
      }
      await ctx.page.waitForTimeout(3000)
    }
    return false
  }

  /**
   * 等终态：新上传成功 / 已上传过（Blob name already taken，同样算成功）/
   * 可恢复错误且不在上传中才刷新（上传中刷新会打断在途请求）
   */
  private async waitSuccess(ctx: TaskContext): Promise<'uploaded' | 'alreadyDone'> {
    const end = Date.now() + this.successWaitMs
    while (Date.now() < end) {
      if (await ctx.textPresent(SUCCESS_TEXT)) return 'uploaded'
      if (await ctx.textPresent(ALREADY_DONE_TEXT)) return 'alreadyDone'
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
    throw new Error(`上传未完成（等待 ${SUCCESS_TEXT} 或 ${ALREADY_DONE_TEXT} 超时）`)
  }
}

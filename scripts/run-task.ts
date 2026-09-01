/**
 * 单窗口单任务调试脚本：只开一个窗口、只跑指定任务、打印结果后退出
 * 用法: BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run
 * 适用场景：任务开发时在真实环境快速验证（比面板全量触发轻量）
 */
import { loadConfig } from '../src/infrastructure/config'
import { createLogger } from '../src/infrastructure/logger'
import { AppDb, todayStr } from '../src/infrastructure/db'
import { DataSource } from '../src/infrastructure/datasource'
import { createBitBrowserClient } from '../src/integrations/bitbrowser'
import { YesCaptchaClient, CaptchaService } from '../src/integrations/yescaptcha'
import { WalletRegistry } from '../src/automation/wallet/types'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { PetraAdapter } from '../src/automation/wallet/petra'
import { PatchrightDriver, WindowRunner } from '../src/engine/window-runner'
import { loadTasks } from '../src/tasks'

async function main(): Promise<void> {
  const profileId = process.env.BITBROWSER_PROFILE_ID
  const taskKey = process.env.TASK_KEY
  if (!profileId || !taskKey) {
    console.error('用法: BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run')
    process.exit(1)
  }
  const cfg = loadConfig()
  const logger = createLogger(cfg)
  const tasks = loadTasks()
  if (!tasks.has(taskKey)) {
    console.error(`任务未注册: ${taskKey}（可用: ${[...tasks.keys()].join(', ')}）`)
    process.exit(1)
  }
  if (!cfg.cloud.url) {
    console.error('未配置 TURSO_DATABASE_URL（请在 config/.env 或 config/config.json 的 cloud 段配置云数据库地址）')
    process.exit(1)
  }
  const db = await AppDb.open(cfg.cloud)
  const bitbrowser = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })
  // 数据源（与 app.ts 同逻辑就地建）：不可用仅告警，任务以 faker 兜底
  const datasource = new DataSource()
  await datasource.load(cfg.dataSource.path)
  if (!datasource.available) logger.warn({ path: cfg.dataSource.path, err: datasource.error }, '数据源不可用，任务将以 faker 兜底')
  const wallets = new WalletRegistry()
  wallets.register(new MetaMaskAdapter())
  wallets.register(new PetraAdapter())
  const yescaptcha = new YesCaptchaClient(
    { apiBase: cfg.captcha.apiBase, clientKey: cfg.captcha.clientKey, solveTimeoutMs: cfg.captcha.solveTimeoutMs, pollIntervalMs: cfg.captcha.pollIntervalMs },
    cfg.captcha.taskTypes,
  )
  const captcha = cfg.captcha.clientKey ? new CaptchaService(yescaptcha, { maxCostPerTask: cfg.captcha.maxCostPerTask }) : null
  let runner!: WindowRunner
  // 本轮会话的复用目标（open_windows 登记 + pid 实测存活才复用）；闭包捕获，重试会话每次重新探测
  let reuse: { http: string } | null = null
  /** 单次运行：跑完查记录打印结果；终态时关库退出，retry_wait 时保持存活等重试定时器 */
  const runOnce = async (): Promise<void> => {
    // 复用探测：表里有登记且比特浏览器实测 pid 存活 → 复用（runner 内不重开、结束不关窗）；
    // 登记残留但 pid 已死 → 清行后按正常开窗流程走
    const row = await db.getOpenWindow(profileId).catch(() => null)
    const wasOpen = row ? await bitbrowser.isOpen(profileId) : false
    reuse = row && wasOpen ? { http: row.http } : null
    if (row && !wasOpen) await db.clearOpenWindow(profileId).catch(() => {})
    await runner.runManual(profileId, taskKey)
    // 取当前窗口当前任务的最新一轮记录（只按 taskKey 找会拿到别的窗口的行，误导排障）
    const prof = (await db.listProfiles(false)).find(p => p.bitbrowserId === profileId)
    const row2 = prof
      ? [...(await db.listRunsForDate(todayStr()))].reverse().find(r => r.taskKey === taskKey && r.profileId === prof.id)
      : undefined
    if (row2) {
      logger.info({ status: row2.status, error: row2.error, screenshot: row2.screenshot }, '任务运行结果')
    } else {
      logger.error('未找到运行记录')
    }
    if (!row2 || row2.status !== 'retry_wait') {
      process.exitCode = row2 && row2.status === 'success' ? 0 : 1
      db.close()
    } else {
      logger.info({ taskKey }, '任务待重试，脚本保持存活等待退避到期')
    }
  }
  runner = new WindowRunner({
    cfg, db, bitbrowser, driver: new PatchrightDriver(), tasks, wallets, captcha, logger, artifactsDir: cfg.storage.screenshotDir, walletPasswords: cfg.wallet.passwords,
    // 窗口复用：面板已打开的窗口直接接管（不复用则正常开新窗并在会话结束后关闭）
    reuseOpen: () => Promise.resolve(reuse),
    // 数据源行解析：与 app.ts 同逻辑（有窗口列按名匹配，无窗口列按窗口列表顺序取行）
    accountResolver: async (profile) => {
      if (!datasource.available) return null
      const row = datasource.rowFor(profile, await db.listProfiles(false))
      return row ? { ...row.values } : null
    },
    // 脚本场景无队列：退避到期直接重跑该任务（定时器不 unref，保持进程存活等待重试）
    scheduleRetry: (profile, taskKey, delayMs) => {
      setTimeout(() => { void runOnce().catch((e) => { console.error((e as Error).message); process.exit(1) }) }, delayMs)
    },
  })
  logger.info({ profileId, taskKey }, '开始单任务调试运行')
  await runOnce()
}

void main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})

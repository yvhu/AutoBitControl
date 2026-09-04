/**
 * 单窗口单任务调试脚本：只开一个窗口、只跑指定任务、打印结果后退出
 * 用法: BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run
 * 适用场景：任务开发时在真实环境快速验证（比面板全量触发轻量）
 */
import { loadConfig } from '../src/infrastructure/config'
import { createLogger } from '../src/infrastructure/logger'
import { AppDb } from '../src/infrastructure/db'
import { DataSource } from '../src/infrastructure/datasource'
import { createBitBrowserClient } from '../src/integrations/bitbrowser'
import { YesCaptchaClient, CaptchaService } from '../src/integrations/yescaptcha'
import { WalletRegistry } from '../src/automation/wallet/types'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { PetraAdapter } from '../src/automation/wallet/petra'
import { PatchrightDriver, WindowRunner } from '../src/engine/window-runner'
import { loadTasks } from '../src/tasks'

// 进程级兜底：浏览器窗口中途被关闭/崩溃时，patchright 内部协议错误（如
// Network.setCacheDisabled session closed）可能以未捕获异常/拒绝形式逃逸——
// 兜底日志化退出（退出码 1），避免裸栈崩溃；任务行停留在 running，重新触发可续跑
process.on('uncaughtException', (err) => {
  console.error(`未捕获异常，脚本退出: ${(err as Error).message}`)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  console.error(`未处理的 Promise 拒绝，脚本退出: ${(err as Error).message}`)
  process.exit(1)
})

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
  // 本脚本运行产生的批次：首次运行时创建，重试（retry_wait 到期后 scheduleRetry 重跑）沿用同一批次
  let lastBatchId: number | null = null
  // 本轮会话的复用目标（open_windows 登记 + pid 实测存活才复用）；闭包捕获，重试会话每次重新探测
  let reuse: { http: string } | null = null
  // 数据库关闭标记：终态后关库，防止重试定时器触发时访问已关闭的连接（今早实测崩溃场景）
  let dbClosed = false
  /** 单次运行：跑完用 runner 内存返回的结果行判定终态；retry_wait 时保持存活等重试定时器 */
  const runOnce = async (): Promise<void> => {
    // 复用探测：表里有登记且比特浏览器实测 pid 存活 → 复用（runner 内不重开、结束不关窗）；
    // 登记残留但 pid 已死 → 清行后按正常开窗流程走
    const row = await db.getOpenWindow(profileId).catch(() => null)
    const wasOpen = row ? await bitbrowser.isOpen(profileId) : false
    reuse = row && wasOpen ? { http: row.http } : null
    if (row && !wasOpen) await db.clearOpenWindow(profileId).catch(() => {})
    // runManual 直接返回本轮最终运行行（内存传递，不做执行后再读库的竞态判定）
    if (lastBatchId === null) {
      lastBatchId = (await db.createBatch('single', taskKey, 'task-run')).id
    }
    const row2 = await runner.runManual(profileId, taskKey, lastBatchId)
    if (row2) {
      logger.info({ status: row2.status, error: row2.error, screenshot: row2.screenshot }, '任务运行结果')
    } else {
      logger.error('未找到运行记录')
    }
    if (!row2 || row2.status !== 'retry_wait') {
      process.exitCode = row2 && row2.status === 'success' ? 0 : 1
      dbClosed = true
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
      setTimeout(() => {
        if (dbClosed) {
          console.error('数据库已关闭，无法执行重试（状态异常）')
          process.exit(1)
          return
        }
        void runOnce().catch((e) => { console.error((e as Error).message); process.exit(1) })
      }, delayMs)
    },
  })
  logger.info({ profileId, taskKey }, '开始单任务调试运行')
  await runOnce()
}

void main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})

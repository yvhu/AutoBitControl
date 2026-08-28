/**
 * 单窗口单任务调试脚本：只开一个窗口、只跑指定任务、打印结果后退出
 * 用法: BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run
 * 适用场景：任务开发时在真实环境快速验证（比面板全量触发轻量）
 */
import { loadConfig } from '../src/infrastructure/config'
import { createLogger } from '../src/infrastructure/logger'
import { AppDb, todayStr } from '../src/infrastructure/db'
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
  const db = AppDb.open(cfg.storage.dbPath)
  const bitbrowser = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })
  const tasks = loadTasks()
  if (!tasks.has(taskKey)) {
    console.error(`任务未注册: ${taskKey}（可用: ${[...tasks.keys()].join(', ')}）`)
    process.exit(1)
  }
  const wallets = new WalletRegistry()
  wallets.register(new MetaMaskAdapter())
  wallets.register(new PetraAdapter())
  const yescaptcha = new YesCaptchaClient(
    { apiBase: cfg.captcha.apiBase, clientKey: cfg.captcha.clientKey, solveTimeoutMs: cfg.captcha.solveTimeoutMs, pollIntervalMs: cfg.captcha.pollIntervalMs },
    cfg.captcha.taskTypes,
  )
  const captcha = cfg.captcha.clientKey ? new CaptchaService(yescaptcha, { maxCostPerTask: cfg.captcha.maxCostPerTask }) : null
  const runner = new WindowRunner({ cfg, db, bitbrowser, driver: new PatchrightDriver(), tasks, wallets, captcha, logger, artifactsDir: cfg.storage.screenshotDir })
  logger.info({ profileId, taskKey }, '开始单任务调试运行')
  await runner.runManual(profileId, taskKey)
  const row = db.listRunsForDate(todayStr()).find(r => r.taskKey === taskKey)
  if (row) {
    logger.info({ status: row.status, error: row.error, screenshot: row.screenshot }, '任务运行结果')
  } else {
    logger.error('未找到运行记录')
  }
  db.close()
  process.exit(row && row.status === 'success' ? 0 : 1)
}

void main()

/**
 * 应用装配（顶层）：startApp 按依赖顺序组装全部模块并启动
 * 依赖方向：顶层依赖所有层，仅被 index.ts 调用（唯一的组装点，compose root）
 * 装配顺序即依赖顺序：配置/日志 → 数据库 → 比特浏览器同步 → 任务/钱包/打码 →
 * 执行器/队列 → Web 服务 → 调度器
 */
import { loadConfig } from './infrastructure/config'
import { createLogger } from './infrastructure/logger'
import { AppDb } from './infrastructure/db'
import { createBitBrowserClient } from './integrations/bitbrowser'
import { PatchrightDriver, WindowRunner } from './engine/window-runner'
import { TaskQueue, CoalescingEnqueuer } from './engine/queue'
import { Scheduler } from './engine/scheduler'
import { YesCaptchaClient, CaptchaService } from './integrations/yescaptcha'
import { WalletRegistry } from './automation/wallet/types'
import { MetaMaskAdapter } from './automation/wallet/metamask'
import { PetraAdapter } from './automation/wallet/petra'
import { loadTasks } from './tasks'
import { createApp } from './server/app'

export async function startApp(): Promise<void> {
  const cfg = loadConfig()
  const logger = createLogger(cfg)

  // 快速失败策略：未捕获异常直接退出（挂着的半死进程比重启更危险）
  process.on('uncaughtException', (err) => {
    logger.error({ err }, '未捕获异常，进程退出')
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, '未处理的 Promise 拒绝，进程退出')
    process.exit(1)
  })

  const db = AppDb.open(cfg.storage.dbPath)
  const bitbrowser = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })

  // 启动时同步窗口列表到 profiles 表（未就绪仅告警，不阻塞启动）
  try {
    const healthy = await bitbrowser.health()
    if (!healthy) {
      logger.warn('比特浏览器本地 API 未就绪（请确认比特浏览器已登录且 API 地址正确）')
    } else {
      const list = await bitbrowser.listBrowsers(0, 100)
      for (const b of list) db.upsertProfile(b.id, b.name)
      logger.info({ count: list.length }, '已同步比特浏览器窗口列表')
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '同步窗口列表失败（请确认比特浏览器已启动）')
  }

  const tasks = loadTasks()
  const wallets = new WalletRegistry()
  wallets.register(new MetaMaskAdapter())
  wallets.register(new PetraAdapter())

  const yescaptcha = new YesCaptchaClient(
    { apiBase: cfg.captcha.apiBase, clientKey: cfg.captcha.clientKey, solveTimeoutMs: cfg.captcha.solveTimeoutMs, pollIntervalMs: cfg.captcha.pollIntervalMs },
    cfg.captcha.taskTypes,
  )
  // clientKey 未配置时 captcha 为 null：任务侧 solveCaptcha 直接返回 none，无 Key 也能跑
  const captcha = cfg.captcha.clientKey
    ? new CaptchaService(yescaptcha, { maxCostPerTask: cfg.captcha.maxCostPerTask })
    : null

  // enqueuer 后置声明：runner 的 scheduleRetry 闭包引用它（重试到期重新入队），
  // 二者互相依赖（enqueuer 需要 runner），先声明变量再在下方赋值
  let enqueuer!: CoalescingEnqueuer
  const runner = new WindowRunner({
    cfg,
    db,
    bitbrowser,
    driver: new PatchrightDriver(),
    tasks,
    wallets,
    captcha,
    logger,
    artifactsDir: cfg.storage.screenshotDir,
    walletPasswords: cfg.wallet.passwords,
    // 重试不占窗：退避到期后重新入队（新一轮窗口会话），当前窗口正常继续/关窗
    scheduleRetry: (profile, taskKey, delayMs) => {
      setTimeout(() => enqueuer.enqueue(profile, taskKey), delayMs)
    },
  })
  const queue = new TaskQueue(cfg.execution.concurrency)
  enqueuer = new CoalescingEnqueuer(queue, runner, logger)

  const app = createApp({
    db,
    enqueuer,
    tasks,
    cfg,
    logger,
    bitbrowser,
    // 余额查询失败返回 null → 面板显示"未配置 Key"（容错优先，不打挂面板；getBalance 失败即异常路径）
    captchaBalance: async () => {
      try {
        return { points: await yescaptcha.getBalance() }
      } catch {
        return null
      }
    },
  })
  // 保存 http server 引用：优雅退出时先 close（等待存量连接结束），再关数据库退出
  const server = app.listen(cfg.web.port, cfg.web.host, () => {
    logger.info({ url: `http://${cfg.web.host}:${cfg.web.port}` }, 'Web 面板已启动')
  })

  const scheduler = new Scheduler(cfg, db, tasks, enqueuer, logger)
  scheduler.start()

  // 优雅退出：先停调度器 → server.close（回调中关库退出）→ 3 秒强制兜底（keep-alive 连接挂着时不阻塞退出）
  let finishing = false
  const finish = () => {
    if (finishing) return
    finishing = true
    try {
      db.close()
    } catch {
      // 兜底与回调竞争时可能已关闭，忽略
    }
    process.exit(0)
  }
  const shutdown = () => {
    logger.info('正在关闭...')
    scheduler.stop()
    server.close(() => finish())
    // 强制退出兜底：3 秒内未优雅关闭则直接收尾（unref 保证不阻止进程自然退出）
    setTimeout(finish, 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

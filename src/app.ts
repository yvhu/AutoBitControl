/**
 * 应用装配（顶层）：startApp 按依赖顺序组装全部模块并启动
 * 依赖方向：顶层依赖所有层，仅被 index.ts 调用（唯一的组装点，compose root）
 * 装配顺序即依赖顺序：配置/日志 → 数据库 → 比特浏览器同步 → 任务/钱包/打码 →
 * 执行器/队列 → Web 服务 → 调度器
 */
import { loadConfig } from './infrastructure/config'
import { createLogger } from './infrastructure/logger'
import { AppDb } from './infrastructure/db'
import { DataSource } from './infrastructure/datasource'
import { createBitBrowserClient, type BitBrowserClient } from './integrations/bitbrowser'
import { PatchrightDriver, WindowRunner } from './engine/window-runner'
import { TaskQueue, CoalescingEnqueuer } from './engine/queue'
import { Scheduler } from './engine/scheduler'
import { YesCaptchaClient, CaptchaService } from './integrations/yescaptcha'
import { WalletRegistry } from './automation/wallet/types'
import { MetaMaskAdapter } from './automation/wallet/metamask'
import { PetraAdapter } from './automation/wallet/petra'
import { loadTasks } from './tasks'
import { createApp } from './server/app'

/**
 * 分页同步比特浏览器窗口列表到 profiles 表（每页 100，page 从 0 起）
 * 返回同步总数；供面板"同步"按钮与启动同步两处复用
 */
async function syncBrowsersPaged(bitbrowser: BitBrowserClient, db: AppDb): Promise<number> {
  let page = 0
  let total = 0
  while (true) {
    const list = await bitbrowser.listBrowsers(page, 100)
    for (const b of list) await db.upsertProfile(b.id, b.name)
    total += list.length
    if (list.length < 100) break
    page++
  }
  return total
}

/**
 * 面板依赖的比特浏览器适配：health 探活 + sync 窗口列表同步 + 开窗/关窗/打开状态探测
 * 独立导出便于测试（sync 闭包持有 db 做 upsert，路由层不直接依赖 db）
 */
export function buildBitbrowserDeps(bitbrowser: BitBrowserClient, db: AppDb): {
  health(): Promise<boolean>
  sync(): Promise<number>
  openBrowser(id: string): Promise<{ http: string; ws: string }>
  closeBrowser(id: string): Promise<void>
  isOpen(id: string): Promise<boolean>
  openPids(ids: string[]): Promise<Set<string>>
} {
  return {
    health: () => bitbrowser.health(),
    // 同步窗口列表到 profiles 表（面板"同步比特浏览器"按钮入口；失败向上抛由统一错误处理器转 500）
    sync: () => syncBrowsersPaged(bitbrowser, db),
    // 打开/关闭与 pid 探测直接透传真实客户端（窗口路由用）
    openBrowser: (id) => bitbrowser.openBrowser(id),
    closeBrowser: (id) => bitbrowser.closeBrowser(id),
    isOpen: (id) => bitbrowser.isOpen(id),
    openPids: (ids) => bitbrowser.openPids(ids),
  }
}

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

  // 云数据库未配置即快速失败：数据层全部走云端，无 url 无法运行
  if (!cfg.cloud.url) {
    logger.error('未配置 TURSO_DATABASE_URL（请在 config/.env 或 config/config.json 的 cloud 段配置云数据库地址）')
    process.exit(1)
  }
  let db: AppDb
  try {
    db = await AppDb.open(cfg.cloud)
  } catch (e) {
    logger.error({ err: (e as Error).message }, '云数据库连接失败（请检查 TURSO_DATABASE_URL/TURSO_AUTH_TOKEN 与网络）')
    process.exit(1)
  }
  const bitbrowser = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })

  // 启动时同步窗口列表到 profiles 表（未就绪仅告警，不阻塞启动）
  try {
    const healthy = await bitbrowser.health()
    if (!healthy) {
      logger.warn('比特浏览器本地 API 未就绪（请确认比特浏览器已登录且 API 地址正确）')
    } else {
      const count = await syncBrowsersPaged(bitbrowser, db)
      logger.info({ count }, '已同步比特浏览器窗口列表')
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '同步窗口列表失败（请确认比特浏览器已启动）')
  }

  // 钱包密码环境变量解析失败告警（config 层无 logger，此处统一提示）
  if (cfg.wallet.parseError) logger.warn('WALLET_PASSWORDS 环境变量解析失败，已忽略（请检查 JSON 格式）')

  // 数据源（Excel 账号表）：加载失败仅告警（数据源是可选增强，任务侧 faker 兜底）
  const datasource = new DataSource()
  await datasource.load(cfg.dataSource.path)
  if (!datasource.available) logger.warn({ path: cfg.dataSource.path, err: datasource.error }, '数据源不可用（未配置/文件不存在/解析失败），任务将以 faker 兜底')

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
    // 窗口复用探测：open_windows 表有登记（面板打开/task:run 登记）即复用该窗口，
    // 本轮会话不重新开窗、结束后不关窗。此处不做 pid 校验（校验在 route/task:run 打开时登记、
    // 关闭时清除）；若窗口被外部关掉而表残留，复用会走到 CDP 连接失败 → failed 终态（可接受）
    reuseOpen: async (id) => {
      const row = await db.getOpenWindow(id)
      return row ? { http: row.http } : null
    },
    // 数据源行解析：有窗口列按窗口名/ID 匹配，无窗口列按窗口列表顺序取行（list 顺序=面板顺序）
    accountResolver: async (profile) => {
      if (!datasource.available) return null
      const row = datasource.rowFor(profile, await db.listProfiles(false))
      return row ? { ...row.values } : null
    },
    // 重试不占窗：退避到期后重新入队（新一轮窗口会话），当前窗口正常继续/关窗；
    // 到期时重取最新 profile（名称/开关可能已被面板修改），窗口已被删除则放弃重试
    scheduleRetry: (profile, taskKey, delayMs) => {
      setTimeout(() => {
        void (async () => {
          try {
            const p = (await db.listProfiles(false)).find(x => x.id === profile.id)
            if (p) enqueuer.enqueue(p, taskKey)
          } catch (e) {
            logger.warn({ err: (e as Error).message }, '重试到期查询窗口失败，放弃本次重试')
          }
        })()
      }, delayMs)
    },
  })
  const queue = new TaskQueue(cfg.execution.concurrency)
  enqueuer = new CoalescingEnqueuer(queue, runner, logger)

  // scheduler 前置声明：面板任务开关 PATCH 回调闭包引用它（开关切换即时重注册 cron），
  // 调度器在 createApp 之后才创建，先声明变量再赋值（与 enqueuer 同法）
  let scheduler: Scheduler | undefined
  const app = createApp({
    db,
    enqueuer,
    tasks,
    cfg,
    logger,
    bitbrowser: buildBitbrowserDeps(bitbrowser, db),
    // 面板数据源展示/重载：闭包包住 datasource（reload = 重新 load 配置路径）
    datasource: {
      summary: () => datasource.summary(),
      reload: () => datasource.load(cfg.dataSource.path),
      get available() { return datasource.available },
      get error() { return datasource.error },
      path: cfg.dataSource.path,
    },
    onToggle: (key) => void scheduler?.refreshTask(key),
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

  scheduler = new Scheduler(cfg, db, tasks, enqueuer, logger)
  await scheduler.start()

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

/**
 * 应用装配（顶层）：startApp 按依赖顺序组装全部模块并启动
 * 依赖方向：顶层依赖所有层，仅被 index.ts 调用（唯一的组装点，compose root）
 * 装配顺序即依赖顺序：配置/日志 → 数据库 → 比特浏览器同步 → 任务/钱包 →
 * 执行器/队列 → Web 服务
 */
import { loadConfig, type AppConfig } from './infrastructure/config'
import { acquireSingleInstanceLock, singleInstanceLockPath, SingleInstanceError } from './infrastructure/single-instance'
import { createLogger, type Logger } from './infrastructure/logger'
import { AppDb, type OpenWindowState, type ProfileRow } from './infrastructure/db'
import { DataSource } from './infrastructure/datasource'
import { startScreenshotCleanupSchedule } from './infrastructure/screenshot-cleanup'
import { createBitBrowserClient, type BitBrowserClient } from './integrations/bitbrowser'
import { PatchrightDriver, WindowRunner, windowProbeLeaseMs } from './engine/window-runner'
import { SerialQueue } from './engine/serial-queue'
import { WindowPoolScheduler } from './engine/window-pool'
import { MemoryGovernor } from './engine/memory-governor'
import { GlobalHealthGate } from './engine/global-health'
import { CancelRegistry } from './engine/cancel-registry'
import { createTaskStopper } from './engine/task-stopper'
import { recoverRuns } from './engine/run-recovery'
import { Scheduler } from './engine/scheduler'
import { startCircuitBreakerResetSchedule } from './engine/maintenance'
import { CDP_TRANSIENT_PATTERN } from './infrastructure/constants'
import { WalletRegistry } from './automation/wallet/types'
import { MetaMaskAdapter } from './automation/wallet/metamask'
import { PetraAdapter } from './automation/wallet/petra'
import { loadTasks } from './tasks'
import { createApp } from './server/app'
import { FileAssignService } from './tools/file-assign/applier'
import { buildFileAssignRunner } from './tools/file-assign/runner'

/**
 * 分页同步比特浏览器窗口列表到 profiles 表（每页 100，page 从 0 起）
 * 返回同步总数；供面板"同步"按钮与启动同步两处复用
 */
async function syncBrowsersPaged(bitbrowser: BitBrowserClient, db: AppDb): Promise<number> {
  let page = 0
  let total = 0
  while (true) {
    const list = await bitbrowser.listBrowsers(page, 100)
    for (const b of list) await db.upsertProfile(b.id, b.name, b)
    total += list.length
    if (list.length < 100) break
    page++
  }
  return total
}

/** 只有生命周期为 open 且调试地址非空的登记才允许复用；opening/closing 交给正常开窗流程 */
export function getReusableWindow(row: { http: string; state: OpenWindowState } | null): { http: string } | null {
  if (!row || row.state !== 'open' || !row.http.trim()) return null
  return { http: row.http }
}

/** RunEnqueuer 装配依赖（独立导出便于测试装配结果） */
export interface RunEnqueuerDeps {
  cfg: AppConfig
  db: AppDb
  logger: Logger
  /** 已注册任务 key：仅用于识别「任务已从注册表移除」的到期行（窗口池不做任务级并发） */
  taskKeys: Set<string>
  bitbrowser: Pick<BitBrowserClient, 'openPids'>
  /** 创建窗口池专用执行器（开窗归属 pool） */
  createPoolRunner(): WindowRunner
}

/** 装配窗口池调度器（唯一调度器）：构建内存/健康门禁并注入配置与任务注册表 */
export function createRunEnqueuer(deps: RunEnqueuerDeps): WindowPoolScheduler {
  const { execution } = deps.cfg
  const pool = execution.windowPool
  return new WindowPoolScheduler({
    db: deps.db,
    runner: deps.createPoolRunner(),
    bitbrowser: deps.bitbrowser,
    logger: deps.logger,
    memory: new MemoryGovernor({
      reserveMb: pool.memoryReserveMb,
      perWindowMb: pool.perWindowMb,
      criticalFreeMb: pool.criticalFreeMb,
      resumeFreeMb: pool.resumeFreeMb,
    }),
    health: new GlobalHealthGate({
      backoffSec: execution.health.backoffSec,
      probeEnabled: execution.health.probeEnabled,
    }),
    cfg: pool,
    taskKeys: deps.taskKeys,
  })
}

/**
 * 面板依赖的比特浏览器适配：health 探活 + sync 窗口列表同步 + 开窗/关窗/打开状态探测
 * 独立导出便于测试（sync 闭包持有 db 做 upsert，路由层不直接依赖 db）
 */
export function buildBitbrowserDeps(bitbrowser: BitBrowserClient, db: AppDb, openCloseQueue?: SerialQueue): {
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
    // 打开/关闭与 pid 探测：开/关窗走全局串行队列（未注入队列时保持直接透传，兼容旧测试/脚本）
    openBrowser: (id) => openCloseQueue ? openCloseQueue.run(() => bitbrowser.openBrowser(id)) : bitbrowser.openBrowser(id),
    // 关窗不参与开窗冷却，但仍与开窗共用同一串行链
    closeBrowser: (id) => openCloseQueue ? openCloseQueue.run(() => bitbrowser.closeBrowser(id), { cooldown: false }) : bitbrowser.closeBrowser(id),
    isOpen: (id) => bitbrowser.isOpen(id),
    openPids: (ids) => bitbrowser.openPids(ids),
  }
}

export async function startApp(): Promise<void> {
  // 配置校验告警：非法/越界值已在 loadConfig 内回退或截断，这里统一输出提示用户修配置
  const configWarnings: string[] = []
  const cfg = loadConfig({ warnings: configWarnings })
  const logger = createLogger(cfg)
  for (const warning of configWarnings) logger.warn(warning)

  // 单实例守卫：同一数据库文件同时只允许一个后端实例——
  // 2026-09-08 事故：旧 npm start 与新 dev 两进程并存，各自调度器重复触发计划、
  // 同一窗口被两个 CDP 会话同时接管（看板双批次、领水额度被打乱）。
  // 锁在 AppDb.open 之前获取（快速失败不产生副作用）；异常退出路径无需清理，
  // 残留锁由下次启动按 PID 存活探测自动接管
  const lockPath = singleInstanceLockPath(cfg.storage.dbPath)
  let singleLock!: ReturnType<typeof acquireSingleInstanceLock>
  try {
    singleLock = acquireSingleInstanceLock(lockPath)
  } catch (e) {
    if (e instanceof SingleInstanceError) {
      logger.error({ lockPath, holderPid: e.holderPid }, '检测到另一个后端实例正在运行（多实例会导致定时计划重复触发与窗口会话互杀），本实例退出；若确认旧实例已退出仍报此错，请删除该锁文件后重试')
      process.exit(1)
    }
    throw e
  }
  logger.info({ lockPath }, '已取得单实例锁')

  // 快速失败策略：未捕获异常直接退出（挂着的半死进程比重启更危险）；
  // 例外：CDP 会话级瞬时错误（窗口中途关闭/崩溃时 patchright 内部协议错误，如
  // Network.setCacheDisabled session closed——真机实测全量并发跑时必现）只记录不退出：
  // 单窗口瞬时错误不应杀死整个服务，该窗口任务按失败落库后由重试机制兜底
  process.on('uncaughtException', (err) => {
    if (CDP_TRANSIENT_PATTERN.test((err as Error).message)) {
      logger.warn({ err: (err as Error).message }, '窗口会话级瞬时异常，忽略（不退出进程）')
      return
    }
    logger.error({ err }, '未捕获异常，进程退出')
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (CDP_TRANSIENT_PATTERN.test(msg)) {
      logger.warn({ err: msg }, '窗口会话级瞬时 Promise 拒绝，忽略（不退出进程）')
      return
    }
    logger.error({ err }, '未处理的 Promise 拒绝，进程退出')
    process.exit(1)
  })

  // 本地 SQLite 数据库：storage.dbPath 有默认值（data/app.db），打开失败（磁盘/权限问题）快速失败
  let db: AppDb
  try {
    db = await AppDb.open(cfg.storage.dbPath)
  } catch (e) {
    logger.error({ err: (e as Error).message }, '本地数据库打开失败（请检查 storage.dbPath 与磁盘状态）')
    process.exit(1)
  }
  logger.info({ path: cfg.storage.dbPath }, '本地数据库已打开')
  // 启动恢复：进程重启后残留的过期半开探测退回 open（1 分钟后可重探），避免窗口永久卡在 half_open
  const recovered = await db.recoverStaleWindowProbes(windowProbeLeaseMs(cfg)).catch(() => 0)
  if (recovered > 0) logger.info({ recovered }, '已回收过期窗口半开探测')
  // 运行恢复必须先于 dispatcher 启动：先结算被更新 slot 取代的旧行，再把崩溃残留 running
  // 重置为 pending，随后 dispatcher 统一按 not_before_ms 拾取（原内存重试定时器已移除）
  try {
    await recoverRuns({ db, logger })
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '启动运行恢复失败（不影响启动）')
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

  // 文件随机分配服务：单实例共享（面板手动分配与计划自动分配共用 busy 锁，防并发改同一文件夹）
  const fileAssignService = new FileAssignService()

  const tasks = loadTasks()
  const wallets = new WalletRegistry()
  wallets.register(new MetaMaskAdapter())
  wallets.register(new PetraAdapter())

  // 取消标记注册表：进程内「已请求停止」标记，runner / 停止器共用
  const cancelRegistry = new CancelRegistry()
  // 比特开/关窗串行队列：全局单实例，避免异步开窗/关窗互相踩踏并按配置冷却限频
  const openCloseQueue = new SerialQueue(cfg.execution.windowPool.openCooldownMs)
  // 执行器共用依赖：手动/面板执行器与窗口池执行器只差开窗归属（openOwnerKind）
  const runnerDeps = {
    cfg,
    db,
    bitbrowser,
    driver: new PatchrightDriver(),
    tasks,
    wallets,
    logger,
    artifactsDir: cfg.storage.screenshotDir,
    walletPasswords: cfg.wallet.passwords,
    openCloseQueue,
    // 取消标记：会话开始前过滤「已请求停止」任务，runTask catch 消费（落 skipped 不重试）
    cancelRegistry,
    // 窗口复用探测：仅 state=open 且调试地址非空的 open_windows 登记可复用（面板/task:run 登记），
    // 本轮会话不重新开窗、结束后不关窗。opening/closing 交给正常开窗流程；Phase 1 不回收
    // 「存活但无登记」的窗口。此处不做 pid 校验（pid 校验在 route/task:run 打开时登记、关闭时清除）；
    // 若窗口被外部关掉而表残留，复用会走到 CDP 连接失败 → failed 终态（可接受）
    reuseOpen: async (id: string) => getReusableWindow(await db.getOpenWindow(id)),
    // 数据源行解析：有窗口列按窗口名/ID 匹配，无窗口列按窗口列表顺序取行（list 顺序=面板顺序）
    accountResolver: async (profile: ProfileRow) => {
      if (!datasource.available) return null
      const row = datasource.rowFor(profile, await db.listProfiles(false))
      return row ? { ...row.values } : null
    },
  }
  // 任务注册表：窗口池仅用于识别未注册任务的到期行，不做任务级并发
  const taskKeys = new Set(tasks.keys())
  // 窗口池是唯一调度器：独立 pool 执行器（开窗归属 pool）负责开窗/复用/回收
  const enqueuer = createRunEnqueuer({
    cfg,
    db,
    logger,
    taskKeys,
    bitbrowser,
    createPoolRunner: () => new WindowRunner({ ...runnerDeps, openOwnerKind: 'pool' }),
  })
  // 调度器常驻：重试退避行即使没有新的 enqueue 也要到点被拾取
  enqueuer.start()
  // 池状态始终可用（窗口池是唯一调度器）
  const poolStatus = () => enqueuer.getStatus()

  // 定时调度器：自研 tick（每 15 秒扫一次 schedules 表）；触发路径与批量手动同构
  // （建 schedule 批次 + 全部启用窗口入队，触发即 pending）
  const scheduler = new Scheduler({
    db, enqueuer, tasks, logger, timezone: cfg.scheduler.timezone,
    // 计划级「上传前自动分配」：preview（校验+计划）→ apply（改名+写回）→ 重载数据源
    // （窗口开窗时 accountResolver 才能读到新路径；任一步失败由 Scheduler 捕获并跳过依赖文件的任务）
    fileAssign: {
      run: buildFileAssignRunner({
        xlsxPath: cfg.dataSource.path,
        apply: (params) => fileAssignService.apply(params),
        reload: () => datasource.load(cfg.dataSource.path),
      }),
    },
  })
  scheduler.start()

  // 熔断每日定时重置：到点重置所有窗口健康状态（circuitBreakerResetAt 为空则不排程）；
  // 退出时随 shutdown 一并 stop，取消已挂定时器
  const maintenance = startCircuitBreakerResetSchedule(cfg, db, logger)

  // 任务停止器：批次级/行级停止路由调用（置标记 + 结算 skipped + 关窗 + 清开窗登记）
  const stopper = createTaskStopper({
    db,
    registry: cancelRegistry,
    logger,
    closeBrowser: (id) => openCloseQueue.run(() => bitbrowser.closeBrowser(id), { cooldown: false }),
    // 严格存活探测：openPids 失败必须向上抛，不能像 BitBrowserClient.isOpen 那样吞成 false，
    // 否则停止器会把探测失败误判为「已关闭」并清掉 closing 登记
    isOpen: async (id) => (await bitbrowser.openPids([id])).has(id),
    getOpenWindow: (id) => db.getOpenWindow(id),
    clearOpenWindow: (id) => db.clearOpenWindow(id),
    // 批次停止先撤队列：排队行已由 dispatcher 落库，DB 原子结算 pending/retry_wait
    cancelQueued: (batchId) => enqueuer.cancelBatch(batchId),
  })

  const app = createApp({
    db,
    enqueuer,
    scheduler: { runNow: (s) => scheduler.runNow(s) },
    tasks,
    cfg,
    logger,
    bitbrowser: buildBitbrowserDeps(bitbrowser, db, openCloseQueue),
    // 面板数据源展示/重载：闭包包住 datasource（reload = 重新 load 配置路径）
    datasource: {
      summary: () => datasource.summary(),
      reload: () => datasource.load(cfg.dataSource.path),
      get available() { return datasource.available },
      get error() { return datasource.error },
      path: cfg.dataSource.path,
    },
    fileAssignService,
    getRunById: (id) => db.getRunById(id),
    stopper,
    // 面板手动关窗前：若窗口有在途 running 行，置会话标记让 runner 按手动停止结算
    cancelSession: (id) => cancelRegistry.requestSession(id),
    poolStatus,
  })
  // 保存 http server 引用：优雅退出时先 close（等待存量连接结束），再关数据库退出
  const server = app.listen(cfg.web.port, cfg.web.host, () => {
    logger.info({ url: `http://${cfg.web.host}:${cfg.web.port}` }, '后端 API 已启动')
  })

  // 历史数据清理：按保留天数删超期 runs/batches（本地文件无限增长，启动时收敛一次）
  try {
    const cleaned = await db.cleanupOld(cfg.storage.dbRetainDays)
    if (cleaned.runs + cleaned.batches > 0) {
      logger.info({ retainDays: cfg.storage.dbRetainDays, cleaned }, '已清理超期历史数据')
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '历史数据清理失败（不影响运行）')
  }

  // 截图目录按日期清理：启动立即清一次，之后每 6 小时重复（服务长开时不能只靠启动清理）
  const screenshotCleanup = startScreenshotCleanupSchedule({
    screenshotDir: cfg.storage.screenshotDir,
    retainDays: cfg.storage.screenshotRetainDays,
    onRemoved: ({ removed }) => {
      if (removed > 0) logger.info({ retainDays: cfg.storage.screenshotRetainDays, removed }, '已清理超期截图目录')
    },
    onError: (err) => logger.warn({ err: err.message }, '截图目录清理失败（不影响运行）'),
  })

  // 优雅退出：server.close（回调中关库退出）→ 3 秒强制兜底（keep-alive 连接挂着时不阻塞退出）
  let finishing = false
  const finish = () => {
    if (finishing) return
    finishing = true
    singleLock.release()
    try {
      db.close()
    } catch {
      // 兜底与回调竞争时可能已关闭，忽略
    }
    process.exit(0)
  }
  const shutdown = () => {
    scheduler.stop()
    enqueuer.stop()
    maintenance.stop()
    screenshotCleanup.stop()
    logger.info('正在关闭...')
    server.close(() => finish())
    // 强制退出兜底：3 秒内未优雅关闭则直接收尾（unref 保证不阻止进程自然退出）
    setTimeout(finish, 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

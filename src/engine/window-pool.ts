/**
 * 窗口池调度器（engine 层）：runs 表即每窗口任务集，open_windows 即池状态；
 * 每秒 tick 对账窗口 → 内存/健康门禁 → 空闲池窗口分配任务 → 补池/轮转 → 记录状态
 * 依赖方向：依赖 infrastructure/db 与 engine 的 memory-governor/global-health/queue 类型；
 *   由 app 装配为唯一调度器
 * 设计：任务级无并发/顺序限制；窗口保持打开（keepWindowOpen），关窗只由健康/内存/轮转/寿命策略触发
 *
 * 内存状态语义：normal 允许补池与分配；warning 停止补池与普通任务分配（已有会话自然结束），
 *   允许 half-open 探测在 effectivePool 容量内启动；critical 停止分配并优先关闭空闲池窗口。
 * 采样频率：当前每 tick 采样一次（checkIntervalMs 暂不用于池调度采样节流；perWindowMb 自动校准同为 Phase 3）。
 */
import { freemem } from 'node:os'
import {
  todayStr,
  type AppDb,
  type OpenWindowPoolRow,
  type ProfileRow,
  type RunRow,
} from '../infrastructure/db'
import type { WindowPoolConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { GlobalHealthGate, GlobalHealthState } from './global-health'
import type { MemoryGovernor, MemoryState } from './memory-governor'
import type { RunEnqueuer, SessionTask } from './queue'

const MB = 1024 * 1024
/** opening 登记超过该时长仍未完成（进程崩溃/开窗调用丢失）即重探：活则转 open，死则清行 */
const OPENING_STALE_MS = 60_000
/** closing 登记仍存活时重试关窗的间隔，避免一直卡在 closing */
const CLOSING_RETRY_MS = 30_000
/** half-open 探测启动预算：到点仍无法开始探测则重新退避，避免永久卡在 probing */
const PROBE_START_TIMEOUT_MS = 30_000
/** half-open 探测会话租约：超过仍未结束则重新退避（不 hard kill 运行中会话） */
const PROBE_SESSION_LEASE_MS = 10 * 60_000
/** 会话异常后任务行回队退避（避免持久故障热循环） */
const REQUEUE_BACKOFF_MS = 30_000
/** 比特 API 故障告警/全局退避升级的最小间隔（避免每秒刷日志与快速升级到最大退避） */
const API_FAILURE_THROTTLE_MS = 30_000

/** 窗口池依赖的执行器：单任务 keep-open 会话 + 池关窗（WindowRunner 实现） */
export interface WindowPoolRunner {
  runWindowTasks(
    profile: ProfileRow,
    tasks: SessionTask[],
    opts?: { keepWindowOpen?: boolean; manualReused?: boolean },
  ): Promise<Map<string, RunRow | null>>
  closePoolWindow(profile: ProfileRow, reason: string): Promise<void>
}

/** 窗口池调度依赖（app 层装配注入） */
export interface WindowPoolSchedulerDeps {
  db: AppDb
  runner: WindowPoolRunner
  bitbrowser: { openPids(ids: string[]): Promise<Set<string>> }
  logger: Logger
  memory: MemoryGovernor
  health: GlobalHealthGate
  cfg: WindowPoolConfig
  /** 已注册任务 key；只用于识别「任务已从注册表移除」的到期行（池不做任务级并发） */
  taskKeys: Set<string>
  now?: () => Date
  tickMs?: number
  /** 空闲内存采样（MB）：默认 os.freemem；测试注入固定值 */
  freeMemMb?: () => number
  /** enqueue 后是否尽快自动 tick（默认 true；测试关闭以便手动控制时钟与 tick 时机） */
  autoTick?: boolean
}

/** 面板池状态（getStatus 返回；Phase 2 面板轮询用） */
export interface PoolStatus {
  memoryState: MemoryState
  globalHealthState: GlobalHealthState
  freeMb: number
  perWindowMb: number
  effectivePool: number
  maxOpenWindows: number
  actualOpen: number
  poolSize: number
  busy: number
  idle: number
  opening: number
  queueWindows: number
  pendingTasks: number
  updatedAt: string | null
}

/** 一次会话的启动意图：补池开窗 or 复用已打开池窗口；probe 标记全局健康 half-open 探测 */
interface SessionStartOptions {
  opening: boolean
  probe: boolean
  /** manual 窗口（面板手动打开）作为工作者：失败/熔断/空闲都不自动关窗 */
  manual?: boolean
}

/** 每 tick 读取的窗口对账结果 */
interface ReconcileResult {
  /** 比特 /browser/pids 实测存活的全部窗口 id（含未登记窗口） */
  live: Set<string>
  /** 尚未存活、仍占用开窗额度的 opening 登记（含外部/DB 预留与进程内开窗请求） */
  openingReservations: Set<string>
  profiles: Map<number, ProfileRow>
  byBitbrowserId: Map<string, ProfileRow>
}

/** half-open 探测租约：profileId 为空表示尚未选中窗口（等待启动），非空表示探测会话在途 */
interface ProbeLease {
  profileId: number | null
  deadlineMs: number
}

export class WindowPoolScheduler implements RunEnqueuer {
  private timer: ReturnType<typeof setInterval> | null = null
  private requestTimer: ReturnType<typeof setTimeout> | null = null
  private requestScheduled = false
  private ticking = false
  private stopped = false
  /** 最近一次调度日期：跨午夜时结算旧日期排队行（running 行由会话按认领日期自行结算） */
  private lastDate: string | null = null
  /** 正在执行会话的窗口（profile id）：同窗口同一时刻只跑一个任务 */
  private readonly inFlight = new Set<number>()
  /** 已发出开窗请求、尚未被 /browser/pids 确认存活的窗口（profile id）；只用于额度预留 */
  private readonly opening = new Set<number>()
  /** opening 登记的首次观察时间（bitbrowser id）：超时重探 */
  private readonly openingSince = new Map<string, number>()
  /** closing 登记仍存活时的首次观察时间（bitbrowser id）：到点重试关窗 */
  private readonly closingSince = new Map<string, number>()
  /** 池窗口首次纳入池的时间（profile id）：寿命回收依据 */
  private readonly openSince = new Map<number, number>()
  /** 池窗口进入空闲的时间（profile id）：空闲回收依据 */
  private readonly idleSince = new Map<number, number>()
  /** 连续占用起点（profile id）：cohortMaxSec 公平轮转依据 */
  private readonly occupiedSince = new Map<number, number>()
  /** half-open 探测租约（防止 paused→probing 后无人结算） */
  private probeLease: ProbeLease | null = null
  /** 最近一次池开窗请求时间（epoch ms）：开窗冷却 */
  private lastOpenAt = 0
  /** 最近一次比特 API 故障告警/全局退避时间（限频） */
  private lastApiFailureAt = 0
  /** 当前 tick 的 opening 预留数（含 DB 外部 opening；状态展示用） */
  private openingReservationCount = 0
  private readonly sessionPromises = new Set<Promise<void>>()
  private readonly now: () => Date
  private readonly tickMs: number
  private status!: PoolStatus
  private lastStatusSignature = ''

  constructor(private readonly deps: WindowPoolSchedulerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.tickMs = deps.tickMs ?? 1000
    this.status = {
      memoryState: 'normal',
      globalHealthState: deps.health.state,
      freeMb: 0,
      perWindowMb: deps.cfg.perWindowMb,
      effectivePool: deps.cfg.maxOpenWindows,
      maxOpenWindows: deps.cfg.maxOpenWindows,
      actualOpen: 0,
      poolSize: 0,
      busy: 0,
      idle: 0,
      opening: 0,
      queueWindows: 0,
      pendingTasks: 0,
      updatedAt: null,
    }
  }

  /** 启动周期 tick（app 装配时调用） */
  start(): void {
    this.stopped = false
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref?.()
  }

  /** 停止调度：清理定时器并拒绝后续 tick */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.requestTimer) clearTimeout(this.requestTimer)
    this.requestTimer = null
    this.requestScheduled = false
  }

  /** 当前池状态快照 */
  getStatus(): PoolStatus {
    return { ...this.status }
  }

  /**
   * 入队：写 pending 行；skipIfSuccess 时若该窗口当天该任务最新行已成功则跳过（定时/批量触发幂等）。
   * 入队后尽快触发一次 tick，开窗节奏仍由池容量/冷却/内存决定。
   */
  async enqueue(
    profile: ProfileRow,
    taskKey: string,
    opts: { batchId?: number; notBeforeMs?: number; skipIfSuccess?: boolean } = {},
  ): Promise<void> {
    const now = this.now()
    const date = todayStr(now)
    if (opts.skipIfSuccess) {
      const latest = await this.deps.db.getLatestRun(profile.id, taskKey, date)
      if (latest?.status === 'success') {
        this.deps.logger.debug({ profile: profile.name, task: taskKey }, '今日已成功，跳过重复入队')
        return
      }
    }
    const row = await this.deps.db.enqueueRun(
      profile.id,
      taskKey,
      date,
      opts.batchId ?? null,
      opts.notBeforeMs ?? now.getTime(),
    )
    if (row.status === 'running') {
      this.deps.logger.warn({ profile: profile.name, task: taskKey }, '任务已在运行，本次入队忽略')
    }
    this.requestTick()
  }

  /** 取消批次中仍在排队的行（running 行由执行器按停止语义结算） */
  async cancelBatch(batchId: number): Promise<number> {
    return this.deps.db.stopQueuedRuns(batchId)
  }

  /** 等待当前在途会话结束（测试与优雅停机用；不等待周期 timer） */
  async waitForIdle(): Promise<void> {
    while (this.sessionPromises.size > 0) {
      await Promise.all([...this.sessionPromises])
    }
  }

  /** 尽快跑一次 tick（合并多次 enqueue） */
  private requestTick(): void {
    if (this.deps.autoTick === false || this.stopped || this.requestScheduled) return
    this.requestScheduled = true
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null
      this.requestScheduled = false
      if (this.stopped) return
      void this.tick()
    }, 0)
    this.requestTimer.unref?.()
  }

  /** 单次调度：对账 → 内存/健康 → 分配 → 补池/轮转 → 状态记录 */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.runTick()
    } catch (e) {
      this.deps.logger.error({ err: (e as Error).message }, '窗口池调度异常')
    } finally {
      this.ticking = false
    }
  }

  private async runTick(): Promise<void> {
    const now = this.now()
    const nowMs = now.getTime()
    const date = todayStr(now)
    await this.settleOldDate(date)

    const reconciled = await this.reconcile(nowMs)
    if (!reconciled) {
      // API 探测失败时 reconcile 已把全局健康置为 paused；同步状态快照供面板读取
      this.status = {
        ...this.status,
        globalHealthState: this.deps.health.state,
        updatedAt: new Date(nowMs).toISOString(),
      }
      return
    }
    const { live, openingReservations, profiles, byBitbrowserId } = reconciled
    this.openingReservationCount = openingReservations.size
    const actualOpen = live.size

    const freeMb = this.sampleFreeMb()
    const mem = this.deps.memory.update({
      freeMb,
      actualOpen,
      maxOpenWindows: this.deps.cfg.maxOpenWindows,
    })
    const effectivePool = mem.effectivePool

    const hasDue = await this.deps.db.hasDueRuns(date, nowMs)
    this.expireProbeLease(nowMs)
    // paused 且无任务时不推进 probing；有任务时 canOpen 到点会把状态切到 probing
    const allow = this.deps.health.state === 'paused'
      ? (hasDue ? this.deps.health.canOpen(nowMs) : false)
      : true
    if (this.deps.health.state === 'probing' && !this.probeLease) {
      // 进入 probing 但尚未选中窗口：设置启动预算，超时由 expireProbeLease 重新退避
      this.probeLease = { profileId: null, deadlineMs: nowMs + PROBE_START_TIMEOUT_MS }
    }
    const isProbing = this.deps.health.state === 'probing'
    const probeRunning = isProbing && this.probeLease?.profileId != null

    if (!allow || probeRunning) {
      if (!allow) await this.closeOneIdlePoolWindow('全局健康暂停')
      const poolRows = await this.deps.db.listPoolWindows()
      const pending = await this.pendingStatus(date, nowMs, hasDue)
      this.recordStatus({
        memoryState: mem.state,
        healthState: this.deps.health.state,
        freeMb,
        perWindowMb: mem.perWindowMb,
        effectivePool,
        actualOpen,
        poolSize: poolRows.length,
        queueWindows: pending.queueWindows,
        pendingTasks: pending.pendingTasks,
        nowMs,
      })
      return
    }

    // 内存 critical：不分配新任务（运行中的自然结束），优先关闭空闲池窗口（无到期任务时同样生效）
    if (mem.state === 'critical') {
      const poolRows = await this.deps.db.listPoolWindows()
      const closed = poolRows.length > 0 ? await this.closeOneIdlePoolWindow('内存临界，关闭空闲池窗口') : false
      const pending = await this.pendingStatus(date, nowMs, hasDue)
      this.recordStatus({
        memoryState: mem.state,
        healthState: this.deps.health.state,
        freeMb,
        perWindowMb: mem.perWindowMb,
        effectivePool,
        actualOpen,
        poolSize: Math.max(0, poolRows.length - (closed ? 1 : 0)),
        queueWindows: pending.queueWindows,
        pendingTasks: pending.pendingTasks,
        nowMs,
      })
      return
    }

    if (!hasDue) {
      // 无到期任务：仍按寿命/任务数/空闲策略回收池窗口；探测等待期间不主动关窗
      const poolRows = await this.deps.db.listPoolWindows()
      if (!isProbing && poolRows.length > 0) {
        await this.closeOneOverdue(nowMs, poolRows, byBitbrowserId)
      }
      this.recordStatus({
        memoryState: mem.state,
        healthState: this.deps.health.state,
        freeMb,
        perWindowMb: mem.perWindowMb,
        effectivePool,
        actualOpen,
        poolSize: poolRows.length,
        queueWindows: 0,
        pendingTasks: 0,
        nowMs,
      })
      return
    }

    // 任务从注册表移除后其到期行永远不会被认领：认领前先结算，避免永久 pending
    try {
      const settled = await this.deps.db.settleUnregisteredRuns(date, nowMs, this.deps.taskKeys)
      if (settled > 0) this.deps.logger.warn({ count: settled, date }, '已结算未注册任务的到期行')
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message, date }, '未注册任务结算失败（下轮重试）')
    }
    if (this.stopped) return

    const openRows = await this.deps.db.listOpenWindows()
    // 池窗口 = pool 归属、open、已有调试地址
    const poolRows = openRows.filter((row) => row.ownerKind === 'pool' && row.state === 'open' && row.http.trim() !== '')
    // 面板手动打开的窗口只作为其 profile 的工作者复用，不纳入池生命周期/轮转
    const manualRows = openRows.filter((row) => row.ownerKind === 'manual'
      && row.state === 'open'
      && row.http.trim() !== ''
      && live.has(row.bitbrowserId)
      && byBitbrowserId.has(row.bitbrowserId))
    const queue = await this.deps.db.listPendingWindowKeys(date, nowMs)
    const waitingNonPool = this.collectWaitingNonPool(queue, poolRows, profiles, byBitbrowserId, live, openingReservations, nowMs)
    const pendingByWindow = new Map<number, RunRow[]>()
    let pendingTotal = 0
    for (const row of [...poolRows, ...manualRows]) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (!profile) continue
      const pending = await this.deps.db.listPendingRunsForWindow(profile.id, date, nowMs)
      pendingByWindow.set(profile.id, pending)
      pendingTotal += pending.length
    }
    for (const row of poolRows) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (profile && !this.openSince.has(profile.id)) this.openSince.set(profile.id, nowMs)
    }

    let activePool = poolRows
    let closedThisTick = false
    // 寿命/任务数/公平轮转：当前任务已结束（不在途）即关闭，剩余任务回到队列等待重新入池
    for (const row of poolRows) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (!profile) {
        await this.clearWindowRow(row.bitbrowserId)
        activePool = activePool.filter((r) => r.bitbrowserId !== row.bitbrowserId)
        continue
      }
      if (this.inFlight.has(profile.id)) continue
      let reason = this.capCloseReason(row, profile.id, nowMs)
      if (!reason && !isProbing && waitingNonPool.length > 0 && this.cohortExceeded(profile.id, nowMs)) {
        reason = '连续占用超限，轮转让位'
      }
      if (reason) {
        await this.closeWindow(profile, reason)
        closedThisTick = true
        activePool = activePool.filter((r) => r.bitbrowserId !== row.bitbrowserId)
        break
      }
    }

    if (isProbing) {
      // half-open 探测：只启动一个会话；优先复用已打开池窗口，否则最多开 1 个（受硬上限/冷却约束）
      const started = await this.startProbeSession(nowMs, activePool, pendingByWindow, queue, profiles, byBitbrowserId, live, openingReservations, effectivePool)
      this.recordStatus({
        memoryState: mem.state,
        healthState: this.deps.health.state,
        freeMb,
        perWindowMb: mem.perWindowMb,
        effectivePool,
        actualOpen,
        poolSize: activePool.length,
        queueWindows: queue.length,
        pendingTasks: pendingTotal,
        nowMs,
      })
      if (started) this.deps.logger.info({ profileId: this.probeLease?.profileId ?? null }, '全局健康探测会话已启动')
      return
    }

    // 已打开窗口优先：池窗口 + 面板手动窗口都可作为其 profile 的工作者（无任务级并发/顺序限制）
    // warning/critical 均不再分配普通任务；warning 仅允许前面的 half-open 探测（受 effectivePool 限制）
    if (mem.state === 'normal') {
      const activeWorkers = [...activePool, ...manualRows]
      for (const row of activeWorkers) {
        if (this.stopped) break
        const profile = byBitbrowserId.get(row.bitbrowserId)
        if (!profile || this.inFlight.has(profile.id)) continue
        if (this.isWindowBreakerBlocked(profile, nowMs)) continue
        const pending = pendingByWindow.get(profile.id) ?? []
        if (pending.length === 0) continue
        const claimed = await this.deps.db.claimQueuedRuns([pending[0].id], nowMs)
        if (claimed.length === 0) continue
        this.idleSince.delete(profile.id)
        this.startSession(profile, claimed[0], { opening: false, probe: false, manual: row.ownerKind === 'manual' })
      }
    }

    // 补池：实际打开数低于有效池且有排队窗口时，每 tick 最多开 1 个（冷却/内存/健康共同裁决）
    const projectedOpen = actualOpen + openingReservations.size
    const cooldownReady = nowMs - this.lastOpenAt >= this.deps.cfg.openCooldownMs
    let filledThisTick = false
    if (
      projectedOpen < effectivePool
      && mem.state === 'normal'
      && queue.length > 0
      && cooldownReady
    ) {
      const candidate = this.pickQueueCandidate(queue, poolRows, profiles, byBitbrowserId, live, openingReservations, nowMs)
      if (candidate) {
        const profile = profiles.get(candidate.profileId)
        if (profile) {
          const pending = await this.deps.db.listPendingRunsForWindow(profile.id, date, nowMs)
          if (pending.length > 0) {
            const claimed = await this.deps.db.claimQueuedRuns([pending[0].id], nowMs)
            if (claimed.length > 0) {
              this.lastOpenAt = nowMs
              this.openSince.set(profile.id, nowMs)
              this.startSession(profile, claimed[0], { opening: true, probe: false })
              filledThisTick = true
            }
          }
        }
      }
    }

    // 轮转/空闲/寿命回收：每 tick 最多关 1 个，避免抖动；本 tick 刚补池时不再关窗（防止关一个开一个）
    if (!closedThisTick && !filledThisTick) {
      await this.rotateOrCloseIdle(
        nowMs,
        activePool,
        pendingByWindow,
        queue,
        waitingNonPool,
        effectivePool,
        actualOpen,
        openingReservations,
        byBitbrowserId,
      )
    }

    this.recordStatus({
      memoryState: mem.state,
      healthState: this.deps.health.state,
      freeMb,
      perWindowMb: mem.perWindowMb,
      effectivePool,
      actualOpen,
      poolSize: activePool.length,
      queueWindows: queue.length,
      pendingTasks: pendingTotal,
      nowMs,
    })
  }

  /** 跨午夜结算旧日期排队行（与跨日结算口径一致；running 行留给会话自行落终态） */
  private async settleOldDate(date: string): Promise<void> {
    if (this.lastDate === date) return
    try {
      const settled = await this.deps.db.settleOldQueuedRuns(date)
      this.lastDate = date
      if (settled > 0) this.deps.logger.warn({ count: settled, date }, '已结算跨日未执行的排队行')
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message, date }, '跨日排队行结算失败（下轮重试）')
    }
  }

  /**
   * 窗口对账：以比特 /browser/pids 实测为准（探测全部 profile id，未登记窗口也计入实际打开数）；
   * 死登记清理；opening 超时重探（活转 open / 死清行）；closing 存活到点重试关窗。
   */
  private async reconcile(nowMs: number): Promise<ReconcileResult | null> {
    const profiles = await this.loadProfiles()
    const byBitbrowserId = new Map([...profiles.values()].map((p) => [p.bitbrowserId, p]))
    const rows = await this.deps.db.listOpenWindows()
    const ids = new Set<string>(rows.map((r) => r.bitbrowserId))
    for (const profile of profiles.values()) ids.add(profile.bitbrowserId)
    let live: Set<string>
    try {
      live = await this.deps.bitbrowser.openPids([...ids])
    } catch (e) {
      // 探测失败无法区分「窗口全关」与「本地 API 故障」：本轮不做任何清理/调度，
      // 并把比特 API 故障上报全局健康（立即暂停；告警/升级退避做 30s 限频）
      this.recordApiFailure(nowMs, (e as Error).message)
      return null
    }

    // opening 只代表「开窗请求在途」：一旦 pids 实测存活即移出额度预留，避免与 actualOpen 重复计数；
    // 尚未存活的进程内开窗请求与 DB opening 登记统一进入 openingReservations 占额度
    const openingReservations = new Set<string>()
    for (const profileId of [...this.opening]) {
      const profile = profiles.get(profileId)
      if (!profile || live.has(profile.bitbrowserId)) {
        this.opening.delete(profileId)
        continue
      }
      openingReservations.add(profile.bitbrowserId)
    }

    const rowIds = new Set(rows.map((r) => r.bitbrowserId))
    for (const row of rows) {
      const id = row.bitbrowserId
      const profile = byBitbrowserId.get(id)
      if (row.state === 'opening') {
        if (live.has(id)) {
          // 已存活：有调试地址才转 open；空 http 说明执行器还没补写地址，
          // 继续按 opening 占位（live 已计入 actualOpen），但必须保留首次观察时间以便超时回收
          if (row.http.trim()) {
            await this.deps.db.setWindowState(id, 'open').catch(() => {})
            this.openingSince.delete(id)
            continue
          }
          const since = this.openingSince.get(id) ?? nowMs
          this.openingSince.set(id, since)
          if (nowMs - since >= OPENING_STALE_MS) {
            // 存活但长期没有调试地址（开窗后崩溃/setOpenWindow 一直失败）：串行关窗释放额度
            if (profile) {
              this.deps.logger.warn({ bitbrowserId: id }, 'opening 存活但缺少调试地址超时，回收窗口')
              await this.closeWindow(profile, '开窗缺少调试地址超时，回收池窗口')
            } else {
              await this.clearWindowRow(id)
            }
            this.openingSince.delete(id)
          }
          continue
        }
        const since = this.openingSince.get(id) ?? nowMs
        this.openingSince.set(id, since)
        if (nowMs - since >= OPENING_STALE_MS) {
          let alive = false
          try {
            alive = (await this.deps.bitbrowser.openPids([id])).has(id)
          } catch (e) {
            // 重探失败时保留登记并重置计时，避免把可能仍在打开的窗口误清成孤儿
            this.deps.logger.warn({ bitbrowserId: id, err: (e as Error).message }, '开窗超时重探失败，保留 opening 登记')
            this.openingSince.set(id, nowMs)
            openingReservations.add(id)
            continue
          }
          if (alive) {
            live.add(id)
            if (row.http.trim()) {
              this.deps.logger.warn({ bitbrowserId: id }, '开窗登记超时但窗口存活，转为 open')
              await this.deps.db.setWindowState(id, 'open').catch(() => {})
              this.openingSince.delete(id)
            } else {
              // 存活但还没有调试地址：继续占 opening，等执行器补写 http
              this.deps.logger.warn({ bitbrowserId: id }, '开窗登记超时且窗口存活但缺少调试地址，保留 opening')
              this.openingSince.set(id, nowMs)
            }
          } else {
            this.deps.logger.warn({ bitbrowserId: id }, '开窗登记超时且窗口不存在，清理 opening 残留')
            await this.clearWindowRow(id)
            if (profile) this.forgetWindow(profile.id)
            this.openingSince.delete(id)
          }
        } else {
          openingReservations.add(id)
        }
        continue
      }
      if (row.state === 'closing') {
        this.openingSince.delete(id)
        if (!live.has(id)) {
          await this.clearWindowRow(id)
          this.closingSince.delete(id)
          if (profile) this.forgetWindow(profile.id)
          continue
        }
        const since = this.closingSince.get(id) ?? nowMs
        this.closingSince.set(id, since)
        if (nowMs - since >= CLOSING_RETRY_MS && profile) {
          this.deps.logger.warn({ bitbrowserId: id }, 'closing 登记仍存活，重试关窗')
          await this.closeWindow(profile, '关闭超时重试', { retryClosing: true })
          // 重试后若仍未清行，重新计时；已清行则在 turn 末清理 closingSince
          this.closingSince.set(id, nowMs)
        }
        continue
      }
      // state = open
      this.openingSince.delete(id)
      this.closingSince.delete(id)
      if (!live.has(id)) {
        await this.clearWindowRow(id)
        if (profile) this.forgetWindow(profile.id)
      }
    }
    for (const id of [...this.openingSince.keys()]) if (!rowIds.has(id)) this.openingSince.delete(id)
    for (const id of [...this.closingSince.keys()]) if (!rowIds.has(id) || !live.has(id)) this.closingSince.delete(id)
    return { live, openingReservations, profiles, byBitbrowserId }
  }

  /**
   * 比特 API 探测失败：非 paused 时立即暂停全局健康；告警与退避升级按 30s 限频，
   * 避免每秒失败把退避级别迅速拉到上限、刷爆日志。
   */
  private recordApiFailure(nowMs: number, error: string): void {
    const shouldEscalate = this.deps.health.state !== 'paused'
    const shouldLog = nowMs - this.lastApiFailureAt >= API_FAILURE_THROTTLE_MS
    if (shouldEscalate || shouldLog) {
      this.lastApiFailureAt = nowMs
      this.deps.health.recordGlobalFailure(nowMs)
      this.deps.logger.warn(
        { err: error, globalHealth: this.deps.health.state, nextProbeMs: this.deps.health.nextProbeMs },
        '比特窗口存活探测失败，全局健康暂停',
      )
    }
  }

  /** 暂停/临界等提前返回路径的状态统计：反映真实到期窗口数与任务数 */
  private async pendingStatus(
    date: string,
    nowMs: number,
    hasDue: boolean,
  ): Promise<{ queueWindows: number; pendingTasks: number }> {
    if (!hasDue) return { queueWindows: 0, pendingTasks: 0 }
    const [queue, pendingTasks] = await Promise.all([
      this.deps.db.listPendingWindowKeys(date, nowMs),
      this.deps.db.countDueRuns(date, nowMs),
    ])
    return { queueWindows: queue.length, pendingTasks }
  }

  /** 探测租约到期：未启动则重新退避；会话超时保守重新退避（不 hard kill 运行中会话） */
  private expireProbeLease(nowMs: number): void {
    if (!this.probeLease) return
    // 探测状态已被手动恢复/其它路径改写：丢弃过期租约，不再反向暂停
    if (this.deps.health.state !== 'probing') {
      this.probeLease = null
      return
    }
    if (nowMs < this.probeLease.deadlineMs) return
    const started = this.probeLease.profileId != null
    this.probeLease = null
    this.deps.logger.warn({ started }, '全局健康探测租约到期，重新退避')
    this.deps.health.recordProbeFailure(nowMs)
  }

  /** 池窗口空闲时关闭一个（健康暂停/critical 路径；任务保持 pending 等恢复） */
  private async closeOneIdlePoolWindow(reason: string): Promise<boolean> {
    const poolRows = await this.deps.db.listPoolWindows()
    if (poolRows.length === 0) return false
    const profiles = await this.loadProfiles()
    const byBitbrowserId = new Map([...profiles.values()].map((p) => [p.bitbrowserId, p]))
    for (const row of poolRows) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (!profile) {
        await this.clearWindowRow(row.bitbrowserId)
        continue
      }
      if (this.inFlight.has(profile.id)) continue
      await this.closeWindow(profile, reason)
      return true
    }
    return false
  }

  /** 无到期任务时：先按寿命/任务数到限关闭，再按空闲时长关闭（每 tick 最多 1 个） */
  private async closeOneOverdue(
    nowMs: number,
    poolRows: OpenWindowPoolRow[],
    byBitbrowserId: Map<string, ProfileRow>,
  ): Promise<boolean> {
    for (const row of poolRows) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (!profile) {
        await this.clearWindowRow(row.bitbrowserId)
        continue
      }
      if (this.inFlight.has(profile.id)) continue
      if (!this.openSince.has(profile.id)) this.openSince.set(profile.id, nowMs)
      const reason = this.capCloseReason(row, profile.id, nowMs)
      if (reason) {
        await this.closeWindow(profile, reason)
        return true
      }
    }
    for (const row of poolRows) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (!profile || this.inFlight.has(profile.id)) continue
      this.occupiedSince.delete(profile.id)
      if (!this.idleSince.has(profile.id)) {
        this.idleSince.set(profile.id, nowMs)
        continue
      }
      const idleMs = nowMs - (this.idleSince.get(profile.id) ?? nowMs)
      if (this.deps.cfg.idleCloseSec > 0 && idleMs >= this.deps.cfg.idleCloseSec * 1000) {
        await this.closeWindow(profile, '空闲超时关闭池窗口')
        return true
      }
    }
    return false
  }

  /**
   * 轮转：池已无补位空间（容量/内存已满）且队列里还有非池窗口等待时，关闭一个空闲池窗口让位；
   * 无队列时按 idleCloseSec 回收。有任务集的窗口不关。
   */
  private async rotateOrCloseIdle(
    nowMs: number,
    poolRows: OpenWindowPoolRow[],
    pendingByWindow: Map<number, RunRow[]>,
    queue: Array<{ profileId: number; oldestQueuedAt: string | null }>,
    waitingNonPool: Array<{ profileId: number; oldestQueuedAt: string | null }>,
    effectivePool: number,
    actualOpen: number,
    openingReservations: Set<string>,
    byBitbrowserId: Map<string, ProfileRow>,
  ): Promise<boolean> {
    const projectedOpen = actualOpen + openingReservations.size
    const idleWithNoTasks = poolRows.filter((row) => {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      return !!profile && !this.inFlight.has(profile.id) && (pendingByWindow.get(profile.id) ?? []).length === 0
    })
    for (const row of idleWithNoTasks) {
      const profile = byBitbrowserId.get(row.bitbrowserId)!
      this.occupiedSince.delete(profile.id)
    }
    if (waitingNonPool.length > 0 && projectedOpen >= effectivePool) {
      const row = idleWithNoTasks[0]
      if (row) {
        await this.closeWindow(byBitbrowserId.get(row.bitbrowserId)!, '空闲窗口轮转让位')
        return true
      }
    }
    if (waitingNonPool.length === 0) {
      for (const row of idleWithNoTasks) {
        const profile = byBitbrowserId.get(row.bitbrowserId)!
        if (!this.idleSince.has(profile.id)) {
          this.idleSince.set(profile.id, nowMs)
          continue
        }
        const idleMs = nowMs - (this.idleSince.get(profile.id) ?? nowMs)
        if (this.deps.cfg.idleCloseSec > 0 && idleMs >= this.deps.cfg.idleCloseSec * 1000) {
          await this.closeWindow(profile, '空闲超时关闭池窗口')
          return true
        }
      }
    }
    return false
  }

  /** 队列候选：最早排队的窗口，排除池内/在途/正在打开/已实测存活的窗口 */
  private pickQueueCandidate(
    queue: Array<{ profileId: number; oldestQueuedAt: string | null }>,
    poolRows: OpenWindowPoolRow[],
    profiles: Map<number, ProfileRow>,
    byBitbrowserId: Map<string, ProfileRow>,
    live: Set<string>,
    openingReservations: Set<string>,
    nowMs: number,
  ): { profileId: number; oldestQueuedAt: string | null } | null {
    const waiting = this.collectWaitingNonPool(queue, poolRows, profiles, byBitbrowserId, live, openingReservations, nowMs)
    return waiting[0] ?? null
  }

  /** 队列中尚未在池/未在途/未打开（非池）的窗口，按队列顺序 */
  private collectWaitingNonPool(
    queue: Array<{ profileId: number; oldestQueuedAt: string | null }>,
    poolRows: OpenWindowPoolRow[],
    profiles: Map<number, ProfileRow>,
    byBitbrowserId: Map<string, ProfileRow>,
    live: Set<string>,
    openingReservations: Set<string>,
    nowMs: number,
  ): Array<{ profileId: number; oldestQueuedAt: string | null }> {
    const poolIds = new Set<number>()
    for (const row of poolRows) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (profile) poolIds.add(profile.id)
    }
    return queue.filter((item) => {
      const profile = profiles.get(item.profileId)
      if (!profile) return false
      if (this.isWindowBreakerBlocked(profile, nowMs)) return false
      if (poolIds.has(profile.id) || this.inFlight.has(profile.id) || this.opening.has(profile.id)) return false
      // 已实测存活（manual/taskrun/未登记外部窗口）或已有 opening 预留的窗口不复用也不重复开
      if (live.has(profile.bitbrowserId) || openingReservations.has(profile.bitbrowserId)) return false
      return true
    })
  }

  /** 寿命/任务数回收原因（0 表示关闭该策略；返回 null 表示未到限） */
  private capCloseReason(row: OpenWindowPoolRow, profileId: number, nowMs: number): string | null {
    const { windowMaxTasks, windowMaxLifetimeSec } = this.deps.cfg
    if (windowMaxTasks > 0 && row.tasksDone >= windowMaxTasks) return '达到单窗口任务上限'
    const since = this.openSince.get(profileId)
    if (windowMaxLifetimeSec > 0 && since != null && nowMs - since >= windowMaxLifetimeSec * 1000) {
      return '达到单窗口最长存活时间'
    }
    return null
  }

  /** 连续占用是否超过 cohortMaxSec（0 表示关闭该策略） */
  private cohortExceeded(profileId: number, nowMs: number): boolean {
    const cohortMs = this.deps.cfg.cohortMaxSec
    if (cohortMs <= 0) return false
    const since = this.occupiedSince.get(profileId)
    return since != null && nowMs - since >= cohortMs * 1000
  }

  /**
   * 窗口级熔断是否仍在冷却：只有 open 且 nextProbeMs 在未来才跳过；
   * nextProbeMs 为空或已到期时放行一次会话，让 WindowRunner.claimWindowProbe 转为 half_open 探测。
   */
  private isWindowBreakerBlocked(profile: ProfileRow, nowMs: number): boolean {
    if (profile.circuitBreakerState !== 'open') return false
    const next = profile.circuitBreakerNextProbeMs
    return next != null && next > nowMs
  }

  /** half-open 探测：优先复用空闲池窗口；否则在硬上限/冷却/非 critical 内存下最多开 1 个 */
  private async startProbeSession(
    nowMs: number,
    poolRows: OpenWindowPoolRow[],
    pendingByWindow: Map<number, RunRow[]>,
    queue: Array<{ profileId: number; oldestQueuedAt: string | null }>,
    profiles: Map<number, ProfileRow>,
    byBitbrowserId: Map<string, ProfileRow>,
    live: Set<string>,
    openingReservations: Set<string>,
    effectivePool: number,
  ): Promise<boolean> {
    for (const row of poolRows) {
      const profile = byBitbrowserId.get(row.bitbrowserId)
      if (!profile || this.inFlight.has(profile.id)) continue
      if (this.isWindowBreakerBlocked(profile, nowMs)) continue
      const pending = pendingByWindow.get(profile.id) ?? []
      if (pending.length === 0) continue
      const claimed = await this.deps.db.claimQueuedRuns([pending[0].id], nowMs)
      if (claimed.length === 0) continue
      this.idleSince.delete(profile.id)
      this.probeLease = { profileId: profile.id, deadlineMs: nowMs + PROBE_SESSION_LEASE_MS }
      this.startSession(profile, claimed[0], { opening: false, probe: true })
      return true
    }
    const projectedOpen = live.size + openingReservations.size
    if (
      queue.length > 0
      && projectedOpen < effectivePool
      && nowMs - this.lastOpenAt >= this.deps.cfg.openCooldownMs
    ) {
      const candidate = this.pickQueueCandidate(queue, poolRows, profiles, byBitbrowserId, live, openingReservations, nowMs)
      if (candidate) {
        const profile = profiles.get(candidate.profileId)
        if (profile) {
          const pending = await this.deps.db.listPendingRunsForWindow(profile.id, todayStr(new Date(nowMs)), nowMs)
          if (pending.length > 0) {
            const claimed = await this.deps.db.claimQueuedRuns([pending[0].id], nowMs)
            if (claimed.length > 0) {
              this.lastOpenAt = nowMs
              this.openSince.set(profile.id, nowMs)
              this.probeLease = { profileId: profile.id, deadlineMs: nowMs + PROBE_SESSION_LEASE_MS }
              this.startSession(profile, claimed[0], { opening: true, probe: true })
              return true
            }
          }
        }
      }
    }
    return false
  }

  /** 启动一次单任务 keep-open 会话；不阻塞 tick，结束后按结果决定是否回收窗口 */
  private startSession(profile: ProfileRow, row: RunRow, opts: SessionStartOptions): void {
    this.inFlight.add(profile.id)
    if (opts.opening) this.opening.add(profile.id)
    if (!this.occupiedSince.has(profile.id)) this.occupiedSince.set(profile.id, this.now().getTime())
    const task: SessionTask = {
      taskKey: row.taskKey,
      date: row.date,
      ...(row.batchId == null ? {} : { batchId: row.batchId }),
    }
    this.deps.logger.info(
      { profile: profile.name, task: row.taskKey, poolState: this.deps.health.state, probe: opts.probe, manual: opts.manual === true },
      '窗口池分配任务',
    )
    // 包一层 Promise.resolve：runner 同步抛错也走统一 catch/回队路径
    let called: Promise<Map<string, RunRow | null>>
    try {
      called = Promise.resolve(this.deps.runner.runWindowTasks(profile, [task], {
        keepWindowOpen: true,
        manualReused: opts.manual === true,
      }))
    } catch (e) {
      called = Promise.reject(e)
    }
    const chain = called
      .then(async (results) => {
        await this.afterSession(profile, row, results, opts.probe, opts.manual === true)
      })
      .catch(async (e) => {
        const message = (e as Error).message
        this.deps.logger.error({ err: message, profile: profile.name }, '窗口池会话异常')
        // 异常时认领行可能仍为 running/环境终态：两种回队路径都走一遍，避免永久占位
        try {
          await this.deps.db.requeueClaimedRuns([row.id], message, this.now().getTime() + REQUEUE_BACKOFF_MS)
          await this.deps.db.requeueEnvironmentRun(row.id, this.now().getTime() + REQUEUE_BACKOFF_MS, message)
        } catch (err) {
          this.deps.logger.warn({ err: (err as Error).message }, '会话异常后任务行回队失败')
        }
        if (opts.probe) {
          this.probeLease = null
          this.deps.health.recordProbeFailure(this.now().getTime())
        }
        // 手动窗口不自动关闭：只回队任务，窗口留给用户/后续任务
        if (opts.manual !== true) await this.closeWindow(profile, '会话异常，回收池窗口')
      })
    let tracked!: Promise<void>
    tracked = chain.finally(() => {
      this.inFlight.delete(profile.id)
      // opening 只代表开窗请求在途：会话结束后撤销额度预留（真实存活窗口由 reconcile 重新接管）
      this.opening.delete(profile.id)
      if (this.probeLease?.profileId === profile.id) this.probeLease = null
      this.sessionPromises.delete(tracked)
      this.requestTick()
    })
    this.sessionPromises.add(tracked)
  }

  /**
   * 会话结束：环境级失败退回 pending 并退避 + 关闭窗口并计入全局健康；
   * 任务级失败说明窗口本身可用，窗口保持打开继续接下一个任务；
   * half-open 探测只有「真实完成且非 skipped/empty」才算成功。
   */
  private async afterSession(
    profile: ProfileRow,
    claimedRow: RunRow,
    results: Map<string, RunRow | null>,
    probe: boolean,
    manual: boolean,
  ): Promise<void> {
    const rows = [...results.values()].filter((row): row is RunRow => row != null)
    const environmentFailure = rows.some((row) => row.failureKind === 'environment')
    const nowMs = this.now().getTime()
    if (environmentFailure) {
      // 环境失败不是任务失败：把本轮已终态的环境失败行退回 pending（退避后重排）
      for (const row of rows) {
        if (row.failureKind !== 'environment') continue
        try {
          await this.deps.db.requeueEnvironmentRun(row.id, nowMs + REQUEUE_BACKOFF_MS, row.error ?? '环境失败，重新排队')
        } catch (e) {
          this.deps.logger.warn({ err: (e as Error).message, runId: row.id }, '环境失败行回队失败')
        }
      }
      if (probe) {
        this.probeLease = null
        this.deps.health.recordProbeFailure(nowMs)
      } else {
        this.deps.health.recordEnvironmentFailure(profile.bitbrowserId, nowMs)
      }
      // 手动窗口不自动关闭：环境失败也只回队任务，窗口留给用户
      if (!manual) await this.closeWindow(profile, '环境失败，回收池窗口')
      return
    }

    if (probe) {
      const outcome = probeOutcome(rows)
      this.probeLease = null
      if (outcome === 'failure') {
        // skipped/empty/手动停止/熔断 都不算探测成功；空结果时认领行可能仍是 running，先回队
        if (rows.length === 0) {
          try {
            await this.deps.db.requeueClaimedRuns([claimedRow.id], '探测未执行，重新排队', nowMs + REQUEUE_BACKOFF_MS)
          } catch (e) {
            this.deps.logger.warn({ err: (e as Error).message }, '探测未执行行回队失败')
          }
        }
        this.deps.health.recordProbeFailure(nowMs)
        if (!manual) await this.closeWindow(profile, '探测未成功，回收池窗口')
        return
      }
      this.deps.health.recordProbeSuccess()
    }

    // 普通会话没有返回该任务行（runner 异常被吞/停止竞态等）：把仍为 running 的认领行退回 pending。
    // requeueClaimedRuns 带 status='running' CAS，已终态行不会被覆盖。
    if (results.get(claimedRow.taskKey) == null) {
      try {
        await this.deps.db.requeueClaimedRuns([claimedRow.id], '会话未返回任务结果，重新排队', nowMs + REQUEUE_BACKOFF_MS)
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message, runId: claimedRow.id }, '会话空结果行回队失败')
      }
    }

    let windowState: string | null = null
    try {
      windowState = (await this.deps.db.getWindowHealth(profile.id)).state
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message, profile: profile.name }, '读取窗口健康状态失败')
    }
    if (windowState === 'open' && !manual) await this.closeWindow(profile, '窗口熔断，回收池窗口')
  }

  /**
   * 关闭池窗口并清理本进程内存态。关窗失败/未确认时保留登记与状态，交给 reconcile 的 closing 重试；
   * 已无登记（执行器环境失败时已自行关窗）则直接清理，避免重复关窗。
   * @param retryClosing true 表示 reconciler 的关闭超时重试，允许对 closing 行再次发起关窗
   */
  private async closeWindow(profile: ProfileRow, reason: string, opts?: { retryClosing?: boolean }): Promise<boolean> {
    const existing = await this.deps.db.getOpenWindow(profile.bitbrowserId).catch(() => null)
    if (!existing) {
      this.forgetWindow(profile.id)
      return true
    }
    // 执行器已进入 closing（环境失败时自行关窗）：不立即重复关，交给 reconciler 超时重试
    if (existing.state === 'closing' && !opts?.retryClosing) {
      this.deps.logger.info({ profile: profile.name }, '窗口已在关闭中，跳过重复关窗')
      return false
    }
    this.deps.logger.info({ profile: profile.name, reason }, '关闭池窗口')
    try {
      await this.deps.runner.closePoolWindow(profile, reason)
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message, profile: profile.name }, '关闭池窗口失败，保留登记下轮重试')
      return false
    }
    const remaining = await this.deps.db.getOpenWindow(profile.bitbrowserId).catch(() => null)
    if (remaining) {
      this.deps.logger.warn({ profile: profile.name, state: remaining.state }, '关窗未确认，保留登记待对账重试')
      return false
    }
    this.forgetWindow(profile.id)
    return true
  }

  private async clearWindowRow(bitbrowserId: string): Promise<void> {
    try {
      await this.deps.db.clearOpenWindow(bitbrowserId)
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message, bitbrowserId }, '清理失效窗口登记失败')
    }
  }

  private forgetWindow(profileId: number): void {
    this.openSince.delete(profileId)
    this.idleSince.delete(profileId)
    this.occupiedSince.delete(profileId)
  }

  private sampleFreeMb(): number {
    const injected = this.deps.freeMemMb
    if (injected) return Math.max(0, injected())
    return Math.max(0, freemem() / MB)
  }

  private async loadProfiles(): Promise<Map<number, ProfileRow>> {
    return new Map((await this.deps.db.listProfiles(false)).map((p) => [p.id, p]))
  }

  /** 记录状态快照；仅状态特征变化时打日志，避免每秒刷屏 */
  private recordStatus(input: {
    memoryState: MemoryState
    healthState: GlobalHealthState
    freeMb: number
    perWindowMb: number
    effectivePool: number
    actualOpen: number
    poolSize: number
    queueWindows: number
    pendingTasks: number
    nowMs: number
  }): void {
    const busy = this.inFlight.size
    this.status = {
      memoryState: input.memoryState,
      globalHealthState: input.healthState,
      freeMb: Math.round(input.freeMb),
      perWindowMb: input.perWindowMb,
      effectivePool: input.effectivePool,
      maxOpenWindows: this.deps.cfg.maxOpenWindows,
      actualOpen: input.actualOpen,
      poolSize: input.poolSize,
      busy,
      idle: Math.max(0, input.poolSize - busy),
      opening: this.openingReservationCount,
      queueWindows: input.queueWindows,
      pendingTasks: input.pendingTasks,
      updatedAt: new Date(input.nowMs).toISOString(),
    }
    const signature = [
      this.status.memoryState,
      this.status.globalHealthState,
      this.status.actualOpen,
      this.status.effectivePool,
      this.status.poolSize,
      this.status.busy,
      this.status.queueWindows,
      this.status.pendingTasks,
    ].join('|')
    if (signature === this.lastStatusSignature) return
    this.lastStatusSignature = signature
    this.deps.logger.info(
      {
        memoryState: this.status.memoryState,
        healthState: this.status.globalHealthState,
        freeMb: this.status.freeMb,
        effectivePool: this.status.effectivePool,
        actualOpen: this.status.actualOpen,
        poolSize: this.status.poolSize,
        busy: this.status.busy,
        idle: this.status.idle,
        queueWindows: this.status.queueWindows,
        pendingTasks: this.status.pendingTasks,
      },
      '窗口池状态变化',
    )
  }
}

/**
 * 探测结果分类：只有 success 或任务级 failed/retry_wait 才算环境可用；
 * skipped（手动停止/熔断/窗口跳过）与空结果一律视为探测失败，避免误恢复全局健康。
 */
function probeOutcome(rows: RunRow[]): 'success' | 'failure' {
  if (rows.length === 0) return 'failure'
  if (rows.some((row) => row.failureKind === 'environment')) return 'failure'
  if (rows.some((row) => row.status === 'skipped')) return 'failure'
  if (rows.some((row) => row.status === 'success' || row.status === 'failed' || row.status === 'retry_wait')) {
    return 'success'
  }
  return 'failure'
}

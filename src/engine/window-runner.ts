/**
 * 窗口执行器（engine 层）：一次完整窗口会话的编排——开窗 → CDP 接管 → 逐个跑任务 → 关窗
 * 依赖方向：依赖 integrations/automation/infrastructure，被 app 顶层装配；不依赖 server 层
 *
 * 会话正流程（runWindowTasks）：
 *   1) 预写 pending 行（批次/错峰期面板即可见；续跑行不动，batch_id 只在此写）
 *   2) 复用探测（reuseOpen 命中则直接取调试地址）或开窗（openWithRetry 退避重试）
 *   3) CDP 连接（PatchrightDriver 接管首个非扩展 page）
 *   4) 建窗口级 WalletSession → 逐任务 runTask（窗口截止时间与熔断双重守卫）
 *   5) finally 先关 CDP 连接再关窗口（复用窗口不关）
 *
 * 失败分支（三段 try 把异常分区为不同终态）：
 *   开窗重试耗尽 → 全部任务 skipped（环境问题，重试无意义）
 *   CDP 连接失败 → 全部任务 failed（窗口已开但接管失败）
 *   任务执行异常 → 按状态机逐任务落状态 + 截图 + 诊断包（不影响同窗口后续任务）
 *
 * 关键参数：cfg.execution.windowTimeoutMs（窗口级截止）、circuitBreakerThreshold（窗口级熔断阈值）、
 *   task.meta.timeoutSec / retry.max / retry.backoffSec（任务级超时与重试，缺省回落全局 execution.*）
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'patchright'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import { AppDb, todayStr, localWallNow, localWallFromMs, type ProfileRow, type RunRow, type CircuitBreakerPolicy, type WindowHealth } from '../infrastructure/db'
import type { BitBrowserClient, OpenResult } from '../integrations/bitbrowser'
import { nextStateAfterFailure } from './state'
import { classifyFailure } from './failure'
import { TaskTimeoutError, type FailureKind } from '../infrastructure/run-errors'
import { TaskContext } from './task-context'
import { reclaimOrphanWindows } from './window-registry'
import type { TaskMeta } from './task'
import type { SessionTask } from './queue'
import type { CancelRegistry } from './cancel-registry'
import { WalletSession, type WalletRegistry } from '../automation'
import { createAiClient, type AiClient } from '../integrations/ai'

/**
 * 开窗失败兜底关窗延迟（毫秒）：/browser/open 是异步的，HTTP 超时报错时窗口可能仍在打开，
 * 此时立即 closeBrowser 多半失败（窗口"正在打开中"），等它开完再补关一次，避免残留孤儿窗口。
 */
const DELAYED_FALLBACK_CLOSE_MS = 90000
/** 跨进程全局窗口上限：等待轮询间隔（毫秒） */
const CAPACITY_POLL_MS = 5000
/** 跨进程全局窗口上限：单次等待总预算（毫秒；超出则放行并告警，不无限阻塞会话） */
const CAPACITY_WAIT_MS = 10 * 60 * 1000

/** 窗口健康状态缺省值（库读取失败时按正常窗口处理） */
const CLOSED_WINDOW_HEALTH: WindowHealth = {
  state: 'closed',
  failures: 0,
  level: 0,
  nextProbeMs: null,
  probeStartedMs: null,
  reason: null,
  updatedAt: null,
}
const DEFAULT_BREAKER_THRESHOLD = 2
const DEFAULT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000
const DEFAULT_BREAKER_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000

/** 熔断配置字段（配置层已提供，保留局部类型便于测试注入缺省字段） */
type BreakerConfigFields = {
  circuitBreakerEnabled?: boolean
  circuitBreakerCooldownSec?: number
  circuitBreakerMaxCooldownSec?: number
}

/**
 * 探测租约时长：覆盖整个窗口会话（含跨进程额度等待）并留余量，
 * 避免探测期间其它会话误抢；供 runner 与启动恢复共用，保证两端口径一致
 */
export function windowProbeLeaseMs(cfg: AppConfig): number {
  return cfg.execution.windowTimeoutMs + CAPACITY_WAIT_MS + 10 * 60 * 1000
}

/** 浏览器连接抽象：测试注入假驱动，生产用 PatchrightDriver */
export interface BrowserDriver {
  connect(endpointUrl: string): Promise<{ page: Page; close(): Promise<void> }>
}

/**
 * 真实驱动：经 CDP 接管比特浏览器已开窗口（复用首个 context 与首个 page）
 * 页面选择避开扩展弹窗页（chrome-extension://）：上次会话遗留的钱包弹窗可能排在 pages()[0]，
 * 弹窗关闭后任务页面随之关闭 → 全部操作报 Target closed（真机实测 portal-rhuna 多窗口失败根因）
 */
export class PatchrightDriver implements BrowserDriver {
  async connect(endpointUrl: string): Promise<{ page: Page; close(): Promise<void> }> {
    const browser = await chromium.connectOverCDP(endpointUrl)
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const pages = context.pages()
    const page = pages.find((p) => !p.url().startsWith('chrome-extension://')) ?? pages[0] ?? (await context.newPage())
    return {
      page,
      close: async () => {
        await browser.close().catch(() => {})
      },
    }
  }
}

/** WindowRunner 的全部依赖（app 层装配注入） */
export interface WindowRunnerDeps {
  cfg: AppConfig
  db: AppDb
  bitbrowser: BitBrowserClient
  driver: BrowserDriver
  tasks: Map<string, { meta: TaskMeta; run(ctx: TaskContext): Promise<void> }>
  wallets: WalletRegistry
  logger: Logger
  artifactsDir: string
  /** 钱包解锁密码映射（key 为钱包类型，如 metamask/petra，透传给 TaskContext） */
  walletPasswords: Record<string, string>
  /** AI 客户端（透传给 TaskContext；未注入时仅当 cfg.ai.apiKey 非空才构建，缺 key 时为 undefined） */
  ai?: AiClient
  /**
   * 重试退避调度（不占窗口）：retry_wait 后由装配层 setTimeout 到期重新入队，
   * 当前窗口立即继续下一个任务/正常关窗；batchId 沿用原批次（重试不产生新批次）
   */
  scheduleRetry: (profile: ProfileRow, taskKey: string, delayMs: number, batchId?: number) => void
  /**
   * 数据源行解析（app 层装配注入）：按窗口取数据源行（列名 -> 值）；
   * 返回 null 表示无映射（任务侧 faker 兜底）；未注入时任务 accountRow 恒为 null
   */
  accountResolver?: (profile: ProfileRow) => Promise<Record<string, string> | null>
  /**
   * 取消标记注册表（app 装配注入）：会话开始前消费「已请求停止」的任务（跳过、不开窗），
   * 任务失败 catch 时消费（落 skipped「手动停止」，不重试、不计熔断）；未注入时行为不变
   */
  cancelRegistry?: CancelRegistry
  /**
   * 窗口复用探测（app 层装配注入）：已登记打开状态（open_windows 表）且调用方实测存活时
   * 返回该窗口调试地址——本轮会话直接复用（不重新开窗、结束后也不关窗）；
   * 返回 null 走正常开窗/关窗流程。未注入时行为不变（恒不开窗复用）
   */
  reuseOpen?: (bitbrowserId: string) => Promise<{ http: string } | null>
}

export class WindowRunner {
  /** 会话共享的 AI 客户端：显式注入优先；否则仅当 cfg.ai.apiKey 非空才构建（缺 key 时为 undefined，便于任务侧判空） */
  private readonly ai: AiClient | undefined

  constructor(private deps: WindowRunnerDeps) {
    this.ai = deps.ai ?? (deps.cfg.ai.apiKey ? createAiClient(deps.cfg.ai) : undefined)
  }

  /**
   * 降级策略：任务执行中的数据库写失败不能杀死执行（写失败时任务照跑）
   * try/catch + logger.warn 后返回 fallback，读取路径按"无记录"处理（fallback null）
   */
  private async safeDb<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message }, '数据库操作失败，已降级继续执行')
      return fallback
    }
  }

  /** 熔断开关（缺省开启；配置层后续提供该字段） */
  private breakerEnabled(): boolean {
    const e = this.deps.cfg.execution as typeof this.deps.cfg.execution & BreakerConfigFields
    return e.circuitBreakerEnabled !== false
  }

  /** 调试逃生：FORCE_BREAKER=1 绕过健康门禁与失败记录 */
  private forceBreaker(): boolean {
    return process.env.FORCE_BREAKER === '1'
  }

  /** 熔断策略（配置缺省/非法值回落默认，冷却上限不小于首次冷却） */
  private breakerPolicy(): CircuitBreakerPolicy {
    const e = this.deps.cfg.execution as typeof this.deps.cfg.execution & BreakerConfigFields
    const threshold = Number.isInteger(e.circuitBreakerThreshold) && e.circuitBreakerThreshold >= 1
      ? e.circuitBreakerThreshold
      : DEFAULT_BREAKER_THRESHOLD
    const cooldownMs = Number.isFinite(e.circuitBreakerCooldownSec) && (e.circuitBreakerCooldownSec ?? 0) >= 60
      ? (e.circuitBreakerCooldownSec as number) * 1000
      : DEFAULT_BREAKER_COOLDOWN_MS
    const configuredMax = Number.isFinite(e.circuitBreakerMaxCooldownSec) && (e.circuitBreakerMaxCooldownSec ?? 0) * 1000 >= cooldownMs
      ? (e.circuitBreakerMaxCooldownSec as number) * 1000
      : DEFAULT_BREAKER_MAX_COOLDOWN_MS
    // 上限不得低于首次冷却：注入配置可能把 cooldown 调大而漏配 max
    const maxCooldownMs = Math.max(cooldownMs, configuredMax)
    return { threshold, cooldownMs, maxCooldownMs }
  }

  /** 探测租约时长（与启动恢复共用同一口径） */
  private probeLeaseMs(): number {
    return windowProbeLeaseMs(this.deps.cfg)
  }

  /** 比特浏览器本地 API 是否健康（无该方法时按健康处理；探测异常按不健康处理，避免把全局故障算到单个窗口） */
  private async bitbrowserHealthy(): Promise<boolean> {
    const fn = this.deps.bitbrowser.health
    if (typeof fn !== 'function') return true
    try {
      return await fn.call(this.deps.bitbrowser)
    } catch {
      return false
    }
  }

  /** 熔断跳过原因（含下次探测 HH:mm） */
  private breakerSkipReason(health: WindowHealth): string {
    const next = health.nextProbeMs == null ? '待定' : localWallFromMs(health.nextProbeMs).slice(11, 16)
    return `窗口熔断：${health.reason ?? '环境失败'}（下次探测 ${next}）`
  }

  /** 整批任务按熔断跳过（不开窗） */
  private async skipAllAsBreaker(profile: ProfileRow, tasks: SessionTask[], date: string, reason: string): Promise<Map<string, RunRow | null>> {
    this.deps.logger.warn({ profile: profile.name, reason }, '窗口熔断中，跳过任务')
    const results = new Map<string, RunRow | null>()
    for (const t of tasks) {
      results.set(t.taskKey, await this.settleWindowSkip(profile, t.taskKey, date, 'skipped', reason, 'breaker'))
    }
    return results
  }

  /** 会话被手动停止：剩余任务按 stopped 结算（不计熔断、不重试） */
  private async settleSessionStopped(profile: ProfileRow, tasks: SessionTask[], date: string, results: Map<string, RunRow | null>): Promise<void> {
    for (const t of tasks) {
      results.set(t.taskKey, await this.settleWindowSkip(profile, t.taskKey, date, 'skipped', '手动停止', 'stopped'))
    }
  }

  /** 记录一次窗口环境失败并输出结构化日志（熔断关闭或调试逃生时不做任何事） */
  private async recordWindowFailure(profile: ProfileRow, reason: string): Promise<WindowHealth | null> {
    if (!this.breakerEnabled() || this.forceBreaker()) return null
    const next = await this.safeDb(() => this.deps.db.recordWindowEnvironmentFailure(profile.id, reason, this.breakerPolicy()), null)
    if (next) {
      this.deps.logger.warn({
        profile: profile.name,
        state: next.state,
        failures: next.failures,
        level: next.level,
        reason: next.reason,
        nextProbeAt: next.nextProbeMs == null ? null : localWallFromMs(next.nextProbeMs),
      }, '窗口环境失败计数')
    }
    return next
  }

  /** 任务成功关闭熔断；仅当此前不是 closed 时输出恢复日志 */
  private async recordWindowSuccess(profile: ProfileRow, previous: WindowHealth): Promise<WindowHealth> {
    const next = await this.safeDb(() => this.deps.db.recordWindowSuccess(profile.id), previous)
    if (next.state === 'closed' && previous.state !== 'closed') {
      this.deps.logger.info({ profile: profile.name }, '窗口健康恢复，关闭熔断')
    }
    return next
  }

  /**
   * 跑一个窗口的一次会话：本窗口当日所有 taskKeys 依次执行
   * 异常分区（见文件头注释）：开窗失败全部 skipped；连接失败全部 failed；
   * 熔断中的任务逐个 skipped；其余逐任务执行
   * @param profile 目标窗口记录（含 bitbrowserId、熔断计数、名称）
   * @param tasks 本轮要跑的任务（SessionTask：taskKey + 可选 batchId）
   * @returns 各任务本轮最终运行行（key → 行；DB 写失败降级时为 null）——
   * 内存传递供调用方（run-task 脚本等）直接取结果，避免执行后再读库的竞态
   */
  async runWindowTasks(profile: ProfileRow, tasks: SessionTask[]): Promise<Map<string, RunRow | null>> {
    const { cfg, db, bitbrowser, logger } = this.deps
    const date = todayStr()
    const results = new Map<string, RunRow | null>()
    const registry = this.deps.cancelRegistry
    // 会话级停止：停止任务时会关闭整窗，同会话剩余任务按手动停止结算，且不再开窗
    if (registry?.isSessionCancelled(profile.id)) {
      registry.clearSession(profile.id)
      await this.settleSessionStopped(profile, tasks, date, results)
      logger.info({ profile: profile.name }, '会话启动前已被停止，整窗任务跳过')
      return results
    }
    // 会话开始前消费取消标记：已请求停止的任务不跑（错峰/排队中的会话也不开窗、直接结束）
    const runTasks: SessionTask[] = []
    for (const t of tasks) {
      if (registry?.isCancelled(profile.id, t.taskKey)) {
        registry.clear(profile.id, t.taskKey)
        results.set(t.taskKey, await this.safeDb(() => this.deps.db.getLatestRun(profile.id, t.taskKey, date), null))
        logger.info({ profile: profile.name, task: t.taskKey }, '任务启动前已被停止，跳过')
        continue
      }
      runTasks.push(t)
    }
    if (runTasks.length === 0) return results
    // 预写 pending：新轮次任务落「待执行」行（批次看板在错峰/开窗期间即可见）；
    // 续跑行（retry_wait 等非终态）不动——重试沿用原行与批次；
    // batch_id 只在此写入，后续 upsert 一律不传（ON CONFLICT COALESCE 保留）
    for (const t of runTasks) {
      const existing = await this.safeDb(() => this.deps.db.getLatestRun(profile.id, t.taskKey, date), null)
      const terminal = existing ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(existing.status) : false
      if (existing && !terminal) continue
      const slot = await this.nextSlot(profile, t.taskKey, date)
      await this.safeDb(() => this.deps.db.upsertRun(profile.id, t.taskKey, date, slot, 'pending', { batchId: t.batchId ?? null }), null)
    }
    // 会话级停止标记必须在所有返回路径清理，避免泄漏到该窗口的下一次会话
    try {
      // 开窗前健康门禁：open 未到期直接跳过（不开窗）；open 到期或 half_open 先原子抢占探测租约
      const breakerOn = this.breakerEnabled() && !this.forceBreaker()
      let health: WindowHealth = CLOSED_WINDOW_HEALTH
      let probeClaimed = false
      let probeRetryReleased = false
      if (breakerOn) {
        health = await this.safeDb(() => db.getWindowHealth(profile.id), CLOSED_WINDOW_HEALTH)
        if (health.state === 'open' && health.nextProbeMs != null && health.nextProbeMs > Date.now()) {
          return await this.skipAllAsBreaker(profile, runTasks, date, this.breakerSkipReason(health))
        }
        if (health.state === 'open' || health.state === 'half_open') {
          const claimed = await this.safeDb(() => db.claimWindowProbe(profile.id, { leaseMs: this.probeLeaseMs() }), false)
          if (!claimed) {
            return await this.skipAllAsBreaker(profile, runTasks, date, `窗口熔断：探测进行中（${health.reason ?? '环境异常'}）`)
          }
          probeClaimed = true
          logger.info({ profile: profile.name, nextProbeAt: health.nextProbeMs == null ? null : localWallFromMs(health.nextProbeMs) }, '窗口熔断进入半开探测')
          health = { ...health, state: 'half_open' }
        }
      }
      let open: OpenResult | null = null
      // 复用已开窗口时跳过开窗/关窗（面板手动打开的窗口、task:run 复用场景）；
      // 复用地址失效会自然落入 CDP 连接失败 → failed 终态（可接受，见 app.ts 装配注释）
      let reusedFlag = false
      // 第一段 try：开窗（含重试）——失败即整窗口跳过，无浏览器可操作
      try {
        const reused = this.deps.reuseOpen ? await this.deps.reuseOpen(profile.bitbrowserId) : null
        if (reused) {
          open = { http: reused.http, ws: '' }
          reusedFlag = true
        } else {
          // 先预留归属登记（避免「已开未登记」竞态被其它进程的孤儿回收误关），再过跨进程闸门、开窗、补 http
          await this.deps.db.reserveOpenWindow(profile.bitbrowserId, process.pid)
          await this.waitForGlobalWindowCapacity()
          try {
            open = await this.openWithRetry(profile.bitbrowserId)
            await this.deps.db.setOpenWindow(profile.bitbrowserId, open.http, process.pid)
          } catch (e) {
            await this.deps.db.clearOpenWindow(profile.bitbrowserId).catch(() => {})
            throw e
          }
        }
      } catch (e) {
        // 停止导致的关窗会表现为开窗失败：按手动停止结算，不记环境失败（否则健康窗口会被误熔断）
        const sessionStopped = registry?.isSessionCancelled(profile.id) ?? false
        const message = sessionStopped ? '手动停止' : `开窗失败: ${(e as Error).message}`
        // 只有本地 API 健康时才把开窗失败算到该窗口（API 全局故障不熔断任何窗口）
        if (!sessionStopped && breakerOn && await this.bitbrowserHealthy()) {
          health = (await this.recordWindowFailure(profile, message)) ?? health
        }
        for (const t of runTasks) {
          results.set(t.taskKey, await this.settleWindowSkip(profile, t.taskKey, date, 'skipped', message, sessionStopped ? 'stopped' : 'environment'))
        }
        // 开窗"失败"的窗口可能仍在后台打开（open 异步 + "正在打开中"），延迟兜底补关一次，防止孤儿窗口堆积
        this.scheduleFallbackClose(profile.bitbrowserId)
        if (probeClaimed && !probeRetryReleased) {
          await this.safeDb(() => db.releaseWindowProbe(profile.id, 'aborted'), undefined)
          probeClaimed = false
        }
        logger.warn({ profile: profile.name, stopped: sessionStopped }, '开窗重试耗尽，本轮跳过')
        return results
      }
      let connected: { page: Page; close(): Promise<void> } | null = null
      // 第二段 try：连接/执行——finally 保证无论成败都关连接、关窗口
      try {
        // 内层 try：连接失败单独分区为 failed 终态
        try {
          connected = await this.deps.driver.connect(`http://${open.http}`)
        } catch (e) {
          const sessionStopped = registry?.isSessionCancelled(profile.id) ?? false
          const message = sessionStopped ? '手动停止' : `CDP 连接失败: ${(e as Error).message}`
          if (!sessionStopped && breakerOn) health = (await this.recordWindowFailure(profile, message)) ?? health
          for (const t of runTasks) {
            results.set(t.taskKey, await this.settleWindowSkip(profile, t.taskKey, date, sessionStopped ? 'skipped' : 'failed', message, sessionStopped ? 'stopped' : 'environment'))
          }
          if (probeClaimed && !probeRetryReleased) {
            await this.safeDb(() => db.releaseWindowProbe(profile.id, 'aborted'), undefined)
            probeClaimed = false
          }
          logger.error({ profile: profile.name, stopped: sessionStopped }, message)
          return results
        }
        const page = connected.page
        // 窗口会话级钱包扩展检测：每轮会话一个实例（内存态，会话结束即丢弃；
        // 扩展状态随浏览器实例重置，新会话必须重建）
        const walletSession = new WalletSession(page)
        // 第三段（循环内）：逐任务执行，失败只影响当前任务
        // 窗口级截止时间：到点后剩余任务标 skipped（异常卡死时保证并发槽位不被长时间占用）
        const deadline = Date.now() + cfg.execution.windowTimeoutMs
        for (let i = 0; i < runTasks.length; i++) {
          const key = runTasks[i].taskKey
          // 停止发生在当前循环检查之后、任务开始之前：剩余任务全部按手动停止结算
          if (registry?.isSessionCancelled(profile.id)) {
            await this.settleSessionStopped(profile, runTasks.slice(i), date, results)
            logger.info({ profile: profile.name }, '会话已被停止，剩余任务跳过')
            break
          }
          if (Date.now() >= deadline) {
            for (const rest of runTasks.slice(i)) {
              results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', '窗口超时', 'timeout'))
            }
            logger.warn({ profile: profile.name }, '窗口超时，剩余任务跳过')
            break
          }
          if (breakerOn && health.state === 'open') {
            for (const rest of runTasks.slice(i)) {
              results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', this.breakerSkipReason(health), 'breaker'))
            }
            break
          }
          const row = await this.runTask(profile, key, page, date, walletSession)
          results.set(key, row)
          // 停止发生在任务执行期间：当前行已由 runTask 按 stopped 结算，剩余任务不再执行
          if (registry?.isSessionCancelled(profile.id)) {
            await this.settleSessionStopped(profile, runTasks.slice(i + 1), date, results)
            logger.info({ profile: profile.name }, '会话已被停止，剩余任务跳过')
            break
          }
          if (!row) continue

          if (row.status === 'success') {
            // 成功即说明窗口健康：即使 FORCE_BREAKER 调试也允许清零；熔断总开关关闭时不参与健康逻辑
            if (this.breakerEnabled() || this.forceBreaker()) {
              health = await this.recordWindowSuccess(profile, health)
              // 成功已清空 probe_started_ms，租约无需再释放
              if (health.state === 'closed') probeClaimed = false
            }
            continue
          }
          if (!breakerOn) continue

          if (row.status === 'failed' && row.failureKind === 'environment') {
            health = (await this.recordWindowFailure(profile, row.error ?? '环境失败')) ?? health
            // 环境终态失败已重新打开熔断并清空租约
            if (health.state !== 'half_open') probeClaimed = false
          } else if (health.state === 'half_open' && (row.status === 'failed' || row.status === 'retry_wait') && (row.failureKind === 'task' || row.failureKind === 'timeout')) {
            // 半开探测成功完成（任务级失败/超时说明窗口本身可用）：关闭熔断
            health = await this.recordWindowSuccess(profile, health)
            if (health.state === 'closed') probeClaimed = false
          } else if (health.state === 'half_open' && row.status === 'retry_wait' && row.failureKind === 'environment') {
            // 环境失败仍在重试预算内：保持 half_open，释放租约等待下一轮探测，剩余任务本轮跳过
            await this.safeDb(() => db.releaseWindowProbe(profile.id, 'retry'), undefined)
            probeRetryReleased = true
            probeClaimed = false
            for (const rest of runTasks.slice(i + 1)) {
              results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', '窗口探测环境失败，等待重试', 'breaker'))
            }
            break
          }

          if (health.state === 'open') {
            for (const rest of runTasks.slice(i + 1)) {
              results.set(rest.taskKey, await this.settleWindowSkip(profile, rest.taskKey, date, 'skipped', this.breakerSkipReason(health), 'breaker'))
            }
            break
          }
        }
        return results
      } finally {
        // 无论成功失败：先关 CDP 连接再关窗口（顺序反了会残留进程）
        if (connected) await connected.close().catch(() => {})
        // 复用（面板/脚本已打开的窗口）不关闭：只关本轮会话自己打开的窗口；关窗失败记日志，便于发现残留
        if (!reusedFlag && open) {
          await this.closeWindowSafely(profile.bitbrowserId, '会话结束')
          await this.deps.db.clearOpenWindow(profile.bitbrowserId).catch(() => {})
        }
        // 探测租约兜底释放：异常路径（任务循环抛出等）不能把窗口永久卡在 half_open
        if (probeClaimed && !probeRetryReleased) {
          await this.safeDb(() => db.releaseWindowProbe(profile.id, 'aborted'), undefined)
        }
      }
    } finally {
      registry?.clearSession(profile.id)
    }
  }

  /** 手动触发入口（面板单窗口执行）：按 bitbrowserId 找窗口记录再跑一次会话；返回该任务本轮最终运行行 */
  async runManual(bitbrowserId: string, taskKey: string, batchId?: number): Promise<RunRow | null> {
    const profiles = await this.safeDb(() => this.deps.db.listProfiles(false), [] as ProfileRow[])
    const profile = profiles.find(p => p.bitbrowserId === bitbrowserId)
    if (!profile) throw new Error(`窗口不存在: ${bitbrowserId}`)
    const results = await this.runWindowTasks(profile, [{ taskKey, ...(batchId === undefined ? {} : { batchId }) }])
    return results.get(taskKey) ?? null
  }

  /**
   * 开窗重试：按 retryBackoffMs 数列退避（5s → 30s → 120s），耗尽后抛最后一次错误
   * 设计权衡：退避间隔拉长是因为开窗失败多为本地服务抖动，给比特浏览器恢复时间
   * 关键修正：比特 /browser/open 是异步的——请求发出后客户端就开始开窗，
   * API 报错/超时 ≠ 窗口没开（真机教训：开窗"失败"的窗口堆积几十个撑爆内存）。
   * 每次失败后都补一次 closeBrowser 清理可能已开/半开的窗口（close 自身失败忽略，
   * 不阻断重试；幂等调用，未开的窗口 close 无害）
   */
  private async openWithRetry(id: string): Promise<OpenResult> {
    const { maxRetries, retryBackoffMs } = this.deps.cfg.bitbrowser
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.deps.bitbrowser.openBrowser(id)
      } catch (e) {
        lastErr = e as Error
        this.deps.logger.warn({ id, attempt: attempt + 1 }, `开窗失败: ${lastErr.message}`)
        await this.closeWindowSafely(id, '开窗重试前清理')
        if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, retryBackoffMs[attempt] ?? 5000))
      }
    }
    throw lastErr ?? new Error('开窗失败')
  }

  /**
   * 关窗（容错）：失败只告警返回，不抛错。用于会话结束 / 开窗重试清理 / 兜底关窗。
   * 之前用 `.catch(() => {})` 完全静默，导致关窗失败产生的残留窗口无法从日志发现。
   * @param bitbrowserId 窗口 ID
   * @param reason 触发场景（日志用）
   */
  private async closeWindowSafely(bitbrowserId: string, reason: string): Promise<void> {
    try {
      await this.deps.bitbrowser.closeBrowser(bitbrowserId)
    } catch (e) {
      this.deps.logger.warn({ bitbrowserId, reason, err: (e as Error).message }, '关窗失败（窗口可能残留）')
    }
  }

  /**
   * 开窗失败后的延迟兜底关窗：`/browser/open` 异步，HTTP 超时报错时窗口可能仍在后台打开，
   * 立即关多半失败（窗口"正在打开中"），等 DELAYED_FALLBACK_CLOSE_MS 后再补关一次（best-effort，不阻塞会话）。
   */
  private scheduleFallbackClose(bitbrowserId: string): void {
    const timer = setTimeout(() => {
      void this.deps.bitbrowser.closeBrowser(bitbrowserId)
        .then(() => this.deps.logger.info({ bitbrowserId }, '开窗失败兜底关窗完成（清理可能半开的窗口）'))
        .catch((e) => this.deps.logger.warn({ bitbrowserId, err: (e as Error).message }, '开窗失败兜底关窗失败（窗口可能残留，请手动清理）'))
    }, DELAYED_FALLBACK_CLOSE_MS)
    timer.unref?.()
  }

  /**
   * 跨进程全局窗口闸门：本进程队列闸门只统计进程内会话，多进程（后端 + task:run 脚本）并存时
   * 各自开满上限 → 实际开窗数翻倍。这里以比特浏览器 `/browser/pids` 实测的「当前已开窗口数」为准，
   * 达到 `execution.maxConcurrentWindows` 时排队等待其它窗口释放；等待超预算则放行并告警（不无限阻塞会话）。
   * 探测失败（本地 API 未就绪）直接放行，避免闸门本身阻断执行。
   */
  private async waitForGlobalWindowCapacity(): Promise<void> {
    const max = this.deps.cfg.execution.maxConcurrentWindows
    if (!Number.isFinite(max)) return
    const ids = (await this.deps.db.listProfiles(false)).map((p) => p.bitbrowserId)
    if (ids.length === 0) return
    const deadline = Date.now() + CAPACITY_WAIT_MS
    let reclaimedOnce = false
    for (;;) {
      let open: Set<string>
      try {
        open = await this.deps.bitbrowser.openPids(ids)
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message }, '窗口占用探测失败，跳过跨进程窗口额度等待')
        return
      }
      if (open.size < max) return
      // 满额先甄别并回收占位者：孤儿/归属进程已死的窗口直接关掉，腾出名额后再重新计数
      if (!reclaimedOnce) {
        reclaimedOnce = true
        const reclaimed = await reclaimOrphanWindows({ db: this.deps.db, bitbrowser: this.deps.bitbrowser }, this.deps.logger)
        if (reclaimed > 0) {
          this.deps.logger.info({ reclaimed, max }, '跨进程窗口满额：已回收孤儿窗口，重新计数')
          continue
        }
      }
      if (Date.now() >= deadline) {
        this.deps.logger.warn({ open: open.size, max }, '跨进程窗口被在途会话占满且等待超时，仍继续开窗（放行）')
        return
      }
      this.deps.logger.info({ open: open.size, max }, '跨进程窗口已达上限，等待其它窗口释放')
      await new Promise((r) => setTimeout(r, CAPACITY_POLL_MS))
    }
  }

  /** 取某任务当日下一轮 slot（库失败兜底 0——不阻塞任务执行） */
  private async nextSlot(profile: ProfileRow, taskKey: string, date: string): Promise<number> {
    const n = await this.safeDb(() => this.deps.db.nextRunSlot(profile.id, taskKey, date), null)
    return typeof n === 'number' ? n : 0
  }

  /**
   * 窗口级跳过/失败的落库：若该任务存在非终态行（retry_wait 待续跑 / 预写 pending），
   * 直接结算该行（沿用原 slot 与 batch_id），否则按新轮次落库——
   * 不结算会留下孤儿 retry_wait 行，每次进程重启都会被重试恢复扫描重新入队重复执行
   */
  private async settleWindowSkip(profile: ProfileRow, taskKey: string, date: string, status: 'skipped' | 'failed', error: string, failureKind?: FailureKind): Promise<RunRow | null> {
    // 终端结算即排空取消标记：避免停止标记残留，误跳过该 (窗口, 任务) 的下一次合法触发
    this.deps.cancelRegistry?.clear(profile.id, taskKey)
    const existing = await this.safeDb(() => this.deps.db.getLatestRun(profile.id, taskKey, date), null)
    const terminal = existing ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(existing.status) : false
    // 非终态行（retry_wait 待续跑 / 预写 pending）直接结算该行——沿用 slot 与 batch_id
    if (existing && !terminal) {
      return this.safeDb(() => this.deps.db.upsertRun(profile.id, taskKey, date, existing.slot, status, { error, finishedAt: localWallNow(), failureKind }), null)
    }
    // 终态或无行的兜底新轮次不传 batchId，归入未分批（正常流程预写已带批次）
    const slot = await this.nextSlot(profile, taskKey, date)
    return this.safeDb(() => this.deps.db.upsertRun(profile.id, taskKey, date, slot, status, { error, finishedAt: localWallNow(), failureKind }), null)
  }

  /**
   * 单任务执行：解析任务级参数（覆盖全局默认）→ 建 TaskContext → 超时保护执行 → 落状态
   * 重试不占窗：retry_wait 不 sleep 占窗，交给 deps.scheduleRetry 到期后重新入队（新一轮窗口会话）；
   * 尝试计数跨会话续算（读数据库已有记录的 attempts：上一轮已跑 N 次则本次从 N+1 开始，
   * attempts=0/首次/终态重跑则从 1），保证重试上限跨会话生效、最终必达 failed；
   * 非首次尝试先复位页面（about:blank），避免上一轮残留 DOM/事件干扰；
   * 失败时采集失败截图 + 诊断包（限时 5s，best-effort，不影响落库），并写入 failureKind；
   * 窗口级健康统计（成功清零 / 环境失败累计）由上层 runWindowTasks 负责
   * @param profile 窗口记录
   * @param taskKey 任务键（须已在 tasks 注册表登记）
   * @param page 该窗口已接管的页面（同一会话内复用）
   * @param date 当日日期串（YYYY-MM-DD，用于 run 行与产物目录）
   * @param walletSession 窗口级钱包会话（跨任务复用）
   * @returns 本轮最终运行行；DB 写失败降级时为 null
   */
  private async runTask(profile: ProfileRow, taskKey: string, page: Page, date: string, walletSession: WalletSession): Promise<RunRow | null> {
    const { cfg, db, logger } = this.deps
    // 停止可能落在「会话开始前检查之后」，而关窗又失败（如窗口正在打开、比特 API 拒绝关闭）：
    // 再次消费取消标记（任务级或会话级），确保不执行任务（把当前非终态行结算为 skipped「手动停止」）。
    if (this.deps.cancelRegistry?.isCancelled(profile.id, taskKey) || this.deps.cancelRegistry?.isSessionCancelled(profile.id)) {
      this.deps.cancelRegistry.clear(profile.id, taskKey)
      const canceled = await this.safeDb(() => db.getLatestRun(profile.id, taskKey, date), null)
      const canceledTerminal = canceled ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(canceled.status) : true
      logger.info({ profile: profile.name, task: taskKey }, '任务已被停止，跳过执行')
      if (canceled && !canceledTerminal) {
        return this.safeDb(() => db.upsertRun(profile.id, taskKey, date, canceled.slot, 'skipped', { error: '手动停止', finishedAt: localWallNow(), failureKind: 'stopped' }), null)
      }
      return canceled
    }
    const task = this.deps.tasks.get(taskKey)
    if (!task) {
      const finishedAt = localWallNow()
      // 与 settleWindowSkip 同理：会话启动已预写 pending 行，未注册任务须就地结算该行
      // （沿用原 slot，不传 batchId 由 COALESCE 保留），否则留下孤儿 pending 行
      const existing = await this.safeDb(() => db.getLatestRun(profile.id, taskKey, date), null)
      const terminal = existing ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(existing.status) : false
      if (existing && !terminal) {
        return this.safeDb(() => db.upsertRun(profile.id, taskKey, date, existing.slot, 'failed', { error: `任务未注册: ${taskKey}`, finishedAt, failureKind: 'task' }), null)
      }
      const slot = await this.nextSlot(profile, taskKey, date)
      return this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'failed', { error: `任务未注册: ${taskKey}`, finishedAt, failureKind: 'task' }), null)
    }
    // 任务级参数优先，缺省回落全局默认（任务 meta 未配置时用 execution.*）
    const retryMax = task.meta.retry?.max ?? cfg.execution.retryMax
    const backoffSec = task.meta.retry?.backoffSec ?? cfg.execution.retryBackoffSec
    const timeoutSec = task.meta.timeoutSec ?? Math.floor(cfg.execution.taskTimeoutMs / 1000)
    // 重试轮次跨会话续算：读数据库已有记录的 attempts（attempts=N 表示上一轮已跑 N 次），
    // 本次会话从 N+1 开始；无记录、attempts=0 或终态行（手动重跑开新一轮）则从 1 开始——
    // 保证 scheduleRetry 重新入队的新会话最终走到 failed 终态，不会无限重试
    const existing = await this.safeDb(() => db.getLatestRun(profile.id, taskKey, date), null)
    const terminal = existing ? ['success', 'failed', 'captcha_failed', 'skipped'].includes(existing.status) : false
    // 续跑沿用原 slot；新轮次（无记录或终态行）取当日 MAX(slot)+1
    const slot = existing && !terminal ? existing.slot : await this.nextSlot(profile, taskKey, date)
    const startAttempt = existing && !terminal ? (existing.attempts > 0 ? existing.attempts + 1 : 1) : 1
    // 超界钳制：历史 attempts 已耗尽重试预算（startAttempt > retryMax + 1）直接落 failed，不进执行循环
    if (startAttempt > retryMax + 1) {
      return this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'failed', { error: '重试次数已耗尽', finishedAt: localWallNow(), failureKind: existing?.failureKind ?? 'task' }), null)
    }
    // 产物目录：data/screenshots/<日期>/<窗口>/<任务>/
    const artifacts = join(this.deps.artifactsDir, date, profile.bitbrowserId, taskKey)
    try {
      mkdirSync(artifacts, { recursive: true })
    } catch (e) {
      return this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'failed', { error: `截图目录创建失败: ${(e as Error).message}`, finishedAt: localWallNow(), failureKind: 'task' }), null)
    }

    // TaskContext 提升到循环 try 外：失败 catch 需经它取步骤时间线采集诊断包
    let ctx: TaskContext | null = null
    for (let attempt = startAttempt; attempt <= retryMax + 1; attempt++) {
      // 重试前页面复位：非首次尝试先清空页面（失败容错：about:blank 加载失败不影响后续）
      if (attempt > 1) {
        await page.goto('about:blank', { timeout: 10000 }).catch(() => {})
      }
      await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'running', { attempts: attempt, error: null, startedAt: localWallNow() }), null)
      // 数据源行解析：失败 catch → null + warn（数据源是可选增强，不阻断任务执行）
      let accountRow: Record<string, string> | null = null
      if (this.deps.accountResolver) {
        try {
          accountRow = await this.deps.accountResolver(profile)
        } catch (e) {
          this.deps.logger.warn({ profile: profile.name, err: (e as Error).message }, '数据源行解析失败，任务将以 faker 兜底')
        }
      }
      try {
        ctx = new TaskContext({
          page,
          task,
          profile,
          cfg: this.deps.cfg,
          logger,
          artifactsDir: artifacts,
          walletPasswords: this.deps.walletPasswords,
          wallets: this.deps.wallets,
          walletSession,
          accountRow,
          ai: this.ai,
        })
        await withTimeout(task.run(ctx), timeoutSec * 1000, `任务 ${taskKey} 超时`)
        // 任务正常结束同样清理取消标记（任务一次运行以任意终态收尾即排空，防止残留误伤下一次合法触发）
        this.deps.cancelRegistry?.clear(profile.id, taskKey)
        // 成功截图：直接取页面截图写产物目录（TaskContext 已收敛为数据袋子，不再有 screenshot 方法）
        const successShot = join(artifacts, `${date}-success.png`)
        const shot = await page.screenshot({ path: successShot }).then(() => successShot).catch(() => null)
        const finishedAt = localWallNow()
        const row = await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'success', { error: null, screenshot: shot, finishedAt, failureKind: null }), null)
        // 成功清空 diag_path：失败轮次残留的诊断路径不应挂在 success 行上，
        // 否则 GET /api/diagnostics/:runId 会为成功行返回失败诊断包（best-effort，失败降级忽略）
        await this.safeDb(() => db.clearRunDiag(profile.id, taskKey, date, slot), undefined)
        logger.info({ profile: profile.name, task: taskKey }, '签到成功')
        return row
      } catch (e) {
        // 已请求停止（关窗打断等）：任务级或会话级停止都落 skipped（手动停止），不重试、不计熔断、不采诊断
        if (this.deps.cancelRegistry?.isCancelled(profile.id, taskKey) || this.deps.cancelRegistry?.isSessionCancelled(profile.id)) {
          this.deps.cancelRegistry.clear(profile.id, taskKey)
          const row = await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'skipped', { error: '手动停止', finishedAt: localWallNow(), failureKind: 'stopped' }), null)
          logger.info({ profile: profile.name, task: taskKey }, '任务被手动停止')
          return row
        }
        const failureKind = classifyFailure('task', e)
        const status = nextStateAfterFailure(attempt, retryMax + 1, 'error')
        // 失败截图留档，供面板"查看"排障
        const shot = await page.screenshot({ path: join(artifacts, `${date}-attempt${attempt}.png`) }).then(() => join(artifacts, `${date}-attempt${attempt}.png`)).catch(() => null)
        // 失败诊断包（页面 + 步骤时间线 + 错误/状态/窗口/任务），best-effort：
        // 采集或写盘异常只告警，绝不影响任务结果落库
        let diagPath: string | null = null
        if (ctx) {
          try {
            const { collectDiagnostics, writeDiagBundle } = await import('../automation')
            // 采集限时：冻结渲染器上 page.evaluate 可能永不返回，
            // race 5s 超时后放弃诊断（diagPath=null）继续落失败状态，避免拖死失败写入/窗口会话
            const bundle = await Promise.race([
              collectDiagnostics({
                page,
                steps: ctx.recorder.steps(),
                error: (e as Error).message,
                status,
                windowName: profile.name,
                taskKey,
              }),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
            ])
            diagPath = bundle ? writeDiagBundle(artifacts, `${date}-attempt${attempt}.diag`, bundle) : null
          } catch (de) {
            logger.warn({ profile: profile.name, task: taskKey, err: (de as Error).message }, '诊断包采集失败（不影响任务结果）')
          }
        }
        const row = await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, status, { error: (e as Error).message, screenshot: shot, diagPath, finishedAt: localWallNow(), failureKind }), null)
        logger.error({ profile: profile.name, task: taskKey, status, err: (e as Error).message }, '任务失败')
        if (status === 'retry_wait') {
          // 重试不占窗：退避期不 sleep，立即返回让窗口继续处理下一个任务/正常关窗；
          // 到期由 scheduleRetry 重新入队，新一轮窗口会话从续跑 attempts 开始；
          // batchId 沿用原行批次（重试不产生新批次）
          this.deps.scheduleRetry(profile, taskKey, backoffSec * 1000, row?.batchId ?? undefined)
          return row
        }
        // 熔断计数由上层窗口健康状态机按 failureKind 统计（仅环境级终态失败计入）
        return row
      }
    }
    return null
  }
}

/** 超时兜底：Promise.race 竞速，超时后清除定时器（抛 TaskTimeoutError，按 timeout 分类，不计窗口熔断） */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TaskTimeoutError(message)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

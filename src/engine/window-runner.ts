/**
 * 窗口执行器（engine 层）：一次完整窗口会话的编排——开窗→连接→探活→逐个跑任务→关窗
 * 依赖方向：依赖 integrations/automation/infrastructure，被 app 顶层装配；不依赖 server 层
 * 设计思路：三段 try 把异常分区为不同终态——
 *   开窗重试耗尽 → 全部任务 skipped（环境问题，重试无意义）
 *   CDP 连接失败 → 全部任务 failed（窗口已开但接管失败）
 *   任务执行异常 → 按状态机逐任务落状态并截图留档（不影响同窗口后续任务）
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'patchright'
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import { AppDb, todayStr, type ProfileRow } from '../infrastructure/db'
import type { BitBrowserClient, OpenResult } from '../integrations/bitbrowser'
import { nextStateAfterFailure, shouldSkipAfterBreaker } from './state'
import { Humanizer } from '../automation/humanize'
import { CaptchaFailure, CaptchaService } from '../integrations/yescaptcha'
import { TaskContext } from './task-context'
import { isIntervalSchedule, type TaskMeta } from './task'
import type { WalletRegistry } from '../automation/wallet/types'

/** 浏览器连接抽象：测试注入假驱动，生产用 PatchrightDriver */
export interface BrowserDriver {
  connect(endpointUrl: string): Promise<{ page: Page; close(): Promise<void> }>
}

/**
 * 真实驱动：经 CDP 接管比特浏览器已开窗口（复用首个 context 与首个 page）
 */
export class PatchrightDriver implements BrowserDriver {
  async connect(endpointUrl: string): Promise<{ page: Page; close(): Promise<void> }> {
    const browser = await chromium.connectOverCDP(endpointUrl)
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = context.pages()[0] ?? (await context.newPage())
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
  captcha: CaptchaService | null
  logger: Logger
  artifactsDir: string
  /** 钱包解锁密码映射（key 为钱包类型，如 metamask/petra，透传给 TaskContext） */
  walletPasswords: Record<string, string>
  /**
   * 重试退避调度（不占窗口）：retry_wait 后由装配层 setTimeout 到期重新入队，
   * 当前窗口立即继续下一个任务/正常关窗
   */
  scheduleRetry: (profile: ProfileRow, taskKey: string, delayMs: number) => void
  /**
   * 数据源行解析（app 层装配注入）：按窗口取数据源行（列名 -> 值）；
   * 返回 null 表示无映射（任务侧 faker 兜底）；未注入时任务 accountRow 恒为 null
   */
  accountResolver?: (profile: ProfileRow) => Promise<Record<string, string> | null>
  /**
   * 窗口复用探测（app 层装配注入）：已登记打开状态（open_windows 表）且调用方实测存活时
   * 返回该窗口调试地址——本轮会话直接复用（不重新开窗、结束后也不关窗）；
   * 返回 null 走正常开窗/关窗流程。未注入时行为不变（恒不开窗复用）
   */
  reuseOpen?: (bitbrowserId: string) => Promise<{ http: string } | null>
}

export class WindowRunner {
  constructor(private deps: WindowRunnerDeps) {}

  /**
   * 降级策略：任务执行中的数据库写失败不能杀死执行（云库抖动/断网时任务照跑）
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

  /**
   * 跑一个窗口的一次会话：本窗口当日所有 taskKeys 依次执行
   * 异常分区（见文件头注释）：开窗失败全部 skipped；连接失败全部 failed；
   * IP 探活失败全部 skipped；熔断中的任务逐个 skipped；其余逐任务执行
   */
  async runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<void> {
    const { cfg, db, bitbrowser, logger } = this.deps
    const date = todayStr()
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
        open = await this.openWithRetry(profile.bitbrowserId)
      }
    } catch (e) {
      for (const key of taskKeys) {
        const slot = await this.nextSlot(profile, key, date)
        await this.safeDb(() => db.upsertRun(profile.id, key, date, slot, 'skipped', { error: `开窗失败: ${(e as Error).message}`, finishedAt: new Date().toISOString() }), null)
      }
      logger.warn({ profile: profile.name }, '开窗重试耗尽，本轮跳过')
      return
    }
    let connected: { page: Page; close(): Promise<void> } | null = null
    // 第二段 try：连接/探活/执行——finally 保证无论成败都关连接、关窗口
    try {
      // 内层 try：连接失败单独分区为 failed 终态
      try {
        connected = await this.deps.driver.connect(`http://${open.http}`)
      } catch (e) {
        for (const key of taskKeys) {
          const slot = await this.nextSlot(profile, key, date)
          await this.safeDb(() => db.upsertRun(profile.id, key, date, slot, 'failed', { error: `CDP 连接失败: ${(e as Error).message}`, finishedAt: new Date().toISOString() }), null)
        }
        logger.error({ profile: profile.name }, `CDP 连接失败: ${(e as Error).message}`)
        return
      }
      const page = connected.page
      // IP 探活：代理 IP 未生效时整窗口跳过，避免用错误 IP 跑任务触发风控
      const probeOk = await this.probe(page)
      if (!probeOk) {
        for (const key of taskKeys) {
          const slot = await this.nextSlot(profile, key, date)
          await this.safeDb(() => db.upsertRun(profile.id, key, date, slot, 'skipped', { error: 'IP 探活失败', finishedAt: new Date().toISOString() }), null)
        }
        logger.warn({ profile: profile.name }, 'IP 探活失败，本轮跳过')
        return
      }
      // 第三段（循环内）：逐任务执行，失败只影响当前任务
      // 窗口级截止时间：到点后剩余任务标 skipped（异常卡死时保证并发槽位不被长时间占用）
      const deadline = Date.now() + cfg.execution.windowTimeoutMs
      for (let i = 0; i < taskKeys.length; i++) {
        const key = taskKeys[i]
        if (Date.now() >= deadline) {
          for (const rest of taskKeys.slice(i)) {
            const slot = await this.nextSlot(profile, rest, date)
            await this.safeDb(() => db.upsertRun(profile.id, rest, date, slot, 'skipped', { error: '窗口超时', finishedAt: new Date().toISOString() }), null)
          }
          logger.warn({ profile: profile.name }, '窗口超时，剩余任务跳过')
          break
        }
        // 窗口级熔断：计数达阈值后当日不再跑（成功一次即重置，见 runTask）
        if (shouldSkipAfterBreaker(profile.circuitBreakerCount, cfg.execution.circuitBreakerThreshold)) {
          const slot = await this.nextSlot(profile, key, date)
          await this.safeDb(() => db.upsertRun(profile.id, key, date, slot, 'skipped', { error: '窗口熔断', finishedAt: new Date().toISOString() }), null)
          logger.warn({ profile: profile.name, task: key }, '窗口熔断，跳过任务')
          continue
        }
        await this.runTask(profile, key, page, date)
      }
    } finally {
      // 无论成功失败：先关 CDP 连接再关窗口（顺序反了会残留进程）；close 失败只忽略
      if (connected) await connected.close().catch(() => {})
      // 复用（面板/脚本已打开的窗口）不关闭：只关本轮会话自己打开的窗口
      if (!reusedFlag && open) await bitbrowser.closeBrowser(profile.bitbrowserId).catch(() => {})
    }
  }

  /** 手动触发入口（面板单窗口执行）：按 bitbrowserId 找窗口记录再跑一次会话 */
  async runManual(bitbrowserId: string, taskKey: string): Promise<void> {
    const profiles = await this.safeDb(() => this.deps.db.listProfiles(false), [] as ProfileRow[])
    const profile = profiles.find(p => p.bitbrowserId === bitbrowserId)
    if (!profile) throw new Error(`窗口不存在: ${bitbrowserId}`)
    await this.runWindowTasks(profile, [taskKey])
  }

  /**
   * 开窗重试：按 retryBackoffMs 数列退避（5s → 30s → 120s），耗尽后抛最后一次错误
   * 设计权衡：退避间隔拉长是因为开窗失败多为本地服务抖动，给比特浏览器恢复时间
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
        if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, retryBackoffMs[attempt] ?? 5000))
      }
    }
    throw lastErr ?? new Error('开窗失败')
  }

  /** 访问探活地址校验 IP 生效（30s 超时，失败不抛错返回 false） */
  private async probe(page: Page): Promise<boolean> {
    try {
      await page.goto(this.deps.cfg.execution.probeUrl, { timeout: 30000, waitUntil: 'domcontentloaded' })
      return true
    } catch {
      return false
    }
  }

  /** 取某任务当日下一轮 slot（库失败兜底 0——不阻塞任务执行） */
  private async nextSlot(profile: ProfileRow, taskKey: string, date: string): Promise<number> {
    const n = await this.safeDb(() => this.deps.db.nextRunSlot(profile.id, taskKey, date), null)
    return typeof n === 'number' ? n : 0
  }

  /**
   * 单任务执行：解析任务级参数（覆盖全局默认）→ 建 TaskContext → 超时保护执行 → 落状态
   * 重试不占窗：retry_wait 不 sleep 占窗，交给 deps.scheduleRetry 到期后重新入队（新一轮窗口会话）；
   * 尝试计数跨会话续算（读数据库已有记录的 attempts：上一轮已跑 N 次则本次从 N+1 开始，
   * attempts=0/首次/终态重跑则从 1），保证重试上限跨会话生效、最终必达 failed；
   * 非首次尝试先复位页面（about:blank），避免上一轮残留 DOM/事件干扰
   * 成功重置熔断计数；终态失败（failed/captcha_failed）熔断计数 +1
   */
  private async runTask(profile: ProfileRow, taskKey: string, page: Page, date: string): Promise<void> {
    const { cfg, db, logger } = this.deps
    const task = this.deps.tasks.get(taskKey)
    if (!task) {
      const slot = await this.nextSlot(profile, taskKey, date)
      await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'failed', { error: `任务未注册: ${taskKey}`, finishedAt: new Date().toISOString() }), null)
      return
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
      await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'failed', { error: '重试次数已耗尽', finishedAt: new Date().toISOString() }), null)
      return
    }
    // 产物目录：data/screenshots/<日期>/<窗口>/<任务>/
    const artifacts = join(this.deps.artifactsDir, date, profile.bitbrowserId, taskKey)
    try {
      mkdirSync(artifacts, { recursive: true })
    } catch (e) {
      await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'failed', { error: `截图目录创建失败: ${(e as Error).message}`, finishedAt: new Date().toISOString() }), null)
      return
    }

    for (let attempt = startAttempt; attempt <= retryMax + 1; attempt++) {
      // 重试前页面复位：非首次尝试先清空页面（失败容错：about:blank 加载失败不影响后续）
      if (attempt > 1) {
        await page.goto('about:blank', { timeout: 10000 }).catch(() => {})
      }
      await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'running', { attempts: attempt, error: null, startedAt: new Date().toISOString() }), null)
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
        const ctx = new TaskContext({
          page,
          task,
          human: new Humanizer(page, this.deps.cfg.execution.humanize),
          profile,
          cfg: this.deps.cfg,
          logger,
          artifactsDir: artifacts,
          walletPasswords: this.deps.walletPasswords,
          captcha: this.deps.captcha ?? undefined,
          wallets: this.deps.wallets,
          accountRow,
          // 打码成本回写 captcha_logs（成功/失败都记，看板统计用）；写失败仅告警不影响任务
          onCaptchaLog: (kind, ok, costPoints) => {
            void this.safeDb(() => db.logCaptcha(profile.id, taskKey, kind, costPoints, ok), undefined)
          },
        })
        await withTimeout(task.run(ctx), timeoutSec * 1000, `任务 ${taskKey} 超时`)
        const shot = await ctx.screenshot(`${date}-success`).catch(() => null)
        const finishedAt = new Date().toISOString()
        await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, 'success', { error: null, screenshot: shot, finishedAt }), null)
        // 间隔任务：成功完成时刻回写调度锚点（只增不减），下一轮 = 锚点 + N 小时 + 缓冲
        if (isIntervalSchedule(task.meta.schedule)) {
          await this.safeDb(() => db.setTaskFiredAt(taskKey, finishedAt), undefined)
        }
        await this.safeDb(() => db.resetCircuitBreaker(profile.id), undefined)
        logger.info({ profile: profile.name, task: taskKey }, '签到成功')
        return
      } catch (e) {
        const isCaptcha = e instanceof CaptchaFailure
        const status = nextStateAfterFailure(attempt, retryMax + 1, isCaptcha ? 'captcha' : 'error')
        // 失败截图留档（含验证码失败现场），供面板"查看"排障
        const shot = await page.screenshot({ path: join(artifacts, `${date}-attempt${attempt}.png`) }).then(() => join(artifacts, `${date}-attempt${attempt}.png`)).catch(() => null)
        await this.safeDb(() => db.upsertRun(profile.id, taskKey, date, slot, status, { error: (e as Error).message, screenshot: shot, finishedAt: new Date().toISOString() }), null)
        logger.error({ profile: profile.name, task: taskKey, status, err: (e as Error).message }, '任务失败')
        if (status === 'retry_wait') {
          // 重试不占窗：退避期不 sleep，立即返回让窗口继续处理下一个任务/正常关窗；
          // 到期由 scheduleRetry 重新入队，新一轮窗口会话从续跑 attempts 开始
          this.deps.scheduleRetry(profile, taskKey, backoffSec * 1000)
          return
        }
        // 终态失败：熔断计数 +1（达阈值后本窗口当日不再跑）
        await this.safeDb(() => db.incrCircuitBreaker(profile.id), profile.circuitBreakerCount)
        return
      }
    }
  }
}

/** 超时兜底：Promise.race 竞速，超时后清除定时器（任务超时按普通失败处理） */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

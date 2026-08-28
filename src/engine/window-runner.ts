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
import type { TaskMeta } from './task'
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
  /** 钱包解锁密码映射（key 为比特窗口 ID，透传给 TaskContext） */
  walletPasswords: Record<string, string>
}

export class WindowRunner {
  constructor(private deps: WindowRunnerDeps) {}

  /**
   * 跑一个窗口的一次会话：本窗口当日所有 taskKeys 依次执行
   * 异常分区（见文件头注释）：开窗失败全部 skipped；连接失败全部 failed；
   * IP 探活失败全部 skipped；熔断中的任务逐个 skipped；其余逐任务执行
   */
  async runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<void> {
    const { cfg, db, bitbrowser, logger } = this.deps
    const date = todayStr()
    let open: OpenResult | null = null
    // 第一段 try：开窗（含重试）——失败即整窗口跳过，无浏览器可操作
    try {
      open = await this.openWithRetry(profile.bitbrowserId)
    } catch (e) {
      for (const key of taskKeys) {
        db.upsertRun(profile.id, key, date, 'skipped', { error: `开窗失败: ${(e as Error).message}`, finishedAt: new Date().toISOString() })
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
          db.upsertRun(profile.id, key, date, 'failed', { error: `CDP 连接失败: ${(e as Error).message}`, finishedAt: new Date().toISOString() })
        }
        logger.error({ profile: profile.name }, `CDP 连接失败: ${(e as Error).message}`)
        return
      }
      const page = connected.page
      // IP 探活：代理 IP 未生效时整窗口跳过，避免用错误 IP 跑任务触发风控
      const probeOk = await this.probe(page)
      if (!probeOk) {
        for (const key of taskKeys) db.upsertRun(profile.id, key, date, 'skipped', { error: 'IP 探活失败', finishedAt: new Date().toISOString() })
        logger.warn({ profile: profile.name }, 'IP 探活失败，本轮跳过')
        return
      }
      // 第三段（循环内）：逐任务执行，失败只影响当前任务
      for (const key of taskKeys) {
        // 窗口级熔断：计数达阈值后当日不再跑（成功一次即重置，见 runTask）
        if (shouldSkipAfterBreaker(profile.circuitBreakerCount, cfg.execution.circuitBreakerThreshold)) {
          db.upsertRun(profile.id, key, date, 'skipped', { error: '窗口熔断', finishedAt: new Date().toISOString() })
          logger.warn({ profile: profile.name, task: key }, '窗口熔断，跳过任务')
          continue
        }
        await this.runTask(profile, key, page, date)
      }
    } finally {
      // 无论成功失败：先关 CDP 连接再关窗口（顺序反了会残留进程）
      if (connected) await connected.close()
      if (open) await bitbrowser.closeBrowser(profile.bitbrowserId).catch(() => {})
    }
  }

  /** 手动触发入口（面板单窗口执行）：按 bitbrowserId 找窗口记录再跑一次会话 */
  async runManual(bitbrowserId: string, taskKey: string): Promise<void> {
    const profile = this.deps.db.listProfiles(false).find(p => p.bitbrowserId === bitbrowserId)
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

  /**
   * 单任务执行：解析任务级参数（覆盖全局默认）→ 建 TaskContext → 超时保护执行 → 落状态
   * 重试循环：attempt 从 1 到 retryMax+1；retry_wait 时退避 backoffSec 秒后继续；
   * 成功重置熔断计数；终态失败（failed/captcha_failed）熔断计数 +1
   */
  private async runTask(profile: ProfileRow, taskKey: string, page: Page, date: string): Promise<void> {
    const { cfg, db, logger } = this.deps
    const task = this.deps.tasks.get(taskKey)
    if (!task) {
      db.upsertRun(profile.id, taskKey, date, 'failed', { error: `任务未注册: ${taskKey}`, finishedAt: new Date().toISOString() })
      return
    }
    // 任务级参数优先，缺省回落全局默认（任务 meta 未配置时用 execution.*）
    const retryMax = task.meta.retry?.max ?? cfg.execution.retryMax
    const backoffSec = task.meta.retry?.backoffSec ?? cfg.execution.retryBackoffSec
    const timeoutSec = task.meta.timeoutSec ?? Math.floor(cfg.execution.taskTimeoutMs / 1000)
    // 产物目录：data/screenshots/<日期>/<窗口>/<任务>/
    const artifacts = join(this.deps.artifactsDir, date, profile.bitbrowserId, taskKey)
    try {
      mkdirSync(artifacts, { recursive: true })
    } catch (e) {
      db.upsertRun(profile.id, taskKey, date, 'failed', { error: `截图目录创建失败: ${(e as Error).message}`, finishedAt: new Date().toISOString() })
      return
    }

    for (let attempt = 1; attempt <= retryMax + 1; attempt++) {
      db.upsertRun(profile.id, taskKey, date, 'running', { attempts: attempt, error: null, startedAt: new Date().toISOString() })
      try {
        const ctx = new TaskContext({
          page,
          task,
          human: new Humanizer(page),
          profile,
          cfg: this.deps.cfg,
          logger,
          artifactsDir: artifacts,
          walletPasswords: this.deps.walletPasswords,
          captcha: this.deps.captcha ?? undefined,
          wallets: this.deps.wallets,
          // 打码成本回写 captcha_logs（成功/失败都记，看板统计用）
          onCaptchaLog: (kind, ok, costPoints) => {
            db.logCaptcha(profile.id, taskKey, kind, costPoints, ok)
          },
        })
        await withTimeout(task.run(ctx), timeoutSec * 1000, `任务 ${taskKey} 超时`)
        const shot = await ctx.screenshot(`${date}-success`).catch(() => null)
        db.upsertRun(profile.id, taskKey, date, 'success', { error: null, screenshot: shot, finishedAt: new Date().toISOString() })
        db.resetCircuitBreaker(profile.id)
        logger.info({ profile: profile.name, task: taskKey }, '签到成功')
        return
      } catch (e) {
        const isCaptcha = e instanceof CaptchaFailure
        const status = nextStateAfterFailure(attempt, retryMax + 1, isCaptcha ? 'captcha' : 'error')
        // 失败截图留档（含验证码失败现场），供面板"查看"排障
        const shot = await page.screenshot({ path: join(artifacts, `${date}-attempt${attempt}.png`) }).then(() => join(artifacts, `${date}-attempt${attempt}.png`)).catch(() => null)
        db.upsertRun(profile.id, taskKey, date, status, { error: (e as Error).message, screenshot: shot, finishedAt: new Date().toISOString() })
        logger.error({ profile: profile.name, task: taskKey, status, err: (e as Error).message }, '任务失败')
        if (status === 'retry_wait') {
          await new Promise(r => setTimeout(r, backoffSec * 1000))
          continue
        }
        // 终态失败：熔断计数 +1（达阈值后本窗口当日不再跑）
        db.incrCircuitBreaker(profile.id)
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

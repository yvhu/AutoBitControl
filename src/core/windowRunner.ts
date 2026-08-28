import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'patchright'
import type { AppConfig } from './config'
import type { Logger } from './logger'
import { AppDb, todayStr, type ProfileRow } from './db'
import type { BitBrowserClient, OpenResult } from './bitbrowser'
import { nextStateAfterFailure, shouldSkipAfterBreaker } from './state'
import { Humanizer } from './humanize'
import { CaptchaFailure, CaptchaService } from './captcha'
import { TaskContext, type SiteTask } from '../tasks/base'
import type { WalletRegistry } from './wallet/types'

export interface BrowserDriver {
  connect(endpointUrl: string): Promise<{ page: Page; close(): Promise<void> }>
}

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

export interface WindowRunnerDeps {
  cfg: AppConfig
  db: AppDb
  bitbrowser: BitBrowserClient
  driver: BrowserDriver
  tasks: Map<string, SiteTask>
  wallets: WalletRegistry
  captcha: CaptchaService | null
  logger: Logger
  artifactsDir: string
}

export class WindowRunner {
  constructor(private deps: WindowRunnerDeps) {}

  async runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<void> {
    const { cfg, db, bitbrowser, logger } = this.deps
    const date = todayStr()
    let open: OpenResult | null = null
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
    try {
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
      const probeOk = await this.probe(page)
      if (!probeOk) {
        for (const key of taskKeys) db.upsertRun(profile.id, key, date, 'skipped', { error: 'IP 探活失败', finishedAt: new Date().toISOString() })
        logger.warn({ profile: profile.name }, 'IP 探活失败，本轮跳过')
        return
      }
      for (const key of taskKeys) {
        if (shouldSkipAfterBreaker(profile.circuitBreakerCount, cfg.execution.circuitBreakerThreshold)) {
          db.upsertRun(profile.id, key, date, 'skipped', { error: '窗口熔断', finishedAt: new Date().toISOString() })
          logger.warn({ profile: profile.name, task: key }, '窗口熔断，跳过任务')
          continue
        }
        await this.runTask(profile, key, page, date)
      }
    } finally {
      if (connected) await connected.close()
      if (open) await bitbrowser.closeBrowser(profile.bitbrowserId).catch(() => {})
    }
  }

  async runManual(bitbrowserId: string, taskKey: string): Promise<void> {
    const profile = this.deps.db.listProfiles(false).find(p => p.bitbrowserId === bitbrowserId)
    if (!profile) throw new Error(`窗口不存在: ${bitbrowserId}`)
    await this.runWindowTasks(profile, [taskKey])
  }

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

  private async probe(page: Page): Promise<boolean> {
    try {
      await page.goto(this.deps.cfg.execution.probeUrl, { timeout: 30000, waitUntil: 'domcontentloaded' })
      return true
    } catch {
      return false
    }
  }

  private async runTask(profile: ProfileRow, taskKey: string, page: Page, date: string): Promise<void> {
    const { cfg, db, logger } = this.deps
    const task = this.deps.tasks.get(taskKey)
    if (!task) {
      db.upsertRun(profile.id, taskKey, date, 'failed', { error: `任务未注册: ${taskKey}`, finishedAt: new Date().toISOString() })
      return
    }
    const retryMax = task.meta.retry?.max ?? cfg.execution.retryMax
    const backoffSec = task.meta.retry?.backoffSec ?? cfg.execution.retryBackoffSec
    const timeoutSec = task.meta.timeoutSec ?? Math.floor(cfg.execution.taskTimeoutMs / 1000)
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
          captcha: this.deps.captcha ?? undefined,
          wallets: this.deps.wallets,
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
        const shot = await page.screenshot({ path: join(artifacts, `${date}-attempt${attempt}.png`) }).then(() => join(artifacts, `${date}-attempt${attempt}.png`)).catch(() => null)
        db.upsertRun(profile.id, taskKey, date, status, { error: (e as Error).message, screenshot: shot, finishedAt: new Date().toISOString() })
        logger.error({ profile: profile.name, task: taskKey, status, err: (e as Error).message }, '任务失败')
        if (status === 'retry_wait') {
          await new Promise(r => setTimeout(r, backoffSec * 1000))
          continue
        }
        db.incrCircuitBreaker(profile.id)
        return
      }
    }
  }
}

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

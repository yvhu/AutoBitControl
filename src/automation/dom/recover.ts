/**
 * 刷新恢复等待内核（automation/dom 层）：目标探针出现即返回；
 * 页面出现可恢复错误文案立即刷新；配置 refreshEveryMs 时周期刷新；每 heartbeatMs 输出心跳
 * 依赖方向：依赖 ./probe、infrastructure/constants 与 logger 类型
 */
import type { Page } from 'patchright'
import type { Logger } from '../../infrastructure/logger'
import { DEFAULT_RELOAD_TIMEOUT_MS, RECOVER_TEXTS } from '../../infrastructure/constants'
import { firstTextPresent, probeDesc, probeVisible, type Probe } from './probe'

export interface RecoverOpts {
  /** 总预算（毫秒） */
  budgetMs: number
  /** 周期主动刷新间隔（毫秒）；缺省 0 = 关闭 */
  refreshEveryMs?: number
  /** 可恢复错误文案，任一出现即刷新（缺省 RECOVER_TEXTS） */
  recoverTexts?: string[]
  /** 刷新后的沉降等待（缺省 5000） */
  settleMs?: number
  /** 心跳日志间隔（缺省 15000） */
  heartbeatMs?: number
}

/**
 * 等待探针出现（刷新恢复导向）
 * @returns 预算内出现 true / 超时 false（不抛错，由调用方决定后续）
 */
export async function recoverProbe(page: Page, probe: Probe, log: Logger, opts: RecoverOpts): Promise<boolean> {
  const reloadTimeoutMs = DEFAULT_RELOAD_TIMEOUT_MS
  const settleMs = opts.settleMs ?? 5000
  const heartbeatMs = opts.heartbeatMs ?? 15000
  const recoverTexts = opts.recoverTexts ?? RECOVER_TEXTS
  const end = Date.now() + opts.budgetMs
  let lastRefresh = Date.now()
  let lastBeat = Date.now()
  while (Date.now() < end) {
    if (await probeVisible(page, probe)) return true
    const errText = await firstTextPresent(page, recoverTexts)
    const stale = (opts.refreshEveryMs ?? 0) > 0 && Date.now() - lastRefresh >= (opts.refreshEveryMs as number)
    if (errText !== '' || stale) {
      log.info({ step: 'recover', errText, url: page.url() }, '刷新页面恢复（错误提示或周期刷新）')
      await page.reload({ timeout: reloadTimeoutMs, waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForTimeout(settleMs)
      lastRefresh = Date.now()
      lastBeat = Date.now()
      continue
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now()
      log.info({ step: 'recover', waitedMs: opts.budgetMs - (end - Date.now()), url: page.url() }, `仍在等待（${probeDesc(probe)}）`)
    }
    await page.waitForTimeout(3000)
  }
  return false
}

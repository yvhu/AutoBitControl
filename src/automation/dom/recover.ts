/**
 * 刷新恢复等待内核（automation/dom 层）：目标探针出现即返回；
 * 页面出现可恢复错误文案立即刷新；配置 refreshEveryMs 时周期刷新；每 heartbeatMs 输出心跳
 * 依赖方向：依赖 ./probe、infrastructure/constants 与 logger 类型
 */
import type { Page } from 'patchright'
import type { Logger } from '../../infrastructure/logger'
import { DEFAULT_RELOAD_TIMEOUT_MS, RECOVER_TEXTS } from '../../infrastructure/constants'
import { firstTextPresent, probeDesc, probeVisible, type Probe } from './probe'

/**
 * 刷新恢复等待的可调参数。核心思想：不无限硬等，而是在等待期间主动刷新页面来摆脱
 * 白屏/错误页等可恢复状态，同时用预算约束总耗时、用心跳日志暴露「卡在哪」。
 */
export interface RecoverOpts {
  /** 总预算（毫秒）：从调用时刻起允许等待的最长时间，耗尽仍未出现即返回 false */
  budgetMs: number
  /** 周期主动刷新间隔（毫秒）；缺省 0 表示不做周期刷新，只在出现错误文案或依赖外部触发时才刷 */
  refreshEveryMs?: number
  /** 可恢复错误文案列表，页面上任一出现即立刻刷新；缺省用全局 RECOVER_TEXTS（网络错误/加载失败等常见提示） */
  recoverTexts?: string[]
  /** 每次刷新后等待页面沉降的时间（毫秒，缺省 5000），避免刷新后立刻又对半成品 DOM 做判断 */
  settleMs?: number
  /** 心跳日志间隔（毫秒，缺省 15000）：每隔这么久打一条「仍在等待」日志，便于判断是否卡死 */
  heartbeatMs?: number
}

/**
 * 等待目标探针出现，期间用「刷新」对抗可恢复的异常页面状态。
 * 执行流程：进入循环直到预算耗尽——每轮先看目标是否已可见，可见立即返回 true；
 * 再看页面是否出现可恢复错误文案，或是否到了周期刷新时刻，二者任一命中就刷新页面、
 * 等沉降、重置计时后进入下一轮；否则每隔 heartbeatMs 打一条心跳日志，并每 3 秒轮询一次。
 * 循环结束仍未出现返回 false。整个过程不抛错，成功与否交给调用方决策。
 * @param page 目标页面
 * @param probe 等待出现的目标探针
 * @param log 日志器，用于刷新、心跳等过程日志
 * @param opts 恢复参数（预算、刷新策略、心跳间隔等，含义见 RecoverOpts）
 * @returns 预算内探针出现为 true；超时未出现为 false
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

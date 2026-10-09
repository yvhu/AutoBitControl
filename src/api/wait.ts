/**
 * 等待能力函数（api 层）：条件等待 / 多探针竞速 / 接口响应等待
 * 依赖方向：engine 的 TaskContext 类型、automation 的探针命中内核、infrastructure 常量
 */
import type { TaskContext } from '../engine/task-context'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '../infrastructure/constants'
import { firstTextPresent, probeDesc, probeHit } from '../automation'

/** 探针（api 层公共形态）：字符串等价于「文案」；文案按存在命中、选择器按可见命中（不含 gone） */
export type Probe = string | { text: string } | { selector: string }

/** 等待探针：在 Probe 基础上增加 gone（目标不可见或消失）；仅 waitFor 这类等待场景使用 */
export type WaitProbe = Probe | { gone: string }

/** 等待可调参数：预算 / 超时断言 / 周期刷新 / 错误文案 / 沉降 / 心跳 */
export interface WaitOptions {
  budgetMs?: number
  assert?: boolean
  refreshEveryMs?: number
  recoverTexts?: string[]
  settleMs?: number
  heartbeatMs?: number
}

/** 等条件命中（出现/可见/消失）；可选刷新恢复；返回是否命中；assert 时超时抛错 */
export async function waitFor(ctx: TaskContext, probe: WaitProbe, options: WaitOptions = {}): Promise<boolean> {
  const budgetMs = options.budgetMs ?? 10000
  const refreshEveryMs = options.refreshEveryMs ?? 0
  const recoverTexts = options.recoverTexts ?? []
  const settleMs = options.settleMs ?? 5000
  const heartbeatMs = options.heartbeatMs ?? 15000
  const end = Date.now() + budgetMs
  let lastRefresh = Date.now()
  let lastBeat = Date.now()
  while (Date.now() < end) {
    if (await probeHit(ctx.page, probe)) return true
    const errText = await firstTextPresent(ctx.page, recoverTexts)
    const stale = refreshEveryMs > 0 && Date.now() - lastRefresh >= refreshEveryMs
    if (errText !== '' || stale) {
      ctx.log.info({ step: 'recover', errText, url: ctx.page.url() }, '刷新页面恢复（错误提示或周期刷新）')
      await ctx.page.reload({ timeout: DEFAULT_RELOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' }).catch(() => {})
      await ctx.page.waitForTimeout(settleMs)
      lastRefresh = Date.now(); lastBeat = Date.now()
      continue
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now()
      ctx.log.info({ step: 'wait', probe: probeDesc(probe), waitedMs: budgetMs - (end - Date.now()), url: ctx.page.url() }, '仍在等待条件命中')
    }
    await ctx.page.waitForTimeout(3000)
  }
  if (options.assert) throw new Error(`等待超时: ${JSON.stringify(probe)}`)
  return false
}

/** 多探针竞速：任一先命中返回其键，都等不到返回 null（空数组直接返回 null，避免 Promise.race([]) 永不落定） */
export async function race<K extends string>(ctx: TaskContext, entries: Array<[K, Probe]>, timeoutMs: number): Promise<K | null> {
  if (entries.length === 0) return null
  const r = await Promise.race(entries.map(async ([k, probe]) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await probeHit(ctx.page, probe)) return k
      await ctx.page.waitForTimeout(800)
    }
    return null
  }))
  return r ?? null
}

/**
 * 等接口响应：URL/方法匹配 + predicate(status,body) 命中后返回 { status, body }。
 * body 默认按 JSON 解析（与旧 waitForApi 一致，解析失败为 null）；parse:'text' 时返回原始文本。
 */
export async function waitResponse(
  ctx: TaskContext,
  match: { urlPart?: string; method?: string; predicate?: (status: number, body: unknown) => boolean; parse?: 'json' | 'text' },
  options: { timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await ctx.page.waitForResponse(
    (r) => (!match.urlPart || r.url().includes(match.urlPart)) && (!match.method || r.request().method() === match.method),
    { timeout: options.timeoutMs ?? 15000 },
  )
  const status = res.status()
  const body = (match.parse ?? 'json') === 'json' ? await res.json().catch(() => null) : await res.text().catch(() => '')
  if (match.predicate && !match.predicate(status, body)) {
    throw new Error(`接口响应未命中判定: status=${status}`)
  }
  return { status, body }
}

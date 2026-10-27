/**
 * 窗口归属登记与孤儿回收（engine 层）：满额时甄别并回收「归属进程已死」的存活窗口
 * 依赖方向：仅依赖 infrastructure 类型；被 window-runner（会话开窗）与 profiles 路由（面板开窗）复用
 * 设计思路：open_windows 表登记每个已开窗口的 owner_pid 与生命周期状态（opening/open/closing）；
 *           本阶段只回收 state=open 且 owner 进程已死的窗口——opening/closing 可能正在被其他进程处理，
 *           无登记行也可能处于「已开未登记」窗口期，均跳过，避免误关正在打开的窗口。
 */
import type { Logger } from '../infrastructure/logger'
import type { OpenWindowRow, OpenWindowState } from '../infrastructure/db'

/** 回收孤儿窗口时等待 pids 消失的总时长（毫秒） */
const RECLAIM_CLOSE_CONFIRM_TIMEOUT_MS = 10_000
/** 回收孤儿窗口时 pids 确认轮询间隔（毫秒） */
const RECLAIM_CLOSE_CONFIRM_POLL_MS = 1000

/** 孤儿回收所需的最小依赖面（window-runner 的 AppDb/BitBrowserClient 与 profiles 路由的 deps 均满足） */
export interface WindowRegistryDeps {
  db: {
    listProfiles(enabledOnly: boolean): Promise<Array<{ bitbrowserId: string }>>
    listOpenWindows(): Promise<OpenWindowRow[]>
    setWindowState(bitbrowserId: string, state: OpenWindowState): Promise<void>
    clearOpenWindow(bitbrowserId: string): Promise<void>
  }
  bitbrowser: {
    openPids(ids: string[]): Promise<Set<string>>
    closeBrowser(id: string): Promise<void>
  }
}

/**
 * 轮询等待窗口关闭：`isAlive` 返回 false 视为已消失。
 * 探测异常按「未能确认关闭」处理并立即返回 false（保留登记，交由 Phase 2 对账）。
 */
export async function waitForWindowClosed(
  isAlive: () => Promise<boolean>,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 1000
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    try {
      if (!(await isAlive())) return true
    } catch {
      return false
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)))
  }
}

/**
 * 判断进程是否存活（跨平台）：`process.kill(pid, 0)` 只探测不发送信号；
 * ESRCH = 不存在；EPERM = 存在但无权限（仍视为存活）；其它异常保守视为存活，避免误关。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 回收孤儿窗口：以比特 /browser/pids 实测的存活窗口为基准。
 * ① 清理 state=open 的死登记行（登记在但 pid 已死）；
 * ② 仅关闭「state=open 且归属进程已死」的窗口并清登记；
 * opening/closing 状态与「存活但无登记行」的窗口一律跳过（可能正在开/关中，避免竞态误关）。
 * 探测失败（本地 API 未就绪）时不动任何窗口，返回 0。
 * @returns 实际回收（关闭）的窗口数
 */
export async function reclaimOrphanWindows(deps: WindowRegistryDeps, logger: Logger): Promise<number> {
  const profiles = await deps.db.listProfiles(false)
  const ids = profiles.map((p) => p.bitbrowserId)
  if (ids.length === 0) return 0
  let alive: Set<string>
  try {
    alive = await deps.bitbrowser.openPids(ids)
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '孤儿回收：窗口占用探测失败，跳过')
    return 0
  }
  const rows = await deps.db.listOpenWindows()
  const byId = new Map(rows.map((r) => [r.bitbrowserId, r] as const))
  // ① state=open 的死登记行（pid 已死）→ 清登记（窗口自身无需关，已不在存活集）
  //    归属进程仍存活时跳过：单次探测缺失可能只是抖动，交给调度器对账清理，避免误删在用登记
  for (const r of rows) {
    if (r.state !== 'open') continue
    if (r.ownerPid != null && isProcessAlive(r.ownerPid)) continue
    if (!alive.has(r.bitbrowserId)) await deps.db.clearOpenWindow(r.bitbrowserId).catch(() => {})
  }
  // ② 仅回收 state=open 且 owner 进程已死的存活窗口
  let reclaimed = 0
  for (const id of alive) {
    const row = byId.get(id)
    if (!row || row.state !== 'open') continue
    const ownerDead = row.ownerPid != null && !isProcessAlive(row.ownerPid)
    if (!ownerDead) continue
    // 先标记 closing 再关窗；关窗失败/确认超时保留登记，避免丢失残留窗口线索
    await deps.db.setWindowState(id, 'closing').catch(() => {})
    try {
      await deps.bitbrowser.closeBrowser(id)
    } catch (e) {
      logger.warn({ bitbrowserId: id, err: (e as Error).message }, '回收孤儿窗口：关窗失败，保留 closing 登记待 Phase 2 对账')
      continue
    }
    const closed = await waitForWindowClosed(
      async () => (await deps.bitbrowser.openPids([id])).has(id),
      { timeoutMs: RECLAIM_CLOSE_CONFIRM_TIMEOUT_MS, pollMs: RECLAIM_CLOSE_CONFIRM_POLL_MS },
    )
    if (!closed) {
      logger.warn({ bitbrowserId: id }, '回收孤儿窗口：关闭确认超时，保留 closing 登记待 Phase 2 对账')
      continue
    }
    await deps.db.clearOpenWindow(id).catch(() => {})
    reclaimed++
    logger.info({ bitbrowserId: id, reason: 'owner-dead' }, '回收孤儿窗口（关闭归属进程已死的窗口）')
  }
  return reclaimed
}

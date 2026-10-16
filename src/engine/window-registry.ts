/**
 * 窗口归属登记与孤儿回收（engine 层）：满额时甄别并回收「无归属 / 归属进程已死」的存活窗口
 * 依赖方向：仅依赖 infrastructure 类型；被 window-runner（会话开窗）与 profiles 路由（面板开窗）复用
 * 设计思路：open_windows 表登记每个已开窗口的 owner_pid（开窗前预留登记，避免「已开未登记」竞态）；
 *           孤儿 = pid 存活但无登记行（开窗超时/外部残留）或归属进程已死（崩溃残留）→ 直接关闭回收。
 */
import type { Logger } from '../infrastructure/logger'
import type { OpenWindowRow } from '../infrastructure/db'

/** 孤儿回收所需的最小依赖面（window-runner 的 AppDb/BitBrowserClient 与 profiles 路由的 deps 均满足） */
export interface WindowRegistryDeps {
  db: {
    listProfiles(enabledOnly: boolean): Promise<Array<{ bitbrowserId: string }>>
    listOpenWindows(): Promise<OpenWindowRow[]>
    clearOpenWindow(bitbrowserId: string): Promise<void>
  }
  bitbrowser: {
    openPids(ids: string[]): Promise<Set<string>>
    closeBrowser(id: string): Promise<void>
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
 * ① 清理死登记行（登记在但 pid 已死）；② 关闭「存活但无登记行」或「归属进程已死」的窗口并清登记。
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
  // ① 死登记行（pid 已死）→ 清登记（窗口自身无需关，已不在存活集）
  for (const r of rows) {
    if (!alive.has(r.bitbrowserId)) await deps.db.clearOpenWindow(r.bitbrowserId).catch(() => {})
  }
  // ② 孤儿（存活但无归属 / 归属进程已死）→ 关窗并清登记
  let reclaimed = 0
  for (const id of alive) {
    const row = byId.get(id)
    const ownerDead = row?.ownerPid != null && !isProcessAlive(row.ownerPid)
    if (!row || ownerDead) {
      await deps.bitbrowser.closeBrowser(id).catch(() => {})
      await deps.db.clearOpenWindow(id).catch(() => {})
      reclaimed++
      logger.info({ bitbrowserId: id, reason: row ? 'owner-dead' : 'unowned' }, '回收孤儿窗口（关闭无归属/归属进程已死的窗口）')
    }
  }
  return reclaimed
}

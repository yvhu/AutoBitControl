/**
 * 全局健康门禁（engine 层）：多窗口环境失败聚合 → 暂停窗口池 → 指数退避 → half-open 探测
 * 依赖方向：仅依赖标准库；被窗口池调度使用
 * 设计：非有限时间戳（NaN/Infinity）回退到 Date.now()，避免污染探测时间导致永久暂停；backoffSec 为空时按 30 秒兜底
 */
export type GlobalHealthState = 'normal' | 'paused' | 'probing'

export interface GlobalHealthConfig {
  windowSec: number
  threshold: number
  backoffSec: number[]
  probeEnabled: boolean
}

function resolveNowMs(nowMs: number): number {
  return Number.isFinite(nowMs) ? nowMs : Date.now()
}

export class GlobalHealthGate {
  state: GlobalHealthState = 'normal'
  nextProbeMs: number | null = null
  private failures = new Map<string, number>()
  private level = 0
  private readonly cfg: GlobalHealthConfig

  constructor(cfg: GlobalHealthConfig) {
    this.cfg = { ...cfg, backoffSec: [...cfg.backoffSec] }
  }

  canOpen(nowMs: number): boolean {
    if (this.state === 'paused' && this.cfg.probeEnabled && this.nextProbeMs != null && resolveNowMs(nowMs) >= this.nextProbeMs) {
      this.state = 'probing'
      this.nextProbeMs = null
      return true
    }
    return this.state === 'normal'
  }

  recordEnvironmentFailure(windowId: string, nowMs: number): GlobalHealthState {
    const at = resolveNowMs(nowMs)
    this.failures.set(windowId, at)
    for (const [id, failedAt] of this.failures) {
      if (at - failedAt > this.cfg.windowSec * 1000) this.failures.delete(id)
    }
    if (this.state === 'normal' && this.failures.size >= this.cfg.threshold) {
      this.state = 'paused'
      this.level = 0
      this.nextProbeMs = at + this.backoffMs()
    }
    return this.state
  }

  /**
   * 全局环境故障（比特 API/断网整体不可用）：立即暂停并进入指数退避，
   * 不需要等多窗口聚合；调用方应做去抖/限频，避免每个 tick 都升级退避级别。
   */
  recordGlobalFailure(nowMs: number): GlobalHealthState {
    const at = resolveNowMs(nowMs)
    // 首次从 normal 暂停用 backoffSec[0]；已 paused/probing 时再次失败才升级退避级别
    if (this.state === 'normal') this.level = 0
    else this.level = Math.min(this.level + 1, this.maxLevel())
    this.state = 'paused'
    this.nextProbeMs = at + this.backoffMs()
    return this.state
  }

  recordProbeSuccess(): void {
    this.state = 'normal'
    this.failures.clear()
    this.level = 0
    this.nextProbeMs = null
  }

  recordProbeFailure(nowMs: number): GlobalHealthState {
    this.state = 'paused'
    this.level = Math.min(this.level + 1, this.maxLevel())
    this.nextProbeMs = resolveNowMs(nowMs) + this.backoffMs()
    return this.state
  }

  private maxLevel(): number {
    return Math.max(0, this.cfg.backoffSec.length - 1)
  }

  private backoffMs(): number {
    const sec = this.cfg.backoffSec[Math.min(this.level, this.maxLevel())] ?? 30
    return sec * 1000
  }
}

/**
 * 内存调速（engine 层）：按空闲内存计算有效窗口池，并维护 normal/warning/critical 迟滞与单窗口内存 EWMA
 * 依赖方向：仅依赖标准库；被窗口池调度使用
 */
export type MemoryState = 'normal' | 'warning' | 'critical'

export interface PoolSizingInput {
  freeMb: number
  actualOpen: number
  maxOpenWindows: number
  perWindowMb: number
  reserveMb: number
}

export function computeEffectivePool(input: PoolSizingInput): number {
  const allowance = Math.max(0, Math.floor((input.freeMb - input.reserveMb) / input.perWindowMb))
  return Math.max(0, Math.min(input.maxOpenWindows, input.actualOpen + allowance))
}

export interface MemoryGovernorOptions {
  reserveMb: number
  perWindowMb: number
  criticalFreeMb: number
  resumeFreeMb: number
  checkCount?: number
}

export class MemoryGovernor {
  private state: MemoryState = 'normal'
  private perWindowMb: number
  private healthyChecks = 0
  private readonly checkCount: number

  constructor(private readonly opts: MemoryGovernorOptions) {
    this.perWindowMb = opts.perWindowMb
    this.checkCount = opts.checkCount ?? 3
  }

  recordOpenDelta(deltaMb: number): void {
    if (!Number.isFinite(deltaMb) || deltaMb <= 0) return
    this.perWindowMb = Math.max(512, Math.min(2048, Math.round(this.perWindowMb * 0.7 + deltaMb * 0.3)))
  }

  update(input: { freeMb: number; actualOpen: number; maxOpenWindows: number }): { state: MemoryState; effectivePool: number; perWindowMb: number } {
    const freeMb = Math.max(0, input.freeMb)
    if (freeMb < this.opts.criticalFreeMb) {
      this.state = 'critical'
      this.healthyChecks = 0
    } else if (freeMb >= this.opts.resumeFreeMb) {
      this.healthyChecks++
      if (this.healthyChecks >= this.checkCount) this.state = 'normal'
    } else if (freeMb < this.opts.reserveMb + this.perWindowMb) {
      this.state = 'warning'
      this.healthyChecks = 0
    }
    const effectivePool = computeEffectivePool({
      freeMb,
      actualOpen: input.actualOpen,
      maxOpenWindows: input.maxOpenWindows,
      perWindowMb: this.perWindowMb,
      reserveMb: this.opts.reserveMb,
    })
    return { state: this.state, effectivePool, perWindowMb: this.perWindowMb }
  }
}

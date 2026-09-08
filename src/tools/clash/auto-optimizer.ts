/**
 * 定时自动优化（tools 层）：节奏状态机 + 在途守卫
 * 依赖方向：依赖 ./optimizer（ClashService）与 logger；由 app.ts 创建并 start/stop
 * 设计思路：正常态/快速态自适应节奏（setTimeout 链，测试用 fake timers）；
 * 任务在途时只测速不切换（换 IP 会破坏签到会话），连续延后 DEFERRED_ALERT_AT 次告警
 */
import type { ClashService } from './optimizer'
import type { Logger } from '../../infrastructure/logger'
import type { AutoOptimizerStatus, ClashPace } from './types'

export interface AutoOptimizerDeps {
  service: ClashService
  /** 任务在途判定（engine queue 注入）：true = 有窗口会话运行中 */
  anyRunning: () => boolean
  logger: Logger
  /** 节奏间隔（分钟）；normalMin=0 时定时关闭 */
  intervals: { normalMin: number; fastMin: number }
}

/** 延后切换告警阈值：连续 N 个检测周期因在途而无法切换时记告警 */
const DEFERRED_ALERT_AT = 3

export class AutoOptimizer {
  private pace: ClashPace = 'normal'
  private lastCheckAt: string | null = null
  private allDown = false
  private deferredSwitches = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(private deps: AutoOptimizerDeps) {}

  /** 启动节奏循环（幂等；normalMin<=0 时不启动） */
  start(): void {
    if (!this.stopped) return
    if (this.deps.intervals.normalMin <= 0) return
    this.stopped = false
    this.scheduleNext(0)
  }

  /** 停止节奏循环（优雅退出用） */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  status(): AutoOptimizerStatus {
    return { pace: this.pace, lastCheckAt: this.lastCheckAt, allDown: this.allDown, deferredSwitches: this.deferredSwitches }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.stopped) return
        const min = this.pace === 'fast' ? this.deps.intervals.fastMin : this.deps.intervals.normalMin
        // 下限保护 1 分钟：fastMin=0 时快速态不得形成 setTimeout(0) 热循环
        this.scheduleNext(Math.max(1, min) * 60 * 1000)
      })
    }, delayMs)
  }

  private async tick(): Promise<void> {
    try {
      if (this.deps.service.isBusy) {
        this.deps.logger.debug('Clash 自动检测跳过（上一次检测/切换进行中）')
        return
      }
      const result = await this.deps.service.test()
      this.lastCheckAt = new Date().toISOString()
      // 空节点列表（如分组无节点）不算全网挂
      this.allDown = result.nodes.length > 0 && result.nodes.every((n) => !n.usable)
      // 需切换判定：全网挂或当前选中节点不可用（当前节点不在测速范围按未知，不触发）
      const shouldSwitch = this.allDown || result.currentUsable === false
      const inFlight = this.deps.anyRunning()
      let switched = false
      if (shouldSwitch && !inFlight) {
        try {
          const out = await this.deps.service.optimize(result)
          switched = out.switched
          this.deferredSwitches = 0
          if (switched) this.deps.logger.info({ chosen: out.chosen }, 'Clash 自动切换节点成功')
          else this.deps.logger.warn({ note: out.switchNote }, 'Clash 自动选优未切换')
        } catch (e) {
          this.deps.logger.warn({ err: (e as Error).message }, 'Clash 自动选优失败')
        }
      } else if (shouldSwitch) {
        // 在途守卫：只测速不切换，切换延后到空闲窗口
        this.deferredSwitches++
        // 仅刚达到阈值时告警一次，避免后续每轮刷屏
        if (this.deferredSwitches === DEFERRED_ALERT_AT) {
          this.deps.logger.warn({ count: this.deferredSwitches }, 'Clash 需切换但任务在途，已连续延后 3 次')
        }
      } else {
        this.deferredSwitches = 0
      }
      this.pace = shouldSwitch && !switched ? 'fast' : 'normal'
    } catch (e) {
      // 单轮异常不中断循环（下轮继续）
      this.deps.logger.warn({ err: (e as Error).message }, 'Clash 自动检测轮次异常')
    }
  }
}

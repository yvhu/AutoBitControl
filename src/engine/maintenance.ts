/**
 * 后台维护（engine 层）：熔断定时重置（间隔模式 / 每日时刻模式）
 * 依赖方向：仅依赖 infrastructure（config/db/logger 类型），不反向依赖上层
 * 设计思路：间隔模式按 everyHours 定时重置；每日模式算下一次到点（按 tz 墙上时间）→ 重置 → 重排；
 *           每日模式同分钟幂等（delta <= 0 一律滚到次日，避免 0 毫秒立即触发）
 */
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { AppDb } from '../infrastructure/db'

/**
 * 计算从 now 到下一次 hh:mm（按 tz 墙上时间）的毫秒
 * @param hhmm 目标时刻（本地墙上时间，格式 HH:mm）
 * @param tz IANA 时区名（如 Asia/Shanghai）
 * @param now 当前时间戳（毫秒，测试可注入）
 * @returns 距下次触发的毫秒；hh:mm 非法返回 -1；到点/已过滚动到次日
 * 注：使用 hourCycle: 'h23'（午夜格式化为 00:xx），避免 hour12:false 在部分运行时解析为 h24（午夜 24:xx）导致午夜时段差值为负
 */
export function msUntilNext(hhmm: string, tz: string, now = Date.now()): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return -1
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return -1
  // tz 非法（Intl 构造抛 RangeError）时降级返回 -1：启动排程只告警不崩，避免坏配置炸掉进程
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return -1
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]))
  const curSec = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
  const targetSec = h * 3600 + min * 60
  let delta = targetSec - curSec
  if (delta <= 0) delta += 86400
  return delta * 1000
}

/**
 * 启动熔断定时重置：优先按 execution.circuitBreakerResetEveryHours 间隔模式（>0 时每 N 小时重置一次），
 * 否则按 execution.circuitBreakerResetAt 每日时刻（cfg.scheduler.timezone 墙上时间）重置；两者都关则不排程。
 * 每次归零所有 circuit_breaker_count > 0 的窗口后自动重排下一次。
 * @param cfg 应用配置（读取 execution.circuitBreakerResetEveryHours / circuitBreakerResetAt 与 scheduler.timezone）
 * @param db 本地数据库（调用 resetMeltedCircuitBreakers）
 * @param logger 日志器
 * @returns 句柄：stop() 取消已挂定时器（进程退出时调用）
 */
export function startCircuitBreakerResetSchedule(cfg: AppConfig, db: AppDb, logger: Logger): { stop(): void } {
  const at = cfg.execution.circuitBreakerResetAt
  // 非法/缺省一律按 0 处理（关闭间隔模式）
  const everyHours = Number(cfg.execution.circuitBreakerResetEveryHours) || 0
  const tz = cfg.scheduler.timezone
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  /** 执行一次重置并落日志（异常只告警，不中断排程） */
  const reset = async (label: string): Promise<void> => {
    try {
      const n = await db.resetMeltedCircuitBreakers()
      logger.info({ reset: n }, `${label}完成`)
    } catch (e) {
      logger.warn({ err: (e as Error).message }, `${label}失败`)
    }
  }

  /** 间隔模式：每 everyHours 小时重置一次，完成后重排下一次 */
  const scheduleInterval = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void (async () => {
        await reset('熔断定时重置')
        scheduleInterval()
      })()
    }, everyHours * 3600 * 1000)
  }

  /** 每日模式：到 HH:mm（tz 墙上时间）重置一次，随后重排次日 */
  const scheduleDaily = (): void => {
    if (stopped || !at) return
    const ms = msUntilNext(at, tz)
    if (ms < 0) {
      logger.warn({ at }, 'circuitBreakerResetAt 非法，跳过一次重置排程')
      return
    }
    // 兜底：ms 为 0 时立即（+1s 避免同 tick 递归）排程，而非跳过
    timer = setTimeout(() => {
      void (async () => {
        await reset('熔断每日重置')
        scheduleDaily()
      })()
    }, ms === 0 ? 1000 : ms)
  }

  if (everyHours > 0) scheduleInterval()
  else if (at) scheduleDaily()
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
}

/**
 * 定时调度纯函数（engine 层）：计划时间语义的单一事实来源
 * 依赖方向：无业务依赖（仅 node 内置 Intl），被 scheduler.ts 与 server 路由依赖
 * 设计思路：全部判断在「配置时区的墙上时钟」上做匹配（不涉及 epoch 换算，DST 无影响）；
 * 星期 1=周一 … 7=周日（由年/月/日纯算得，不依赖 Intl 的星期输出避免 locale 差异）；
 * 四种模式：interval 每 N 小时（午夜对齐、排除 00:00）/ daily 每日多时间点 /
 * weekly 每周几+时间点 / monthly 每月几号+时间点（小月无该日自然跳过）
 */

/** 频率模式 */
export type ScheduleMode = 'interval' | 'daily' | 'weekly' | 'monthly'

/** 计划时间配置（对应 schedules.config JSON 的解析形态） */
export interface ScheduleConfig {
  /** interval：自 00:00 起每 N 小时（1–23） */
  everyHours?: number
  /** daily/weekly/monthly：'HH:mm' 列表（可多个时间点） */
  times?: string[]
  /** weekly：星期集合，1=周一 … 7=周日 */
  weekdays?: number[]
  /** monthly：每月几号集合（1–31） */
  days?: number[]
}

/** 配置时区的墙上时钟 */
export interface WallClock {
  year: number
  month: number
  day: number
  /** 1=周一 … 7=周日 */
  weekday: number
  hour: number
  minute: number
}

const WEEK_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

const pad = (n: number) => String(n).padStart(2, '0')

/** 由年月日纯算星期（1=周一 … 7=周日；用 UTC 避开本地时区影响） */
function weekdayOf(year: number, month: number, day: number): number {
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0=周日 … 6=周六
  return utcDay === 0 ? 7 : utcDay
}

/** 读某时刻在指定时区的墙上时钟（Intl formatToParts，无第三方依赖） */
export function wallClockIn(tz: string, now: Date = new Date()): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  let hour = get('hour')
  if (hour === 24) hour = 0 // 个别引擎午夜输出 24
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const minute = get('minute')
  return { year, month, day, weekday: weekdayOf(year, month, day), hour, minute }
}

const hmOf = (wc: WallClock) => `${pad(wc.hour)}:${pad(wc.minute)}`
const minuteOfDay = (wc: WallClock) => wc.hour * 60 + wc.minute

/** 当前分钟是否匹配计划（到点判断；不感知「已触发过」，去重由 Scheduler 负责） */
export function isDueMinute(mode: ScheduleMode, cfg: ScheduleConfig, wc: WallClock): boolean {
  if (mode === 'interval') {
    const n = (cfg.everyHours ?? 0) * 60
    const cur = minuteOfDay(wc)
    return n > 0 && cur > 0 && cur % n === 0
  }
  if (!cfg.times?.includes(hmOf(wc))) return false
  if (mode === 'daily') return true
  if (mode === 'weekly') return cfg.weekdays?.includes(wc.weekday) ?? false
  if (mode === 'monthly') return cfg.days?.includes(wc.day) ?? false
  return false
}

/** 模式徽标文案（面板与规则摘要共用） */
export function modeLabel(mode: ScheduleMode): string {
  return { interval: '每 N 小时', daily: '每日', weekly: '每周', monthly: '每月' }[mode]
}

/** 触发规则摘要文案（面板列表展示） */
export function ruleText(mode: ScheduleMode, cfg: ScheduleConfig): string {
  if (mode === 'interval') return `每 ${cfg.everyHours} 小时一次`
  const times = (cfg.times ?? []).join(' / ')
  if (mode === 'daily') return times
  if (mode === 'weekly') return `${(cfg.weekdays ?? []).map((d) => WEEK_NAMES[d]).join('、')} ${times}`
  return `${(cfg.days ?? []).join('、')} 号 ${times}`
}

/** 闰年判断（纯墙钟日期算术用） */
function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/** 下次执行的墙上时间文本（面板展示用，纯墙钟算术，不做 epoch 换算） */
export function nextRunText(mode: ScheduleMode, cfg: ScheduleConfig, tz: string, now: Date = new Date()): string {
  const wc = wallClockIn(tz, now)
  const cur = minuteOfDay(wc)
  if (mode === 'interval') {
    const n = (cfg.everyHours ?? 1) * 60
    // 候选点为 n, 2n, …（<= 1439 分钟，即排除 00:00）
    const maxK = Math.floor((24 * 60 - 1) / n)
    if (cur < maxK * n) {
      const next = Math.max(n, Math.ceil(cur / n) * n)
      return `今天 ${pad(Math.floor(next / 60))}:${pad(next % 60)}`
    }
    return `明天 ${pad(Math.floor(n / 60))}:${pad(n % 60)}`
  }
  const times = [...(cfg.times ?? [])].sort()
  const after = (off: number) => (off === 0 ? times.filter((t) => t > hmOf(wc)) : times)
  const first = (off: number) => after(off).sort()[0]
  if (mode === 'daily') {
    return first(0) ? `今天 ${first(0)}` : `明天 ${times[0]}`
  }
  if (mode === 'weekly') {
    for (let off = 0; off <= 7; off++) {
      const d = ((wc.weekday - 1 + off) % 7) + 1
      if (!cfg.weekdays?.includes(d)) continue
      const t = first(off)
      if (t) return `${off === 0 ? '今天' : off === 1 ? '明天' : WEEK_NAMES[d]} ${t}`
    }
    return '—'
  }
  // monthly：逐日推进墙钟日期（日/月/年进位），扫 62 天（覆盖 2 月初到 3 月 31 的最坏间隔）
  let y = wc.year
  let m = wc.month
  let d = wc.day
  for (let off = 0; off <= 62; off++) {
    if (off > 0) {
      d += 1
      if (d > daysInMonth(y, m)) { d = 1; m += 1; if (m > 12) { m = 1; y += 1 } }
    }
    const dayNum = d
    if (!cfg.days?.includes(dayNum)) continue
    const t = first(off)
    if (t) return `${off === 0 ? '今天' : off === 1 ? '明天' : `${m}月${d}日`} ${t}`
  }
  return '—'
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 校验计划配置；null = 合法，否则为中文错误文案（路由 400 用） */
export function validateScheduleConfig(mode: ScheduleMode, cfg: ScheduleConfig): string | null {
  if (mode === 'interval') {
    const n = cfg.everyHours
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 23) return '间隔小时数需为 1–23 的整数'
    return null
  }
  if (!Array.isArray(cfg.times) || cfg.times.length === 0) return '至少需要一个时间点'
  for (const t of cfg.times) {
    if (typeof t !== 'string' || !TIME_RE.test(t)) return `时间点格式非法（须为 HH:mm）: ${t}`
  }
  if (mode === 'weekly') {
    if (!Array.isArray(cfg.weekdays) || cfg.weekdays.length === 0) return '至少选择一个星期'
    for (const d of cfg.weekdays) {
      if (!Number.isInteger(d) || d < 1 || d > 7) return '星期取值须为 1–7'
    }
  }
  if (mode === 'monthly') {
    if (!Array.isArray(cfg.days) || cfg.days.length === 0) return '至少选择一个日期'
    for (const d of cfg.days) {
      if (!Number.isInteger(d) || d < 1 || d > 31) return '日期取值须为 1–31'
    }
  }
  return null
}

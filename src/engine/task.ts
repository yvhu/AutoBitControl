/**
 * 任务元数据类型（engine 层）：TaskMeta 描述一个站点的静态信息
 * 依赖方向：纯类型模块，被 tasks/server/scheduler 依赖
 * 设计思路：运行参数全部挂在 meta 上（面板可读可展示、API 原样返回），
 * 执行逻辑只依赖 TaskContext，实现与元数据分离
 */

/**
 * 任务元信息：
 * key 全局唯一（API/数据库/面板都用它标识）；
 * schedule 支持 cron 字符串或错峰窗口（stagger 起止时刻）；
 * deprecated 标记失效任务（调度器跳过、面板置灰）；
 * url 为空表示文档示例（仅手动触发，调度器跳过）
 */
export interface TaskMeta {
  key: string
  name: string
  url: string
  /** 信息来源页：选择器是从哪个页面确认的，站点改版时回这里重查 */
  sourceUrl?: string
  /** 备注：站点的坑与特殊逻辑，面板任务页直接可见 */
  note?: string
  category?: 'checkin' | 'faucet' | 'mint' | 'other'
  lastUpdated?: string
  deprecated?: boolean
  /** 任务开关（纯代码开关）：false 时调度器跳过、窗口"立即跑"排除、手动触发接口 409；改后需重启生效 */
  enabled?: boolean
  /** 调度配置：cron 字符串（固定时间点）/ stagger（每日错峰窗口）/ everyHours（每 N 小时间隔，锚点=最近一次成功完成时刻） */
  schedule?: string | { stagger: [string, string] } | { everyHours: number }
  /** 登录用钱包的 key（对应 WalletRegistry 注册表） */
  wallet?: string
  /** 单次运行超时（秒，缺省用 execution.taskTimeoutMs） */
  timeoutSec?: number
  /** 失败重试：max 额外重试次数、backoffSec 重试间隔（秒） */
  retry?: { max: number; backoffSec: number }
  /** 验证码自动处理开关与单任务费用上限（点） */
  captcha?: { auto?: boolean; maxCost?: number }
}

/** 任务引用（runner 内部持有的最小视图） */
export interface TaskRef {
  meta: TaskMeta
}

/** 是否间隔调度（每 N 小时）——调度器与窗口执行器共用判定 */
export function isIntervalSchedule(s: TaskMeta['schedule'] | null): s is { everyHours: number } {
  if (typeof s !== 'object' || s === null || !('everyHours' in s)) return false
  const v = (s as { everyHours?: unknown }).everyHours
  // 必须是有限正数：0/负数/NaN 都会让间隔判定恒真、nextAllow 推后 0，导致每分钟全窗口触发
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

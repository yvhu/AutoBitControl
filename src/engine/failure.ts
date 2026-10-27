/**
 * 任务失败分类（engine 层）：把一次失败归为环境/任务/超时
 * 依赖方向：依赖 infrastructure/run-errors；被 window-runner 使用
 */
import { TaskExecutionError, TaskTimeoutError, WindowUnavailableError, type FailureKind } from '../infrastructure/run-errors'

export type FailureStage = 'open' | 'connect' | 'task'

const WINDOW_UNHEALTHY_PATTERN = new RegExp(
  [
    'Protocol error',
    'session closed',
    'Target page',
    'Target closed',
    'target crashed',
    'browser has been closed',
    '钱包扩展未加载',
    '窗口 .* 已关闭',
    'net::ERR_PROXY',
    'net::ERR_TUNNEL',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NAME_NOT_RESOLVED',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'socket hang up',
  ].join('|'),
  'i',
)

/** 代理/隧道/SOCKS 连接失败：通常只影响该窗口的代理，恢复时间以分钟计，使用短熔断冷却 */
const PROXY_FAILURE_PATTERN = /net::ERR_(?:PROXY|TUNNEL|SOCKS)_|ERR_PROXY_AUTH|ERR_SOCKS_CONNECTION/i

/** 失败消息是否属于代理连接类失败 */
export function isProxyFailure(message: string): boolean {
  return PROXY_FAILURE_PATTERN.test(message)
}

/**
 * 分类一次失败：
 * 1. 显式错误类型优先；
 * 2. 开窗/CDP 阶段默认环境失败；
 * 3. 消息命中窗口/网络模式按环境失败；
 * 4. 其余默认任务失败（宁可漏熔断，不误熔断）。
 */
export function classifyFailure(stage: FailureStage, error: unknown): FailureKind {
  if (error instanceof WindowUnavailableError) return 'environment'
  if (error instanceof TaskTimeoutError) return 'timeout'
  if (error instanceof TaskExecutionError) return 'task'
  if (stage === 'open' || stage === 'connect') return 'environment'
  const message = error instanceof Error ? error.message : String(error)
  return WINDOW_UNHEALTHY_PATTERN.test(message) ? 'environment' : 'task'
}

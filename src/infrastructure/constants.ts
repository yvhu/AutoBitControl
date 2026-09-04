/**
 * 通用运行时常量（infrastructure 层）：跨层共享的默认值与错误模式
 * 依赖方向：无依赖，被 engine/automation/tasks/app 共用
 */

/**
 * CDP 会话级瞬时错误模式（app 进程级兜底与任务级点击重试共用）：
 * 窗口中途关闭/崩溃时 patchright 内部协议错误；任务侧用于区分「可重试的瞬时错误」与确定性失败
 */
export const CDP_TRANSIENT_PATTERN = /Protocol error|session closed|Target page|target crashed|Navigation failed|Execution context was destroyed|browser has been closed/i

/** page.reload 默认超时（毫秒）：登录态判定/页面恢复共用（真机实测网络差时 45s 内能回来） */
export const DEFAULT_RELOAD_TIMEOUT_MS = 45000

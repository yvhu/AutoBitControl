/**
 * 运行失败公共类型（infrastructure 层）：失败分类枚举与错误类型
 * 依赖方向：无业务依赖；被 engine/automation 使用
 */
export type FailureKind = 'environment' | 'task' | 'timeout' | 'stopped' | 'captcha' | 'breaker'

export class WindowUnavailableError extends Error {
  readonly kind: FailureKind = 'environment'

  constructor(message: string) {
    super(message)
    this.name = 'WindowUnavailableError'
  }
}

export class TaskExecutionError extends Error {
  readonly kind: FailureKind = 'task'

  constructor(message: string) {
    super(message)
    this.name = 'TaskExecutionError'
  }
}

export class TaskTimeoutError extends Error {
  readonly kind: FailureKind = 'timeout'

  constructor(message: string) {
    super(message)
    this.name = 'TaskTimeoutError'
  }
}

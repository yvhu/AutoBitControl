/**
 * 统一业务错误码（server 层）：错误码常量表与业务 HttpError
 * 依赖方向：无依赖，被 http/error.ts 与各路由引用
 * 设计思路：code = status*100 + 序号（与 HTTP 状态码联动，前端可按千位段处理）；
 * 4 开头 = 客户端可理解错误，5 开头 = 服务端异常
 */

/** 业务错误码表：与 HTTP 状态码联动（code = status*100 + 序号） */
export const ERROR_CODES = {
  INVALID_ARGUMENT: 40000,
  GENERIC_NOT_FOUND: 40400,
  TASK_NOT_FOUND: 40401,
  PROFILE_NOT_FOUND: 40402,
  SCREENSHOT_NOT_FOUND: 40403,
  DOCS_NOT_FOUND: 40404,
  BATCH_NOT_FOUND: 40405,
  SCHEDULE_NOT_FOUND: 40406,
  TASK_DISABLED: 40901,
  TASK_RUNNING: 40902,
  SCHEDULE_DISABLED: 40903,
  INTERNAL: 50000,
} as const

/** 业务错误：status 为期望返回的 HTTP 状态码，code 为业务错误码（路由直接 throw 交给 errorHandler） */
export class HttpError extends Error {
  constructor(public status: number, public code: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

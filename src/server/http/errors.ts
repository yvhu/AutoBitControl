/**
 * 统一业务错误码（server 层）：错误码常量表与业务 HttpError
 * 依赖方向：无依赖，被 http/error.ts 与各路由引用
 * 设计思路：code = status*100 + 序号（与 HTTP 状态码联动，前端可按千位段处理）；
 * 4 开头 = 客户端可理解错误，5 开头 = 服务端异常
 *
 * 注意：本表所有键名与数值均为对外稳定契约（前端/测试/文档按数值引用），
 * 仅按 HTTP 段重排、加分组注释，绝不改动任何键名或数值。
 */

/** 业务错误码表：与 HTTP 状态码联动（code = status*100 + 序号），按 HTTP 段分组、组内按数值升序 */
export const ERROR_CODES = {
  // 400xx：请求参数 / 工具入参校验失败
  INVALID_ARGUMENT: 40000,
  // 工具域错误码（与 src/tools/errors.ts 的 TOOL_ERROR_CODES 数值一致）
  TOOL_DIR_NOT_FOUND: 40001,
  TOOL_COLUMN_NOT_FOUND: 40002,
  TOOL_FILES_INSUFFICIENT: 40003,
  TOOL_TEMPLATE_INVALID: 40004,
  TOOL_PLAN_INVALID: 40005,
  // 404xx：资源不存在
  GENERIC_NOT_FOUND: 40400,
  TASK_NOT_FOUND: 40401,
  PROFILE_NOT_FOUND: 40402,
  SCREENSHOT_NOT_FOUND: 40403,
  DOCS_NOT_FOUND: 40404,
  BATCH_NOT_FOUND: 40405,
  SCHEDULE_NOT_FOUND: 40406,
  // 空投追踪域错误码
  AIRDROP_NOT_FOUND: 40407,
  RUN_DIAG_NOT_FOUND: 40408,
  RUN_NOT_FOUND: 40409,
  // 409xx：状态冲突
  TASK_DISABLED: 40901,
  TASK_RUNNING: 40902,
  SCHEDULE_DISABLED: 40903,
  TOOL_BUSY: 40904,
  AIRDROP_STATUS_NOT_EMPTY: 40905,
  SCHEDULE_PURE_ASSIGN_EXISTS: 40906,
  /** 同时打开的窗口数已达 execution.maxConcurrentWindows 上限，拒绝再开 */
  WINDOW_LIMIT_REACHED: 40907,
  // 500xx：服务端异常
  INTERNAL: 50000,
  TOOL_IO_FAILED: 50001,
} as const

/** 业务错误：status 为期望返回的 HTTP 状态码，code 为业务错误码（路由直接 throw 交给 errorHandler） */
export class HttpError extends Error {
  constructor(public status: number, public code: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

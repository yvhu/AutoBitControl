/**
 * 工具域错误（tools 层）：工具业务错误码与 ToolError
 * 依赖方向：无依赖，被 tools 内各模块抛出，由 server 路由映射为统一响应
 * 设计思路：tools 不能反向依赖 server（分层约束），故自持错误码；
 * 数值与 server/http/errors.ts 的 ERROR_CODES 对应项保持一致（code = status*100 + 序号）
 */
export const TOOL_ERROR_CODES = {
  /** 400：源文件夹不存在或不是目录 */
  TOOL_DIR_NOT_FOUND: 40001,
  /** 400：目标列在 accounts.xlsx 中不存在 */
  TOOL_COLUMN_NOT_FOUND: 40002,
  /** 400：文件数少于账号行数 */
  TOOL_FILES_INSUFFICIENT: 40003,
  /** 400：名称模板无效（生成串为空/个数越界/插入参数缺失） */
  TOOL_TEMPLATE_INVALID: 40004,
  /** 400：执行阶段回传计划校验失败（文件变动/行数不一致等） */
  TOOL_PLAN_INVALID: 40005,
  /** 409：上一次执行进行中 */
  TOOL_BUSY: 40904,
  /** 500：磁盘 IO 失败（重命名/写回 xlsx） */
  TOOL_IO_FAILED: 50001,
} as const

/** 工具域业务错误：status 为期望 HTTP 状态码，code 为业务错误码（路由负责转统一响应） */
export class ToolError extends Error {
  constructor(public status: number, public code: number, message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

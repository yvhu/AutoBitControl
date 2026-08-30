/**
 * 错误处理（server 层）：统一 404/500 处理器（业务 HttpError 已迁至 http/errors.ts，此处重导出保证旧引用不破）
 * 依赖方向：仅依赖 express 类型与 infrastructure/logger，被 app 装配
 * 设计思路：路由抛 HttpError 直接映射为对应状态码 + 业务错误码；
 * 其余异常一律 500，只向客户端暴露通用文案（细节进日志，不泄露内部信息）
 */
import type { ErrorRequestHandler, RequestHandler } from 'express'
import type { Logger } from '../../infrastructure/logger'
import { fail } from './response'
import { HttpError, ERROR_CODES } from './errors'

// 兼容重导出：历史引用 `import { HttpError } from '../http/error'` 继续可用
export { HttpError }

/** /api 前缀下未匹配路由的兜底 404（业务码 40400 = 404*100，泛化"接口不存在"，无细分实体） */
export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    fail(res, 404, 40400, `接口不存在: ${req.method} ${req.path}`)
  }
}

/**
 * 统一错误处理器：HttpError 按 status + 业务 code 返回；未知异常 500 + 记录日志
 * 注意：必须保留 4 参签名，express 以此识别为错误处理中间件
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : 500
    if (status >= 500) logger.error({ err: err.message, path: req.path }, '接口异常')
    fail(res, status, err instanceof HttpError ? err.code : ERROR_CODES.INTERNAL, err instanceof HttpError ? err.message : '服务器内部错误')
  }
}

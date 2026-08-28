import type { ErrorRequestHandler, RequestHandler } from 'express'
import type { Logger } from '../../infrastructure/logger'
import { fail } from './response'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    fail(res, 404, 404, `接口不存在: ${req.method} ${req.path}`)
  }
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : 500
    if (status >= 500) logger.error({ err: err.message, path: req.path }, '接口异常')
    fail(res, status, status, err instanceof HttpError ? err.message : '服务器内部错误')
  }
}

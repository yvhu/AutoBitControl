/**
 * 响应封装（server 层）：统一响应包格式与异步处理器包装
 * 依赖方向：仅依赖 express 类型，被所有路由依赖
 * 设计思路：统一 { code, message, data } 包格式（spec 1.3），
 * 前端 api.js 按同一约定解包，测试断言只看 code/data
 */
import type { RequestHandler, Response } from 'express'

/** 成功响应：code=0 约定成功，data 为业务数据 */
export function ok(res: Response, data: unknown = null): void {
  res.json({ code: 0, message: 'ok', data })
}

/** 失败响应：code 为业务错误码（见 http/errors.ts ERROR_CODES） */
export function fail(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ code, message, data: null })
}

/**
 * 包装 async 路由：异常交给 next 走统一错误处理器（不用每个路由手写 try/catch）
 * @returns 标准 RequestHandler（express 按 3 参识别为普通中间件）
 */
export function asyncHandler(fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

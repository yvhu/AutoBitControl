import type { RequestHandler, Response } from 'express'

export function ok(res: Response, data: unknown = null): void {
  res.json({ code: 0, message: 'ok', data })
}

export function fail(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ code, message, data: null })
}

export function asyncHandler(fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

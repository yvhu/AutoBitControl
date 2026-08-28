export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface HttpJsonOptions {
  baseUrl: string
  path: string
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  timeoutMs?: number
  headers?: Record<string, string>
}

export async function httpJson<T>(opts: HttpJsonOptions): Promise<T> {
  const method = opts.method ?? 'GET'
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  if (opts.timeoutMs !== undefined) init.signal = AbortSignal.timeout(opts.timeoutMs)
  let res: Response
  try {
    res = await fetch(`${opts.baseUrl}${opts.path}`, init)
  } catch (e) {
    throw new HttpError(0, `请求失败: ${(e as Error).message}`)
  }
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`)
  try {
    return (await res.json()) as T
  } catch (e) {
    throw new HttpError(res.status, `响应解析失败: ${(e as Error).message}`)
  }
}

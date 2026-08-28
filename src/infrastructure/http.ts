/**
 * HTTP 工具层（infrastructure）：统一 JSON 请求封装与 HTTP 错误类型
 * 依赖方向：仅依赖 Node 内置 fetch，被 integrations 层依赖
 * 设计思路：所有出站 API 调用收敛到 httpJson，统一超时/错误包装，避免各客户端重复处理
 */

/**
 * HTTP 错误：status=0 表示网络层失败（fetch 抛错，无 HTTP 状态码），
 * 非 0 表示服务端返回的实际状态码；message 可直接展示给日志/面板
 */
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

/**
 * 发送 JSON 请求并解析响应体
 * @param opts.baseUrl 服务根地址（不含路径）
 * @param opts.path 接口路径（以 / 开头）
 * @param opts.body 请求体（存在时序列化为 JSON）
 * @param opts.timeoutMs 超时（缺省不设超时）
 * @returns 解析后的 JSON 响应体
 * @throws HttpError 网络失败（status=0）/ 非 2xx 响应 / JSON 解析失败
 */
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

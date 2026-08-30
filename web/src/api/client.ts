export class HttpError extends Error {
  constructor(public code: number, message: string) { super(message) }
}

interface Envelope<T> { code: number; message: string; data: T }

export async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const json = (await res.json().catch(() => null)) as Envelope<T> | null
  if (!json || json.code !== 0) throw new HttpError(json?.code ?? res.status, json?.message ?? '请求失败')
  return json.data
}

export const get = <T>(path: string) => request<T>(path)
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body })
export const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body })

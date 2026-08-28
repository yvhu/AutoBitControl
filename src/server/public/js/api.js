async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const json = await res.json().catch(() => ({ code: res.status, message: '响应解析失败', data: null }))
  if (json.code !== 0) {
    console.error(`API 错误 [${json.code}] ${json.message}`)
    throw new Error(json.message)
  }
  return json.data
}

export function get(path) { return request(path) }
export function post(path, body) { return request(path, { method: 'POST', body }) }
export function patch(path, body) { return request(path, { method: 'PATCH', body }) }
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) }

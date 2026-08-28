// 统一 API 客户端：所有请求走 fetch，按后端 { code, message, data } 包格式解包
async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  // 非 JSON 响应（如静态文件被代理）兜底为错误包
  const json = await res.json().catch(() => ({ code: res.status, message: '响应解析失败', data: null }))
  if (json.code !== 0) {
    console.error(`API 错误 [${json.code}] ${json.message}`)
    throw new Error(json.message)
  }
  return json.data
}

// GET 请求
export function get(path) { return request(path) }
// POST 请求（body 自动 JSON 序列化）
export function post(path, body) { return request(path, { method: 'POST', body }) }
// PATCH 请求
export function patch(path, body) { return request(path, { method: 'PATCH', body }) }
// HTML 转义：所有拼进 innerHTML 的动态值必须过它（防 XSS）
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) }

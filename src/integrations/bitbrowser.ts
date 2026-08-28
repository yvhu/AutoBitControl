import { httpJson } from '../infrastructure/http'

export interface OpenResult {
  http: string
  ws: string
}

export interface BrowserInfo {
  id: string
  name: string
}

interface BitBrowserResp {
  success?: boolean
  code?: number
  msg?: string
  data?: Record<string, unknown>
}

export class BitBrowserClient {
  constructor(private cfg: { apiBase: string; timeoutMs: number }) {}

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const json = await httpJson<BitBrowserResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: this.cfg.timeoutMs })
    const ok = json.success === true || json.code === 0
    if (!ok) throw new Error(`比特浏览器 API 失败: ${path} ${json.msg ?? `code=${json.code}`}`)
    return (json.data ?? {}) as Record<string, unknown>
  }

  async health(): Promise<boolean> {
    try {
      await this.post('/health', {})
      return true
    } catch {
      return false
    }
  }

  async openBrowser(id: string): Promise<OpenResult> {
    const d = await this.post('/browser/open', { id })
    const http = String(d.http ?? '')
    const legacy = String(d.debugPort ?? d.debug_port ?? '')
    const httpField = http || (legacy ? `127.0.0.1:${legacy}` : '')
    if (!httpField) throw new Error(`开窗失败: 未返回调试端口, data=${JSON.stringify(d)}`)
    return { http: httpField, ws: String(d.ws ?? '') }
  }

  async closeBrowser(id: string): Promise<void> {
    await this.post('/browser/close', { id })
  }

  async listBrowsers(page = 0, pageSize = 100): Promise<BrowserInfo[]> {
    const d = await this.post('/browser/list', { page, pageSize })
    const raw = (d.list ?? d.page ?? []) as Array<{ id: string | number; name?: string }>
    return raw.map(l => ({ id: String(l.id), name: l.name ?? String(l.id) }))
  }
}

export function createBitBrowserClient(cfg: { apiBase: string; timeoutMs: number }): BitBrowserClient {
  return new BitBrowserClient(cfg)
}

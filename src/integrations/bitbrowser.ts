/**
 * 比特浏览器客户端（integrations 层）：封装本地 API 的 POST 调用
 * 依赖方向：依赖 infrastructure/http，被 engine/window-runner 与 server 层依赖
 * 设计思路：统一校验平台响应包（success/code/msg），只向调用方暴露业务字段
 */
import { httpJson } from '../infrastructure/http'

/** 开窗结果：http 为调试端口地址（CDP 连接用），ws 为 websocket 地址（备用） */
export interface OpenResult {
  http: string
  ws: string
}

/** 窗口基本信息（列表接口返回项） */
export interface BrowserInfo {
  id: string
  name: string
}

/** 平台响应包：success 与 code 两种口径兼容（不同版本 API 返回习惯不同） */
interface BitBrowserResp {
  success?: boolean
  code?: number
  msg?: string
  data?: Record<string, unknown>
}

export class BitBrowserClient {
  constructor(private cfg: { apiBase: string; timeoutMs: number }) {}

  /**
   * 平台统一 POST：校验响应包后返回 data 段
   * @throws 平台返回非成功码时抛错（message 带平台 msg/code）
   */
  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const json = await httpJson<BitBrowserResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: this.cfg.timeoutMs })
    const ok = json.success === true || json.code === 0
    if (!ok) throw new Error(`比特浏览器 API 失败: ${path} ${json.msg ?? `code=${json.code}`}`)
    return (json.data ?? {}) as Record<string, unknown>
  }

  /** 健康检查（服务未就绪返回 false，不抛错） */
  async health(): Promise<boolean> {
    try {
      await this.post('/health', {})
      return true
    } catch {
      return false
    }
  }

  /**
   * 打开窗口并返回调试地址
   * @throws 未返回调试端口时抛错（data.http 缺失且无旧版 debugPort 字段）
   */
  async openBrowser(id: string): Promise<OpenResult> {
    const d = await this.post('/browser/open', { id })
    const http = String(d.http ?? '')
    // 兼容旧版平台字段 debugPort/debug_port：仅返回端口号时补上本机地址
    const legacy = String(d.debugPort ?? d.debug_port ?? '')
    const httpField = http || (legacy ? `127.0.0.1:${legacy}` : '')
    if (!httpField) throw new Error(`开窗失败: 未返回调试端口, data=${JSON.stringify(d)}`)
    return { http: httpField, ws: String(d.ws ?? '') }
  }

  /** 关闭窗口（失败抛错由调用方兜底） */
  async closeBrowser(id: string): Promise<void> {
    await this.post('/browser/close', { id })
  }

  /** 分页拉取窗口列表（app 启动时同步到 profiles 表） */
  async listBrowsers(page = 0, pageSize = 100): Promise<BrowserInfo[]> {
    const d = await this.post('/browser/list', { page, pageSize })
    const raw = (d.list ?? d.page ?? []) as Array<{ id: string | number; name?: string }>
    return raw.map(l => ({ id: String(l.id), name: l.name ?? String(l.id) }))
  }
}

/** 工厂函数（统一创建入口，测试可整体替换） */
export function createBitBrowserClient(cfg: { apiBase: string; timeoutMs: number }): BitBrowserClient {
  return new BitBrowserClient(cfg)
}

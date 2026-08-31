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

/** 窗口基本信息（列表接口返回项；元数据字段随比特客户端填写情况可为空） */
export interface BrowserInfo {
  id: string
  name: string
  remark?: string
  seq?: number
  lastIp?: string
  lastCountry?: string
  coreVersion?: string
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

  /**
   * 单窗口打开状态探测（POST /browser/pids）
   * @returns pid 实测存活返回 true；请求失败/结构异常一律返回 false（容错优先，调用方按未开处理）
   */
  async isOpen(id: string): Promise<boolean> {
    try {
      return (await this.openPids([id])).has(id)
    } catch {
      return false
    }
  }

  /**
   * 批量打开状态探测（一次请求查全部窗口，面板列表 100 窗口场景避免逐窗口请求）
   * data 结构容错：map 对象 {id: pid} / id 数组 / 对象数组（{id,pid} 等），值真值即视为打开
   * @throws 请求失败向上抛（由调用方决定降级策略，如面板列表按全部未开处理但不清理登记行）
   */
  async openPids(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const d = await this.post('/browser/pids', { ids })
    return parseOpenPids(d, ids)
  }

  /** 分页拉取窗口列表（app 启动时同步到 profiles 表；附带备注/序号/最近 IP 与内核版本元数据） */
  async listBrowsers(page = 0, pageSize = 100): Promise<BrowserInfo[]> {
    const d = await this.post('/browser/list', { page, pageSize })
    const raw = (d.list ?? d.page ?? []) as Array<Record<string, unknown>>
    return raw.map((l) => ({
      id: String(l.id),
      name: typeof l.name === 'string' ? l.name : String(l.id),
      remark: typeof l.remark === 'string' && l.remark !== '' ? l.remark : undefined,
      seq: typeof l.seq === 'number' ? l.seq : undefined,
      lastIp: typeof l.lastIp === 'string' && l.lastIp !== '' ? l.lastIp : undefined,
      lastCountry: typeof l.lastCountry === 'string' && l.lastCountry !== '' ? l.lastCountry : undefined,
      coreVersion: typeof l.coreVersion === 'string' && l.coreVersion !== '' ? l.coreVersion : undefined,
    }))
  }
}

/** 真值判定：排除空/0/false（pid 为 0 或空串均视为未打开） */
function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (typeof v === 'string') return v !== '0'
  return true
}

/**
 * 解析 /browser/pids 的 data 段（平台版本差异容错）：
 * - map 对象 {id: pid}：直接取 id 键的真值
 * - 数组：元素为 id 字符串（打开列表）或 {id, pid} 对象（取 pid 真值）
 */
function parseOpenPids(data: unknown, ids: string[]): Set<string> {
  const open = new Set<string>()
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') {
        if (ids.includes(item)) open.add(item)
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const id = String(obj.id ?? obj.bitbrowserId ?? obj.bitbrowser_id ?? '')
        const pid = obj.pid ?? obj.value ?? obj
        if (id && ids.includes(id) && isTruthy(pid)) open.add(id)
      }
    }
    return open
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const id of ids) {
      if (isTruthy((data as Record<string, unknown>)[id])) open.add(id)
    }
  }
  return open
}

/** 工厂函数（统一创建入口，测试可整体替换） */
export function createBitBrowserClient(cfg: { apiBase: string; timeoutMs: number }): BitBrowserClient {
  return new BitBrowserClient(cfg)
}

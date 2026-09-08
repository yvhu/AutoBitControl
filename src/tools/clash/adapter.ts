/**
 * Clash 客户端适配器（tools 层）：mihomo external-controller REST API 统一封装
 * 依赖方向：默认请求走 infrastructure/http（httpJson），测试注入 fake request 替换
 * 设计思路：不识别 GUI 客户端名，只面向 external-controller 协议（各客户端最大公约数）；
 * delay 接口 404 时置 delaySupported=false 供上层降级决策
 */
import { httpJson, HttpError } from '../../infrastructure/http'
import type { ClashGroup, ClashSubscription } from './types'

/** 可注入请求面：默认实现走 httpJson + baseUrl/secret/timeout；测试替换模拟平台响应 */
export interface ClashRequest {
  (opts: { method: 'GET' | 'PUT'; path: string; body?: unknown }): Promise<unknown>
}

/** delay 测速结果：supported=false 表示内核不支持该接口（调用方应降级报错而非造假数据） */
export interface DelayOutcome {
  supported: boolean
  reachable: boolean
  delayMs: number
}

export class ClashAdapter {
  /** delay 接口可用性（首次 404 后置 false，此后不再发起该调用） */
  private delaySupportedFlag = true

  constructor(
    public readonly apiBase: string,
    private readonly apiSecret: string,
    private readonly timeoutMs: number,
    private readonly request: ClashRequest = (opts) =>
      httpJson({
        baseUrl: apiBase,
        path: opts.path,
        method: opts.method,
        body: opts.body,
        timeoutMs,
        headers: apiSecret ? { Authorization: `Bearer ${apiSecret}` } : {},
      }),
  ) {}

  /** GET /version：内核版本（探测用） */
  async version(): Promise<Record<string, unknown>> {
    return (await this.request({ method: 'GET', path: '/version' })) as Record<string, unknown>
  }

  /** GET /configs：读取实际混合代理口（兼容 mixed-port/mixedPort/port 三种字段） */
  async mixedPort(): Promise<number | null> {
    const c = (await this.request({ method: 'GET', path: '/configs' })) as Record<string, unknown>
    for (const key of ['mixed-port', 'mixedPort', 'port']) {
      const v = c[key]
      if (typeof v === 'number' && Number.isInteger(v)) return v
    }
    return null
  }

  /** GET /proxies：全部 Selector/URLTest 分组（含当前选中 now 与组内节点 all） */
  async groups(): Promise<ClashGroup[]> {
    const d = (await this.request({ method: 'GET', path: '/proxies' })) as Record<string, unknown>
    const proxies = (d.proxies ?? {}) as Record<string, Record<string, unknown>>
    return Object.entries(proxies)
      .filter(([, p]) => p.type === 'Selector' || p.type === 'URLTest')
      .map(([name, p]) => ({
        name,
        now: typeof p.now === 'string' ? p.now : undefined,
        all: Array.isArray(p.all) ? p.all.map(String) : undefined,
      }))
  }

  /** GET /proxies/{name}/delay：单节点对单 URL 的延迟测试（不可达返回 delay=0） */
  async delay(name: string, url: string): Promise<DelayOutcome> {
    if (!this.delaySupportedFlag) return { supported: false, reachable: false, delayMs: 0 }
    try {
      const d = (await this.request({
        method: 'GET',
        path: `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${this.timeoutMs}`,
      })) as Record<string, unknown>
      const delayMs = Number(d.delay)
      return { supported: true, reachable: delayMs > 0, delayMs: delayMs > 0 ? delayMs : 0 }
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        this.delaySupportedFlag = false
        return { supported: false, reachable: false, delayMs: 0 }
      }
      // 其余失败（网络错误/500）按不可达处理，不打断整轮测速
      return { supported: true, reachable: false, delayMs: 0 }
    }
  }

  /** PUT /proxies/{group}：切换分组选中节点 */
  async switchNode(group: string, name: string): Promise<void> {
    await this.request({ method: 'PUT', path: `/proxies/${encodeURIComponent(group)}`, body: { name } })
  }

  /** GET /providers/proxies：订阅列表（订阅未以 proxy-provider 配置时为空数组） */
  async providers(): Promise<ClashSubscription[]> {
    const d = (await this.request({ method: 'GET', path: '/providers/proxies' })) as Record<string, unknown>
    const map = (d.providers ?? {}) as Record<string, Record<string, unknown>>
    return Object.entries(map).map(([name, p]) => ({
      name,
      vehicleType: String(p.vehicleType ?? ''),
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
      proxiesCount: Array.isArray(p.proxies) ? p.proxies.length : 0,
    }))
  }

  /** PUT /providers/proxies/{name}：重拉订阅（更新节点列表） */
  async updateProvider(name: string): Promise<void> {
    await this.request({ method: 'PUT', path: `/providers/proxies/${encodeURIComponent(name)}` })
  }

  /** PUT /configs：以指定配置文件重载（订阅文件切换） */
  async reloadConfig(path: string): Promise<void> {
    await this.request({ method: 'PUT', path: '/configs', body: { path } })
  }

  /** delay 接口当前可用性（供能力集展示） */
  get delaySupported(): boolean {
    return this.delaySupportedFlag
  }
}

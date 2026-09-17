/**
 * Clash 测速选优服务（tools 层）：测速 → 综合评分 → 选优 → 切换 → 回滚
 * 依赖方向：依赖 ./adapter ./client-detector ../errors ./types 与 infrastructure 类型
 * 设计思路：单例 + 进程内 busy 锁（自动检测与手动触发互斥）；切换失败自动回滚；
 * 全 IO 经注入（adapter/logger/getCfg），测试不连真 Clash
 */
import type { ClashAdapter } from './adapter'
import { detectClash } from './client-detector'
import { ToolError, TOOL_ERROR_CODES } from '../errors'
import type { ClashConfig } from '../../infrastructure/config'
import type { Logger } from '../../infrastructure/logger'
import type {
  ClashDetectResult, ClashGroup, ClashTestResult, CurrentNodeTestResult,
  NodeTestResult, OptimizeResult, UrlDelay,
} from './types'

export interface ClashServiceDeps {
  adapter: ClashAdapter
  getCfg: () => ClashConfig
  logger: Logger
}

/** 小组并发池：limit 控制同时测速数（机场风控）；节点内多 URL 串行 */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

/**
 * 单节点综合得分：可达 URL 加权延迟 + 不可达 URL 惩罚（按超时计）；
 * 全部不可达判不可用（白名单机场节点只要有一个目标可达就不会被误杀）
 */
export function scoreNode(urls: UrlDelay[], weights: number[], timeoutMs: number): { score: number; usable: boolean } {
  let score = 0
  let reachableCount = 0
  urls.forEach((u, i) => {
    const w = weights[i] ?? 1
    if (u.reachable) {
      score += u.delayMs * w
      reachableCount++
    } else {
      score += timeoutMs * w
    }
  })
  return { score, usable: reachableCount > 0 }
}

/** 配置文件名校验：仅普通 yaml/yml 文件名（防路径穿越） */
const PROFILE_FILE_RE = /^[\w.-]+\.ya?ml$/i

export class ClashService {
  private busy = false

  constructor(private deps: ClashServiceDeps) {}

  /** 是否有检测/切换进行中（路由与自动检测共用） */
  get isBusy(): boolean {
    return this.busy
  }

  /** 探测客户端（面板状态条） */
  async detect(): Promise<ClashDetectResult> {
    return detectClash(this.deps.adapter)
  }

  /** 当前工作分组：优先配置 clash.group，其次 GLOBAL/第一个 Selector 组 */
  private async resolveGroup(): Promise<ClashGroup> {
    const configured = this.deps.getCfg().group
    const groups = await this.deps.adapter.groups()
    if (configured) {
      const g = groups.find((x) => x.name === configured)
      if (!g) throw new ToolError(400, TOOL_ERROR_CODES.CLASH_GROUP_NOT_FOUND, `目标分组不存在: ${configured}`)
      return g
    }
    const fallback = groups.find((x) => x.name === 'GLOBAL') ?? groups[0]
    if (!fallback) throw new ToolError(400, TOOL_ERROR_CODES.CLASH_GROUP_NOT_FOUND, '未找到可用的 Selector 分组（请检查 Clash 配置）')
    return fallback
  }

  /** 只读测速：当前节点（单节点；「立即测速」入口） */
  async test(): Promise<CurrentNodeTestResult> {
    if (this.busy) throw new ToolError(409, TOOL_ERROR_CODES.TOOL_BUSY, '上一次检测/切换进行中，请稍候')
    this.busy = true
    try {
      return await this.testCurrentNode()
    } finally {
      this.busy = false
    }
  }

  /** 只读测速：分组内全部候选节点（选优/自动检测用） */
  async testGroup(): Promise<ClashTestResult> {
    if (this.busy) throw new ToolError(409, TOOL_ERROR_CODES.TOOL_BUSY, '上一次检测/切换进行中，请稍候')
    this.busy = true
    try {
      return await this.testGroupInner()
    } finally {
      this.busy = false
    }
  }

  private async testCurrentNode(): Promise<CurrentNodeTestResult> {
    const cfg = this.deps.getCfg()
    if (!this.deps.adapter.delaySupported) {
      throw new ToolError(500, TOOL_ERROR_CODES.CLASH_API_FAILED, '当前内核不支持 delay 测速接口，无法测速')
    }
    const group = await this.resolveGroup()
    const now = group.now
    // 当前节点为空/直连/拦截/兜底时无可测意义，返回空态由前端提示
    if (!now || now === 'DIRECT' || now === 'REJECT' || now === 'PASS') {
      return { group: group.name, currentNode: now ?? null, currentUsable: false, node: null }
    }
    const results: UrlDelay[] = []
    for (const url of cfg.testUrls) {
      const out = await this.deps.adapter.delay(now, url)
      results.push({ url, delayMs: out.delayMs, reachable: out.supported && out.reachable })
    }
    const { score, usable } = scoreNode(results, cfg.weights, cfg.testTimeoutMs)
    return { group: group.name, currentNode: now, currentUsable: usable, node: { name: now, urls: results, score, usable } }
  }

  private async testGroupInner(): Promise<ClashTestResult> {
    const cfg = this.deps.getCfg()
    if (!this.deps.adapter.delaySupported) {
      throw new ToolError(500, TOOL_ERROR_CODES.CLASH_API_FAILED, '当前内核不支持 delay 测速接口，无法测速')
    }
    const group = await this.resolveGroup()
    const names = (group.all ?? [])
      .filter((n) => n !== 'DIRECT' && n !== 'REJECT' && n !== 'PASS' && !n.startsWith('__'))
      .slice(0, cfg.maxNodes)
    const nodes: NodeTestResult[] = []
    await runPool(names, cfg.testConcurrency, async (name) => {
      const results: UrlDelay[] = []
      for (const url of cfg.testUrls) {
        const out = await this.deps.adapter.delay(name, url)
        results.push({ url, delayMs: out.delayMs, reachable: out.supported && out.reachable })
      }
      const { score, usable } = scoreNode(results, cfg.weights, cfg.testTimeoutMs)
      nodes.push({ name, urls: results, score, usable })
    })
    nodes.sort((a, b) => a.score - b.score)
    const currentUsable = nodes.find((n) => n.name === group.now)?.usable ?? null
    return { group: group.name, currentNode: group.now ?? null, currentUsable, nodes }
  }

  /**
   * 选优并切换（手动入口与自动检测共用）
   * @param prev 已测结果（自动检测先 test 再传入，跳过重复测速）
   */
  async optimize(prev?: ClashTestResult): Promise<OptimizeResult> {
    if (this.busy) throw new ToolError(409, TOOL_ERROR_CODES.TOOL_BUSY, '上一次检测/切换进行中，请稍候')
    this.busy = true
    try {
      const cfg = this.deps.getCfg()
      const result = prev ?? (await this.testGroupInner())
      const usable = result.nodes.filter((n) => n.usable)
      if (usable.length === 0) {
        this.deps.logger.warn({ group: result.group }, 'Clash 测速全网不可用（全部节点不通），不切换')
        return { chosen: null, switched: false, nodes: result.nodes, switchNote: '全网不可用' }
      }
      const group = await this.resolveGroup()
      const current = result.currentNode ?? group.now
      const chosen = usable[0]
      const currentNode = result.nodes.find((n) => n.name === current && n.usable)
      if (currentNode && chosen.name === currentNode.name) {
        return { chosen: chosen.name, switched: false, nodes: result.nodes, switchNote: '当前节点已是最优' }
      }
      if (currentNode && chosen.score + cfg.minGainMs >= currentNode.score) {
        return { chosen: chosen.name, switched: false, nodes: result.nodes, switchNote: `优势不足 ${cfg.minGainMs}ms，不切换` }
      }
      try {
        await this.deps.adapter.switchNode(result.group, chosen.name)
      } catch (e) {
        // 切换失败自动回滚原节点；回滚也失败时只告警，错误信息附「节点异常」
        let rollbackNote = ''
        if (current) {
          try {
            await this.deps.adapter.switchNode(result.group, current)
            rollbackNote = '已回滚原节点'
          } catch {
            rollbackNote = '回滚失败，节点状态异常，请人工检查'
          }
        }
        this.deps.logger.error({ err: (e as Error).message, rollbackNote }, 'Clash 切换节点失败')
        throw new ToolError(500, TOOL_ERROR_CODES.CLASH_SWITCH_FAILED, `切换节点失败（${rollbackNote || '无回滚目标'}）`)
      }
      this.deps.logger.info({ group: result.group, from: current ?? '-', to: chosen.name, score: Math.round(chosen.score) }, 'Clash 已切换最优节点')
      return { chosen: chosen.name, switched: true, nodes: result.nodes }
    } finally {
      this.busy = false
    }
  }

  /** 面板状态汇总（探测 + 工作分组 + 当前节点 + delay 能力） */
  async status(): Promise<{
    detected: boolean
    kernel: ClashDetectResult['kernel']
    mixedPort: number | null
    apiBase: string
    delaySupported: boolean
    group: string
    currentNode: string | null
  }> {
    const detect = await this.detect()
    const cfg = this.deps.getCfg()
    const groupName = cfg.group
    let currentNode: string | null = null
    if (detect.detected) {
      try {
        const groups = await this.deps.adapter.groups()
        const g = groups.find((x) => x.name === groupName)
        currentNode = g?.now ?? null
      } catch {
        currentNode = null
      }
    }
    return {
      detected: detect.detected,
      kernel: detect.kernel,
      mixedPort: detect.mixedPort,
      apiBase: this.deps.adapter.apiBase,
      delaySupported: detect.detected && this.deps.adapter.delaySupported,
      group: groupName,
      currentNode,
    }
  }
}

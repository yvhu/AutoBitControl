/**
 * Clash 测速选优服务（tools 层）：测速 → 综合评分 → 选优 → 切换 → 回滚
 * 依赖方向：依赖 ./adapter ./client-detector ../errors ./types 与 infrastructure 类型
 * 设计思路：单例 + 进程内 busy 锁（自动检测与手动触发互斥）；切换失败自动回滚；
 * 全 IO 经注入（adapter/logger/getCfg），测试不连真 Clash
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ClashAdapter } from './adapter'
import { detectClash } from './client-detector'
import { ToolError, TOOL_ERROR_CODES } from '../errors'
import type { ClashConfig } from '../../infrastructure/config'
import type { Logger } from '../../infrastructure/logger'
import type {
  ClashCapability, ClashDetectResult, ClashGroup, ClashSubscription,
  ClashTestResult, NodeTestResult, OptimizeResult, UrlDelay,
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
  /** 面板写入的分组覆盖（config.json 写回前的运行时态，重启回落到配置值） */
  private groupOverride = ''

  constructor(private deps: ClashServiceDeps) {
    this.groupOverride = deps.getCfg().group
  }

  /** 是否有检测/切换进行中（路由与自动检测共用） */
  get isBusy(): boolean {
    return this.busy
  }

  /** 探测客户端（面板状态条） */
  async detect(): Promise<ClashDetectResult> {
    return detectClash(this.deps.adapter)
  }

  /** 面板设置目标分组（写回 config.json 由路由负责，这里只更新运行时态） */
  setGroup(group: string): void {
    this.groupOverride = group
  }

  /** 当前目标分组：面板覆盖优先，其次配置，其次 GLOBAL/第一个 Selector 组 */
  private async resolveGroup(): Promise<ClashGroup> {
    const configured = this.groupOverride || this.deps.getCfg().group
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

  /** 只读测速：对分组内节点逐一测速评分（不动节点选择） */
  async test(): Promise<ClashTestResult> {
    if (this.busy) throw new ToolError(409, TOOL_ERROR_CODES.TOOL_BUSY, '上一次检测/切换进行中，请稍候')
    this.busy = true
    try {
      return await this.testInner()
    } finally {
      this.busy = false
    }
  }

  private async testInner(): Promise<ClashTestResult> {
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
      const result = prev ?? (await this.testInner())
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

  /** 订阅列表（provider 模式；接口异常返回空数组容错） */
  async subscriptions(): Promise<ClashSubscription[]> {
    try {
      return await this.deps.adapter.providers()
    } catch {
      return []
    }
  }

  /** 更新订阅（重拉节点列表） */
  async updateSubscription(name: string): Promise<void> {
    try {
      await this.deps.adapter.updateProvider(name)
    } catch (e) {
      throw new ToolError(500, TOOL_ERROR_CODES.CLASH_API_FAILED, `更新订阅失败: ${(e as Error).message}`)
    }
  }

  /** 订阅配置文件列表（clash.configPath 目录下 *.yaml/*.yml；未配置或读目录失败返回空） */
  profileFiles(): string[] {
    const dir = this.deps.getCfg().configPath
    if (!dir) return []
    try {
      return readdirSync(dir).filter((n) => PROFILE_FILE_RE.test(n)).sort()
    } catch {
      return []
    }
  }

  /** 切换订阅文件（PUT /configs 以指定配置重载；文件名必须在配置目录内防穿越） */
  async switchProfile(file: string): Promise<void> {
    const dir = this.deps.getCfg().configPath
    if (!dir) {
      throw new ToolError(400, TOOL_ERROR_CODES.CLASH_PROFILE_NOT_CONFIGURED, '未配置 clash.configPath，订阅文件切换不可用')
    }
    if (!PROFILE_FILE_RE.test(file) || !this.profileFiles().includes(file)) {
      throw new ToolError(400, TOOL_ERROR_CODES.CLASH_PROFILE_NOT_CONFIGURED, `配置文件不在配置目录中: ${file}`)
    }
    try {
      await this.deps.adapter.reloadConfig(join(dir, file))
    } catch (e) {
      throw new ToolError(500, TOOL_ERROR_CODES.CLASH_API_FAILED, `切换订阅文件失败: ${(e as Error).message}`)
    }
  }

  /** 面板状态汇总（探测 + 分组 + 当前节点 + 能力集 + 订阅） */
  async status(): Promise<{
    detected: boolean
    kernel: ClashDetectResult['kernel']
    mixedPort: number | null
    apiBase: string
    capability: ClashCapability
    group: string
    currentNode: string | null
    groups: Array<{ name: string; now?: string }>
    subscriptions: ClashSubscription[]
  }> {
    const detect = await this.detect()
    const cfg = this.deps.getCfg()
    const groupName = this.groupOverride || cfg.group
    let groups: ClashGroup[] = []
    let currentNode: string | null = null
    if (detect.detected) {
      try {
        groups = await this.deps.adapter.groups()
        const g = groups.find((x) => x.name === groupName)
        currentNode = g?.now ?? null
      } catch {
        groups = []
      }
    }
    const subs = detect.detected ? await this.subscriptions() : []
    return {
      detected: detect.detected,
      kernel: detect.kernel,
      mixedPort: detect.mixedPort,
      apiBase: this.deps.adapter.apiBase,
      capability: {
        listProxies: detect.detected,
        delay: detect.detected && this.deps.adapter.delaySupported,
        switchNode: detect.detected,
        providers: subs.length > 0,
        switchProfile: cfg.configPath !== '',
      },
      group: groupName,
      currentNode,
      groups: groups.map((g) => ({ name: g.name, now: g.now })),
      subscriptions: subs,
    }
  }
}

/**
 * clash 域类型（tools 层）：探测/节点/测速/订阅/状态数据结构
 * 依赖方向：无依赖，被 clash 内各模块与 server 路由引用
 */

/** 客户端内核类型：/version 的 meta 字段为 true 记 mihomo 系，否则 generic */
export type ClashKernel = 'mihomo' | 'generic'

/** 能力集（按探测结果与配置裁剪，面板据此显隐按钮） */
export interface ClashCapability {
  /** 列分组/节点 */
  listProxies: boolean
  /** 节点延迟测试（内核不支持 delay 接口时为 false） */
  delay: boolean
  /** 切换节点 */
  switchNode: boolean
  /** 订阅以 proxy-provider 配置（更新订阅按钮可见性） */
  providers: boolean
  /** 订阅文件切换（configPath 配置后可用） */
  switchProfile: boolean
}

/** 探测结果 */
export interface ClashDetectResult {
  detected: boolean
  kernel: ClashKernel | null
  /** 实际混合代理口（/configs 实测；面板展示「窗口代理应填」地址） */
  mixedPort: number | null
}

/** 分组（GET /proxies 的 group 条目） */
export interface ClashGroup {
  name: string
  /** 当前选中节点 */
  now?: string
  /** 组内全部节点 */
  all?: string[]
}

/** 订阅（GET /providers/proxies 条目） */
export interface ClashSubscription {
  name: string
  vehicleType: string
  updatedAt?: string
  proxiesCount: number
}

/** 单 URL 测速结果 */
export interface UrlDelay {
  url: string
  delayMs: number
  reachable: boolean
}

/** 单节点测速明细（含综合得分，得分越低越好） */
export interface NodeTestResult {
  name: string
  urls: UrlDelay[]
  score: number
  usable: boolean
}

/** 测速结果（test 与 optimize 共用；nodes 已按得分升序） */
export interface ClashTestResult {
  group: string
  /** 分组当前选中节点（切换/节奏判定依据） */
  currentNode: string | null
  /** 当前节点是否可用（不在测速范围时 null，按未知保守处理） */
  currentUsable: boolean | null
  nodes: NodeTestResult[]
}

/** 选优切换结果 */
export interface OptimizeResult {
  chosen: string | null
  switched: boolean
  nodes: NodeTestResult[]
  /** 未切换原因说明（全网不可用/minGain 不满足/已是当前节点，供面板展示） */
  switchNote?: string
}

/** 自动检测节奏 */
export type ClashPace = 'normal' | 'fast'

/** 自动优化器状态（status 接口合并输出） */
export interface AutoOptimizerStatus {
  pace: ClashPace
  lastCheckAt: string | null
  allDown: boolean
  deferredSwitches: number
}

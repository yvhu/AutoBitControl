# Clash 代理网络工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板「工具中心」新增「代理网络」工具——探测本机 Clash 客户端，测速选优、切换节点/订阅，定时自动检测（自适应节奏）。

**Architecture:** 新增 `src/tools/clash/` 域（types/adapter/client-detector/optimizer/auto-optimizer），沿用 file-assign 先例（server → tools 单向依赖、ToolError 统一错误、进程内 busy 锁）。external-controller 是各 Clash 客户端的最大公约数，只面向协议不识别 GUI 名。

**Tech Stack:** TypeScript（无分号/单引号/2 空格/中文注释）、vitest（注入 fake request，不连真 Clash）、express 路由 @swagger、React 18 + antd 5 + react-query。

**规格文档：** `docs/superpowers/specs/2026-09-08-clash-network-tool-design.md`（写代码前通读）。

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块说明模块职责与依赖方向；命名 camelCase、文件 kebab-case
- 日志用 logger（中文消息，格式 `logger.info({count}, '消息')`）；所有新增注释/commit 用中文
- commit 风格 conventional：`feat:`/`fix:`/`chore:`/`docs:` + 中文描述
- 每任务完成跑 `npm run typecheck` 和 `npm test`（30s 超时），前端改动另跑 `npm run test:web`；全部通过才算任务完成
- 测试不连真实 Clash/数据库/文件系统（临时目录 fixture 除外），IO 全部经构造注入
- 分层依赖不可反向：tools/clash 只依赖 infrastructure（config/logger/http），server 路由依赖 tools/clash；tools/clash 不得 import server/engine
- 错误码双表一致：`src/tools/errors.ts` 与 `src/server/http/errors.ts` 数值必须同步（tests/tools-errors-consistency.test.ts 自动校验）
- 计划与规格的偏差（已决策）：① spec 所述「delay 接口 404 降级只测可达性」实现为**直接报错 CLASH_API_FAILED**（外部控制协议没有无 delay 的测速途径，造假数据比报错更糟）；② 新增错误码 40009 CLASH_PROFILE_NOT_CONFIGURED（规格错误表未覆盖订阅文件切换）；③ 新增 GET /api/tools/clash/profiles 与 POST /api/tools/clash/profiles/switch（规格能力矩阵提及但 API 清单遗漏）；④ status 接口增加 apiBase/anyRunning 字段（前端引导文案与在途确认提示所需）

---

### Task 1: 基础件——clash 配置段、错误码、queue.anyRunning()、配置写回

**Files:**
- Modify: `src/infrastructure/config.ts`
- Modify: `src/tools/errors.ts`
- Modify: `src/server/http/errors.ts`
- Modify: `src/engine/queue.ts`
- Create: `tests/clash-config.test.ts`
- Create: `tests/clash-queue-guard.test.ts`

**Interfaces:**
- Produces: `AppConfig.clash: ClashConfig`（含 `enabled/apiBase/apiSecret/group/testUrls/weights/maxNodes/testConcurrency/testTimeoutMs/minGainMs/autoCheck{enabled,normalIntervalMin,fastIntervalMin}/configPath`）；`updateConfigFile(patch: { group?: string }, opts?: LoadConfigOptions): void`；`TOOL_ERROR_CODES.CLASH_NOT_FOUND(40006)/CLASH_AUTH_FAILED(40007)/CLASH_GROUP_NOT_FOUND(40008)/CLASH_PROFILE_NOT_CONFIGURED(40009)/CLASH_API_FAILED(50002)/CLASH_ALL_DOWN(50003)/CLASH_SWITCH_FAILED(50004)`；`CoalescingEnqueuer.anyRunning(): boolean`

- [ ] **Step 1: config.ts 新增 ClashConfig 接口与缺省值**

`src/infrastructure/config.ts`，在 `SchedulerConfig` 接口（约第 85 行）后追加：

```ts
/** Clash 定时自动检测配置 */
export interface ClashAutoCheckConfig {
  /** 是否开启定时自动检测（节奏状态机开关） */
  enabled: boolean
  /** 正常态检测间隔（分钟；0 = 关闭定时） */
  normalIntervalMin: number
  /** 快速态检测间隔（分钟）：当前节点不可用/全网挂时缩短节奏 */
  fastIntervalMin: number
}

/** Clash 代理网络工具配置（tools/clash 域使用） */
export interface ClashConfig {
  /** 工具总开关 */
  enabled: boolean
  /** external-controller 管理 API 地址（默认 9090；区别于 7890 混合代理口） */
  apiBase: string
  /** external-controller secret（客户端开启鉴权时必填，走 Authorization Bearer） */
  apiSecret: string
  /** 目标分组名：留空时面板从 API 实时拉取分组选择（选择后由 updateConfigFile 写回此处） */
  group: string
  /** 测速目标 URL 列表（连通性+延迟判定依据） */
  testUrls: string[]
  /** 各测试 URL 的权重（与 testUrls 按下标对应，缺位按 1） */
  weights: number[]
  /** 单轮测速最多测的节点数 */
  maxNodes: number
  /** 节点间测速并发上限（机场风控考虑） */
  testConcurrency: number
  /** 单次测速超时（毫秒） */
  testTimeoutMs: number
  /** 最小收益（毫秒）：当选节点比当前节点快不到该值时不切换，避免频繁跳变 */
  minGainMs: number
  /** 定时自动检测配置 */
  autoCheck: ClashAutoCheckConfig
  /** mihomo 配置目录（含 *.yaml）：留空 = 订阅文件切换能力隐藏 */
  configPath: string
}
```

`AppConfig` 接口（约第 88-97 行）追加一行 `clash: ClashConfig`（在 `scheduler` 之后）。

`defaults` 对象（约第 102-163 行）追加：

```ts
  // Clash 代理网络工具：探测/测速/选优/定时检测
  clash: {
    enabled: true,
    // external-controller 管理口（默认 9090）≠ 混合代理口 7890；探测后以 /configs 实测混合口为准
    apiBase: 'http://127.0.0.1:9090',
    apiSecret: '',
    group: '',
    // 测速目标：gstatic 204 为标准低开销探测（各机场通用）；google 兜底
    testUrls: ['https://www.gstatic.com/generate_204', 'https://www.google.com'],
    weights: [2, 1],
    maxNodes: 20,
    // 低并发防机场风控
    testConcurrency: 2,
    testTimeoutMs: 5000,
    minGainMs: 100,
    autoCheck: { enabled: true, normalIntervalMin: 30, fastIntervalMin: 2 },
    configPath: '',
  },
```

- [ ] **Step 2: config.ts 新增 updateConfigFile（配置写回）**

顶部 import 改为：`import { readFileSync, existsSync, writeFileSync } from 'node:fs'`（第 7 行加 `writeFileSync`）。

`loadConfig` 函数之后追加：

```ts
/**
 * 写回配置覆盖项到 config/config.json（面板运行时修改入口，如 clash 分组选择）
 * 读取现有文件与 patch 深合并后写回（保留原有全部键；JSON 无注释概念，手工注释会丢失，属已知代价）
 * @param patch 覆盖项（当前仅 clash.group）
 * @param opts.rootDir 项目根目录，缺省为 src 上两级（与 loadConfig 同口径）
 * @throws 读写失败向上抛（由调用方路由映射为统一响应）
 */
export function updateConfigFile(patch: { group?: string }, opts: LoadConfigOptions = {}): void {
  const root = opts.rootDir ?? DEFAULT_ROOT
  const path = join(root, 'config', 'config.json')
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>) : {}
  const merged = deepMerge(current, { clash: { ...patch } })
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`)
}
```

- [ ] **Step 3: 写失败测试 tests/clash-config.test.ts**

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, updateConfigFile } from '../src/infrastructure/config'

let dir: string
let cfgPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'clash-cfg-'))
  mkdirSync(join(dir, 'config'))
  cfgPath = join(dir, 'config', 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ execution: { staggerMaxSec: 60 } }, null, 2))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('clash 配置段', () => {
  it('缺省值齐备（apiBase 9090 / autoCheck 30-2 / 权重 2-1）', () => {
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.clash.apiBase).toBe('http://127.0.0.1:9090')
    expect(cfg.clash.autoCheck).toEqual({ enabled: true, normalIntervalMin: 30, fastIntervalMin: 2 })
    expect(cfg.clash.weights).toEqual([2, 1])
    expect(cfg.clash.testConcurrency).toBe(2)
    expect(cfg.clash.minGainMs).toBe(100)
  })

  it('config.json 的 clash.group 覆盖缺省值', () => {
    writeFileSync(cfgPath, JSON.stringify({ clash: { group: 'GLOBAL' } }, null, 2))
    expect(loadConfig({ rootDir: dir }).clash.group).toBe('GLOBAL')
  })
})

describe('updateConfigFile', () => {
  it('写回 group 且保留其他键', () => {
    updateConfigFile({ group: '🚀 节点选择' }, { rootDir: dir })
    const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(saved.clash.group).toBe('🚀 节点选择')
  })

  it('多次写回不丢历史键', () => {
    writeFileSync(cfgPath, JSON.stringify({ execution: { staggerMaxSec: 60 }, clash: { group: 'A' } }, null, 2))
    updateConfigFile({ group: 'B' }, { rootDir: dir })
    const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(saved.clash.group).toBe('B')
    expect(saved.execution.staggerMaxSec).toBe(60)
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run tests/clash-config.test.ts`
Expected: FAIL（loadConfig 返回的 cfg.clash 为 undefined、updateConfigFile 不存在）

- [ ] **Step 5: 错误码——src/tools/errors.ts**

在 `TOOL_ERROR_CODES` 对象内 `TOOL_BUSY` 之前追加（注意保持 `as const`）：

```ts
  /** 400：未检测到运行中的 Clash 客户端 */
  CLASH_NOT_FOUND: 40006,
  /** 400：external-controller 鉴权失败（secret 错误） */
  CLASH_AUTH_FAILED: 40007,
  /** 400：目标分组不存在 */
  CLASH_GROUP_NOT_FOUND: 40008,
  /** 400：订阅文件切换能力未配置或文件不在配置目录 */
  CLASH_PROFILE_NOT_CONFIGURED: 40009,
```

在 `TOOL_IO_FAILED: 50001,` 之后追加：

```ts
  /** 500：Clash API 调用失败（非探测类） */
  CLASH_API_FAILED: 50002,
  /** 500：测速全网不可用 */
  CLASH_ALL_DOWN: 50003,
  /** 500：切换节点失败（已自动回滚） */
  CLASH_SWITCH_FAILED: 50004,
```

- [ ] **Step 6: 错误码——src/server/http/errors.ts**

`ERROR_CODES` 对象内 `TOOL_PLAN_INVALID: 40005,` 之后追加：

```ts
  CLASH_NOT_FOUND: 40006,
  CLASH_AUTH_FAILED: 40007,
  CLASH_GROUP_NOT_FOUND: 40008,
  CLASH_PROFILE_NOT_CONFIGURED: 40009,
```

`TOOL_IO_FAILED: 50001,` 之后追加：

```ts
  CLASH_API_FAILED: 50002,
  CLASH_ALL_DOWN: 50003,
  CLASH_SWITCH_FAILED: 50004,
```

（`tests/tools-errors-consistency.test.ts` 会遍历 TOOL_ERROR_CODES 自动校验双表一致。）

- [ ] **Step 7: queue.anyRunning()——src/engine/queue.ts**

`pendingCount()` 方法（约第 216 行）之后追加：

```ts
  /** 是否有任何窗口会话正在运行（代理切换的在途守卫：任务运行中换 IP 会破坏签到会话） */
  anyRunning(): boolean {
    return this.running.size > 0
  }
```

- [ ] **Step 8: 写失败测试 tests/clash-queue-guard.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest'
import { CoalescingEnqueuer } from '../src/engine/queue'
import type { ProfileRow } from '../src/infrastructure/db'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function makeProfile(id: number): ProfileRow {
  return { id, bitbrowserId: `b${id}`, name: `${id}`, enabled: 1, circuitBreakerCount: 0 }
}

/** 可控 runner：runWindowTasks 挂起直到手动 resolve，模拟窗口会话运行中 */
function makeRunner() {
  let release!: () => void
  const started = vi.fn()
  const gate = new Promise<void>((r) => (release = r))
  const runner = {
    runWindowTasks: vi.fn(() => {
      started()
      return gate
    }),
  }
  return { runner, started, release: () => release() }
}

describe('CoalescingEnqueuer.anyRunning', () => {
  it('无会话时 false', () => {
    const { runner } = makeRunner()
    const q = new CoalescingEnqueuer(runner, logger as never, () => 1, 0)
    expect(q.anyRunning()).toBe(false)
  })

  it('会话运行中 true，结束后 false', async () => {
    const { runner, started, release } = makeRunner()
    const q = new CoalescingEnqueuer(runner, logger as never, () => 1, 0)
    q.enqueue(makeProfile(1), 'demo', { immediate: true })
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    expect(q.anyRunning()).toBe(true)
    release()
    await vi.waitFor(() => expect(q.anyRunning()).toBe(false))
  })
})
```

- [ ] **Step 9: 跑测试确认失败**

Run: `npx vitest run tests/clash-queue-guard.test.ts`
Expected: FAIL（`q.anyRunning` 不是函数）

- [ ] **Step 10: 全量验证 + 提交**

Run: `npm run typecheck` 预期通过；`npx vitest run tests/clash-config.test.ts tests/clash-queue-guard.test.ts tests/tools-errors-consistency.test.ts` 预期通过；再跑 `npm test` 预期全绿（新增代码不影响存量）。

```bash
git add src/infrastructure/config.ts src/tools/errors.ts src/server/http/errors.ts src/engine/queue.ts tests/clash-config.test.ts tests/clash-queue-guard.test.ts
git commit -m "feat: clash 工具基础件（配置段/错误码/在途守卫）"
```

---

### Task 2: clash 域类型与适配器（types + adapter + client-detector）

**Files:**
- Create: `src/tools/clash/types.ts`
- Create: `src/tools/clash/adapter.ts`
- Create: `src/tools/clash/client-detector.ts`
- Create: `tests/clash-adapter.test.ts`
- Create: `tests/clash-detector.test.ts`

**Interfaces:**
- Consumes: `httpJson/HttpError`（src/infrastructure/http）、`TOOL_ERROR_CODES`（Task 1）
- Produces（后续任务依赖的精确签名）：
  - `ClashAdapter(apiBase: string, apiSecret: string, timeoutMs: number, request?: ClashRequest)`；方法 `version(): Promise<Record<string, unknown>>`、`mixedPort(): Promise<number | null>`、`groups(): Promise<ClashGroup[]>`、`delay(name: string, url: string): Promise<DelayOutcome>`、`switchNode(group: string, name: string): Promise<void>`、`providers(): Promise<ClashSubscription[]>`、`updateProvider(name: string): Promise<void>`、`reloadConfig(path: string): Promise<void>`、getter `delaySupported: boolean`、属性 `apiBase`
  - `detectClash(adapter: ClashAdapter): Promise<ClashDetectResult>`
  - 类型：`ClashKernel='mihomo'|'generic'`、`ClashGroup{name,now?,all?}`、`ClashSubscription{name,vehicleType,updatedAt?,proxiesCount}`、`UrlDelay{url,delayMs,reachable}`、`NodeTestResult{name,urls,score,usable}`、`ClashTestResult{group,currentNode,currentUsable,nodes}`、`OptimizeResult{chosen,switched,nodes,switchNote?}`、`ClashDetectResult{detected,kernel,mixedPort}`、`ClashCapability{listProxies,delay,switchNode,providers,switchProfile}`、`ClashPace='normal'|'fast'`、`AutoOptimizerStatus{pace,lastCheckAt,allDown,deferredSwitches}`

- [ ] **Step 1: 写失败测试 tests/clash-adapter.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest'
import { ClashAdapter } from '../src/tools/clash/adapter'
import { HttpError } from '../src/infrastructure/http'

/** fake request：按注册表返回预设响应，记录调用 */
function fakeRequest(responses: Array<{ method: string; path: string; respond: () => unknown }>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const request = (opts: { method: 'GET' | 'PUT'; path: string; body?: unknown }) => {
    calls.push(opts)
    const hit = responses.find((r) => r.method === opts.method && opts.path === r.path)
    if (!hit) return Promise.reject(new HttpError(500, '未注册的路径'))
    return Promise.resolve(hit.respond())
  }
  return { request, calls }
}

describe('ClashAdapter', () => {
  it('groups 解析 Selector 分组的 now/all', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/proxies', respond: () => ({ proxies: { GLOBAL: { type: 'Selector', now: 'HK-01', all: ['HK-01', 'HK-02'] }, DIRECT: { type: 'Direct' } } }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    const groups = await a.groups()
    expect(groups).toEqual([{ name: 'GLOBAL', now: 'HK-01', all: ['HK-01', 'HK-02'] }])
  })

  it('delay 可达返回延迟；异常节点返回不可达', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/proxies/HK-01/delay?url=https%3A%2F%2Fa.com&timeout=5000', respond: () => ({ delay: 233 }) },
      { method: 'GET', path: '/proxies/DEAD/delay?url=https%3A%2F%2Fa.com&timeout=5000', respond: () => ({ delay: 0, message: 'error' }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.delay('HK-01', 'https://a.com')).toEqual({ supported: true, reachable: true, delayMs: 233 })
    expect(await a.delay('DEAD', 'https://a.com')).toEqual({ supported: true, reachable: false, delayMs: 0 })
  })

  it('delay 404 后降级：supported=false 且不再调用', async () => {
    const { request, calls } = fakeRequest([
      { method: 'GET', path: '/proxies/A/delay?url=https%3A%2F%2Fa.com&timeout=5000', respond: () => { throw new HttpError(404, 'not found') } },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.delay('A', 'https://a.com')).toEqual({ supported: false, reachable: false, delayMs: 0 })
    expect(a.delaySupported).toBe(false)
    expect(await a.delay('A', 'https://a.com')).toEqual({ supported: false, reachable: false, delayMs: 0 })
    expect(calls).toHaveLength(1)
  })

  it('switchNode 发 PUT /proxies/{group} {name}', async () => {
    const { request, calls } = fakeRequest([
      { method: 'PUT', path: '/proxies/GLOBAL', respond: () => ({}) },
    ])
    const a = new ClashAdapter('http://x', 'secret', 5000, request)
    await a.switchNode('GLOBAL', 'HK-02')
    expect(calls[0]).toEqual({ method: 'PUT', path: '/proxies/GLOBAL', body: { name: 'HK-02' } })
  })

  it('providers 解析订阅列表', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/providers/proxies', respond: () => ({ providers: { sub1: { vehicleType: 'HTTP', updatedAt: '2026-09-01', proxies: [{}, {}] } } }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.providers()).toEqual([{ name: 'sub1', vehicleType: 'HTTP', updatedAt: '2026-09-01', proxiesCount: 2 }])
  })

  it('mixedPort 兼容 mixed-port/mixedPort/port 三种字段', async () => {
    const { request } = fakeRequest([
      { method: 'GET', path: '/configs', respond: () => ({ 'mixed-port': 7890 }) },
    ])
    const a = new ClashAdapter('http://x', '', 5000, request)
    expect(await a.mixedPort()).toBe(7890)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/clash-adapter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/tools/clash/types.ts**

```ts
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
```

- [ ] **Step 4: 实现 src/tools/clash/adapter.ts**

```ts
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
```

- [ ] **Step 5: 实现 src/tools/clash/client-detector.ts**

```ts
/**
 * Clash 客户端探测（tools 层）：GET /version 探活 + 内核识别 + /configs 读混合口
 * 依赖方向：依赖 ./adapter 与 ../errors；被 optimizer（ClashService）调用
 * 设计思路：探测失败不抛业务错（返回 detected=false 由面板引导）；仅 401 视为鉴权错误抛出
 */
import { HttpError } from '../../infrastructure/http'
import type { ClashAdapter } from './adapter'
import { ToolError, TOOL_ERROR_CODES } from '../errors'
import type { ClashDetectResult, ClashKernel } from './types'

/**
 * 探测本机 Clash 客户端
 * @param adapter external-controller 适配器
 * @returns detected=false 表示未检测到（连接失败/未开启外部控制）；401 时抛 CLASH_AUTH_FAILED
 */
export async function detectClash(adapter: ClashAdapter): Promise<ClashDetectResult> {
  let version: Record<string, unknown>
  try {
    version = await adapter.version()
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      throw new ToolError(400, TOOL_ERROR_CODES.CLASH_AUTH_FAILED, 'Clash 外部控制鉴权失败（请检查 clash.apiSecret 配置）')
    }
    return { detected: false, kernel: null, mixedPort: null }
  }
  const kernel: ClashKernel = version.meta === true ? 'mihomo' : 'generic'
  let mixedPort: number | null = null
  try {
    mixedPort = await adapter.mixedPort()
  } catch {
    mixedPort = null
  }
  return { detected: true, kernel, mixedPort }
}
```

- [ ] **Step 6: 写失败测试 tests/clash-detector.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { detectClash } from '../src/tools/clash/client-detector'
import { HttpError } from '../src/infrastructure/http'
import type { ClashRequest } from '../src/tools/clash/adapter'

/** 构造带固定响应的 ClashAdapter 替身（只实现 detector 用到的三个方法） */
function stubAdapter(responses: { version?: unknown; configs?: unknown; versionError?: Error }) {
  const request: ClashRequest = (opts) => {
    if (opts.path === '/version') {
      if (responses.versionError) return Promise.reject(responses.versionError)
      return Promise.resolve(responses.version)
    }
    return Promise.resolve(responses.configs)
  }
  return { apiBase: 'http://x', request }
}

describe('detectClash', () => {
  it('meta:true → mihomo 内核 + 混合口', async () => {
    const a = stubAdapter({ version: { meta: true, version: 'v1.19.0' }, configs: { 'mixed-port': 7890 } })
    const r = await detectClash(a as never)
    expect(r).toEqual({ detected: true, kernel: 'mihomo', mixedPort: 7890 })
  })

  it('无 meta → generic 内核', async () => {
    const a = stubAdapter({ version: { version: '1.2.3' }, configs: {} })
    const r = await detectClash(a as never)
    expect(r).toEqual({ detected: true, kernel: 'generic', mixedPort: null })
  })

  it('连接失败 → detected=false', async () => {
    const a = stubAdapter({ versionError: new HttpError(0, '连接失败') })
    const r = await detectClash(a as never)
    expect(r).toEqual({ detected: false, kernel: null, mixedPort: null })
  })

  it('401 → 抛 CLASH_AUTH_FAILED', async () => {
    const a = stubAdapter({ versionError: new HttpError(401, 'unauthorized') })
    await expect(detectClash(a as never)).rejects.toMatchObject({ status: 400, code: 40007 })
  })
})
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/clash-adapter.test.ts tests/clash-detector.test.ts`
Expected: PASS

- [ ] **Step 8: 全量验证 + 提交**

Run: `npm run typecheck`；`npm test`

```bash
git add src/tools/clash/types.ts src/tools/clash/adapter.ts src/tools/clash/client-detector.ts tests/clash-adapter.test.ts tests/clash-detector.test.ts
git commit -m "feat: clash 域类型/适配器/客户端探测"
```

---

### Task 3: 测速选优服务 ClashService（optimizer.ts）

**Files:**
- Create: `src/tools/clash/optimizer.ts`
- Create: `tests/clash-optimizer.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ClashAdapter`/`detectClash`/types、`ToolError/TOOL_ERROR_CODES`（Task 1）、`ClashConfig` 类型、`Logger` 类型、node:fs/path
- Produces（Task 4/5 依赖）：
  - `scoreNode(urls: UrlDelay[], weights: number[], timeoutMs: number): { score: number; usable: boolean }`（导出纯函数）
  - `ClashService` 构造 `(deps: ClashServiceDeps)`，`ClashServiceDeps = { adapter: ClashAdapter; getCfg: () => ClashConfig; logger: Logger }`
  - 方法：`get isBusy(): boolean`、`detect(): Promise<ClashDetectResult>`、`test(): Promise<ClashTestResult>`、`optimize(prev?: ClashTestResult): Promise<OptimizeResult>`、`status(): Promise<{detected,kernel,mixedPort,apiBase,capability,group,currentNode,groups,subscriptions}>`、`subscriptions(): Promise<ClashSubscription[]>`、`updateSubscription(name): Promise<void>`、`setGroup(group): void`、`profileFiles(): string[]`、`switchProfile(file): Promise<void>`

- [ ] **Step 1: 写失败测试 tests/clash-optimizer.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClashService, scoreNode } from '../src/tools/clash/optimizer'
import type { ClashConfig } from '../src/infrastructure/config'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function makeCfg(over: Partial<ClashConfig> = {}): ClashConfig {
  return {
    enabled: true,
    apiBase: 'http://127.0.0.1:9090',
    apiSecret: '',
    group: 'GLOBAL',
    testUrls: ['https://a.com', 'https://b.com'],
    weights: [2, 1],
    maxNodes: 20,
    testConcurrency: 2,
    testTimeoutMs: 5000,
    minGainMs: 100,
    autoCheck: { enabled: true, normalIntervalMin: 30, fastIntervalMin: 2 },
    configPath: '',
    ...over,
  }
}

/** fake adapter：delay 按节点名映射返回值，switchNode/groups 记录调用 */
function makeAdapter(delayMap: Record<string, Array<{ reachable: boolean; delayMs: number }>>, opts: { groups?: unknown; switchError?: Error } = {}) {
  const switchCalls: Array<[string, string]> = []
  const adapter = {
    apiBase: 'http://127.0.0.1:9090',
    get delaySupported() { return true },
    delay: vi.fn(async (name: string, url: string) => {
      const list = delayMap[name]
      if (!list) return { supported: true, reachable: false, delayMs: 0 }
      const item = list[url === 'https://a.com' ? 0 : 1] ?? { reachable: false, delayMs: 0 }
      return { supported: true, ...item }
    }),
    switchNode: vi.fn(async (group: string, name: string) => {
      switchCalls.push([group, name])
      if (opts.switchError) throw opts.switchError
    }),
    groups: vi.fn(async () => opts.groups ?? [{ name: 'GLOBAL', now: 'HK-01', all: ['HK-01', 'HK-02'] }]),
    providers: vi.fn(async () => []),
    updateProvider: vi.fn(async () => undefined),
  }
  return { adapter, switchCalls }
}

function makeService(adapter: never, cfg: ClashConfig) {
  return new ClashService({ adapter, getCfg: () => cfg, logger: logger as never })
}

describe('scoreNode', () => {
  it('全部不可达 → 不可用，得分按惩罚计', () => {
    const urls = [
      { url: 'a', delayMs: 0, reachable: false },
      { url: 'b', delayMs: 0, reachable: false },
    ]
    expect(scoreNode(urls, [2, 1], 5000)).toEqual({ score: 15000, usable: false })
  })

  it('部分可达（白名单机场）→ 可用，得分加权', () => {
    const urls = [
      { url: 'a', delayMs: 100, reachable: true },
      { url: 'b', delayMs: 0, reachable: false },
    ]
    expect(scoreNode(urls, [2, 1], 5000)).toEqual({ score: 5200, usable: true })
  })
})

describe('ClashService.test', () => {
  it('按并发测速并按得分升序返回', async () => {
    const { adapter } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 200 }],
      'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }],
    })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.test()
    expect(r.group).toBe('GLOBAL')
    expect(r.currentNode).toBe('HK-01')
    expect(r.currentUsable).toBe(true)
    expect(r.nodes.map((n) => n.name)).toEqual(['HK-02', 'HK-01'])
    expect(r.nodes[0].score).toBeLessThan(r.nodes[1].score)
  })

  it('分组不存在 → CLASH_GROUP_NOT_FOUND', async () => {
    const { adapter } = makeAdapter({})
    const svc = makeService(adapter as never, makeCfg({ group: 'NOPE' }))
    await expect(svc.test()).rejects.toMatchObject({ status: 400, code: 40008 })
  })

  it('busy 锁：进行中再次调用 409', async () => {
    const { adapter } = makeAdapter({ 'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 200 }] })
    const svc = makeService(adapter as never, makeCfg())
    const first = svc.test()
    await expect(svc.test()).rejects.toMatchObject({ status: 409, code: 40904 })
    await first
  })
})

describe('ClashService.optimize', () => {
  it('全网不可用 → 不切换，chosen=null', async () => {
    const { adapter, switchCalls } = makeAdapter({ 'HK-01': [{ reachable: false, delayMs: 0 }, { reachable: false, delayMs: 0 }] })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.optimize()
    expect(r.switched).toBe(false)
    expect(r.chosen).toBeNull()
    expect(r.switchNote).toBe('全网不可用')
    expect(switchCalls).toHaveLength(0)
  })

  it('选出更优节点 → 切换成功', async () => {
    const { adapter, switchCalls } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 800 }, { reachable: true, delayMs: 800 }],
      'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }],
    })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.optimize()
    expect(r.chosen).toBe('HK-02')
    expect(r.switched).toBe(true)
    expect(switchCalls).toEqual([['GLOBAL', 'HK-02']])
  })

  it('当选者优势不足 minGainMs → 不切换', async () => {
    const { adapter, switchCalls } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 100 }],
      'HK-02': [{ reachable: true, delayMs: 60 }, { reachable: true, delayMs: 60 }],
    })
    const svc = makeService(adapter as never, makeCfg({ minGainMs: 100 }))
    const r = await svc.optimize()
    expect(r.switched).toBe(false)
    expect(r.switchNote).toContain('优势不足')
    expect(switchCalls).toHaveLength(0)
  })

  it('切换失败自动回滚原节点', async () => {
    const { adapter, switchCalls } = makeAdapter(
      { 'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }], 'HK-01': [{ reachable: true, delayMs: 800 }, { reachable: true, delayMs: 800 }] },
      { switchError: new Error('API 挂了') },
    )
    const svc = makeService(adapter as never, makeCfg())
    await expect(svc.optimize()).rejects.toMatchObject({ status: 500, code: 50004 })
    expect(switchCalls).toEqual([['GLOBAL', 'HK-02'], ['GLOBAL', 'HK-01']])
  })

  it('传入 prev 跳过重测（自动检测路径）', async () => {
    const { adapter, switchCalls } = makeAdapter({})
    const svc = makeService(adapter as never, makeCfg())
    const prev = {
      group: 'GLOBAL',
      currentNode: 'HK-01',
      currentUsable: false,
      nodes: [{ name: 'HK-02', urls: [{ url: 'https://a.com', delayMs: 50, reachable: true }], score: 100, usable: true }],
    }
    const r = await svc.optimize(prev)
    expect(r.switched).toBe(true)
    expect(switchCalls).toEqual([['GLOBAL', 'HK-02']])
    expect(adapter.delay).not.toHaveBeenCalled()
  })
})

describe('ClashService.subscriptions/updateSubscription', () => {
  it('providers 接口异常 → 空数组容错', async () => {
    const { adapter } = makeAdapter({})
    adapter.providers = vi.fn(async () => { throw new Error('boom') })
    const svc = makeService(adapter as never, makeCfg())
    expect(await svc.subscriptions()).toEqual([])
  })

  it('更新订阅失败 → CLASH_API_FAILED', async () => {
    const { adapter } = makeAdapter({})
    adapter.updateProvider = vi.fn(async () => { throw new Error('boom') })
    const svc = makeService(adapter as never, makeCfg())
    await expect(svc.updateSubscription('sub1')).rejects.toMatchObject({ status: 500, code: 50002 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/clash-optimizer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/tools/clash/optimizer.ts**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/clash-optimizer.test.ts`
Expected: PASS

注意：test 用例中 fake adapter 的 `delay` 在 optimize(prev) 用例断言 `not.toHaveBeenCalled`——`makeAdapter` 的 delay 是 vi.fn，成立。若有个别断言与实现细节不符（如 busy 锁时序），按实现语义微调断言并保持用例意图（锁生效/回滚顺序/跳过重测）不变。

- [ ] **Step 5: 全量验证 + 提交**

Run: `npm run typecheck`；`npm test`

```bash
git add src/tools/clash/optimizer.ts tests/clash-optimizer.test.ts
git commit -m "feat: clash 测速选优服务（评分/切换/回滚/busy 锁）"
```

---

### Task 4: 定时自动优化 AutoOptimizer（auto-optimizer.ts）

**Files:**
- Create: `src/tools/clash/auto-optimizer.ts`
- Create: `tests/clash-auto-optimizer.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ClashService`（`isBusy/test/optimize`）、`Logger`、types
- Produces（Task 5 依赖）：`AutoOptimizer` 构造 `(deps: AutoOptimizerDeps)`，`AutoOptimizerDeps = { service: ClashService; anyRunning: () => boolean; logger: Logger; intervals: { normalMin: number; fastMin: number } }`；方法 `start(): void`、`stop(): void`、`status(): AutoOptimizerStatus`

- [ ] **Step 1: 写失败测试 tests/clash-auto-optimizer.test.ts**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AutoOptimizer } from '../src/tools/clash/auto-optimizer'
import type { ClashService } from '../src/tools/clash/optimizer'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

/** fake service：按场景预设 test/optimize 行为 */
function makeService(testImpl: () => Promise<unknown>, optimizeImpl: () => Promise<unknown>) {
  return {
    isBusy: false,
    test: vi.fn(testImpl),
    optimize: vi.fn(optimizeImpl),
  } as unknown as ClashService
}

const allOk = () => Promise.resolve({ group: 'GLOBAL', currentNode: 'A', currentUsable: true, nodes: [{ name: 'A', urls: [], score: 100, usable: true }] })
const currentDown = () => Promise.resolve({ group: 'GLOBAL', currentNode: 'A', currentUsable: false, nodes: [{ name: 'B', urls: [], score: 50, usable: true }] })
const switched = () => Promise.resolve({ chosen: 'B', switched: true, nodes: [] })

describe('AutoOptimizer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalMin=0 → start 不启动', () => {
    const svc = makeService(allOk, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 0, fastMin: 2 } })
    a.start()
    expect(svc.test).not.toHaveBeenCalled()
  })

  it('全部可用 → 只测速不切换，正常节奏', async () => {
    const svc = makeService(allOk, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.test).toHaveBeenCalledTimes(1)
    expect(svc.optimize).not.toHaveBeenCalled()
    expect(a.status().pace).toBe('normal')
    a.stop()
  })

  it('当前节点不可用 → 自动切换 → 恢复正常节奏', async () => {
    const svc = makeService(currentDown, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.optimize).toHaveBeenCalledTimes(1)
    expect(a.status().pace).toBe('normal')
    a.stop()
  })

  it('全网挂且切换未成功 → 快速节奏', async () => {
    const svc = makeService(currentDown, () => Promise.resolve({ chosen: null, switched: false, nodes: [], switchNote: '全网不可用' }))
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.status().pace).toBe('fast')
    a.stop()
  })

  it('任务在途 → 不切换并计数，连续 3 次告警', async () => {
    const svc = makeService(currentDown, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => true, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.optimize).not.toHaveBeenCalled()
    expect(a.status().deferredSwitches).toBe(1)
    expect(a.status().pace).toBe('fast')
    // 快速节奏 2 分钟一轮，连跑 3 轮
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(a.status().deferredSwitches).toBe(3)
    expect(logger.warn).toHaveBeenCalled()
    a.stop()
  })

  it('恢复后 deferredSwitches 清零', async () => {
    const svc = makeService(currentDown, switched)
    let running = true
    const a = new AutoOptimizer({ service: svc, anyRunning: () => running, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.status().deferredSwitches).toBe(1)
    running = false
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(svc.optimize).toHaveBeenCalledTimes(1)
    expect(a.status().deferredSwitches).toBe(0)
    a.stop()
  })

  it('test 抛错不中断循环（下一轮继续）', async () => {
    const svc = makeService(() => Promise.reject(new Error('boom')), switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(logger.warn).toHaveBeenCalled()
    // 正常节奏下一轮 30 分钟后仍在跑
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(svc.test).toHaveBeenCalledTimes(2)
    a.stop()
  })

  it('stop 后不再调度', async () => {
    const svc = makeService(allOk, switched)
    const a = new AutoOptimizer({ service: svc, anyRunning: () => false, logger: logger as never, intervals: { normalMin: 30, fastMin: 2 } })
    a.start()
    await vi.advanceTimersByTimeAsync(0)
    a.stop()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(svc.test).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/clash-auto-optimizer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/tools/clash/auto-optimizer.ts**

```ts
/**
 * 定时自动优化（tools 层）：节奏状态机 + 在途守卫
 * 依赖方向：依赖 ./optimizer（ClashService）与 logger；由 app.ts 创建并 start/stop
 * 设计思路：正常态/快速态自适应节奏（setTimeout 链，测试用 fake timers）；
 * 任务在途时只测速不切换（换 IP 会破坏签到会话），连续延后 DEFERRED_ALERT_AT 次告警
 */
import type { ClashService } from './optimizer'
import type { Logger } from '../../infrastructure/logger'
import type { AutoOptimizerStatus, ClashPace } from './types'

export interface AutoOptimizerDeps {
  service: ClashService
  /** 任务在途判定（engine queue 注入）：true = 有窗口会话运行中 */
  anyRunning: () => boolean
  logger: Logger
  /** 节奏间隔（分钟）；normalMin=0 时定时关闭 */
  intervals: { normalMin: number; fastMin: number }
}

/** 延后切换告警阈值：连续 N 个检测周期因在途而无法切换时记告警 */
const DEFERRED_ALERT_AT = 3

export class AutoOptimizer {
  private pace: ClashPace = 'normal'
  private lastCheckAt: string | null = null
  private allDown = false
  private deferredSwitches = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(private deps: AutoOptimizerDeps) {}

  /** 启动节奏循环（幂等；normalMin<=0 时不启动） */
  start(): void {
    if (!this.stopped) return
    if (this.deps.intervals.normalMin <= 0) return
    this.stopped = false
    this.scheduleNext(0)
  }

  /** 停止节奏循环（优雅退出用） */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  status(): AutoOptimizerStatus {
    return { pace: this.pace, lastCheckAt: this.lastCheckAt, allDown: this.allDown, deferredSwitches: this.deferredSwitches }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.stopped) return
        const min = this.pace === 'fast' ? this.deps.intervals.fastMin : this.deps.intervals.normalMin
        this.scheduleNext(min * 60 * 1000)
      })
    }, delayMs)
  }

  private async tick(): Promise<void> {
    try {
      if (this.deps.service.isBusy) {
        this.deps.logger.debug('Clash 自动检测跳过（上一次检测/切换进行中）')
        return
      }
      const result = await this.deps.service.test()
      this.lastCheckAt = new Date().toISOString()
      this.allDown = result.nodes.every((n) => !n.usable)
      // 需切换判定：全网挂或当前选中节点不可用（当前节点不在测速范围按未知，不触发）
      const shouldSwitch = this.allDown || result.currentUsable === false
      const inFlight = this.deps.anyRunning()
      let switched = false
      if (shouldSwitch && !inFlight) {
        try {
          const out = await this.deps.service.optimize(result)
          switched = out.switched
          this.deferredSwitches = 0
          if (switched) this.deps.logger.info({ chosen: out.chosen }, 'Clash 自动切换节点成功')
          else this.deps.logger.warn({ note: out.switchNote }, 'Clash 自动选优未切换')
        } catch (e) {
          this.deps.logger.warn({ err: (e as Error).message }, 'Clash 自动选优失败')
        }
      } else if (shouldSwitch) {
        // 在途守卫：只测速不切换，切换延后到空闲窗口
        this.deferredSwitches++
        if (this.deferredSwitches >= DEFERRED_ALERT_AT) {
          this.deps.logger.warn({ count: this.deferredSwitches }, 'Clash 需切换但任务在途，已连续延后 3 次')
        }
      } else {
        this.deferredSwitches = 0
      }
      this.pace = shouldSwitch && !switched ? 'fast' : 'normal'
    } catch (e) {
      // 单轮异常不中断循环（下轮继续）
      this.deps.logger.warn({ err: (e as Error).message }, 'Clash 自动检测轮次异常')
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/clash-auto-optimizer.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验证 + 提交**

Run: `npm run typecheck`；`npm test`

```bash
git add src/tools/clash/auto-optimizer.ts tests/clash-auto-optimizer.test.ts
git commit -m "feat: clash 定时自动优化（自适应节奏+在途守卫）"
```

---

### Task 5: 路由、装配与工具登记（routes/app.ts/config.json）

**Files:**
- Modify: `src/server/routes/tools.ts`
- Modify: `src/server/app.ts`（ServerDeps + toolsRouter 挂载）
- Modify: `src/app.ts`（装配 clash 服务与定时器）
- Modify: `src/tools/index.ts`（TOOLS 注册表加 clash）
- Modify: `config/config.json`（加 clash 段）
- Create: `tests/clash-route.test.ts`

**Interfaces:**
- Consumes: Task 3/4 的 ClashService/AutoOptimizer、Task 1 的 updateConfigFile/anyRunning
- Produces: `GET /api/tools/clash/status`、`POST /api/tools/clash/test`、`POST /api/tools/clash/optimize`、`GET /api/tools/clash/subscriptions`、`POST /api/tools/clash/subscriptions/:name/update`、`GET /api/tools/clash/profiles`、`POST /api/tools/clash/profiles/switch`、`POST /api/tools/clash/group`

- [ ] **Step 1: 写失败测试 tests/clash-route.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { toolsRouter } from '../src/server/routes/tools'
import { errorHandler } from '../src/server/http/error'
import { ToolError } from '../src/tools/errors'
import type { Logger } from '../src/infrastructure/logger'

const statusData = {
  detected: true,
  kernel: 'mihomo',
  mixedPort: 7890,
  apiBase: 'http://127.0.0.1:9090',
  capability: { listProxies: true, delay: true, switchNode: true, providers: false, switchProfile: false },
  group: 'GLOBAL',
  currentNode: 'HK-01',
  groups: [{ name: 'GLOBAL', now: 'HK-01' }],
  subscriptions: [],
}

const testData = { group: 'GLOBAL', currentNode: 'HK-01', currentUsable: true, nodes: [] }
const optimizeData = { chosen: 'HK-02', switched: true, nodes: [] }

function makeApp() {
  const app = express()
  app.use(express.json())
  const clash = {
    service: {
      status: vi.fn().mockResolvedValue(statusData),
      test: vi.fn().mockResolvedValue(testData),
      optimize: vi.fn().mockResolvedValue(optimizeData),
      subscriptions: vi.fn().mockResolvedValue([]),
      updateSubscription: vi.fn().mockResolvedValue(undefined),
      setGroup: vi.fn(),
      profileFiles: vi.fn().mockReturnValue(['a.yaml', 'b.yaml']),
      switchProfile: vi.fn().mockResolvedValue(undefined),
    },
    auto: { status: () => ({ pace: 'normal', lastCheckAt: null, allDown: false, deferredSwitches: 0 }) },
    saveGroup: vi.fn().mockResolvedValue(undefined),
    anyRunning: () => false,
  }
  const datasource = { reload: vi.fn().mockResolvedValue(undefined), summary: vi.fn().mockReturnValue({ rows: 0, columns: [] }) }
  app.use('/api', toolsRouter({ xlsxPath: 'x', datasource, clash }))
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {} } as unknown as Logger))
  return { app, clash }
}

describe('GET /api/tools', () => {
  it('工具清单含代理网络', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools')
    expect(res.body.data.tools).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'clash' })]))
  })
})

describe('GET /api/tools/clash/status', () => {
  it('返回探测状态 + 自动优化器状态', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools/clash/status')
    expect(res.body.code).toBe(0)
    expect(res.body.data.detected).toBe(true)
    expect(res.body.data.auto.pace).toBe('normal')
    expect(res.body.data.anyRunning).toBe(false)
  })
})

describe('POST /api/tools/clash/test', () => {
  it('返回测速结果', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/tools/clash/test').send({})
    expect(res.body.code).toBe(0)
    expect(res.body.data.group).toBe('GLOBAL')
  })

  it('ToolError 映射为统一失败响应', async () => {
    const { app, clash } = makeApp()
    clash.service.test.mockRejectedValueOnce(new ToolError(500, 50002, '内核不支持 delay 测速接口'))
    const res = await request(app).post('/api/tools/clash/test').send({})
    expect(res.status).toBe(500)
    expect(res.body.code).toBe(50002)
  })
})

describe('POST /api/tools/clash/optimize', () => {
  it('返回切换结果', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/tools/clash/optimize').send({})
    expect(res.body.data.switched).toBe(true)
    expect(res.body.data.chosen).toBe('HK-02')
  })
})

describe('GET /api/tools/clash/subscriptions', () => {
  it('返回订阅列表', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools/clash/subscriptions')
    expect(res.body.data.subscriptions).toEqual([])
  })
})

describe('POST /api/tools/clash/subscriptions/:name/update', () => {
  it('触发订阅更新', async () => {
    const { app, clash } = makeApp()
    const res = await request(app).post('/api/tools/clash/subscriptions/sub1/update').send({})
    expect(res.body.code).toBe(0)
    expect(clash.service.updateSubscription).toHaveBeenCalledWith('sub1')
  })
})

describe('POST /api/tools/clash/group', () => {
  it('写回配置并更新运行时分组', async () => {
    const { app, clash } = makeApp()
    const res = await request(app).post('/api/tools/clash/group').send({ group: 'GLOBAL' })
    expect(res.body.code).toBe(0)
    expect(clash.saveGroup).toHaveBeenCalledWith('GLOBAL')
    expect(clash.service.setGroup).toHaveBeenCalledWith('GLOBAL')
  })

  it('参数非法 → 400/40000', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/tools/clash/group').send({ group: '' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })
})

describe('GET /api/tools/clash/profiles', () => {
  it('返回配置目录下的订阅文件', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/tools/clash/profiles')
    expect(res.body.data.files).toEqual(['a.yaml', 'b.yaml'])
  })
})

describe('POST /api/tools/clash/profiles/switch', () => {
  it('切换订阅文件', async () => {
    const { app, clash } = makeApp()
    const res = await request(app).post('/api/tools/clash/profiles/switch').send({ file: 'a.yaml' })
    expect(res.body.code).toBe(0)
    expect(clash.service.switchProfile).toHaveBeenCalledWith('a.yaml')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/clash-route.test.ts`
Expected: FAIL（/api/tools/clash/status 404）

- [ ] **Step 3: src/tools/index.ts 登记工具**

`TOOLS` 数组追加：

```ts
  {
    key: 'clash',
    name: '代理网络',
    description: '探测本机 Clash 客户端，测速选优、自动切换节点，保持网络可用',
  },
```

- [ ] **Step 4: src/server/routes/tools.ts 追加路由**

顶部 import 追加：

```ts
import type { ClashTestResult, ClashSubscription, OptimizeResult, AutoOptimizerStatus } from '../../tools/clash/types'
```

文件头注释块更新为：「工具路由（server 层）：工具清单 + 文件随机分配 + 代理网络（clash）」。

在 `toolsRouter` 的签名与实现中扩展 deps（保持现有 file-assign 逻辑不动）：

```ts
/** clash 工具的路由依赖面（结构化类型，测试传普通对象替身） */
export interface ClashRouteDeps {
  service: {
    status(): Promise<{
      detected: boolean
      kernel: string | null
      mixedPort: number | null
      apiBase: string
      capability: Record<string, boolean>
      group: string
      currentNode: string | null
      groups: Array<{ name: string; now?: string }>
      subscriptions: ClashSubscription[]
    }>
    test(): Promise<ClashTestResult>
    optimize(prev?: ClashTestResult): Promise<OptimizeResult>
    subscriptions(): Promise<ClashSubscription[]>
    updateSubscription(name: string): Promise<void>
    setGroup(group: string): void
    profileFiles(): string[]
    switchProfile(file: string): Promise<void>
  }
  auto: { status(): AutoOptimizerStatus }
  saveGroup(group: string): Promise<void>
  anyRunning(): boolean
}

export function toolsRouter(deps: {
  xlsxPath: string
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void> }
  clash: ClashRouteDeps
}): Router {
```

`toolsRouter` 内（`return router` 之前）追加：

```ts
  /** 统一执行 clash 工具操作：ToolError 转统一响应，其余异常交给全局错误处理器 */
  const clashGuard = (res: express.Response, e: unknown) => {
    if (e instanceof ToolError) {
      fail(res, e.status, e.code, e.message)
      return
    }
    throw e
  }

  router.get('/tools/clash/status', asyncHandler(async (req, res) => {
    try {
      const s = await deps.clash.service.status()
      ok(res, { ...s, auto: deps.clash.auto.status(), anyRunning: deps.clash.anyRunning() })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/test', asyncHandler(async (req, res) => {
    try {
      ok(res, await deps.clash.service.test())
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/optimize', asyncHandler(async (req, res) => {
    try {
      ok(res, await deps.clash.service.optimize())
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.get('/tools/clash/subscriptions', asyncHandler(async (req, res) => {
    try {
      ok(res, { subscriptions: await deps.clash.service.subscriptions() })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/subscriptions/:name/update', asyncHandler(async (req, res) => {
    try {
      await deps.clash.service.updateSubscription(String(req.params.name ?? ''))
      ok(res, { name: req.params.name })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.post('/tools/clash/group', asyncHandler(async (req, res) => {
    const body = req.body as { group?: unknown }
    if (typeof body?.group !== 'string' || body.group.trim() === '') {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（group 不能为空）')
      return
    }
    try {
      await deps.clash.saveGroup(body.group)
      deps.clash.service.setGroup(body.group)
      ok(res, { group: body.group })
    } catch (e) {
      clashGuard(res, e)
    }
  }))

  router.get('/tools/clash/profiles', (req, res) => {
    ok(res, { files: deps.clash.service.profileFiles() })
  })

  router.post('/tools/clash/profiles/switch', asyncHandler(async (req, res) => {
    const body = req.body as { file?: unknown }
    if (typeof body?.file !== 'string' || body.file === '') {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（file 不能为空）')
      return
    }
    try {
      await deps.clash.service.switchProfile(body.file)
      ok(res, { file: body.file })
    } catch (e) {
      clashGuard(res, e)
    }
  }))
```

注意：`clashGuard` 里用到 `express.Response` 类型——顶部加 `import type { Response } from 'express'` 并把参数类型写成 `Response`（express 默认导入已存在，用 `import type { Response } from 'express'` 与现有 `import { Router } from 'express'` 并存）。

在 `/api/tools` 的 `GET /tools` 与 file-assign 路由之后为 clash 路由补 `@swagger` 注解（每个端点一段，参照文件头现有注解风格）：

```ts
/**
 * @swagger
 * /api/tools/clash/status:
 *   get:
 *     summary: 代理网络状态（客户端探测/分组/当前节点/自动检测状态）
 *     responses:
 *       '200':
 *         description: 状态汇总
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     detected: { type: boolean }
 *                     kernel: { type: string, nullable: true }
 *                     mixedPort: { type: integer, nullable: true }
 *                     apiBase: { type: string }
 *                     capability: { type: object }
 *                     group: { type: string }
 *                     currentNode: { type: string, nullable: true }
 *                     groups: { type: array, items: { type: object } }
 *                     subscriptions: { type: array, items: { type: object } }
 *                     auto: { type: object }
 *                     anyRunning: { type: boolean }
 */

/**
 * @swagger
 * /api/tools/clash/test:
 *   post:
 *     summary: 代理节点测速（只读，不切换）
 *     responses:
 *       '200':
 *         description: 测速结果（nodes 按得分升序）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     group: { type: string }
 *                     currentNode: { type: string, nullable: true }
 *                     currentUsable: { type: boolean, nullable: true }
 *                     nodes:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           urls: { type: array, items: { type: object } }
 *                           score: { type: number }
 *                           usable: { type: boolean }
 */

/**
 * @swagger
 * /api/tools/clash/optimize:
 *   post:
 *     summary: 测速选优并切换节点（手动入口；任务在途由前端确认提示）
 *     responses:
 *       '200':
 *         description: 切换结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     chosen: { type: string, nullable: true }
 *                     switched: { type: boolean }
 *                     nodes: { type: array, items: { type: object } }
 *                     switchNote: { type: string }
 */

/**
 * @swagger
 * /api/tools/clash/subscriptions:
 *   get:
 *     summary: 订阅列表（proxy-provider 模式；非该模式为空数组）
 *     responses:
 *       '200':
 *         description: 订阅列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     subscriptions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           vehicleType: { type: string }
 *                           updatedAt: { type: string }
 *                           proxiesCount: { type: integer }
 */

/**
 * @swagger
 * /api/tools/clash/subscriptions/{name}/update:
 *   post:
 *     summary: 更新订阅（重拉节点列表）
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: 更新完成
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     name: { type: string }
 */

/**
 * @swagger
 * /api/tools/clash/group:
 *   post:
 *     summary: 设置目标分组（写回 config.json 的 clash.group）
 *     responses:
 *       '200':
 *         description: 分组已更新
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     group: { type: string }
 */

/**
 * @swagger
 * /api/tools/clash/profiles:
 *   get:
 *     summary: 订阅配置文件列表（clash.configPath 目录下 *.yaml）
 *     responses:
 *       '200':
 *         description: 文件列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     files: { type: array, items: { type: string } }
 */

/**
 * @swagger
 * /api/tools/clash/profiles/switch:
 *   post:
 *     summary: 切换订阅文件（PUT /configs 以指定配置重载）
 *     responses:
 *       '200':
 *         description: 切换完成
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     file: { type: string }
 */
```

- [ ] **Step 5: src/server/app.ts 挂载 clash 依赖**

`ServerDeps` 接口追加（`datasource` 之后）：

```ts
  /** 代理网络工具（tools/clash）：服务/自动检测/分组写回/在途判定 */
  clash: {
    service: import('../tools/clash/optimizer').ClashService
    auto: import('../tools/clash/auto-optimizer').AutoOptimizer
    saveGroup(group: string): Promise<void>
    anyRunning(): boolean
  }
```

`createApp` 内 `toolsRouter` 挂载改为：

```ts
  api.use(toolsRouter({ xlsxPath: deps.cfg.dataSource.path, datasource: deps.datasource, clash: deps.clash }))
```

- [ ] **Step 6: src/app.ts 装配**

`createApp({...})` 调用之前（`const scheduler` 定义之后）追加：

```ts
  // 代理网络工具（tools/clash）：适配器 → 服务 → 定时自动检测；
  // 在途守卫复用 enqueuer.anyRunning()（任务运行中不切换节点，避免换 IP 破坏签到会话）
  const clashAdapter = new ClashAdapter(cfg.clash.apiBase, cfg.clash.apiSecret, cfg.clash.testTimeoutMs)
  const clashService = new ClashService({ adapter: clashAdapter, getCfg: () => cfg.clash, logger })
  const clashAuto = new AutoOptimizer({
    service: clashService,
    anyRunning: () => enqueuer.anyRunning(),
    logger,
    intervals: { normalMin: cfg.clash.autoCheck.normalIntervalMin, fastMin: cfg.clash.autoCheck.fastIntervalMin },
  })
  if (cfg.clash.enabled && cfg.clash.autoCheck.enabled) clashAuto.start()
```

顶部 import 追加：

```ts
import { ClashAdapter } from './tools/clash/adapter'
import { ClashService } from './tools/clash/optimizer'
import { AutoOptimizer } from './tools/clash/auto-optimizer'
import { updateConfigFile } from './infrastructure/config'
```

`createApp` 的 deps 对象追加：

```ts
    clash: {
      service: clashService,
      auto: clashAuto,
      saveGroup: async (group) => {
        updateConfigFile({ group })
      },
      anyRunning: () => enqueuer.anyRunning(),
    },
```

优雅退出 `shutdown` 内（`scheduler.stop()` 之后）加 `clashAuto.stop()`。

- [ ] **Step 7: config/config.json 追加 clash 段**

```json
  "clash": {
    "enabled": true,
    "apiBase": "http://127.0.0.1:9090",
    "apiSecret": "",
    "group": "",
    "testUrls": ["https://www.gstatic.com/generate_204", "https://www.google.com"],
    "weights": [2, 1],
    "maxNodes": 20,
    "testConcurrency": 2,
    "testTimeoutMs": 5000,
    "minGainMs": 100,
    "autoCheck": { "enabled": true, "normalIntervalMin": 30, "fastIntervalMin": 2 },
    "configPath": ""
  },
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/clash-route.test.ts tests/tools-route.test.ts`
Expected: PASS（注意 tools-route.test.ts 的 `makeApp` 未传 clash deps——toolsRouter 现在要求 clash 必填。若编译报错，在该文件的 makeApp 中补一个最小 clash 替身：

```ts
  const clash = {
    service: {
      status: vi.fn().mockResolvedValue({ detected: false, kernel: null, mixedPort: null, apiBase: '', capability: {}, group: '', currentNode: null, groups: [], subscriptions: [] }),
      test: vi.fn(), optimize: vi.fn(), subscriptions: vi.fn().mockResolvedValue([]),
      updateSubscription: vi.fn(), setGroup: vi.fn(), profileFiles: vi.fn().mockReturnValue([]), switchProfile: vi.fn(),
    },
    auto: { status: () => ({ pace: 'normal', lastCheckAt: null, allDown: false, deferredSwitches: 0 }) },
    saveGroup: vi.fn().mockResolvedValue(undefined),
    anyRunning: () => false,
  }
```
并把 `toolsRouter({ xlsxPath, datasource, clash })` 传入。）

- [ ] **Step 9: 全量验证 + 提交**

Run: `npm run typecheck`；`npm test`

```bash
git add src/server/routes/tools.ts src/server/app.ts src/app.ts src/tools/index.ts config/config.json tests/clash-route.test.ts tests/tools-route.test.ts
git commit -m "feat: clash 工具路由与装配（status/test/optimize/订阅/分组）"
```

---

### Task 6: 前端面板（types/endpoints/hooks/clash.tsx + 单测）

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api/endpoints.ts`
- Modify: `web/src/pages/tools/hooks.ts`
- Modify: `web/src/pages/tools/hooks.test.tsx`
- Modify: `web/src/pages/tools/index.tsx`
- Create: `web/src/pages/tools/clash.tsx`

**Interfaces:**
- Consumes: Task 5 的 API；前端 `get/post`（web/src/api/client.ts）
- Produces: 工具中心「代理网络」面板

- [ ] **Step 1: 写失败测试 web/src/pages/tools/hooks.test.tsx**

把现有 `vi.mock('../../api/endpoints', ...)` 工厂替换为（保留 applyFileAssign 以兼容存量用例）：

```tsx
vi.mock('../../api/endpoints', () => ({
  applyFileAssign: vi.fn().mockResolvedValue({ renamedCount: 2, updatedRows: 2, reloadedRows: 2 }),
  fetchClashStatus: vi.fn().mockResolvedValue({
    detected: true, kernel: 'mihomo', mixedPort: 7890, apiBase: 'http://127.0.0.1:9090',
    capability: { listProxies: true, delay: true, switchNode: true, providers: false, switchProfile: false },
    group: 'GLOBAL', currentNode: 'HK-01', groups: [{ name: 'GLOBAL', now: 'HK-01' }], subscriptions: [],
    auto: { pace: 'normal', lastCheckAt: null, allDown: false, deferredSwitches: 0 }, anyRunning: false,
  }),
  testClash: vi.fn().mockResolvedValue({ group: 'GLOBAL', currentNode: 'HK-01', currentUsable: true, nodes: [] }),
  optimizeClash: vi.fn().mockResolvedValue({ chosen: 'HK-02', switched: true, nodes: [] }),
  setClashGroup: vi.fn().mockResolvedValue({ group: 'GLOBAL' }),
  updateClashSubscription: vi.fn().mockResolvedValue(null),
  fetchClashProfiles: vi.fn().mockResolvedValue({ files: ['a.yaml'] }),
  switchClashProfile: vi.fn().mockResolvedValue({ file: 'a.yaml' }),
}))
```

顶部 import 追加 `summarizeNodes, useClashStatus, useClashOptimize`。文件末尾追加：

```tsx
describe('summarizeNodes', () => {
  it('统计可用/不可用并取最优节点', () => {
    const nodes = [
      { name: 'B', urls: [], score: 50, usable: true },
      { name: 'A', urls: [], score: 100, usable: true },
      { name: 'D', urls: [], score: 999, usable: false },
    ]
    expect(summarizeNodes(nodes)).toEqual({ usableCount: 2, downCount: 1, best: nodes[0] })
  })

  it('全部不可用 → best 为 null', () => {
    expect(summarizeNodes([{ name: 'D', urls: [], score: 999, usable: false }])).toEqual({ usableCount: 0, downCount: 1, best: null })
  })
})

describe('useClashStatus', () => {
  it('返回探测状态', async () => {
    const qc = new QueryClient()
    const { result } = renderHook(() => useClashStatus(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    await waitFor(() => expect(result.current.data?.detected).toBe(true))
  })
})

describe('useClashOptimize', () => {
  it('成功后失效 clash-status 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useClashOptimize(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['clash-status'] }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web`
Expected: FAIL（summarizeNodes/useClashStatus 未导出）

- [ ] **Step 3: web/src/types.ts 追加类型**

文件末尾追加：

```ts
// ===== 代理网络工具（手补类型：/api/tools/clash/*，与后端 src/tools/clash/types.ts 同构） =====

export interface ClashUrlDelay {
  url: string
  delayMs: number
  reachable: boolean
}

export interface ClashNodeResult {
  name: string
  urls: ClashUrlDelay[]
  score: number
  usable: boolean
}

export interface ClashTestData {
  group: string
  currentNode: string | null
  currentUsable: boolean | null
  nodes: ClashNodeResult[]
}

export interface ClashOptimizeResult {
  chosen: string | null
  switched: boolean
  nodes: ClashNodeResult[]
  switchNote?: string
}

export interface ClashSubscriptionItem {
  name: string
  vehicleType: string
  updatedAt?: string
  proxiesCount: number
}

export interface ClashStatusData {
  detected: boolean
  kernel: string | null
  mixedPort: number | null
  apiBase: string
  capability: { listProxies: boolean; delay: boolean; switchNode: boolean; providers: boolean; switchProfile: boolean }
  group: string
  currentNode: string | null
  groups: Array<{ name: string; now?: string }>
  subscriptions: ClashSubscriptionItem[]
  auto: { pace: string; lastCheckAt: string | null; allDown: boolean; deferredSwitches: number }
  anyRunning: boolean
}
```

- [ ] **Step 4: web/src/api/endpoints.ts 追加请求函数**

文件末尾追加：

```ts
// ===== 代理网络工具 =====
export const fetchClashStatus = () => get<ClashStatusData>('/api/tools/clash/status')
export const testClash = () => post<ClashTestData>('/api/tools/clash/test', {})
export const optimizeClash = () => post<ClashOptimizeResult>('/api/tools/clash/optimize', {})
export const fetchClashSubscriptions = () => get<{ subscriptions: ClashSubscriptionItem[] }>('/api/tools/clash/subscriptions')
export const updateClashSubscription = (name: string) => post<{ name: string }>(`/api/tools/clash/subscriptions/${encodeURIComponent(name)}/update`, {})
export const setClashGroup = (group: string) => post<{ group: string }>('/api/tools/clash/group', { group })
export const fetchClashProfiles = () => get<{ files: string[] }>('/api/tools/clash/profiles')
export const switchClashProfile = (file: string) => post<{ file: string }>('/api/tools/clash/profiles/switch', { file })
```

第 2 行 import 的类型清单追加 `ClashStatusData, ClashTestData, ClashOptimizeResult, ClashSubscriptionItem`。

- [ ] **Step 5: web/src/pages/tools/hooks.ts 追加 hooks**

import 行追加：

```ts
import { applyFileAssign, fetchTools, previewFileAssign, fetchClashStatus, testClash, optimizeClash, fetchClashProfiles, setClashGroup, switchClashProfile, updateClashSubscription } from '../../api/endpoints'
```

类型 import 追加 `ClashNodeResult, ClashStatusData`（不需要 ClashStatusData——useQuery 泛型自动推导，仅 import `ClashNodeResult`）。

文件末尾追加：

```ts
// ===== 代理网络工具 =====

/** 代理网络状态（15 秒轮询：探测/节奏/订阅实时性） */
export function useClashStatus() {
  return useQuery({ queryKey: ['clash-status'], queryFn: fetchClashStatus, refetchInterval: 15000 })
}

/** 节点测速（只读） */
export function useClashTest() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: () => testClash(),
    onSuccess: (res) => {
      const usable = res.nodes.filter((n) => n.usable).length
      message.success(`测速完成：共 ${res.nodes.length} 个节点，${usable} 个可用`)
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 选优并切换 */
export function useClashOptimize() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => optimizeClash(),
    onSuccess: (res) => {
      message.success(res.switched ? `已切换到 ${res.chosen}` : `未切换${res.switchNote ? `（${res.switchNote}）` : ''}`)
      queryClient.invalidateQueries({ queryKey: ['clash-status'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 设置目标分组（写回 config.json） */
export function useClashSetGroup() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (group: string) => setClashGroup(group),
    onSuccess: () => {
      message.success('目标分组已更新')
      queryClient.invalidateQueries({ queryKey: ['clash-status'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 更新订阅（重拉节点列表） */
export function useClashUpdateSubscription() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: (name: string) => updateClashSubscription(name),
    onSuccess: () => message.success('订阅已更新'),
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 订阅配置文件列表（仅 switchProfile 能力时启用） */
export function useClashProfiles(enabled: boolean) {
  return useQuery({ queryKey: ['clash-profiles'], queryFn: fetchClashProfiles, enabled })
}

/** 切换订阅文件 */
export function useClashSwitchProfile() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: string) => switchClashProfile(file),
    onSuccess: () => {
      message.success('订阅文件已切换')
      queryClient.invalidateQueries({ queryKey: ['clash-status'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 节点汇总（纯函数，面板与单测共用）：nodes 需已按得分升序 */
export function summarizeNodes(nodes: ClashNodeResult[]): { usableCount: number; downCount: number; best: ClashNodeResult | null } {
  const usable = nodes.filter((n) => n.usable)
  return { usableCount: usable.length, downCount: nodes.length - usable.length, best: usable[0] ?? null }
}
```

- [ ] **Step 6: 实现 web/src/pages/tools/clash.tsx**

```tsx
import { useState } from 'react'
import { Alert, Button, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { summarizeNodes, useClashOptimize, useClashProfiles, useClashSetGroup, useClashStatus, useClashSwitchProfile, useClashTest, useClashUpdateSubscription } from './hooks'
import type { ClashNodeResult, ClashUrlDelay } from '../../types'

const columns = [
  { title: '节点', dataIndex: 'name', key: 'name' },
  {
    title: '可用', dataIndex: 'usable', key: 'usable',
    render: (v: boolean) => (v ? <Tag color="green">可用</Tag> : <Tag color="red">不可用</Tag>),
  },
  { title: '得分', dataIndex: 'score', key: 'score', render: (v: number) => Math.round(v) },
  {
    title: '延迟明细', dataIndex: 'urls', key: 'urls',
    render: (urls: ClashUrlDelay[]) => urls.map((u) => `${u.url}: ${u.reachable ? `${u.delayMs}ms` : '超时'}`).join(' ｜ '),
  },
]

export default function ClashPanel() {
  const status = useClashStatus()
  const test = useClashTest()
  const optimize = useClashOptimize()
  const setGroup = useClashSetGroup()
  const updateSub = useClashUpdateSubscription()
  const profiles = useClashProfiles(status.data?.capability.switchProfile === true)
  const switchProfile = useClashSwitchProfile()
  const [nodes, setNodes] = useState<ClashNodeResult[] | null>(null)
  const [profile, setProfile] = useState<string>()

  if (status.isPending) {
    return <Alert type="info" showIcon message="正在探测本机 Clash 客户端..." />
  }

  if (status.isError || !status.data) {
    return <Alert type="warning" showIcon message="代理网络状态加载失败" description="请检查后端服务是否运行" />
  }

  const data = status.data
  const summary = nodes ? summarizeNodes(nodes) : null
  const paceTag = data.auto.pace === 'fast' ? <Tag color="orange">快速重检中</Tag> : <Tag color="blue">正常节奏</Tag>

  if (!data.detected) {
    return (
      <Alert
        type="warning"
        showIcon
        message="未检测到运行中的 Clash 客户端"
        description={`请确认 Clash 已启动且开启外部控制（external-controller，当前探测地址 ${data.apiBase}）。注意：管理 API 端口（默认 9090）与代理流量端口（7890）不是同一个。`}
      />
    )
  }

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Alert
        type={data.auto.allDown ? 'error' : 'info'}
        showIcon
        message={
          <Space wrap>
            <span>内核：{data.kernel ?? '未知'}</span>
            <span>当前节点：{data.currentNode ?? '未选择'}</span>
            {paceTag}
            {data.auto.allDown && <Tag color="red">全网不可用</Tag>}
            {data.anyRunning && <Tag>任务运行中</Tag>}
          </Space>
        }
        description={data.mixedPort ? `窗口代理应填 127.0.0.1:${data.mixedPort}（实测混合口）` : undefined}
      />

      <Space wrap>
        <Select
          value={data.group || undefined}
          placeholder="选择目标分组"
          style={{ width: 260 }}
          options={data.groups.map((g) => ({ value: g.name, label: g.now ? `${g.name}（当前 ${g.now}）` : g.name }))}
          onChange={(v) => setGroup.mutate(v)}
        />
        <Button
          icon={<ReloadOutlined />}
          loading={test.isPending}
          onClick={() => test.mutate(undefined, { onSuccess: (res) => setNodes(res.nodes) })}
        >
          立即测速
        </Button>
        <Popconfirm
          title="确定选优并切换？"
          description={data.anyRunning ? '有任务正在运行，切换节点会更换 IP，可能中断签到会话' : '将切换到当前最优节点'}
          onConfirm={() => optimize.mutate(undefined, { onSuccess: (res) => setNodes(res.nodes) })}
          okText="确定"
          cancelText="取消"
        >
          <Button type="primary" icon={<ThunderboltOutlined />} loading={optimize.isPending}>
            选优并切换
          </Button>
        </Popconfirm>
      </Space>

      {summary && (
        <Typography.Text type="secondary">
          测速结果：{nodes?.length} 个节点，{summary.usableCount} 个可用、{summary.downCount} 个不可用
          {summary.best && `，最优 ${summary.best.name}（${Math.round(summary.best.score)}）`}
        </Typography.Text>
      )}
      {nodes && <Table rowKey="name" size="small" columns={columns} dataSource={nodes} pagination={false} />}

      {data.capability.providers && (
        <Space direction="vertical" size={8} style={{ display: 'flex' }}>
          <Typography.Text strong>订阅</Typography.Text>
          {data.subscriptions.map((s) => (
            <Space key={s.name}>
              <span>{s.name}（{s.vehicleType}，{s.proxiesCount} 节点）</span>
              <Button size="small" loading={updateSub.isPending} onClick={() => updateSub.mutate(s.name)}>
                更新订阅
              </Button>
            </Space>
          ))}
        </Space>
      )}

      {data.capability.switchProfile && (
        <Space>
          <Select
            value={profile}
            placeholder="选择订阅配置文件"
            style={{ width: 260 }}
            options={(profiles.data?.files ?? []).map((f) => ({ value: f, label: f }))}
            onChange={setProfile}
          />
          <Button
            disabled={!profile}
            loading={switchProfile.isPending}
            onClick={() => profile && switchProfile.mutate(profile)}
          >
            切换订阅文件
          </Button>
        </Space>
      )}
    </Space>
  )
}
```

- [ ] **Step 7: web/src/pages/tools/index.tsx 挂载面板**

顶部 import 追加 `import ClashPanel from './clash'`；`{activeKey === 'file-assign' && <FileAssignPanel />}` 之后追加：

```tsx
      {activeKey === 'clash' && <ClashPanel />}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npm run test:web` 预期 PASS（含新单测）；`npx tsc --noEmit -p web` 或 `npm run typecheck`（项目 typecheck 覆盖 web？——若 `npm run typecheck` 不含 web 的 tsconfig，改用 `npm --prefix web exec tsc --noEmit` 验证；以仓库现有 tsconfig 覆盖范围为准，先跑 `npm run typecheck` 再按需补 web 检查）

- [ ] **Step 9: 全量验证 + 提交**

Run: `npm run typecheck`；`npm test`；`npm run test:web`

```bash
git add web/src/types.ts web/src/api/endpoints.ts web/src/pages/tools/hooks.ts web/src/pages/tools/hooks.test.tsx web/src/pages/tools/index.tsx web/src/pages/tools/clash.tsx
git commit -m "feat: 代理网络工具面板（状态/测速/选优/订阅）"
```

---

## Self-Review 记录

1. **Spec coverage**：探测与能力矩阵 → Task 2；测速选优算法（含白名单机场评分/低并发/切换回滚）→ Task 3；自适应节奏 + 在途守卫 → Task 4；API 与面板 → Task 5/6；配置 clash 段 → Task 1/5；错误码 → Task 1；queue.anyRunning → Task 1；测试（detector/optimizer/auto/router/hooks）→ 各任务内。规格「端口澄清（/configs 实测混合口）」→ adapter.mixedPort + 面板提示。规格「分组下拉实时拉取 + 写回」→ status.groups + POST /group。
2. **Placeholder scan**：无 TBD/TODO；每个代码步骤含完整代码。
3. **Type consistency**：`ClashTestResult{group,currentNode,currentUsable,nodes}` 在 Task 2 定义、Task 3 实现、Task 4/5 消费，签名一致；`OptimizeResult.chosen/switchNote` 与前端类型一致；错误码数值 Task 1 定义后各任务直接引用；`AutoOptimizerStatus` 三处一致；`toolsRouter` 新 deps 在 server/app.ts 与 app.ts 与测试替身三处结构一致。
4. **已知取舍**：Task 3 测试若因 busy 锁时序（`svc.test()` 与 `optimize` 内部 `testInner`）出现断言偏差，按「锁生效/回滚顺序/跳过重测」意图微调；Task 5 若 tools-route.test.ts 因 clash deps 必填而编译失败，按 Step 8 内嵌的补丁补替身。

# Clash 代理网络工具重设计（节点中心化）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「代理网络」工具从分组中心改为节点中心：去掉面板分组下拉，当前节点从主代理分组读，「立即测速」只测当前节点，「选优并切换」在主代理分组内选优。

**Architecture:** `ClashService` 拆分出 `testGroup()`（全节点测速，供选优与自动检测）与新的 `test()`（单节点测当前节点）；删除 `setGroup`/`groupOverride`/`updateConfigFile`/`/tools/clash/group` 及前端分组下拉；`clash.group` 语义变为后台工作分组（默认 `🔰 节点选择`）。

**Tech Stack:** Node + Express 5 + TS 严格模式；React 18 + antd 5 + react-query；vitest + supertest + testing-library。

## Global Constraints

- 无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块说明模块职责与依赖方向；commit 用中文 conventional 前缀（`feat:`/`fix:`/`docs:`）。
- 后端路由统一 `{code,message,data}` 响应（`ok`/`fail` + `asyncHandler`）；`ToolError` 经路由 `clashGuard` 映射，错误码见 `src/tools/errors.ts`（`CLASH_GROUP_NOT_FOUND`=40008、`CLASH_API_FAILED`=50002、`TOOL_BUSY`=40904）。
- `web/src/api/schema.d.ts` 为生成文件不改；前端类型手补到 `web/src/types.ts`；前端请求只走 `web/src/api/client.ts`。
- 每次改完跑 `npm run typecheck`、`npm test`、`npm run test:web` 全过。
- 文档同步（硬性要求）：`docs/API-GUIDE.md`（第 11 章代理网络小节 + 8.2 工具页 + 8.3 REST 总表）。
- 主代理分组名 `🔰 节点选择` 是用户 Clash 里的真实分组名（含 emoji，属数据值非代码标识，必须逐字匹配）。

---

### Task 1: 后端类型与 ClashService 重构

**Files:**
- Modify: `src/tools/clash/types.ts`（新增 `CurrentNodeTestResult`）
- Modify: `src/tools/clash/optimizer.ts`（`test()` 改测当前节点；原全节点逻辑迁 `testGroup()`；`optimize()` 复用 `testGroupInner`；删 `groupOverride`/`setGroup`；`status()` 删 `groups`）
- Test: `tests/clash-optimizer.test.ts`

**Interfaces:**
- Consumes: 无（独立起点）
- Produces: `CurrentNodeTestResult { group, currentNode, currentUsable, node: NodeTestResult | null }`；`ClashService.test(): Promise<CurrentNodeTestResult>`、`ClashService.testGroup(): Promise<ClashTestResult>`；`ClashTestResult` 保持全节点形态（供 Task 2/3 使用）

- [ ] **Step 1: 写失败测试**

`tests/clash-optimizer.test.ts`：将现有 `describe('ClashService.test', ...)`（第 67-95 行）整块替换为下面两个 describe；`describe('ClashService.optimize')` 整块保持原样不动。

```ts
describe('ClashService.test（测当前节点）', () => {
  it('只测当前节点，返回单节点结果', async () => {
    const { adapter } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 200 }],
      'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }],
    })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.test()
    expect(r.group).toBe('GLOBAL')
    expect(r.currentNode).toBe('HK-01')
    expect(r.currentUsable).toBe(true)
    expect(r.node).toEqual({
      name: 'HK-01',
      urls: [
        { url: 'https://a.com', delayMs: 100, reachable: true },
        { url: 'https://b.com', delayMs: 200, reachable: true },
      ],
      score: 400,
      usable: true,
    })
    expect(adapter.delay).not.toHaveBeenCalledWith('HK-02', expect.anything())
  })

  it('当前节点为 DIRECT → node=null、currentUsable=false', async () => {
    const { adapter } = makeAdapter({}, { groups: [{ name: 'GLOBAL', now: 'DIRECT', all: ['DIRECT', 'HK-01'] }] })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.test()
    expect(r.currentNode).toBe('DIRECT')
    expect(r.currentUsable).toBe(false)
    expect(r.node).toBeNull()
    expect(adapter.delay).not.toHaveBeenCalled()
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

describe('ClashService.testGroup（全节点测速，选优/自动检测用）', () => {
  it('按并发测速并按得分升序返回', async () => {
    const { adapter } = makeAdapter({
      'HK-01': [{ reachable: true, delayMs: 100 }, { reachable: true, delayMs: 200 }],
      'HK-02': [{ reachable: true, delayMs: 50 }, { reachable: true, delayMs: 80 }],
    })
    const svc = makeService(adapter as never, makeCfg())
    const r = await svc.testGroup()
    expect(r.group).toBe('GLOBAL')
    expect(r.currentNode).toBe('HK-01')
    expect(r.currentUsable).toBe(true)
    expect(r.nodes.map((n) => n.name)).toEqual(['HK-02', 'HK-01'])
    expect(r.nodes[0].score).toBeLessThan(r.nodes[1].score)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/clash-optimizer.test.ts`
Expected: `testGroup` 用例 FAIL（`svc.testGroup is not a function`）；`test` 的「只测当前节点」「DIRECT 空态」FAIL。

- [ ] **Step 3: 实现**

3a. `src/tools/clash/types.ts` 在 `ClashTestResult` 之后新增：

```ts
/** 当前节点测速结果（「立即测速」单节点形态；node=null 表示直连/未选择节点无可测） */
export interface CurrentNodeTestResult {
  group: string
  /** 分组当前选中节点名（DIRECT/REJECT/PASS 时为该特殊名） */
  currentNode: string | null
  /** 当前节点是否可达（不可测时为 false） */
  currentUsable: boolean
  /** 当前节点测速明细；null 表示不可测 */
  node: NodeTestResult | null
}
```

3b. `src/tools/clash/optimizer.ts`：

- import 行补 `CurrentNodeTestResult`：

```ts
import type {
  ClashDetectResult, ClashGroup, ClashTestResult, CurrentNodeTestResult,
  NodeTestResult, OptimizeResult, UrlDelay,
} from './types'
```

- 删除字段 `groupOverride` 与构造函数里的赋值（第 59-64 行）：

```ts
export class ClashService {
  private busy = false

  constructor(private deps: ClashServiceDeps) {}
```

- 删除 `setGroup` 方法（第 76-79 行）。

- `resolveGroup`（第 82-93 行）改为：

```ts
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
```

- `test()`（第 96-104 行）与 `testInner`（第 106-128 行）整体替换为：

```ts
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
```

- `optimize()`（第 139 行）中 `const result = prev ?? (await this.testInner())` 改为 `const result = prev ?? (await this.testGroupInner())`（仅改名，其余不动）。

- `status()`（第 179-213 行）整体替换为：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/clash-optimizer.test.ts` 然后 `npm run typecheck`
Expected: 测试全 PASS，typecheck 0 error。

- [ ] **Step 5: Commit**

```bash
git add src/tools/clash/types.ts src/tools/clash/optimizer.ts tests/clash-optimizer.test.ts
git commit -m "feat: clash 立即测速改为测当前节点，全节点测速迁 testGroup"
```

---

### Task 2: 自动检测适配 testGroup

**Files:**
- Modify: `src/tools/clash/auto-optimizer.ts`（`tick()` 改调 `testGroup()`）
- Test: `tests/clash-auto-optimizer.test.ts`

**Interfaces:**
- Consumes: `ClashService.testGroup(): Promise<ClashTestResult>`（Task 1）
- Produces: 无新接口

- [ ] **Step 1: 写失败测试**

`tests/clash-auto-optimizer.test.ts` 的 `makeService`（第 8-14 行）改为：

```ts
function makeService(testImpl: () => Promise<unknown>, optimizeImpl: () => Promise<unknown>, busy = false) {
  return {
    isBusy: busy,
    testGroup: vi.fn(testImpl),
    optimize: vi.fn(optimizeImpl),
  } as unknown as ClashService
}
```

并把全部用例里的 `svc.test` 断言（第 34、43、46、55、64、127、138 行）统一改为 `svc.testGroup`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/clash-auto-optimizer.test.ts`
Expected: FAIL（`svc.test` 为 undefined，`toHaveBeenCalled` 失败）。

- [ ] **Step 3: 实现**

`src/tools/clash/auto-optimizer.ts` 的 `tick()` 内（第 71 行）`const result = await this.deps.service.test()` 改为：

```ts
      const result = await this.deps.service.testGroup()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/clash-auto-optimizer.test.ts` 然后 `npm run typecheck`
Expected: 测试全 PASS，typecheck 0 error。

- [ ] **Step 5: Commit**

```bash
git add src/tools/clash/auto-optimizer.ts tests/clash-auto-optimizer.test.ts
git commit -m "feat: 自动检测改调 testGroup 全节点测速"
```

---

### Task 3: 路由/装配/配置清理

**Files:**
- Modify: `src/server/routes/tools.ts`（删 `/tools/clash/group` 端点与 swagger；`ClashRouteDeps` 删 `setGroup`/`saveGroup`；`test` 返回类型改 `CurrentNodeTestResult`；status swagger 删 `groups`）
- Modify: `src/app.ts`（删 `saveGroup` 闭包与 `updateConfigFile` import）
- Modify: `src/infrastructure/config.ts`（删 `updateConfigFile`；`clash.group` 默认 `''` → `'🔰 节点选择'`）
- Modify: `config/config.json`（`clash.group` → `"🔰 节点选择"`）
- Test: `tests/clash-route.test.ts`、`tests/clash-config.test.ts`

**Interfaces:**
- Consumes: `CurrentNodeTestResult`（Task 1）
- Produces: 无新接口；移除 `POST /api/tools/clash/group`、`updateConfigFile`

- [ ] **Step 1: 写失败测试**

1a. `tests/clash-route.test.ts`：

- 顶部 `statusData`（第 10-19 行）删 `groups` 字段；`testData`（第 21 行）改为：

```ts
const testData = { group: 'GLOBAL', currentNode: 'HK-01', currentUsable: true, node: { name: 'HK-01', urls: [], score: 100, usable: true } }
```

- `makeApp` 的 clash 对象删 `setGroup` 与 `saveGroup`（第 32、35 行）。

- 删整个 `describe('POST /api/tools/clash/group', ...)` 块（第 89-111 行）。

- `POST /api/tools/clash/test` 的「返回测速结果」用例（第 64-69 行）保留 `expect(res.body.data.group).toBe('GLOBAL')`，并追加：

```ts
    expect(res.body.data.node.name).toBe('HK-01')
```

1b. `tests/clash-config.test.ts`：

- 顶部 import（第 5 行）`import { loadConfig, updateConfigFile }` 改为 `import { loadConfig }`。

- 删整个 `describe('updateConfigFile', ...)` 块（第 37-51 行）。

- 「缺省值齐备」用例（第 22-29 行）追加一行：

```ts
    expect(cfg.clash.group).toBe('🔰 节点选择')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/clash-route.test.ts tests/clash-config.test.ts`
Expected: FAIL（config 缺省 group 仍为 `''` 与断言不符；`status` 仍返回 `groups`；`testData` 单节点结构与旧 `nodes` 形态不符）。

- [ ] **Step 3: 实现**

3a. `src/server/routes/tools.ts`：

- import（第 14 行）改为：

```ts
import type { ClashTestResult, CurrentNodeTestResult, OptimizeResult, AutoOptimizerStatus } from '../../tools/clash/types'
```

- 删 swagger 块 `/** @swagger /api/tools/clash/group ... */`（第 185-204 行）。

- swagger `/api/tools/clash/status`（第 117-124 行）删 `groups: { type: array, items: { type: object } }` 行。

- `ClashRouteDeps.service`（第 207-222 行）改为：

```ts
export interface ClashRouteDeps {
  service: {
    status(): Promise<{
      detected: boolean
      kernel: string | null
      mixedPort: number | null
      apiBase: string
      delaySupported: boolean
      group: string
      currentNode: string | null
    }>
    test(): Promise<CurrentNodeTestResult>
    optimize(prev?: ClashTestResult): Promise<OptimizeResult>
  }
  auto: { status(): AutoOptimizerStatus }
  anyRunning(): boolean
}
```

- 删 `/tools/clash/group` 端点实现（第 322-335 行）。

3b. `src/app.ts`：

- `clash` 对象（第 252-259 行）删 `saveGroup`，改为：

```ts
    clash: {
      service: clashService,
      auto: clashAuto,
      anyRunning: () => enqueuer.anyRunning(),
    },
```

- 删顶部 import 里的 `updateConfigFile`（查找 `updateConfigFile` 所在 import 行，移除该标识符）。

3c. `src/infrastructure/config.ts`：

- `clash.group` 默认值（第 199 行）`group: '',` 改为 `group: '🔰 节点选择',`。

- 删除 `updateConfigFile` 函数（第 297-311 行）及文件顶部 `writeFileSync` import（若 `writeFileSync` 仅 `updateConfigFile` 使用则移除该标识符；`deepMerge` 仍被 `loadConfig` 使用，保留）。

3d. `config/config.json` 第 39 行 `"group": "AutoSelection"` 改为 `"group": "🔰 节点选择"`。

- [ ] **Step 4: 跑测试 + typecheck 确认通过**

Run: `npm test -- tests/clash-route.test.ts tests/clash-config.test.ts` 然后 `npm run typecheck`
Expected: 测试全 PASS，typecheck 0 error（`src/app.ts` 无测试直接覆盖，靠 typecheck 兜底）。

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/tools.ts src/app.ts src/infrastructure/config.ts config/config.json tests/clash-route.test.ts tests/clash-config.test.ts
git commit -m "feat: 移除分组下拉与写回能力，clash.group 改为主代理分组默认值"
```

---

### Task 4: 前端类型/API/hooks

**Files:**
- Modify: `web/src/types.ts`（`ClashStatusData` 删 `groups`；`ClashTestData` 改单节点形态）
- Modify: `web/src/api/endpoints.ts`（删 `setClashGroup`）
- Modify: `web/src/pages/tools/hooks.ts`（删 `useClashSetGroup`；适配 `useClashTest`）
- Test: `web/src/pages/tools/hooks.test.tsx`

**Interfaces:**
- Consumes: 无（与 Task 1/3 后端结构对齐）
- Produces: `useClashTest()`（Task 5 使用）；`ClashTestData` 新形态 `{ group, currentNode, currentUsable, node: ClashNodeResult | null }`

- [ ] **Step 1: 写失败测试**

`web/src/pages/tools/hooks.test.tsx` 的 `vi.mock('../../api/endpoints', ...)`（第 8-18 行）：

- `fetchClashStatus` mock（第 10-14 行）删 `groups` 字段。
- `testClash` mock（第 15 行）改为：

```ts
  testClash: vi.fn().mockResolvedValue({ group: 'GLOBAL', currentNode: 'HK-01', currentUsable: true, node: { name: 'HK-01', urls: [], score: 100, usable: true } }),
```

- 删 `setClashGroup` mock（第 17 行）。

- 无新增用例；现有 `useClashStatus`/`useClashOptimize` 用例不引用已删字段，保持通过。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web -- src/pages/tools/hooks.test.tsx`
Expected: FAIL（类型与 mock 一起改，编译期报 `groups`/`node` 不匹配）。

- [ ] **Step 3: 实现**

3a. `web/src/types.ts`：

- `ClashStatusData`（第 137-148 行）删 `groups` 行。
- `ClashTestData`（第 123-128 行）改为：

```ts
export interface ClashTestData {
  group: string
  currentNode: string | null
  currentUsable: boolean
  node: ClashNodeResult | null
}
```

3b. `web/src/api/endpoints.ts` 删第 40 行 `setClashGroup`。

3c. `web/src/pages/tools/hooks.ts`：

- 顶部 import（第 3 行）从列表移除 `setClashGroup`。
- 删 `useClashSetGroup`（第 75-87 行）。
- `useClashTest`（第 48-59 行）改为：

```ts
/** 节点测速（只测当前节点） */
export function useClashTest() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: () => testClash(),
    onSuccess: (res) => {
      if (!res.node) {
        message.info(res.currentNode ? `当前节点 ${res.currentNode} 不可测（直连或未选择节点）` : '当前无可测节点')
        return
      }
      const detail = res.node.urls.map((u) => (u.reachable ? `${u.delayMs}ms` : '超时')).join(' / ')
      message.success(`当前节点 ${res.node.name}：${detail}`)
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 4: 跑测试 + typecheck 确认通过**

Run: `npm run test:web -- src/pages/tools/hooks.test.tsx` 然后 `npm run typecheck`
Expected: 测试全 PASS，typecheck 0 error。

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api/endpoints.ts web/src/pages/tools/hooks.ts web/src/pages/tools/hooks.test.tsx
git commit -m "feat: 前端移除分组选择，立即测速适配单节点形态"
```

---

### Task 5: 面板 UI（去分组下拉 + 单节点测速展示）

**Files:**
- Modify: `web/src/pages/tools/clash.tsx`

**Interfaces:**
- Consumes: `useClashTest`（Task 4，返回单节点）、`useClashOptimize`（返回 `nodes` 数组）
- Produces: 无

- [ ] **Step 1: 实现**

`web/src/pages/tools/clash.tsx` 整体改写为：

```tsx
import { useState } from 'react'
import { Alert, Button, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { summarizeNodes, useClashOptimize, useClashStatus, useClashTest } from './hooks'
import type { ClashNodeResult, ClashTestData, ClashUrlDelay } from '../../types'

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
  const [nodes, setNodes] = useState<ClashNodeResult[] | null>(null)
  const [currentTest, setCurrentTest] = useState<ClashTestData | null>(null)

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
            <span>主代理分组：{data.group}</span>
            <span>当前节点：{data.currentNode ?? '未选择'}</span>
            {paceTag}
            {data.auto.allDown && <Tag color="red">全网不可用</Tag>}
            {data.anyRunning && <Tag>任务运行中</Tag>}
          </Space>
        }
        description={data.mixedPort ? `窗口代理应填 127.0.0.1:${data.mixedPort}（实测混合口）` : undefined}
      />

      <Space wrap>
        <Button
          icon={<ReloadOutlined />}
          loading={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (res) => {
                setCurrentTest(res)
                setNodes(null)
              },
            })
          }
        >
          立即测速
        </Button>
        <Popconfirm
          title="确定选优并切换？"
          description={data.anyRunning ? '有任务正在运行，切换节点会更换 IP，可能中断签到会话' : '将切换到当前最优节点'}
          onConfirm={() =>
            optimize.mutate(undefined, {
              onSuccess: (res) => {
                setNodes(res.nodes)
                setCurrentTest(null)
              },
            })
          }
          okText="确定"
          cancelText="取消"
        >
          <Button type="primary" icon={<ThunderboltOutlined />} loading={optimize.isPending}>
            选优并切换
          </Button>
        </Popconfirm>
      </Space>

      {currentTest && currentTest.node && (
        <Typography.Text type="secondary">
          当前节点 {currentTest.node.name} 测速：
          {currentTest.node.urls.map((u) => `${u.url}: ${u.reachable ? `${u.delayMs}ms` : '超时'}`).join(' ｜ ')}
        </Typography.Text>
      )}
      {currentTest && !currentTest.node && (
        <Typography.Text type="warning">
          {currentTest.currentNode ? `当前节点 ${currentTest.currentNode} 不可测（直连或未选择节点）` : '当前无可测节点'}
        </Typography.Text>
      )}

      {summary && (
        <Typography.Text type="secondary">
          测速结果：{nodes?.length} 个节点，{summary.usableCount} 个可用、{summary.downCount} 个不可用
          {summary.best && `，最优 ${summary.best.name}（${Math.round(summary.best.score)}）`}
        </Typography.Text>
      )}
      {nodes && <Table rowKey="name" size="small" columns={columns} dataSource={nodes} pagination={false} />}
    </Space>
  )
}
```

- [ ] **Step 2: typecheck + 前端单测验证**

Run: `npm run typecheck` 然后 `npm run test:web`
Expected: typecheck 0 error，前端单测全部 PASS。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/tools/clash.tsx
git commit -m "feat: 代理网络面板去分组下拉，立即测速展示单节点"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md`

- [ ] **Step 1: 更新 8.3 REST 总表**

8.3 表（约第 1140-1143 行）把 `clash/status`、`clash/test` 行更新、删除 `clash/group` 行：

```md
| GET | `/api/tools/clash/status` | 代理网络状态（客户端探测/主代理分组/当前节点/delay 能力/自动检测状态/任务在途标记） |
| POST | `/api/tools/clash/test` | 当前节点测速（只测当前节点） |
| POST | `/api/tools/clash/optimize` | 测速选优并切换（在主代理分组内选优） |
```

（删除原 `| POST | /api/tools/clash/group | 设置目标分组（写回 config.json 的 clash.group） |` 行。）

- [ ] **Step 2: 更新第 11 章「代理网络（Clash 工具）」**

第 11 章「代理网络（Clash 工具）」小节（约第 1601-1612 行）的面板操作说明，把「分组下拉（未配置 group 时从 Clash 实时拉取，选择后自动写回 config.json）」与「立即测速只读测一遍（节点表格展示每 URL 延迟/得分/可用）」替换为：

```md
**面板操作**：顶部状态条显示内核类型/主代理分组/当前节点/检测节奏/全网可用性/任务运行中标记与实测混合口；「立即测速」只测当前节点（显示各 URL 延迟）；「选优并切换」在主代理分组（clash.group，默认「🔰 节点选择」）内测全部候选节点后切到最优节点（任务在途时会弹确认提示，因为换 IP 可能中断签到会话）。
```

- [ ] **Step 3: 更新 8.1 配置表 clash 段与 config 默认值说明**

8.1 配置表 `clash` 行（约第 1094 行）里 `group` 的说明「目标分组（留空时面板下拉选，选择后自动写回本文件）」改为「主代理分组（读当前节点与选优的锚点，默认 `🔰 节点选择`；面板不再提供分组下拉，需改时手改本文件）」。

- [ ] **Step 4: Commit**

```bash
git add docs/API-GUIDE.md
git commit -m "docs: 代理网络工具节点中心化说明同步（去分组下拉/立即测速测当前节点）"
```

---

## 验证清单（全部任务完成后）

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（含 clash-optimizer/clash-auto-optimizer/clash-route/clash-config 改动）
- [ ] `npm run test:web` 通过（含 hooks.test.tsx 改动）
- [ ] `npm run dev` 面板人工验收：代理网络面板无分组下拉，当前节点显示「极速 专线 香港 01」，立即测速显示单节点延迟（需本机 Clash 在跑）

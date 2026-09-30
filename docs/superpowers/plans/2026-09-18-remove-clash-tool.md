# 移除「代理网络」（Clash）工具实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工具中心「代理网络」（Clash）工具整套删除——后端 `src/tools/clash/` 目录、路由、装配、配置、错误码，前端面板/类型/API/hooks，6 个测试文件与文档。

**Architecture:** 纯删除任务。按依赖方向自底向上删：先删 `src/tools/clash/`（源码根），再删引用它的 config/路由/装配，再删前端，最后删文档。每步以 typecheck/测试确认无残留引用。

**Tech Stack:** Node + Express 5 + TS 严格模式；React 18 + antd 5 + react-query；vitest。

## Global Constraints

- 无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块；commit 用中文 conventional 前缀（`chore:`/`refactor:`/`docs:` 用于删除，中文描述）。
- 删除后必须无残留引用：`npm run typecheck` 0 error。
- 保留 `src/engine/queue.ts` 的 `anyRunning()`（非 clash 专用）；保留 `src/tools/errors.ts` 的其它错误码（file-assign 域）；保留历史 spec/plan 文档。
- `web/src/api/schema.d.ts` 为生成文件不改（本计划不涉及它，手补类型在 `web/src/types.ts`）。
- 每次改完跑 `npm run typecheck`、`npm test`、`npm run test:web` 全过。
- 文档同步（硬性要求）：`docs/API-GUIDE.md`。

---

### Task 1: 删除 tools/clash 源码目录与错误码

**Files:**
- Delete: `src/tools/clash/` 整个目录（`adapter.ts`、`optimizer.ts`、`auto-optimizer.ts`、`client-detector.ts`、`types.ts`）
- Modify: `src/tools/errors.ts`（删 4 个 clash 错误码）
- Modify: `src/server/http/errors.ts`（删 4 个 `CLASH_*` 常量）
- Modify: `src/tools/index.ts`（删 TOOLS 的 clash 项）

**Interfaces:**
- Consumes: 无
- Produces: 无（删除项）；`TOOL_ERROR_CODES` 删后仅剩 file-assign 域错误码

- [ ] **Step 1: 删除 clash 目录**

Run: `Remove-Item -Recurse -Force "src\tools\clash"`
Expected: 目录删除成功。

- [ ] **Step 2: 删 `src/tools/errors.ts` 的 clash 错误码**

将第 18-21、26-29 行的 `CLASH_AUTH_FAILED` / `CLASH_GROUP_NOT_FOUND` / `CLASH_API_FAILED` / `CLASH_SWITCH_FAILED` 四个条目删除。删除后 `TOOL_ERROR_CODES` 应为：

```ts
export const TOOL_ERROR_CODES = {
  /** 400：源文件夹不存在或不是目录 */
  TOOL_DIR_NOT_FOUND: 40001,
  /** 400：目标列在 accounts.xlsx 中不存在 */
  TOOL_COLUMN_NOT_FOUND: 40002,
  /** 400：文件数少于账号行数 */
  TOOL_FILES_INSUFFICIENT: 40003,
  /** 400：名称模板无效（生成串为空/个数越界/插入参数缺失） */
  TOOL_TEMPLATE_INVALID: 40004,
  /** 400：执行阶段回传计划校验失败（文件变动/行数不一致等） */
  TOOL_PLAN_INVALID: 40005,
  /** 409：上一次执行进行中 */
  TOOL_BUSY: 40904,
  /** 500：磁盘 IO 失败（重命名/写回 xlsx） */
  TOOL_IO_FAILED: 50001,
} as const
```

- [ ] **Step 3: 删 `src/server/http/errors.ts` 的 clash 常量**

将 `CLASH_AUTH_FAILED: 40007,`、`CLASH_GROUP_NOT_FOUND: 40008,`、`CLASH_API_FAILED: 50002,`、`CLASH_SWITCH_FAILED: 50004,` 四行删除。

- [ ] **Step 4: 删 `src/tools/index.ts` 的 clash 项**

将 TOOLS 数组里的 `{ key: 'clash', ... }` 对象删除，仅保留 file-assign：

```ts
export const TOOLS: ToolMeta[] = [
  {
    key: 'file-assign',
    name: '文件随机分配',
    description: '按名称模板重命名指定文件夹内的文件，随机分配给 accounts.xlsx 各账号行并写回目标列',
  },
]
```

- [ ] **Step 5: typecheck 确认**

Run: `npm run typecheck`
Expected: 报大量错误（引用已删目录的文件报错：config.ts / routes/tools.ts / server/app.ts / app.ts），这证明删除点已定位，属 Task 2/3 待处理，非本任务缺陷。本任务本身无新引入错误。

- [ ] **Step 6: Commit**

```bash
git add -A src/tools/clash src/tools/errors.ts src/server/http/errors.ts src/tools/index.ts
git commit -m "chore: 删除 clash 工具源码目录与错误码"
```

---

### Task 2: 删除后端装配与配置

**Files:**
- Modify: `src/app.ts`（删 import、clashAdapter/clashService/clashAuto 装配、createApp clash 传参、clashAuto.stop()）
- Modify: `src/server/app.ts`（删 ServerDeps.clash 字段、toolsRouter clash 传参）
- Modify: `src/infrastructure/config.ts`（删 ClashConfig/ClashAutoCheckConfig 接口、AppConfig.clash 字段、默认值 clash 段）
- Modify: `config/config.json`（删 clash 段）
- Modify: `src/server/routes/tools.ts`（删 clash swagger、ClashRouteDeps、3 端点、clashGuard、import）

**Interfaces:**
- Consumes: 无
- Produces: 无（删除项）；`toolsRouter` 签名去掉 `clash` 参数，`ServerDeps` 去掉 `clash` 字段

- [ ] **Step 1: 删 `src/app.ts` 装配**

- 删 import 行 26-28：

```ts
import { ClashAdapter } from './tools/clash/adapter'
import { ClashService } from './tools/clash/optimizer'
import { AutoOptimizer } from './tools/clash/auto-optimizer'
```

- 删装配块（第 222-233 行，从 `// 代理网络工具（tools/clash）...` 到 `if (cfg.clash.enabled ...) clashAuto.start()`）：

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

- 删 `createApp({...})` 里的 clash 对象（第 251-254 行）：

```ts
    clash: {
      service: clashService,
      auto: clashAuto,
      anyRunning: () => enqueuer.anyRunning(),
    },
```

- 删 `shutdown()` 里的 `clashAuto.stop()`（第 313 行）。

- [ ] **Step 2: 删 `src/server/app.ts`**

- 删 ServerDeps 里的 clash 字段（第 56-61 行）：

```ts
  /** 代理网络工具（tools/clash）：服务/自动检测/在途判定 */
  clash: {
    service: import('../tools/clash/optimizer').ClashService
    auto: import('../tools/clash/auto-optimizer').AutoOptimizer
    anyRunning(): boolean
  }
```

- 删 `toolsRouter({...})` 传参里的 `clash: deps.clash`（第 84 行），改为：

```ts
  api.use(toolsRouter({ xlsxPath: deps.cfg.dataSource.path, datasource: deps.datasource, fileAssignService: deps.fileAssignService }))
```

- [ ] **Step 3: 删 `src/infrastructure/config.ts`**

- 删 `ClashAutoCheckConfig` 接口（第 92-100 行）与 `ClashConfig` 接口（第 102-126 行）。
- 删 `AppConfig` 里的 `clash: ClashConfig`（第 138 行）。
- 删默认值里的 clash 段（第 193-209 行，从 `// Clash 代理网络工具：探测/测速/选优/定时检测` 到 `autoCheck: {...}`）。

- [ ] **Step 4: 删 `config/config.json` 的 clash 段**

删除第 35-57 行的 `"clash": { ... }` 整段（含前后逗号处理，保持 JSON 合法）。

- [ ] **Step 5: 删 `src/server/routes/tools.ts`**

- 删 import 行 14（`ClashTestResult, CurrentNodeTestResult, OptimizeResult, AutoOptimizerStatus`）；若 `Response` 仅 clashGuard 用，一并删除（grep 确认，file-assign 的 fail 里没用到 `Response` 类型则删）。
- 删 3 个 swagger 注解块（第 99-181 行：`/api/tools/clash/status`、`/api/tools/clash/test`、`/api/tools/clash/optimize`）。
- 删 `ClashRouteDeps` 接口（第 183-200 行）。
- 删 `toolsRouter` 签名里的 `clash: ClashRouteDeps`（第 205 行）。
- 删 `clashGuard` 辅助（第 262-269 行）。
- 删 3 个端点（第 271-294 行：`/tools/clash/status`、`/tools/clash/test`、`/tools/clash/optimize`）。

- [ ] **Step 6: typecheck + 后端测试确认**

Run: `npm run typecheck` 然后 `npm test`
Expected: typecheck 0 error（后端源码无 clash 引用）。`npm test` 会因 6 个 clash 测试文件 import 已删源码而失败——这是 Task 4 待处理的，本任务跑 typecheck 确认源码干净即可；`npm test` 的失败点应为 clash 测试文件本身。

- [ ] **Step 7: Commit**

```bash
git add src/app.ts src/server/app.ts src/infrastructure/config.ts config/config.json src/server/routes/tools.ts
git commit -m "refactor: 移除 clash 后端装配、配置与路由"
```

---

### Task 3: 删除前端源码

**Files:**
- Delete: `web/src/pages/tools/clash.tsx`
- Modify: `web/src/pages/tools/index.tsx`（删 ClashPanel import、TOOL_ICONS.clash、TOOL_PANELS.clash、GlobalOutlined）
- Modify: `web/src/pages/tools/hooks.ts`（删 useClashStatus/useClashTest/useClashOptimize/summarizeNodes + import）
- Modify: `web/src/api/endpoints.ts`（删 fetchClashStatus/testClash/optimizeClash + 类型 import）
- Modify: `web/src/types.ts`（删 5 个 Clash 类型）

**Interfaces:**
- Consumes: 无
- Produces: 无（删除项）

- [ ] **Step 1: 删 `web/src/pages/tools/clash.tsx`**

Run: `Remove-Item "web\src\pages\tools\clash.tsx"`

- [ ] **Step 2: 改 `web/src/pages/tools/index.tsx`**

- 删 import 行 7（`import ClashPanel from './clash'`）。
- 删 `TOOL_ICONS` 里的 `clash` 行（第 12 行），删 `TOOL_PANELS` 里的 `clash` 行（第 18 行）。
- 删 antd icons import 里的 `GlobalOutlined`（第 4 行，若不再使用）：

```ts
import { SwapOutlined, ToolOutlined } from '@ant-design/icons'
```

- [ ] **Step 3: 改 `web/src/pages/tools/hooks.ts`**

- import 行 3 改为：

```ts
import { applyFileAssign, fetchTools, previewFileAssign } from '../../api/endpoints'
```

- import 行 5 改为：

```ts
import type { FileAssignTemplate, FileAssignRow } from '../../types'
```

- 删「===== 代理网络工具 =====」整段（第 41-83 行，含 `useClashStatus`/`useClashTest`/`useClashOptimize`/`summarizeNodes`）。

- [ ] **Step 4: 改 `web/src/api/endpoints.ts`**

- import 行 2 删 `ClashStatusData, ClashTestData, ClashOptimizeResult` 三个类型名。
- 删「===== 代理网络工具 =====」段（第 36-40 行，含 `fetchClashStatus`/`testClash`/`optimizeClash`/`setClashGroup`）。

- [ ] **Step 5: 改 `web/src/types.ts`**

删「===== 代理网络工具...=====」段（第 108-147 行，含 `ClashUrlDelay`/`ClashNodeResult`/`ClashTestData`/`ClashOptimizeResult`/`ClashStatusData` 5 个类型）。

- [ ] **Step 6: typecheck 确认**

Run: `npm run typecheck`
Expected: 0 error（前端源码无 clash 引用；`web/src/pages/tools/hooks.test.tsx` 的 clash mock 属 Task 4 待处理，但它不影响后端 typecheck；若项目 typecheck 覆盖 web，报错点应在 hooks.test.tsx）。

- [ ] **Step 7: Commit**

```bash
git add -A web/src/pages/tools web/src/api/endpoints.ts web/src/types.ts
git commit -m "refactor: 移除代理网络前端面板、类型与 hooks"
```

---

### Task 4: 删除测试

**Files:**
- Delete: `tests/clash-adapter.test.ts`、`tests/clash-auto-optimizer.test.ts`、`tests/clash-config.test.ts`、`tests/clash-detector.test.ts`、`tests/clash-optimizer.test.ts`、`tests/clash-route.test.ts`
- Modify: `tests/tools-route.test.ts`（删 clash mock + toolsRouter clash 传参）
- Modify: `web/src/pages/tools/hooks.test.tsx`（删 clash mock、useClashStatus/useClashOptimize/summarizeNodes 用例与 import）

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 删 6 个 clash 测试文件**

Run: `Remove-Item tests\clash-adapter.test.ts, tests\clash-auto-optimizer.test.ts, tests\clash-config.test.ts, tests\clash-detector.test.ts, tests\clash-optimizer.test.ts, tests\clash-route.test.ts`

- [ ] **Step 2: 改 `tests/tools-route.test.ts`**

删 `makeApp` 里的 clash mock 对象（第 21-29 行）与 `toolsRouter` 传参里的 `clash`（第 29 行），改为：

```ts
  app.use('/api', toolsRouter({ xlsxPath, datasource: { reload, summary }, fileAssignService: new FileAssignService() }))
```

- [ ] **Step 3: 改 `web/src/pages/tools/hooks.test.tsx`**

- import 行 5 改为（删 `summarizeNodes, useClashStatus, useClashOptimize`）：

```ts
import { buildTemplate, sampleName, useFileAssignApply } from './hooks'
```

- 删 `vi.mock('../../api/endpoints', ...)` 里的 `fetchClashStatus`/`testClash`/`optimizeClash` mock（第 10-16 行），仅保留 `applyFileAssign`：

```ts
vi.mock('../../api/endpoints', () => ({
  applyFileAssign: vi.fn().mockResolvedValue({ renamedCount: 2, updatedRows: 2, reloadedRows: 2 }),
}))
```

- 删 `describe('summarizeNodes', ...)`（第 92-105 行）、`describe('useClashStatus', ...)`（第 107-115 行）、`describe('useClashOptimize', ...)`（第 117-131 行）。

- [ ] **Step 4: 全量测试 + typecheck 确认**

Run: `npm run typecheck` 然后 `npm test` 然后 `npm run test:web`
Expected: 三者全过（typecheck 0 error，后端测试无 clash 残留，前端测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add -A tests web/src/pages/tools/hooks.test.tsx
git commit -m "chore: 删除 clash 相关测试"
```

---

### Task 5: 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md`

- [ ] **Step 1: 删 8.1 配置表 clash 行**

删除 8.1 配置表（约第 1094 行）的 `| `clash` | ... |` 整行。

- [ ] **Step 2: 改 8.2 工具页描述**

第 1104 行的「目前两个工具——「文件随机分配」与「代理网络」，点卡片展开对应工具面板，用法见第 11 章」改为：

```md
- **工具页**：工具卡片中心（卡片数据来自 `GET /api/tools`，随需扩展），目前一个工具——「文件随机分配」，点卡片展开对应工具面板，用法见[第 11 章](#11-工具中心)。
```

- [ ] **Step 3: 删 8.3 REST 表 clash 行**

删除 8.3 表（约第 1140-1142 行）的 `/api/tools/clash/status`、`/api/tools/clash/test`、`/api/tools/clash/optimize` 三行。

- [ ] **Step 4: 删第 11 章 clash 内容**

- 第 1590 行「目前两个工具：文件随机分配、代理网络」改为「目前一个工具：文件随机分配」。
- 删除「### 代理网络（Clash 工具）」整节（第 1600-1617 行）与「### 在不同 Clash 客户端开启外部控制」整节（第 1619-1650 行），到「## 12. 验证码」之前。

- [ ] **Step 5: Commit**

```bash
git add docs/API-GUIDE.md
git commit -m "docs: 移除代理网络工具文档"
```

---

## 验证清单（全部任务完成后）

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（删除 clash 用例后全量仍绿）
- [ ] `npm run test:web` 通过
- [ ] `npm run dev` 面板验收：工具中心只剩「文件随机分配」一个卡片，无「代理网络」

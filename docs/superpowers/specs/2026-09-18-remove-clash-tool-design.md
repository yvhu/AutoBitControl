# 移除「代理网络」（Clash）工具

日期：2026-09-18
状态：已确认（用户决定：工具中心「代理网络」相关全部删除）

## 背景与目标

工具中心里的「代理网络」（Clash）工具经历两次改版（分组中心 → 节点中心），最终用户判断其设计本身有问题：系统用「测 Google/gstatic 延迟」判断网络好坏、与任务实际访问的 Web3 站点不相干，且与 Clash 客户端自带的自动切换能力重叠甚至冲突。结论：**整个工具连同后端服务、定时自动切换、前端面板、配置、错误码、文档全部移除**，切换节点交给 Clash 客户端自己。

## 决策记录

- 删除范围：工具**全部能力**（探测/测速/选优/自动切换/当前节点展示），不留只读展示。面板工具中心只保留「文件随机分配」。
- `queue.anyRunning()` 本身不删（它还用于其它守卫逻辑），只删 clash 传进去的引用。
- 历史设计文档 `docs/superpowers/specs/2026-09-08-clash-network-tool-design.md`、`2026-09-17-clash-node-centric-redesign.md` 与对应 plans 保留留档（不删，属历史记录）。

## 删除清单

### 后端源码

| 文件 | 操作 |
|---|---|
| `src/tools/clash/` 目录（adapter.ts / optimizer.ts / auto-optimizer.ts / client-detector.ts / types.ts） | 整个目录删除 |
| `src/tools/index.ts` | 删 TOOLS 里的 `clash` 项 |
| `src/tools/errors.ts` | 删 `CLASH_AUTH_FAILED` / `CLASH_GROUP_NOT_FOUND` / `CLASH_API_FAILED` / `CLASH_SWITCH_FAILED` 4 个错误码 |
| `src/server/http/errors.ts` | 删对应的 4 个 `CLASH_*` 错误码常量 |
| `src/server/routes/tools.ts` | 删 3 个 clash swagger 注解、`ClashRouteDeps` 类型、3 个 `/tools/clash/*` 端点、`clashGuard` 辅助、`clash` 依赖参数与 import |
| `src/server/app.ts` | 删 `ServerDeps.clash` 字段 + `toolsRouter({... clash})` 传参 |
| `src/app.ts` | 删 3 个 import、clashAdapter/clashService/clashAuto 装配块、`createApp({...clash})` 传参、`clashAuto.stop()` |
| `src/infrastructure/config.ts` | 删 `ClashConfig` / `ClashAutoCheckConfig` 接口、`AppConfig.clash` 字段、默认值 `clash` 段 |

### 配置

| 文件 | 操作 |
|---|---|
| `config/config.json` | 删 `"clash": {...}` 段（第 35-57 行） |

### 前端源码

| 文件 | 操作 |
|---|---|
| `web/src/pages/tools/clash.tsx` | 整个文件删除 |
| `web/src/pages/tools/index.tsx` | 删 `ClashPanel` import、`TOOL_ICONS.clash`、`TOOL_PANELS.clash`、`GlobalOutlined` 图标 import（若不再使用） |
| `web/src/pages/tools/hooks.ts` | 删 `useClashStatus` / `useClashTest` / `useClashOptimize` / `summarizeNodes` + clash 相关 import |
| `web/src/api/endpoints.ts` | 删 `fetchClashStatus` / `testClash` / `optimizeClash` + 类型 import |
| `web/src/types.ts` | 删 `ClashUrlDelay` / `ClashNodeResult` / `ClashTestData` / `ClashOptimizeResult` / `ClashStatusData` 5 个类型 |

### 测试

| 文件 | 操作 |
|---|---|
| `tests/clash-adapter.test.ts` / `clash-auto-optimizer.test.ts` / `clash-config.test.ts` / `clash-detector.test.ts` / `clash-optimizer.test.ts` / `clash-route.test.ts` | 整文件删除（6 个） |
| `tests/tools-route.test.ts` | 删 `clash` mock 对象 + `toolsRouter` 的 `clash` 传参 |
| `web/src/pages/tools/hooks.test.tsx` | 删 clash 相关 mock、`useClashStatus` / `useClashOptimize` / `summarizeNodes` 用例与 import |

### 文档

| 文件 | 操作 |
|---|---|
| `docs/API-GUIDE.md` | 8.1 配置表删 `clash` 行；8.2 工具页「目前两个工具」改「目前一个工具（文件随机分配）」；8.3 REST 总表删 3 个 clash 行；第 11 章删「代理网络（Clash 工具）」整节、「在不同 Clash 客户端开启外部控制」整节，并顺带清理该章剩余部分的 clash 引用（排错项等） |

## 范围外

- `src/engine/queue.ts` 的 `anyRunning()` 方法（保留，非 clash 专用）
- 历史 spec/plan 文档（留档）
- 面板其它页面（看板/任务/定时/设置）均不涉及 clash

## 验证

- `npm run typecheck` 0 error
- `npm test` 通过（删除 clash 用例后全量仍绿）
- `npm run test:web` 通过
- `npm run dev` 面板验收：工具中心只剩「文件随机分配」一个卡片，无「代理网络」

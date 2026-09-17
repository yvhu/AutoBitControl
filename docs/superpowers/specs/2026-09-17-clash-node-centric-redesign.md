# Clash 代理网络工具重设计（节点中心化）

日期：2026-09-17
状态：已确认（用户 3 轮问答对齐：去分组下拉、当前节点从「🔰 节点选择」读、立即测速测当前节点、选优在「🔰 节点选择」组内进行）

## 背景与问题

现有实现（2026-09-08 clash-network-tool）以「分组」为中心：面板有「目标分组」下拉（写回 `config.json` 的 `clash.group`），「当前节点」靠 `status()` 里 `groups.find(name === group)` 取 `now` 得出。用户实机反馈三个问题：

1. **「当前节点」显示「未选择」**：`config.json` 里 `clash.group` 配的是 `"AutoSelection"`，但用户的 Clash 客户端里根本没有这个名字的分组（实测 15 个分组：GLOBAL / Ⓜ️ 微软服务 / ♻️ 自动选择 / ⛔️ 广告拦截 / ✈ Steam / 🌍 tiktok / 🌍 国外媒体 / 🌏 ChatGPT/Claude / 🌏 国内媒体 / 🍎 苹果服务 / 🎥 NETFLIX / 🎯 全球直连 / 📲 电报信息 / 🔰 节点选择 / 🛑 全球拦截）。`find` 不到 → 返回 `null` → 面板显示「未选择」。
2. **「立即测速」测的不是当前节点**：现有 `test()` 测的是「目标分组内**所有节点**」，与「当前节点」无关，用户认为不合理。
3. **分组下拉本身多余**：分组是 Clash 内部概念，用户要的是「节点」视角，切换由「选优并切换」或去 Clash 客户端手动完成，不需要在面板选分组。

## 目标

把「代理网络」工具从「分组中心」改为「节点中心」：

- 状态条「当前节点」直接显示主代理分组的当前选中节点，不再依赖用户手配的分组名去匹配。
- 「立即测速」只测当前节点的速度。
- 「选优并切换」在主代理分组内测全部候选节点选最优切换。
- 去掉面板「目标分组」下拉；手动切节点去 Clash 客户端操作。

## 决策记录

- **主代理分组**：用户确认其 Clash 顶部「当前节点」来自「🔰 节点选择」分组（当前 `极速 专线 香港 01`）。该分组名写入配置，作为后台工作分组，面板不再暴露选择入口。
- **`clash.group` 语义变化**：从「面板可选的业务分组」变为「后台工作分组（选优/读当前节点的锚点）」，默认值改为 `"🔰 节点选择"`。现有 `config.json` 的 `"AutoSelection"` 是失效历史值，一并修正。
- **去掉的能力**：`GET /api/tools/clash/status` 的 `groups` 字段、`POST /api/tools/clash/group` 端点、前端 `useClashSetGroup`、面板分组下拉 `Select`，以及 `updateConfigFile` 的「写回 group」入口（`app.ts` 的 `saveGroup` 闭包）。
- **立即测速**：`POST /api/tools/clash/test` 语义改为「只测当前节点」，返回单个节点的延迟/可达，不再遍历组内全部节点。

## 数据模型与接口

### 配置（config/config.json）

```json
"clash": {
  "group": "🔰 节点选择",
  ...
}
```

- `group` 语义：主代理分组名（Clash `/proxies` 里承载手动节点的 Selector 组），用于「当前节点」展示与「选优并切换」的候选范围。
- 若配置的分组在 `/proxies` 中不存在，`status()` 的 `currentNode` 仍返回 `null`（行为与现在一致），但这次默认值正确，且用户可在 `config.json` 改回自己的分组名。

### 后端

**`ClashService.status()`**（`src/tools/clash/optimizer.ts`）

- 移除返回字段 `groups`；保留 `detected / kernel / mixedPort / apiBase / delaySupported / group / currentNode`。
- `currentNode`：`groups.find(name === groupName)?.now ?? null`（逻辑不变，只是不再对外返回分组列表）。
- `group` 仍返回（面板状态条可显示「主代理分组」，帮助用户理解节点来源）。

**`ClashService.test()`**（新增「测当前节点」语义）

- 不再遍历组内全部节点测速；改为：
  1. `resolveGroup()` 取工作分组 → 得 `now`（当前节点名）。
  2. 若 `now` 为空、或为 `DIRECT/REJECT/PASS`（直连/拦截/兜底，无可测意义），返回 `{ group, currentNode: now, currentUsable: false, node: null }`（前端提示「当前节点不可测：直连或未选择节点」）。
  3. 对 `now` 这一个节点，按 `testUrls` 逐个调 `delay`，用 `scoreNode` 评分。
  4. 返回 `{ group, currentNode: now, currentUsable, node: { name, urls, score, usable } }`。
- 返回结构从 `ClashTestResult`（含 `nodes: NodeTestResult[]`）改为单节点形态。**影响 `optimize()` 与自动检测**：两者仍需要「组内全节点测速选优」，故原 `testInner` 改名为私有 `testGroup()`（返回旧的全节点 `ClashTestResult`），`optimize(prev)` 与 `AutoOptimizer.tick()` 改调 `testGroup()`；公开 `test()` 变成「测当前节点」的新语义与结构。

**`ClashService.optimize()`**

- 保留原有「组内全节点测速选优切换」逻辑（原 `testInner` 迁到私有 `testGroup`，`optimize` 与自动检测复用 `testGroup`）。
- `resolveGroup()` 现在固定返回配置的 `group`（工作分组），找不到抛 `CLASH_GROUP_NOT_FOUND`（行为不变）。

**`POST /api/tools/clash/test` 路由**

- 调 `service.test()`，返回单节点测速结果（新结构）。

**`POST /api/tools/clash/group` 路由与 `updateConfigFile` 写回**

- 删除 `/tools/clash/group` 端点、`app.ts` 的 `saveGroup` 闭包、`ClashService.setGroup()` 与 `groupOverride` 字段、`config.ts` 的 `updateConfigFile`（已确认全仓库仅 `app.ts` 的 `saveGroup` 调用它，删除后无调用方，一并删除）。

### 前端

**`web/src/pages/tools/clash.tsx`**

- 移除分组下拉 `Select` 与 `useClashSetGroup`。
- 状态条保留：内核 / 当前节点 / 节奏 / 全网可用 / 任务运行中；可选加「主代理分组」小字。
- 「立即测速」：调 `useClashTest`（改接口），测完显示当前节点延迟明细（单节点），替换原来的节点表格。
- 「选优并切换」：保留 `useClashOptimize`，测速结果表格展示组内候选节点（`optimize` 仍返回 `nodes` 数组）。
- 移除 `ClashUrlDelay` 表格列中不适用部分，适配新 `test` 返回结构。

**hooks（`web/src/pages/tools/hooks.ts`）**

- 删除 `useClashSetGroup`。
- `useClashTest` 适配新返回结构（消息文案改「当前节点 xxx：xx ms / 不可达」）。

## 改动清单

| 文件 | 改动 |
|---|---|
| `config/config.json` | `clash.group` → `"🔰 节点选择"` |
| `src/infrastructure/config.ts` | `clash.group` 默认值 `''` → `'🔰 节点选择'`；删除 `updateConfigFile`（无调用方） |
| `src/tools/clash/optimizer.ts` | 删 `groupOverride`/`setGroup`；`test()` 改测当前节点；原全节点测速迁 `testGroup`；`optimize()` 复用 `testGroup`；`status()` 删 `groups` |
| `src/tools/clash/auto-optimizer.ts` | `tick()` 里 `service.test()` 改调 `service.testGroup()`（自动检测仍需全节点选优，不受「立即测速测当前节点」影响） |
| `src/tools/clash/types.ts` | `ClashTestResult` 改为单节点形态（或新增 `CurrentNodeTestResult`），`NodeTestResult` 保留供 optimize |
| `src/server/routes/tools.ts` | 删 `/tools/clash/group`；`status`/`test` swagger 与 deps 签名同步；`ClashRouteDeps` 删 `setGroup`/`saveGroup` |
| `src/app.ts` | 删 `saveGroup` 闭包 |
| `web/src/pages/tools/clash.tsx` | 删分组下拉；适配 `test` 单节点结果展示 |
| `web/src/pages/tools/hooks.ts` | 删 `useClashSetGroup`；适配 `useClashTest` |
| `web/src/types.ts` | 手补 `ClashStatusData` 删 `groups`；`ClashTestData` 改单节点形态 |
| `web/src/api/endpoints.ts` | 删 `setClashGroup` |
| `docs/API-GUIDE.md` | 8.2 工具页、8.3 REST 表、第 11 章代理网络小节同步 |

## 测试

- `tests/clash-optimizer.test.ts`：`test()` 改为测当前节点（now 节点评分、now 为空/DIRECT 分支）；`optimize()` 仍全节点选优（原用例迁移）；删 `setGroup` 相关用例。
- `tests/clash-route.test.ts`：删 `/tools/clash/group` 用例；`status` 断言删 `groups`；`test` 断言适配新结构。
- `tests/clash-auto-optimizer.test.ts`：自动检测复用 `testGroup`，断言不回归。
- `web/src/pages/tools/hooks.test.tsx`：删 `setClashGroup` mock；`fetchClashStatus` mock 删 `groups`；`testClash` mock 改单节点。
- 全量：`npm run typecheck`、`npm test`、`npm run test:web`。

## 范围外

- 数据源路径修改（用户明确暂不处理）。
- 面板手动指定节点切换（用户明确去掉，手动切去 Clash 客户端）。
- 「选优并切换」的候选范围扩展为「全部分组去重节点」（用户明确保持「🔰 节点选择」组内选优）。
- 分组列表展示（已去掉）。

# 窗口页批量操作设计

日期：2026-09-17
状态：已确认（用户在线 mockup 确认：行多选 + 顶部批量工具条 + 新增 `/api/profiles/batch` 后端端点）

## 目标

窗口页（profiles）在现有「单窗口操作列」之外，提供**批量操作**：一次选中多个窗口，批量打开 / 批量关闭 / 复制 ID / 重置熔断。降低窗口量大时的重复点击成本。

## 决策记录

- 交互形态：**antd Table 行多选（rowSelection）+ 顶部工具条 4 个批量按钮**（用户在线 mockup 确认）
- 后端实现：**新增 `POST /api/profiles/batch` 端点**，后端统一循环 + 逐项结果（用户选择，弃「前端循环复用单窗口端点」方案）
- 复制 ID：**纯前端**，join 选中窗口 bitbrowserId 写入剪贴板，不走后端（无需后端能力）
- 范围：仅窗口页；操作列单个「打开/关闭」「复制ID」「重置熔断」保持现状不变

## 后端改动

### 1. 新端点 `POST /api/profiles/batch`

`src/server/routes/profiles.ts` 新增（放在 `profilesRouter` 内，与现有 `find` 辅助同域）：

- 请求体：`{ action: 'open' | 'close' | 'resetBreaker', ids: number[] }`
  - `action` 非法 / `ids` 非空数组 → 400（`ERROR_CODES.INVALID_ARGUMENT`）
- 处理：按 `ids` 顺序循环，逐项复用现有单窗口逻辑，**逐项 try/catch**（一项失败不影响其余）：
  - `open`：复用现有 `/open` 的判定链（登记 + `isOpen` → already 跳过；否则 `openBrowser` + `setOpenWindow`）
  - `close`：复用现有 `/close`（`closeBrowser` catch 兜底 + `clearOpenWindow`）
  - `resetBreaker`：`db.resetCircuitBreaker`
- 响应：`{ total, succeeded, failed: Array<{ id: number; error: string }> }`
  - `total` = ids 长度；`succeeded` = 成功数；`failed` 逐项带窗口 id 与错误 message
- 内部抽 `find(id)` 复用现有 404 语义（单项不存在记入 failed，不整体 404）

### 2. @swagger 注解

`profiles.ts` 头部补 `POST /api/profiles/batch` 注解（summary、requestBody schema、200 响应 schema），与 openapi.ts 聚合保持一致。

## 前端改动

### 3. API 层（web/src/api/endpoints.ts）

```ts
export const batchProfiles = (action: 'open' | 'close' | 'resetBreaker', ids: number[]) =>
  post<{ total: number; succeeded: number; failed: Array<{ id: number; error: string }> }>('/api/profiles/batch', { action, ids })
```

### 4. 类型（web/src/types.ts 手补，不跑 openapi-typescript）

```ts
export type ProfileBatchAction = 'open' | 'close' | 'resetBreaker'
export interface ProfileBatchResult { total: number; succeeded: number; failed: Array<{ id: number; error: string }> }
```

### 5. 页面（web/src/pages/profiles/index.tsx）

- `useState<React.Key[]>([])` 承载选中行；Table 加 `rowSelection={{ selectedRowKeys, onChange }}`（rowKey 沿用 `(p) => p.id`）
- 顶部卡片右侧新增批量工具条（`Space` 组件）：
  - 「已选 N 个窗口」徽标（未选中时显示「已选 0 个窗口」或隐藏）
  - 4 个按钮：**批量打开 / 批量关闭 / 复制 ID / 重置熔断**，未选中时 `disabled`
- 批量打开 / 批量关闭 / 重置熔断：调 `useBatchProfiles` mutation → 成功后 `message.success('成功 X，失败 Y')`，`failed` 非空时追加 `message.warning` 列出失败窗口与原因（多则截断）
- 复制 ID：`navigator.clipboard.writeText(选中窗口 bitbrowserId 换行 join)`，成功 `message.success('已复制 N 个窗口ID')`（纯前端，不走 mutation）
- 操作列保持现状（单个打开/关闭切换、复制ID、重置熔断均不动）

### 6. hooks（web/src/pages/profiles/hooks.ts）

- 新增 `useBatchProfiles()` mutation：`mutationFn` 调 `batchProfiles`，`onSuccess` invalidate `['profiles']` 并返回结果供页面弹 message；`onError` 复用 `errMsg`
- 新增纯函数 `joinBitbrowserIds(profiles: ProfileRow[], ids: React.Key[]): string[]`（按选中 id 取 bitbrowserId，供复制 ID 与批量按钮取值，配单测）

## 测试

- `tests/web.test.ts`（后端）：
  - `POST /api/profiles/batch` action=open：逐项调 openBrowser + setOpenWindow，返回 total/succeeded/failed
  - action=close：逐项调 closeBrowser + clearOpenWindow
  - action=resetBreaker：逐项调 resetCircuitBreaker
  - 单项目录不存在（db.find 抛 404）→ 该项记入 failed，其余继续，HTTP 仍 200
  - action 非法 / ids 为空 → 400
- `web/src/pages/profiles/hooks.test.ts`（前端）：`joinBitbrowserIds` 选中子集/空选/顺序保持
- `npm run typecheck`、`npm test`、`npm run test:web` 全过

## 文档同步（硬性要求）

- `docs/API-GUIDE.md` 8.2 面板使用「窗口页」小节补批量操作说明；8.3 REST 接口总表新增 `POST /api/profiles/batch` 行
- TASK-DEVELOPMENT-LESSONS 不涉及（非真机任务开发）

## 范围外

- 全选所有页（跨页全选）：只做当前页表头全选（受搜索过滤），跨页批量由用户翻页多选，YAGNI
- 批量启用/停用（Switch）：不在本次范围，用户未要求
- 批量结果明细弹窗：先以 message 汇总呈现，失败项多时截断提示；复杂明细弹窗留待需要时再加
- 批量打开错峰（stagger）：`open` 复用现有单窗口逻辑不接 engine 队列，逐个即时开窗；如日后需要打散起点再议

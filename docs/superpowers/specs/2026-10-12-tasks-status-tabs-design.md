# 任务页状态 Tab + 移除 deprecated 字段（设计）

日期：2026-10-12
状态：待用户复核
相关：`web/src/pages/tasks/`、`src/engine/task.ts`、`src/server/routes/tasks.ts`、`docs/API-GUIDE.md`

## 背景与问题

任务页 `/tasks` 现在把全部任务按**站点分组**（group.key，如 shelby/inception/portal/arc/example）折叠展示，所有任务混在一页。任务越来越多时，用户想快速只看到「正在启用」或「已停用」的任务，当前没有这样的视角。

同时发现 `TaskMeta.deprecated` 是**历史遗留的半死字段**：

- 引入时（commit `710f2af`）的用途是「调度器跳过失效任务」；
- 调度器重写后（commit `554fd08` 删除 cron/meta.schedule），当前 `src/engine/scheduler.ts` **完全不读 `deprecated`**；
- `git log -S "deprecated: true" -- src` **零记录**——从未有任何任务设置过它；
- 面板不可设置它，现在它仅剩「卡片置灰 + 显示『已失效』标签」这点外观作用。

## 目标

1. 任务页把任务按**启用状态**分 Tab：**已启用 / 已停用**，默认选中「已启用」，Tab 标签带数量。
2. 每个 Tab 内**保留现有站点分组折叠**结构，交互不变。
3. **彻底移除 `deprecated` 字段**（代码/类型/面板/文档），清理死代码。

## 非目标

- 不改后端任务数据来源（仍返回全量任务，前端分桶）。
- 不改 TaskCard 的开关/触发逻辑。
- 不引入 URL 记忆选中 Tab（保持简单）。
- 不动历史文档 `docs/superpowers/{specs,plans}/` 里对 deprecated 的记录（它们是历史留档）。

## 设计

### 1. 数据分桶（纯函数，放 `web/src/pages/tasks/hooks.ts`）

```ts
export type TaskBucket = 'enabled' | 'disabled'

/** 启用状态：显式 false 视为停用，其余（含 undefined）视为启用 */
export function taskBucket(t: TaskMetaView): TaskBucket {
  return t.enabled === false ? 'disabled' : 'enabled'
}

/** 保序分桶 */
export function bucketTasks(tasks: TaskMetaView[]): Record<TaskBucket, TaskMetaView[]> {
  const out: Record<TaskBucket, TaskMetaView[]> = { enabled: [], disabled: [] }
  for (const t of tasks) out[taskBucket(t)].push(t)
  return out
}
```

- 与现有 `groupTasks` 正交：先 `bucketTasks`，再对每桶 `groupTasks`。
- Tab 顺序：**已启用 / 已停用**；默认 **已启用**。

### 2. 组件结构（`web/src/pages/tasks/index.tsx`）

- 把现有「站点分组折叠列表」逻辑（现 index.tsx:161-192）抽成子组件 **`GroupedTaskList({ tasks })`**：
  - 内部做 `groupTasks(tasks)`、单组未分组时平铺、`GroupCard` 渲染；
  - **自持 `openKeys` state**（每个 Tab 的展开/收起相互独立）；
  - 自带「全部展开/收起」按钮（作用于当前 Tab 内分组）。
- `TasksPage` 改为：取数 → `bucketTasks(tasks.data)` → 渲染 antd `<Tabs>`：
  - Tab 项 labels：`已启用 {n}` / `已停用 {n}`；
  - `activeKey` 用组件内 state，默认 `'enabled'`；
  - 每个 Tab 的 children = `<GroupedTaskList tasks={bucket} />`。
- `TaskCard` 不改（含开关、触发按钮、分类标签、note、sourceUrl）。
- 页脚说明文案保留。

### 3. 边界与空态

- 某个 Tab 无任务 → 该 Tab 内显示 `<Empty description="该状态下暂无任务" />`。
- 全部任务都未分组（原 `flat` 特例）→ 在 `GroupedTaskList` 内部沿用：单一未分组时平铺卡片网格。
- 切换开关（`useSetTaskEnabled`）成功后 invalidate → 5s 轮询刷新；卡片会从当前 Tab 移出——`activeKey` 保持不动（用户仍停在原 Tab，不自动跳走），空 Tab 显示空态。

### 4. 移除 `deprecated`（改动点）

| 文件 | 改动 |
|---|---|
| `src/engine/task.ts` | 删 `deprecated?: boolean` 字段 + 顶部注释里的相关描述 |
| `src/server/routes/tasks.ts` | 删 swagger 注解 `deprecated` 行 + 响应构造里 `deprecated: m.deprecated ?? false` |
| `web/src/api/schema.d.ts` | 删任务视图里的 `deprecated?: boolean`（手补类型） |
| `web/src/pages/tasks/index.tsx` | 删 `dimmed` 里的 `task.deprecated \|\|`；删「已失效」Tag；相应把 `dimmed` 收敛为仅依据 `enabled === false` |
| `docs/API-GUIDE.md` | 删第 2 章 TaskMeta 表里的 `deprecated` 行（§2.1，现第 156 行）。**注意：本手册（function-manual 重写后）已无「面板使用」章节**，故无需改面板描述 |

> 注：`schema.d.ts` 由 openapi-typescript 生成，但项目先例是手补类型，直接改即可。

## 测试

- `web/src/pages/tasks/hooks.test.ts` 增：`taskBucket`（`enabled:false`→disabled；`enabled:true`/`undefined`→enabled）、`bucketTasks`（保序、空输入、全启用/全停用）。
- 组件级（可选，若已有页面测试约定）：Tabs 数量标签、默认选中「已启用」、切 Tab 展示对应分组。
- 后端：删除 `deprecated` 后跑 `npm run typecheck` + `npm test`（确认无测试引用，已核实 tests 零引用）。
- 前端：`npm run test:web`。

## 文档同步（硬性）

- `docs/API-GUIDE.md` §2.1 TaskMeta 表删 `deprecated` 行即可。经核实，本手册在 2026-10-09 function-manual 重写后**不再包含「面板使用」章节**，因此面板 UI 变更无需改手册（也无 8.2 可改）。
- commit：代码用 `refactor:`/`feat:`，文档同批或 `docs:` 前缀（中文描述）。

## 风险

- `schema.d.ts` 是手补类型，删字段后若后端确实不再返回该字段则一致；已确认后端将删除该字段。
- 无明显兼容风险（字段从未被使用）。

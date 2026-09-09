# 任务分组（空投分组）设计

日期：2026-09-09
状态：已确认（方案 A 折叠分区；范围 = 任务页 + 定时任务页 + 看板，三处一起做）

## 目标

同一空投的多个任务（领水/签到/部署/上传…）在面板上归为一组展示，解决任务多时平铺列表难以查找的问题。分组是**纯展示层概念**，不影响触发/调度/执行逻辑（引擎与数据库零改动）。

## 决策记录

- 呈现方式：**方案 A 折叠分区**（用户在线 mockup 确认，备选 B 筛选标签被否）
- 范围：① 任务页折叠分区（核心）② 定时任务页任务多选按分组 optgroup 归类 ③ 看板任务列显示分组名，三处一起做
- 建组策略：**全部任务都建组**——真实空投单任务也建组（代表空投身份），示例任务归「示例」组（用户确认）。「未分组」仅作为未写 `group` 字段时的兜底展示
- 分组定义内联在 `TaskMeta.group` 上，**不建独立分组注册表**（与 sourceUrl/note 等字段风格一致，API 原样返回，零服务端装配逻辑）

## 数据模型（唯一后端实质改动）

`src/engine/task.ts` 的 `TaskMeta` 新增可选字段：

```ts
/** 空投分组：同一空投的多个任务（领水/签到/部署…）写相同的 key+name，面板按组折叠展示；key 全局唯一 */
group?: { key: string; name: string }
```

约束：
- `group.key` 全局唯一，同一分组的任务必须写完全相同的 `{key, name}`（改组分名要同改组内所有任务，任务数少可接受）
- 字段可选：未写的任务落「未分组」兜底展示

## 改动清单

### 1. 后端（src/engine/task.ts + src/server/routes/tasks.ts）

- `TaskMeta` 加 `group` 字段（见上）
- `routes/tasks.ts` GET 组装补一行：`group: m.group ?? null`（缺省补 null，与现有 sourceUrl/note 的稳定性约定一致）
- `routes/tasks.ts` 头部 @swagger 注解的 `/api/tasks` 响应 schema 补：

```yaml
group:
  type: object
  nullable: true
  description: 空投分组（同一空投的任务写相同 key+name）
  properties:
    key: { type: string }
    name: { type: string }
```

### 2. 前端类型（web/src/api/schema.d.ts 手补）

按项目先例手补（不跑 openapi-typescript 生成）：`/api/tasks` 响应 items 加 `group?: { key: string; name: string } | null`。`web/src/types.ts` 的 `TaskMetaView` 自动获得该字段，无需改动。

### 3. 共享派生函数（web/src/pages/tasks/hooks.ts 导出）

```ts
export interface TaskGroup { key: string; name: string; tasks: TaskMetaView[] }
/** 按任务数组顺序派生分组：组顺序 = 组内第一个任务的出现顺序；未分组任务归入末尾伪分组（key 空串、name 未分组） */
export function groupTasks(tasks: TaskMetaView[]): TaskGroup[]
```

边界定义：
- tasks 为空 → 返回 `[]`
- 全部未分组 → 返回单元素 `[{ key: '', name: '未分组', tasks }]`，页面据此回退平铺渲染
- 部分未分组 → 伪分组垫底

### 4. 页面 ① 任务页（web/src/pages/tasks/index.tsx）

- 用 `groupTasks` 派生分组；`TaskCard` 组件本体不变
- 渲染规则：
  - 若 `groups.length === 1 && groups[0].key === ''`（全部未分组）或 tasks 为空 → 维持现有平铺 Row 网格，行为与现状完全一致
  - 否则渲染 antd `Collapse`（`ghost`，size small），每组一个面板：
    - `key = g.key`，`label = `${g.name} · ${g.tasks.length} 个任务``
    - children = 组内现有 Row 网格（xs 24 / xl 12 双列不变）
    - 「未分组」伪分组若有，样式与其他组一致，垫底
  - `defaultActiveKey = 全部分组 key`（默认全部展开；折叠状态仅组件内部状态，刷新回默认全展开）
- 底部说明文字「→ 任务定义在代码（src/tasks）…」保持不变

### 5. 页面 ② 定时任务页（web/src/pages/schedules/hooks.ts + index.tsx）

- hooks.ts 新增纯函数：

```ts
/** 任务多选选项：有分组时按 optgroup 归类（未分组垫底），全部未分组时返回平铺数组（维持现状行为） */
export function buildTaskOptions(tasks: TaskMetaView[]): Array<{ label: string; value: string } | { label: string; options: Array<{ label: string; value: string }> }>
```

- index.tsx 的 `taskOptions`（现第 39 行 map）替换为 `buildTaskOptions(tasks ?? [])`
- 选项 `value` 仍为 task key、`label` 仍为任务名，提交 payload 不变
- 已知限制（可接受）：antd Select 的 `optionFilterProp="label"` 搜索只匹配任务名，不匹配分组名

### 6. 页面 ③ 看板（web/src/pages/dashboard/hooks.ts + index.tsx）

- hooks.ts 新增纯函数：

```ts
/** 任务显示信息映射：key → { name, groupName }（groupName 为 null 时不显示分组） */
export function buildTaskInfo(tasks: TaskMetaView[]): Record<string, { name: string; groupName: string | null }>
```

- index.tsx 现有 `taskNames` 映射替换为 `taskInfo`，三处渲染点：
  - `BatchCard` 头部任务名后：有分组时追加小灰字分组名（`<span style={{ color: '#999', fontSize: 12 }}>{groupName}</span>`，与任务名空一格）
  - `RunsTable` 任务列（width 130）：任务名后同上追加分组名
  - `SingleBatchRow` 任务列：同上
- 无分组任务不显示，行高不变（内联一行，不换行）

### 7. 任务数据登记（src/tasks/ 各文件）

| 任务文件 | group.key | group.name |
|---|---|---|
| shelby-faucet.ts | shelby | Shelby |
| shelby-explorer.ts | shelby | Shelby |
| inception-dachain.ts | inception | Inception |
| portal-rhuna.ts | portal | Portal |
| arc-faucet.ts | arc | Arc |
| example-checkin.ts | example | 示例 |
| faucet-example.ts | example | 示例 |
| mint-example.ts | example | 示例 |

### 8. 测试

- `web/src/pages/tasks/hooks.test.ts`：`groupTasks` — 分组顺序按出现顺序 / 未分组垫底 / 全未分组返回伪分组 / 空数组返回 []
- `web/src/pages/schedules/hooks.test.ts`：`buildTaskOptions` — 有分组时 optgroup 结构（含未分组垫底）/ 全未分组时平铺 / 空数组返回 []
- `web/src/pages/dashboard/hooks.test.ts`（新建）：`buildTaskInfo` — 名称映射与 groupName 抽取 / 无分组为 null
- 后端无逻辑变更不新增后端测试；跑 `npm test` 确认现有断言不受响应新字段影响

### 9. 文档同步（硬性要求）

- `docs/API-GUIDE.md` 第 2 章 TaskMeta 字段表加 `group` 行；9.2 面板使用章节补任务页折叠分区、定时任务页分组下拉、看板任务列分组名三处说明；9.3 REST 接口总表 `/api/tasks` 备注补 group 字段
- TASK-DEVELOPMENT-LESSONS 不涉及（非真机任务开发）

### 10. 验证

- `npm run typecheck`、`npm test`、`npm run test:web` 全过
- `npm run dev` 面板人工验收三个页面（无需比特浏览器，任务页/定时页/看板均纯前端数据）

## 范围外

- 分组级操作：组头「全部启用/一键触发」按钮（mockup 中曾出现，YAGNI 砍掉；未来需要时在组头加按钮即可，不影响本次结构）
- 分组内任务执行顺序/依赖（引擎不感知分组）
- 任务页搜索/筛选框（方案 B 组件，任务量大后再议）
- 分组名/顺序的运行时配置（分组定义只在代码里，与现有任务定义方式一致）

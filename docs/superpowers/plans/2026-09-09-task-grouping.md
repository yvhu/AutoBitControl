# 任务分组（空投分组）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一空投的多个任务在面板上按组展示（任务页折叠分区 + 定时任务页分组下拉 + 看板任务列分组名），纯展示层概念，不影响执行引擎。

**Architecture:** `TaskMeta` 新增可选 `group: { key, name }` 字段，后端 API 原样透传（未写补 null），前端派生纯函数 `groupTasks` 供三个页面复用。无数据库/引擎改动。

**Tech Stack:** TypeScript（严格模式，无分号、单引号、2 空格）、Express 路由 @swagger 注解、React 18 + antd 5、vitest（后端 `npm test`、前端 `npm run test:web`）。

**Spec:** `docs/superpowers/specs/2026-09-09-task-grouping-design.md`

## Global Constraints

- 分组是纯展示概念：不碰 engine 执行逻辑、不碰 SQLite 表结构
- `group` 字段可选；未写的任务落「未分组」兜底展示
- 全部 8 个任务都建组：Shelby（shelby-faucet + xyz-shelbynet）、Inception、Portal、Arc、示例（example-checkin + faucet-example + mint-example）
- 不做分组级操作（组头「全部启用/一键触发」按钮不做）
- 代码/分组名不使用 emoji；注释与 commit message 用中文，commit 风格 `feat:`/`docs:` + 中文描述
- 验证命令：`npm run typecheck`（后端）、`npm --prefix web exec tsc -b`（前端类型）、`npm test`、`npm run test:web`

---

### Task 1: 后端 group 字段定义与 API 透传 + 前端 schema 类型

**Files:**
- Modify: `src/engine/task.ts`（TaskMeta 加 group）
- Modify: `src/server/routes/tasks.ts:29-60`（swagger 注解）与 `:146-167`（响应组装）
- Modify: `tests/web.test.ts:37`（MockDeps 类型）与 `:298-317`（新增 2 个测试）
- Modify: `web/src/api/schema.d.ts:492`（手补 group 类型）

**Interfaces:**
- Produces: `TaskMeta.group?: { key: string; name: string }`；`GET /api/tasks` 每项多 `group: { key, name } | null`；前端 `TaskMetaView['group']` 为 `{ key: string; name: string } | null`（DeepRequired 后）

- [ ] **Step 1: 写失败测试**

`tests/web.test.ts` 第 37 行 MockDeps 的 tasks meta 类型加 `group` 字段：

```ts
  tasks: Map<string, { meta: { key: string; name: string; url: string; wallet: string; enabled?: boolean; concurrency?: number; group?: { key: string; name: string } } }>
```

在第 317 行「meta 显式写并发时透传该值」测试之后新增两个测试：

```ts
  it('GET /api/tasks meta 显式写 group 时透传该值', async () => {
    const deps = makeDeps()
    deps.tasks.set('t2', { meta: { key: 't2', name: '任务2', url: '', wallet: 'petra', group: { key: 'g1', name: '组1' } } })
    const res = await request(createApp(deps as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    const t2 = res.body.data.find((t: { key: string }) => t.key === 't2')
    expect(t2.group).toEqual({ key: 'g1', name: '组1' })
  })

  it('GET /api/tasks meta 未写 group 时返回 null', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    expect(res.body.data[0].group).toBeNull()
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts -t "group"`
Expected: 2 个测试 FAIL（`t2.group` 为 `undefined`、`data[0].group` 为 `undefined`，非 null）

- [ ] **Step 3: TaskMeta 加 group 字段**

`src/engine/task.ts`，在 `category` 字段（第 22 行）之后插入：

```ts
  /** 空投分组：同一空投的多个任务（领水/签到/部署…）写相同的 key+name，面板按组折叠展示；key 全局唯一 */
  group?: { key: string; name: string }
```

- [ ] **Step 4: 路由透传 + swagger 注解**

`src/server/routes/tasks.ts` 响应组装（第 156 行 `category: m.category ?? null,` 之后）插入：

```ts
        group: m.group ?? null,
```

swagger 注解（第 41 行 `category: { type: string, nullable: true },` 之后）插入：

```
 *                       group:
 *                         type: object
 *                         nullable: true
 *                         description: 空投分组（同一空投的任务写相同 key+name）
 *                         properties:
 *                           key: { type: string }
 *                           name: { type: string }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/web.test.ts`
Expected: 全部 PASS（含既有断言不受影响）

- [ ] **Step 6: 前端 schema.d.ts 手补**

`web/src/api/schema.d.ts` 第 492 行 `concurrency?: number;` 之后（保持同缩进）插入：

```ts
                                group?: {
                                    /** @description 分组 key（全局唯一） */
                                    key?: string;
                                    /** @description 分组显示名 */
                                    name?: string;
                                } | null;
```

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck` 和 `npm --prefix web exec tsc -b`
Expected: 两者零错误退出

- [ ] **Step 8: 提交**

```powershell
git add src/engine/task.ts src/server/routes/tasks.ts tests/web.test.ts web/src/api/schema.d.ts
git commit -m "feat: TaskMeta 增加空投分组 group 字段并透传 API"
```

---

### Task 2: groupTasks 分组派生纯函数

**Files:**
- Modify: `web/src/pages/tasks/hooks.ts`（追加导出）
- Modify: `web/src/pages/tasks/hooks.test.ts`（追加测试）

**Interfaces:**
- Produces: `TaskGroup { key: string; name: string; tasks: TaskMetaView[] }`；`groupTasks(tasks: TaskMetaView[]): TaskGroup[]`——组顺序 = 组内第一个任务出现顺序；未分组任务归入末尾伪分组（key 空串、name `'未分组'`）；空数组返回 `[]`

- [ ] **Step 1: 写失败测试**

`web/src/pages/tasks/hooks.test.ts` 文件末尾追加：

```ts
import { groupTasks } from './hooks'
import type { TaskMetaView } from '../../types'

describe('groupTasks', () => {
  const t = (key: string, group: { key: string; name: string } | null) => ({ key, name: `任务${key}`, group }) as unknown as TaskMetaView

  it('按组内第一个任务的出现顺序分组', () => {
    const tasks = [t('a', { key: 'g2', name: '组2' }), t('b', { key: 'g1', name: '组1' }), t('c', { key: 'g2', name: '组2' })]
    const groups = groupTasks(tasks)
    expect(groups.map((g) => g.key)).toEqual(['g2', 'g1'])
    expect(groups[0].tasks.map((x) => x.key)).toEqual(['a', 'c'])
    expect(groups[1].tasks.map((x) => x.key)).toEqual(['b'])
  })

  it('未分组任务归入末尾伪分组（key 空串、name 未分组）', () => {
    const groups = groupTasks([t('a', { key: 'g1', name: '组1' }), t('b', null)])
    expect(groups.map((g) => g.key)).toEqual(['g1', ''])
    expect(groups[1].name).toBe('未分组')
    expect(groups[1].tasks.map((x) => x.key)).toEqual(['b'])
  })

  it('全部未分组返回单一伪分组', () => {
    const groups = groupTasks([t('a', null), t('b', null)])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('')
  })

  it('空数组返回空数组', () => {
    expect(groupTasks([])).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:web`（web 目录内 vitest run）
Expected: groupTasks 相关用例 FAIL（`groupTasks is not a function` / 导入报错）

- [ ] **Step 3: 实现 groupTasks**

`web/src/pages/tasks/hooks.ts` 在 `useTasks` 之前插入：

```ts
export interface TaskGroup {
  key: string
  name: string
  tasks: TaskMetaView[]
}

/** 按任务数组顺序派生分组：组顺序 = 组内第一个任务的出现顺序；未分组任务归入末尾伪分组（key 空串、name 未分组） */
export function groupTasks(tasks: TaskMetaView[]): TaskGroup[] {
  const groups: TaskGroup[] = []
  const index = new Map<string, number>()
  for (const t of tasks) {
    const key = t.group?.key ?? ''
    if (!index.has(key)) {
      index.set(key, groups.length)
      groups.push({ key, name: t.group?.name ?? '未分组', tasks: [] })
    }
    groups[index.get(key)!].tasks.push(t)
  }
  return groups
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:web`
Expected: 全部 PASS

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm --prefix web exec tsc -b`
Expected: 零错误

```powershell
git add web/src/pages/tasks/hooks.ts web/src/pages/tasks/hooks.test.ts
git commit -m "feat: 任务分组派生函数 groupTasks"
```

---

### Task 3: 任务页折叠分区

**Files:**
- Modify: `web/src/pages/tasks/index.tsx:2`（antd 导入加 Collapse）、`:5-11`（hooks 导入加 groupTasks）、`:131-144`（渲染块）

**Interfaces:**
- Consumes: `groupTasks`（Task 2）
- Produces: 任务页按分组渲染 Collapse；全部未分组时保持原平铺网格

- [ ] **Step 1: 修改导入**

`web/src/pages/tasks/index.tsx` 第 2 行改为：

```tsx
import { Button, Card, Col, Collapse, Empty, Row, Space, Spin, Switch, Tag, Typography } from 'antd'
```

第 5-11 行 hooks 导入改为：

```tsx
import {
  categoryColor,
  categoryLabel,
  groupTasks,
  useSetTaskEnabled,
  useTasks,
  useTriggerTask,
} from './hooks'
```

- [ ] **Step 2: 替换渲染块**

第 131-144 行的 return 渲染块整体替换为：

```tsx
  const groups = groupTasks(tasks.data)
  const flat = groups.length === 1 && groups[0].key === ''

  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      {flat ? (
        <Row gutter={[12, 12]} align="stretch">
          {tasks.data.map((t) => (
            <Col key={t.key} xs={24} xl={12}>
              <TaskCard task={t} />
            </Col>
          ))}
        </Row>
      ) : (
        <Collapse
          ghost
          defaultActiveKey={groups.map((g) => g.key)}
          items={groups.map((g) => ({
            key: g.key,
            label: `${g.name} · ${g.tasks.length} 个任务`,
            children: (
              <Row gutter={[12, 12]} align="stretch">
                {g.tasks.map((t) => (
                  <Col key={t.key} xs={24} xl={12}>
                    <TaskCard task={t} />
                  </Col>
                ))}
              </Row>
            ),
          }))}
        />
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        → 任务定义在代码（src/tasks），开关与触发在此页管理
      </Typography.Text>
    </Space>
  )
}
```

注意：`const groups` 声明要放在 `tasks.data` 判空返回之后（第 123-129 行 Empty 分支之后）——把原第 131 行的 `return (` 上方留出声明位置，最终结构为 Empty 判断 → `const groups = ...` → `return (...)`。

- [ ] **Step 3: 测试与类型检查**

Run: `npm run test:web` 和 `npm --prefix web exec tsc -b`
Expected: 全部 PASS、零错误（本页无新增单测，groupTasks 逻辑已被 Task 2 覆盖）

- [ ] **Step 4: 提交**

```powershell
git add web/src/pages/tasks/index.tsx
git commit -m "feat: 任务页按空投分组折叠展示"
```

---

### Task 4: 定时任务页任务多选按分组归类

**Files:**
- Modify: `web/src/pages/schedules/hooks.ts`（新增 buildTaskOptions）
- Modify: `web/src/pages/schedules/hooks.test.ts`（追加测试）
- Modify: `web/src/pages/schedules/index.tsx:19`（导入）、`:39`（替换 taskOptions 构造）

**Interfaces:**
- Consumes: `groupTasks`（Task 2）
- Produces: `buildTaskOptions(tasks: TaskMetaView[]): TaskSelectOption[]`，其中 `type TaskSelectOption = { label: string; value: string } | { label: string; options: Array<{ label: string; value: string }> }`；全部未分组时返回平铺数组（维持现状）

- [ ] **Step 1: 写失败测试**

`web/src/pages/schedules/hooks.test.ts` 文件末尾追加：

```ts
import { buildTaskOptions } from './hooks'
import type { TaskMetaView } from '../../types'

describe('buildTaskOptions', () => {
  const t = (key: string, group: { key: string; name: string } | null) => ({ key, name: `任务${key}`, group }) as unknown as TaskMetaView

  it('有分组时返回 optgroup 结构且未分组垫底', () => {
    const opts = buildTaskOptions([t('a', { key: 'g1', name: '组1' }), t('b', null)])
    expect(opts).toEqual([
      { label: '组1', options: [{ label: '任务a', value: 'a' }] },
      { label: '未分组', options: [{ label: '任务b', value: 'b' }] },
    ])
  })

  it('全部未分组时返回平铺数组', () => {
    const opts = buildTaskOptions([t('a', null), t('b', null)])
    expect(opts).toEqual([
      { label: '任务a', value: 'a' },
      { label: '任务b', value: 'b' },
    ])
  })

  it('空数组返回空数组', () => {
    expect(buildTaskOptions([])).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:web`
Expected: buildTaskOptions 用例 FAIL

- [ ] **Step 3: 实现 buildTaskOptions**

`web/src/pages/schedules/hooks.ts` 顶部 import 区（第 10 行 `import type { ScheduleItem... }` 之后）追加：

```ts
import type { TaskMetaView } from '../../types'
import { groupTasks } from '../tasks/hooks'
```

文件末尾（useRunSchedule 之后）追加：

```ts
export type TaskSelectOption =
  | { label: string; value: string }
  | { label: string; options: Array<{ label: string; value: string }> }

/** 任务多选选项：有分组时按 optgroup 归类（未分组垫底），全部未分组时返回平铺数组（维持现状行为） */
export function buildTaskOptions(tasks: TaskMetaView[]): TaskSelectOption[] {
  const groups = groupTasks(tasks)
  if (groups.length === 1 && groups[0].key === '') {
    return groups[0].tasks.map((t) => ({ label: t.name, value: t.key }))
  }
  return groups.map((g) => ({
    label: g.name,
    options: g.tasks.map((t) => ({ label: t.name, value: t.key })),
  }))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:web`
Expected: 全部 PASS

- [ ] **Step 5: 接线 index.tsx**

`web/src/pages/schedules/index.tsx` 第 13-17 行 hooks 导入（`MODE_OPTIONS, ... buildPayload,` 处）改为：

```tsx
import {
  MODE_OPTIONS, WEEKDAY_OPTIONS, DAY_OPTIONS, modeLabel, buildPayload, buildTaskOptions,
  useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule, useRunSchedule,
  type FormValues,
} from './hooks'
```

第 39 行替换为：

```tsx
  const taskOptions = buildTaskOptions(tasks ?? [])
```

- [ ] **Step 6: 测试与类型检查 + 提交**

Run: `npm run test:web` 和 `npm --prefix web exec tsc -b`
Expected: 全部 PASS、零错误

```powershell
git add web/src/pages/schedules/hooks.ts web/src/pages/schedules/hooks.test.ts web/src/pages/schedules/index.tsx
git commit -m "feat: 定时任务页任务多选按空投分组归类"
```

---

### Task 5: 看板任务列显示分组名

**Files:**
- Modify: `web/src/pages/dashboard/hooks.ts`（新增 buildTaskInfo）
- Create: `web/src/pages/dashboard/hooks.test.ts`
- Modify: `web/src/pages/dashboard/index.tsx`（三处渲染点 + 辅助组件）

**Interfaces:**
- Consumes: `TaskMetaView`（group 字段来自 Task 1）
- Produces: `TaskInfoMap = Record<string, { name: string; groupName: string | null }>`；`buildTaskInfo(tasks: TaskMetaView[]): TaskInfoMap`

- [ ] **Step 1: 写失败测试**

新建 `web/src/pages/dashboard/hooks.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildTaskInfo } from './hooks'
import type { TaskMetaView } from '../../types'

describe('buildTaskInfo', () => {
  it('名称与分组名映射', () => {
    const tasks = [
      { key: 'a', name: '任务A', group: { key: 'g1', name: '组1' } },
      { key: 'b', name: '任务B', group: null },
    ] as unknown as TaskMetaView[]
    expect(buildTaskInfo(tasks)).toEqual({
      a: { name: '任务A', groupName: '组1' },
      b: { name: '任务B', groupName: null },
    })
  })

  it('空数组返回空映射', () => {
    expect(buildTaskInfo([])).toEqual({})
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:web`
Expected: FAIL（buildTaskInfo 未导出）

- [ ] **Step 3: 实现 buildTaskInfo**

`web/src/pages/dashboard/hooks.ts` 第 4 行 import 之后追加：

```ts
import type { TaskMetaView } from '../../types'
```

文件末尾追加：

```ts
export type TaskInfoMap = Record<string, { name: string; groupName: string | null }>

/** 任务显示信息映射：key → { name, groupName }；无分组时 groupName 为 null */
export function buildTaskInfo(tasks: TaskMetaView[]): TaskInfoMap {
  const map: TaskInfoMap = {}
  for (const t of tasks) map[t.key] = { name: t.name, groupName: t.group?.name ?? null }
  return map
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:web`
Expected: 全部 PASS

- [ ] **Step 5: 接线 index.tsx**

`web/src/pages/dashboard/index.tsx` 第 5 行改为：

```tsx
import { useBatches, useBatchDetail, useTasks, useTriggerTask, buildTaskInfo, type TaskInfoMap } from './hooks'
```

`RunsTable` 组件（第 34 行）签名与任务列改为：

```tsx
function TaskName({ info, fallback }: { info: { name: string; groupName: string | null } | undefined; fallback: string }) {
  if (!info) return <>{fallback}</>
  return (
    <span>
      {info.name}
      {info.groupName && <span style={{ color: '#999', fontSize: 11, marginLeft: 4 }}>{info.groupName}</span>}
    </span>
  )
}

function RunsTable({ runs, loading, taskInfo }: { runs: RunRow[]; loading: boolean; taskInfo: TaskInfoMap }) {
```

任务列（第 47 行）改为：

```tsx
        { title: '任务', dataIndex: 'taskKey', width: 130, render: (k: string) => <TaskName info={taskInfo[k]} fallback={k} /> },
```

`BatchCard` 组件（第 63 行）签名改为：

```tsx
function BatchCard({ batch, taskInfo, defaultOpen }: { batch: BatchItem; taskInfo: TaskInfoMap; defaultOpen: boolean }) {
```

第 80 行任务名改为：

```tsx
        <span style={{ fontWeight: 600 }}><TaskName info={taskInfo[batch.taskKey]} fallback={batch.taskKey} /></span>
```

`SingleBatchRow` 组件（第 106 行）签名改为：

```tsx
function SingleBatchRow({ batch, taskInfo }: { batch: BatchItem; taskInfo: TaskInfoMap }) {
```

第 119 行任务列改为：

```tsx
        { title: '任务', width: 120, render: () => <TaskName info={taskInfo[batch.taskKey]} fallback={batch.taskKey} /> },
```

`DashboardPage` 内（第 141-145 行）替换为：

```tsx
  const taskInfo = useMemo(() => buildTaskInfo(tasks.data ?? []), [tasks.data])
```

三处调用点改为传 `taskInfo`：第 168 行 `<BatchCard ... taskNames={taskNames} ...>` → `taskInfo={taskInfo}`；第 179 行 `<SingleBatchRow ... taskNames={taskNames} />` → `taskInfo={taskInfo}`；第 185 行 `<RunsTable runs={unbatched} loading={false} taskNames={taskNames} />` → `taskInfo={taskInfo}`。同时删除 `taskNames` 变量声明（原第 141-145 行）。

- [ ] **Step 6: 测试与类型检查 + 提交**

Run: `npm run test:web` 和 `npm --prefix web exec tsc -b`
Expected: 全部 PASS、零错误（dashboard 既有 format/groupBatches 测试不受影响）

```powershell
git add web/src/pages/dashboard/hooks.ts web/src/pages/dashboard/hooks.test.ts web/src/pages/dashboard/index.tsx
git commit -m "feat: 看板任务列显示空投分组名"
```

---

### Task 6: 8 个任务登记 group 字段

**Files:**
- Modify: `src/tasks/shelby-faucet.ts`、`src/tasks/shelby-explorer.ts`、`src/tasks/inception-dachain.ts`、`src/tasks/portal-rhuna.ts`、`src/tasks/arc-faucet.ts`、`src/tasks/example-checkin.ts`、`src/tasks/faucet-example.ts`、`src/tasks/mint-example.ts`

**Interfaces:**
- Consumes: `TaskMeta.group`（Task 1）

- [ ] **Step 1: 逐文件在 `name:` 行之后插入 group 字段**

每个文件在 `name: '…',` 行后插入一行（2 空格缩进与 meta 对象一致）：

| 文件 | 插入行 |
| --- | --- |
| shelby-faucet.ts（第 139 行后） | `group: { key: 'shelby', name: 'Shelby' },` |
| shelby-explorer.ts（第 94 行后） | `group: { key: 'shelby', name: 'Shelby' },` |
| inception-dachain.ts（第 51 行后） | `group: { key: 'inception', name: 'Inception' },` |
| portal-rhuna.ts（第 48 行后） | `group: { key: 'portal', name: 'Portal' },` |
| arc-faucet.ts（第 138 行后） | `group: { key: 'arc', name: 'Arc' },` |
| example-checkin.ts（第 10 行后） | `group: { key: 'example', name: '示例' },` |
| faucet-example.ts（第 9 行后） | `group: { key: 'example', name: '示例' },` |
| mint-example.ts（第 9 行后） | `group: { key: 'example', name: '示例' },` |

- [ ] **Step 2: 类型检查与后端测试**

Run: `npm run typecheck` 和 `npm test`
Expected: 零错误、全部 PASS

- [ ] **Step 3: 提交**

```powershell
git add src/tasks
git commit -m "feat: 全部任务登记空投分组（Shelby/Inception/Portal/Arc/示例）"
```

---

### Task 7: 文档同步（API-GUIDE）

**Files:**
- Modify: `docs/API-GUIDE.md:157`（TaskMeta 字段表）、`:1155-1158`（9.2 面板使用三条）、`:1171`（9.3 REST 总表）

- [ ] **Step 1: 第 2 章字段表加 group 行**

第 157 行 `category` 行之后插入：

```markdown
| `group` | `{ key: string; name: string }?` | `undefined` | 空投分组：同一空投的多个任务写完全相同的 key+name，面板任务页按组折叠展示、定时任务页任务多选按组归类、看板任务列显示组名；未写 → 归入「未分组」 |
```

- [ ] **Step 2: 9.2 面板使用三条更新**

看板条目（第 1155 行）把「明细行含窗口/任务/开始/耗时/状态/错误/截图」改为「明细行含窗口/任务（任务名后带空投分组名小灰字）/开始/耗时/状态/错误/截图」；

任务页条目（第 1157 行）开头「任务卡片网格（每卡两列，行内卡片等高），卡片含…」改为「任务按空投分组折叠展示（Collapse 分区，组标题为「分组名 · N 个任务」，默认全展开；未写 group 的任务归入末尾「未分组」区；全部任务都未分组时保持平铺网格）。组内任务卡片网格（每卡两列，行内卡片等高），卡片含…」（后续原文不变）；

定时任务页条目（第 1158 行）在「新建（四种频率模式，见第 8 章）」之后插入「，任务多选下拉按空投分组归类（optgroup，未分组任务垫底；选项值仍为任务 key 不变）」。

- [ ] **Step 3: 9.3 REST 总表更新**

第 1171 行改为：

```markdown
| GET | `/api/tasks` | 任务列表（meta 全字段 ＋ 本地库开关状态，含空投分组 `group` 字段） |
```

- [ ] **Step 4: 提交**

```powershell
git add docs/API-GUIDE.md
git commit -m "docs: 任务分组功能文档同步（TaskMeta 字段表/面板使用/REST 总表）"
```

---

### Task 8: 全量验证与手动验收

- [ ] **Step 1: 全量验证**

Run 四个命令全部通过：

```powershell
npm run typecheck
npm test
npm run test:web
npm --prefix web exec tsc -b
```

Expected: 全部零错误、全部 PASS

- [ ] **Step 2: 手动验收（npm run dev）**

打开面板 Vite 端口：
- 任务页：出现 5 个折叠分区（Shelby 2 个任务 / Inception / Portal / Arc / 示例 3 个任务），默认全展开，可折叠展开；卡片功能（开关/触发）不变
- 定时任务页：新建弹窗任务多选下拉按分组归类，可选值与之前完全一致
- 看板：批次卡与运行表格任务列出现分组名小灰字
- 确认无 emoji、无布局错乱

- [ ] **Step 3: 发现问题的处理**

若验收发现问题：按 systematic-debugging 修 bug → 跑对应测试 → 补提交（`fix:` 前缀）；若全部正常，结束（不额外提交）

---

## 自审记录

- Spec 覆盖：字段定义与透传（T1）、派生函数（T2）、任务页（T3）、定时页（T4）、看板（T5）、任务数据（T6）、文档（T7）、验证（T8）——spec 各节均有对应任务
- 类型一致性：`group` / `groupTasks` / `TaskGroup` / `buildTaskOptions` / `TaskSelectOption` / `buildTaskInfo` / `TaskInfoMap` 全计划命名唯一一致
- 无占位符：所有代码步骤含完整代码

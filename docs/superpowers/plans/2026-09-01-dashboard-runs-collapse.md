# 看板执行记录折叠展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板执行记录按（窗口,任务）折叠多轮记录——默认只显示最新一轮，历史轮次经展开区嵌套小表查看；统计口径同步改为按最新轮计数。纯前端改动。

**Architecture:** 新增纯函数模块 `groupRuns.ts`（分组/最新轮/历史轮/最新轮统计），dashboard 页接入 antd Table 的 `expandable`（`rowExpandable` + `expandedRowRender` 嵌套小表），顶部统计卡改用 `latestStats` 派生值。后端/调度/数据零改动。

**Tech Stack:** React 18、antd 5（Table expandable）、vitest + jsdom。

## Global Constraints

- 只改前端（`web/src/pages/dashboard/`）；后端接口、DB、调度、触发语义、重试逻辑零改动
- 折叠规则：按 `(profileId, taskKey)` 分组；顶层 = 最新 slot；历史按 slot 倒序；单轮组不可展开
- 统计口径：success/failed/captchaFailed/skipped/running(含 retry_wait)/pending/total 均按**每窗口每任务最新一轮**计数
- 筛选（状态/任务/窗口搜索）只作用于最新轮；展开出的历史行不被二次过滤
- 展开区嵌套小表列：`轮次(#slot) | 开始时间 | 结束时间 | 总耗时 | 状态 | 错误 | 截图 | 操作`（不重复窗口/任务列）
- 提交风格：单行 `feat:/fix:/docs:/chore:` 前缀
- 测试命令：`npm --prefix web run test`；构建：`npm --prefix web run build`
- 运行环境：Windows PowerShell 5.1；工作目录 `D:\StudySpace\AutoBitControl`，直接提交 `develop` 分支

---

### Task 1: groupRuns 纯函数与统计口径

**Files:**
- Create: `web/src/pages/dashboard/groupRuns.ts`
- Test: `web/src/pages/dashboard/groupRuns.test.ts`

**Interfaces:**
- Consumes: `RunRow`（`web/src/types.ts`，含 `id/profileId/taskKey/slot/status` 等字段）
- Produces:
  - `RunGroup { latest: RunRow; history: RunRow[] }`（history 按 slot 倒序）
  - `groupRuns(runs: RunRow[]): RunGroup[]`（组顺序按首次出现顺序）
  - `latestStats(runs: RunRow[]): DashboardData['stats']`（按每窗口每任务最新一轮计数；`running` = latest 为 running 或 retry_wait）
  - `historyMap(runs: RunRow[]): Map<number, RunRow[]>`（key = 该组最新行 id，value = 历史轮次列表，单轮组不入表）
  （Task 2 消费全部三个导出）

- [ ] **Step 1: 写失败测试**

`web/src/pages/dashboard/groupRuns.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { groupRuns, latestStats, historyMap } from './groupRuns'
import type { RunRow } from '../../types'

/** 造一行：slot 与状态必填，其余字段给默认值 */
function makeRun(over: Partial<RunRow>): RunRow {
  return {
    id: over.id ?? 1,
    profileId: over.profileId ?? 1,
    taskKey: over.taskKey ?? 't',
    date: '2026-09-01',
    slot: over.slot ?? 0,
    status: over.status ?? 'success',
    attempts: 1,
    error: null,
    screenshot: null,
    startedAt: null,
    finishedAt: null,
    durationSec: null,
    profileName: '窗口1',
    ...over,
  } as RunRow
}

describe('groupRuns 多轮折叠', () => {
  it('同窗口同任务多轮 → 一组；latest 为最大 slot；history 按 slot 倒序', () => {
    const groups = groupRuns([
      makeRun({ id: 1, profileId: 1, taskKey: 't1', slot: 0, status: 'failed' }),
      makeRun({ id: 2, profileId: 1, taskKey: 't1', slot: 1, status: 'success' }),
      makeRun({ id: 3, profileId: 1, taskKey: 't1', slot: 2, status: 'success' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].latest.id).toBe(3)
    expect(groups[0].history.map((r) => r.id)).toEqual([2, 1])
  })

  it('不同窗口/不同任务各成一组；组顺序按首次出现', () => {
    const groups = groupRuns([
      makeRun({ id: 1, profileId: 1, taskKey: 't1' }),
      makeRun({ id: 2, profileId: 2, taskKey: 't1' }),
      makeRun({ id: 3, profileId: 1, taskKey: 't2' }),
    ])
    expect(groups.map((g) => g.latest.id)).toEqual([1, 2, 3])
    expect(groups.every((g) => g.history.length === 0)).toBe(true)
  })

  it('单轮组不产生 history', () => {
    const groups = groupRuns([makeRun({ id: 9 })])
    expect(groups[0].history).toEqual([])
  })
})

describe('latestStats 最新轮统计口径', () => {
  it('只按每窗口每任务最新一轮计数（历史轮次不参与）', () => {
    const stats = latestStats([
      // 组 A：历史 failed、最新 success → 计 1 成功
      makeRun({ id: 1, profileId: 1, taskKey: 't1', slot: 0, status: 'failed' }),
      makeRun({ id: 2, profileId: 1, taskKey: 't1', slot: 1, status: 'success' }),
      // 组 B：历史 success、最新 failed → 计 1 失败
      makeRun({ id: 3, profileId: 2, taskKey: 't1', slot: 0, status: 'success' }),
      makeRun({ id: 4, profileId: 2, taskKey: 't1', slot: 1, status: 'failed' }),
      // 组 C：最新 retry_wait → 计 1 进行中
      makeRun({ id: 5, profileId: 3, taskKey: 't1', slot: 0, status: 'retry_wait' }),
    ])
    expect(stats.total).toBe(3)
    expect(stats.success).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.running).toBe(1)
    expect(stats.skipped).toBe(0)
  })
})

describe('historyMap 历史轮次索引', () => {
  it('key = 最新行 id；单轮组不入表', () => {
    const map = historyMap([
      makeRun({ id: 1, profileId: 1, taskKey: 't1', slot: 0 }),
      makeRun({ id: 2, profileId: 1, taskKey: 't1', slot: 1 }),
      makeRun({ id: 3, profileId: 2, taskKey: 't1', slot: 0 }),
    ])
    expect(map.get(2)?.map((r) => r.id)).toEqual([1])
    expect(map.has(3)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npm --prefix web run test`
Expected: FAIL（`./groupRuns` 模块不存在）

- [ ] **Step 3: 最小实现**

`web/src/pages/dashboard/groupRuns.ts`：

```ts
/**
 * 执行记录折叠分组（纯函数）：按（窗口,任务）分组，顶层为最新一轮，
 * 历史轮次按 slot 倒序；统计口径同步改为按最新轮计数
 */
import type { RunRow, DashboardData } from '../../types'

/** 一个（窗口,任务）组的折叠视图：latest 最新轮，history 历史轮次（slot 倒序） */
export interface RunGroup {
  latest: RunRow
  history: RunRow[]
}

/** 分组：组顺序按首次出现顺序（即 API 返回顺序 p.id, taskKey, slot 的自然序） */
export function groupRuns(runs: RunRow[]): RunGroup[] {
  const groups = new Map<string, RunRow[]>()
  for (const r of runs) {
    const key = `${r.profileId}-${r.taskKey}`
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => b.slot - a.slot)
    return { latest: sorted[0], history: sorted.slice(1) }
  })
}

/** 每窗口每任务最新一轮的统计（与折叠后表格行数一致） */
export function latestStats(runs: RunRow[]): DashboardData['stats'] {
  const stats = { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0 }
  for (const { latest } of groupRuns(runs)) {
    stats.total++
    if (latest.status === 'success') stats.success++
    else if (latest.status === 'failed') stats.failed++
    else if (latest.status === 'captcha_failed') stats.captchaFailed++
    else if (latest.status === 'skipped') stats.skipped++
    else if (latest.status === 'running' || latest.status === 'retry_wait') stats.running++
    else if (latest.status === 'pending') stats.pending++
  }
  return stats
}

/** 历史轮次索引：key = 该组最新行 id；单轮组不入表（展开区查询用） */
export function historyMap(runs: RunRow[]): Map<number, RunRow[]> {
  const map = new Map<number, RunRow[]>()
  for (const { latest, history } of groupRuns(runs)) {
    if (history.length > 0) map.set(latest.id, history)
  }
  return map
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npm --prefix web run test`
Expected: PASS（新模块用例全绿）

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/dashboard/groupRuns.ts web/src/pages/dashboard/groupRuns.test.ts
git commit -m "feat: dashboard runs grouping + latest-round stats (pure helpers)"
```

---

### Task 2: 看板页接入折叠展示

**Files:**
- Modify: `web/src/pages/dashboard/index.tsx`

**Interfaces:**
- Consumes: Task 1 的 `groupRuns / latestStats / historyMap`、既有 `formatDuration`、`StatusPill`
- Produces: 折叠后的表格（顶层 = 最新轮；展开 = 历史嵌套小表）；统计卡按最新轮口径

- [ ] **Step 1: 基线验证**

Run: `npm --prefix web run test`
Expected: 现有 40 个前端用例 PASS（改动前基线）

- [ ] **Step 2: 实现**

`web/src/pages/dashboard/index.tsx` 按以下四处修改：

1. import 追加：

```ts
import { groupRuns, latestStats, historyMap } from './groupRuns'
```

2. 数据派生（原 `rows` useMemo 区块 126-134 行整段替换）：

```ts
  const groups = useMemo(() => groupRuns(dashboard.data?.runs ?? []), [dashboard.data])
  const historyOf = useMemo(() => historyMap(dashboard.data?.runs ?? []), [dashboard.data])
  // 筛选只作用于最新轮（顶层行）；展开出的历史行不被二次过滤
  const rows = useMemo(
    () =>
      groups
        .filter(
          (g) =>
            STATUS_FILTERS[statusFilter]?.(g.latest) &&
            (!taskFilter || g.latest.taskKey === taskFilter) &&
            (!profileSearch || (g.latest.profileName ?? '').toLowerCase().includes(profileSearch.toLowerCase())),
        )
        .map((g) => g.latest),
    [groups, statusFilter, taskFilter, profileSearch],
  )
  // 统计口径：按每窗口每任务最新一轮计数（与表格行数一致）
  const displayData = useMemo(
    () => (dashboard.data ? { ...dashboard.data, stats: latestStats(dashboard.data.runs) } : dashboard.data),
    [dashboard.data],
  )
```

3. 统计卡数据源替换（CompleteCard/DistributionCard/LiveCard 三处 `dashboard.data` → `displayData`）：
   - 255 行 `<CompleteCard data={dashboard.data} loading={dashboard.isPending} />` → `data={displayData}`
   - 258 行 `<DistributionCard data={dashboard.data ?? EMPTY_DASHBOARD} />` → `data={displayData ?? EMPTY_DASHBOARD}`
   - 264 行 `<LiveCard data={dashboard.data ?? EMPTY_DASHBOARD} />` → `data={displayData ?? EMPTY_DASHBOARD}`
   （CaptchaCard 不动：打码统计与轮次无关）

4. 列定义：「尝试」列（171-172 行）之后插入「轮次」列：

```tsx
    {
      title: '轮次',
      key: 'round',
      width: 100,
      render: (_, r) => {
        const n = historyOf.get(r.id)?.length ?? 0
        return n > 0 ? <Tag color="blue">历史 {n} 轮</Tag> : '—'
      },
    },
```

5. Table 组件（309-317 行）增加 `expandable`：

```tsx
        <Table<RunRow>
          rowKey={(r) => `${r.id}-${r.taskKey}`}
          columns={columns}
          dataSource={rows}
          loading={dashboard.isPending}
          expandable={{
            rowExpandable: (r) => (historyOf.get(r.id)?.length ?? 0) > 0,
            expandedRowRender: (r) => {
              const hist = historyOf.get(r.id) ?? []
              return (
                <Table<RunRow>
                  size="small"
                  rowKey={(h) => `${h.id}-${h.taskKey}`}
                  pagination={false}
                  dataSource={hist}
                  columns={[
                    { title: '轮次', dataIndex: 'slot', width: 80, render: (s: number) => `#${s}` },
                    { title: '开始时间', dataIndex: 'startedAt', width: 130, render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—') },
                    { title: '结束时间', dataIndex: 'finishedAt', width: 130, render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—') },
                    { title: '总耗时', dataIndex: 'durationSec', width: 90, render: (sec: number | null) => formatDuration(sec) },
                    { title: '状态', dataIndex: 'status', width: 110, render: (s: RunRow['status']) => <StatusPill status={s} /> },
                    { title: '错误', dataIndex: 'error', ellipsis: true, render: (err: string | null) => (err ? <Typography.Text type="danger" ellipsis={{ tooltip: err }} style={{ maxWidth: 240 }}>{err}</Typography.Text> : '—') },
                    { title: '截图', dataIndex: 'screenshot', width: 90, render: (shot: string | null) => (shot ? <Button type="link" size="small" onClick={() => window.open(`/api/screenshots?path=${encodeURIComponent(shot)}`, '_blank')}>🖼 查看</Button> : '—') },
                    { title: '操作', width: 100, render: (_, h) => {
                      const failed = h.status === 'failed' || h.status === 'captcha_failed'
                      const id = bitbrowserOf(h.profileId)
                      return <Button type="link" size="small" loading={trigger.isPending} disabled={!id} onClick={() => { if (id) trigger.mutate({ key: h.taskKey, bitbrowserId: id }) }}>{failed ? '重跑' : '执行'}</Button>
                    } },
                  ]}
                />
              )
            },
          }}
          pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'], showTotal: (t) => `共 ${t} 条` }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行记录" /> }}
          scroll={{ x: 900 }}
        />
```

（原 309-317 行的 Table 整体替换为上述带 expandable 的版本）

- [ ] **Step 3: 运行验证通过**

Run: `npm --prefix web run test`；`npm --prefix web run build`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/dashboard/index.tsx
git commit -m "feat: dashboard runs table collapse multi-rounds with expandable history"
```

---

### Task 3: 全量回归与收尾

**Files:**
- 无（仅验证）

- [ ] **Step 1: 前端全量回归**

Run: `npm --prefix web run test`；`npm --prefix web run build`
Expected: 全部 PASS

- [ ] **Step 2: 后端确认无影响**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS（前端改动不应影响后端；确认无遗漏引用）

- [ ] **Step 3: 提交（无文档变更则跳过）**

无文档变更则跳过。

---

## Self-Review

- **Spec coverage**：折叠规则与组顺序（Task 1 groupRuns 用例）、统计口径（Task 1 latestStats 用例 + Task 2 displayData）、筛选只作用最新轮（Task 2 rows 过滤）、展开嵌套小表列集（Task 2 expandedRowRender）、单轮不可展开（Task 1 用例 + Task 2 rowExpandable）、8/12 小时间隔任务同规则（分组逻辑天然覆盖，无需特殊处理）——全部覆盖。
- **Placeholder scan**：无 TBD/TODO；代码步骤均含完整代码。
- **Type consistency**：`RunGroup`/`groupRuns`/`latestStats`/`historyMap` 在 Task 1 定义、Task 2 消费，签名一致；`historyMap` 返回 `Map<number, RunRow[]>` 与 Task 2 的 `historyOf.get(r.id)` 匹配；`latestStats` 返回 `DashboardData['stats']` 与 displayData 合并匹配。

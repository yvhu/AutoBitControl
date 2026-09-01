# 运行记录结束时间与总耗时 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板执行记录表格新增「结束时间」「总耗时」两列，总耗时由后端 `/api/dashboard` 计算（`durationSec` 派生字段，不落库）。

**Architecture:** 后端 dashboard 路由为每个 run 附加 `durationSec: number | null`（`startedAt/finishedAt` 墙钟字符串差值秒，任一缺失/解析失败为 null）并更新 Swagger；前端 `web/src/api/schema.d.ts` 手补该字段类型（沿用本项目既有手改先例），看板表格在「开始时间」后插入两列，耗时格式化抽纯函数配单测。

**Tech Stack:** Express 5 + swagger-jsdoc（后端）、supertest + vitest（后端测试）、React 18 + antd 5 + vitest/jsdom（前端）。

## Global Constraints

- 不落库、不改表结构、无迁移；`durationSec` 为派生字段
- 时间解析口径：`new Date(s.replace(' ', 'T')).getTime()`（与 src/app.ts 重试恢复一致）
- null 语义：`startedAt`/`finishedAt` 任一缺失或解析 NaN → `durationSec = null`
- 列顺序固定：`窗口 | 任务 | 开始时间 | 结束时间 | 总耗时 | 状态 | 尝试 | 错误 | 截图 | 操作`
- 耗时展示：null → `—`；`<60` → `Xs`；`>=60` → `Xm Ys`（秒为整数值）
- 提交风格：单行 `feat:/fix:/docs:/chore:` 前缀
- 测试命令：后端 `npx vitest run tests/web.test.ts`、`npm run typecheck`；前端 `npm --prefix web run test`、`npm --prefix web run build`
- 运行环境：Windows PowerShell 5.1；工作目录 `D:\StudySpace\AutoBitControl`，直接提交 `develop` 分支

---

### Task 1: 后端 dashboard 路由 durationSec

**Files:**
- Modify: `src/server/routes/dashboard.ts`（runs 映射附加字段 + Swagger 注解）
- Test: `tests/web.test.ts`（追加用例）

**Interfaces:**
- Consumes: `AppDb.listRunsForDate(date): Promise<RunRow[]>`（RunRow 含 `startedAt: string | null`、`finishedAt: string | null`）
- Produces: `/api/dashboard` 响应 runs item 增加 `durationSec: number | null`（Task 2/3 消费）

- [ ] **Step 1: 写失败测试**

`tests/web.test.ts` 在 `GET /api/dashboard 返回 {code:0,data:{stats,runs,profiles,...}}` 用例之后追加：

```ts
  it('GET /api/dashboard runs 附加 durationSec（started/finished 差值秒；缺失为 null）', async () => {
    const deps = makeDeps()
    deps.db.listRunsForDate.mockResolvedValue([
      { id: 1, profileId: 1, taskKey: 't1', date: '2026-08-28', status: 'success', attempts: 1, error: null, screenshot: null, startedAt: '2026-08-28 10:00:00.000', finishedAt: '2026-08-28 10:01:05.000', profileName: '窗口1' },
      { id: 2, profileId: 1, taskKey: 't2', date: '2026-08-28', status: 'running', attempts: 1, error: null, screenshot: null, startedAt: '2026-08-28 10:02:00.000', finishedAt: null, profileName: '窗口1' },
      { id: 3, profileId: 1, taskKey: 't3', date: '2026-08-28', status: 'pending', attempts: 0, error: null, screenshot: null, startedAt: null, finishedAt: null, profileName: '窗口1' },
    ])
    const res = await request(createApp(deps as never)).get('/api/dashboard?date=2026-08-28')
    expect(res.status).toBe(200)
    expect(res.body.data.runs[0].durationSec).toBe(65)
    expect(res.body.data.runs[1].durationSec).toBeNull()
    expect(res.body.data.runs[2].durationSec).toBeNull()
  })
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/web.test.ts`
Expected: FAIL（`durationSec` 为 undefined，`toBe(65)` 不成立）

- [ ] **Step 3: 最小实现**

`src/server/routes/dashboard.ts`：

1. 文件底部（router 定义前）新增辅助函数：

```ts
/** 运行耗时（秒）：started/finished 任一缺失或解析失败返回 null（墙钟字符串解析与重试恢复同口径） */
function runDurationSec(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null
  const s = new Date(startedAt.replace(' ', 'T')).getTime()
  const f = new Date(finishedAt.replace(' ', 'T')).getTime()
  if (Number.isNaN(s) || Number.isNaN(f)) return null
  return Math.round((f - s) / 1000)
}
```

2. 路由内 `const runs = await deps.db.listRunsForDate(date)` 改为：

```ts
    const runs = (await deps.db.listRunsForDate(date)).map((r) => ({ ...r, durationSec: runDurationSec(r.startedAt, r.finishedAt) }))
```

3. Swagger 注解 runs.items.properties 的 `finishedAt` 之后追加：

```
 *                           durationSec: { type: integer, nullable: true, description: '总耗时（秒）；startedAt/finishedAt 任一缺失为 null' }
```

（保持缩进与相邻行一致：`*                           <字段>` 三级缩进）

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/web.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/dashboard.ts tests/web.test.ts
git commit -m "feat: dashboard runs add durationSec derived field"
```

---

### Task 2: 前端 schema.d.ts 补 durationSec 类型

**Files:**
- Modify: `web/src/api/schema.d.ts`（dashboard 的 runs item 块）

**Interfaces:**
- Consumes: Task 1 的 `/api/dashboard` runs item 新字段
- Produces: `EnvelopeData<'/api/dashboard'>['runs'][number]` 含 `durationSec?: number | null`（Task 3 消费）

- [ ] **Step 1: 定位目标块**

`web/src/api/schema.d.ts` 中查找 `/api/dashboard` 的 runs item 定义块——含 `startedAt?: string | null;` 与 `finishedAt?: string | null;` 的同一 item 类型（本项目先例：interval 计划中 slot 字段即手补于此块）。

- [ ] **Step 2: 手补字段**

在 `finishedAt?: string | null;` 同一行下方追加（缩进与相邻行一致）：

```ts
                        durationSec?: number | null;
```

- [ ] **Step 3: 运行验证通过**

Run: `npm --prefix web run build`
Expected: 编译通过（`web/src/types.ts` 的 `RunRow` 自动带上 `durationSec`，无需改动）

- [ ] **Step 4: 提交**

```bash
git add web/src/api/schema.d.ts
git commit -m "feat: schema.d.ts add run durationSec field"
```

---

### Task 3: 看板表格两列 + 耗时格式化

**Files:**
- Create: `web/src/pages/dashboard/format.ts`
- Test: `web/src/pages/dashboard/format.test.ts`
- Modify: `web/src/pages/dashboard/index.tsx`（139-171 行的列定义区）

**Interfaces:**
- Consumes: Task 2 的 `RunRow.durationSec: number | null`、既有 `RunRow.finishedAt: string | null`
- Produces: `formatDuration(sec: number | null): string`（本任务内部消费，供表格列 render 使用）

- [ ] **Step 1: 写失败测试**

`web/src/pages/dashboard/format.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { formatDuration } from './format'

describe('formatDuration 总耗时展示', () => {
  it('null（无结束时间）→ —', () => {
    expect(formatDuration(null)).toBe('—')
  })
  it('60 秒以内 → Xs', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59)).toBe('59s')
  })
  it('60 秒及以上 → Xm Ys', () => {
    expect(formatDuration(60)).toBe('1m 0s')
    expect(formatDuration(92)).toBe('1m 32s')
    expect(formatDuration(605)).toBe('10m 5s')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npm --prefix web run test`
Expected: FAIL（`./format` 模块不存在）

- [ ] **Step 3: 最小实现**

`web/src/pages/dashboard/format.ts`：

```ts
/** 总耗时展示：null（无结束时间）→ '—'；60 秒以内 → 'Xs'；否则 → 'Xm Ys'（秒为整数值） */
export function formatDuration(sec: number | null): string {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npm --prefix web run test`
Expected: PASS

- [ ] **Step 5: 表格加两列**

`web/src/pages/dashboard/index.tsx`：

1. 顶部 import 区追加：`import { formatDuration } from './format'`

2. 列定义中「开始时间」列（165-170 行）之后插入两列：

```tsx
    {
      title: '结束时间',
      dataIndex: 'finishedAt',
      key: 'finishedAt',
      width: 130,
      render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—'),
    },
    {
      title: '总耗时',
      dataIndex: 'durationSec',
      key: 'durationSec',
      width: 90,
      render: (sec: number | null) => formatDuration(sec),
    },
```

- [ ] **Step 6: 运行验证通过**

Run: `npm --prefix web run test`；`npm --prefix web run build`
Expected: 前端测试与构建全绿

- [ ] **Step 7: 提交**

```bash
git add web/src/pages/dashboard/format.ts web/src/pages/dashboard/format.test.ts web/src/pages/dashboard/index.tsx
git commit -m "feat: dashboard runs table finish time + duration columns"
```

---

### Task 4: 全量回归与收尾

**Files:**
- 无（仅验证）

- [ ] **Step 1: 后端全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS（dashboard 新用例在内）

- [ ] **Step 2: 前端全量回归**

Run: `npm --prefix web run test`；`npm --prefix web run build`
Expected: 全部 PASS

- [ ] **Step 3: 提交（如有文档更新则一并）**

无文档变更则跳过提交；若 `docs/API-GUIDE.md` 需要补充 dashboard 字段说明，追加后：

```bash
git add docs/API-GUIDE.md
git commit -m "docs: dashboard runs durationSec"
```

---

## Self-Review

- **Spec coverage**：后端计算与 Swagger（Task 1）、前端类型（Task 2）、两列展示与列顺序（Task 3）、格式化纯函数与单测（Task 3）、null 语义与解析口径（Task 1 代码）、范围外不动 profiles 页（无对应任务，符合）、验证命令（Task 4）——全部覆盖。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency**：`durationSec: number | null` 在后端（Task 1）、schema.d.ts（Task 2）、formatDuration 签名（Task 3）三处一致；`runDurationSec` 仅 Task 1 内部使用。

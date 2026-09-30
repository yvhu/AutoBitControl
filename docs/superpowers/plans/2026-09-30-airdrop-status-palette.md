# 空投追踪状态列调色板实施计划（airdrop-status-palette）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板状态列头与管理状态列弹窗的色点从统一蓝色改为 8 色调色板按列顺序循环取色。

**Architecture:** 纯前端改动——`board.ts` 加 `STATUS_PALETTE` 常量与 `statusColor(index)` 纯函数；`StatusColumn` 改为接收 `color` prop（index.tsx 按渲染顺序传入）；`StatusManageModal` 行内圆点同函数取色。spec：`docs/superpowers/specs/2026-09-30-airdrop-status-palette-design.md`。

**Tech Stack:** React 18 + antd 5 + vitest（前端单测在 web workspace）。

## Global Constraints

- 注释全部中文；无分号、单引号、2 空格缩进；camelCase/kebab-case
- 调色板逐字：`['#2f54eb', '#d46b08', '#13a8a8', '#52c41a', '#8c959f', '#722ed1', '#eb2f96', '#a0d911']`
- `statusColor(index)` 实现必须保证负 index 安全：`STATUS_PALETTE[((index % STATUS_PALETTE.length) + STATUS_PALETTE.length) % STATUS_PALETTE.length]`
- 前端测试命令 `npm run test:web -- src/pages/airdrop`；web 类型验证 `npm run build:web`（预期仅 web/src/pages/profiles/index.tsx 2 个 HEAD 存量错误，airdrop 相关零错误）
- 每 Task 结束前相关测试全绿才 commit；commit 前缀 feat:

---

### Task 1: board.ts 调色板纯函数 + 单测

**Files:**
- Modify: `web/src/pages/airdrop/board.ts`
- Test: `web/src/pages/airdrop/board.test.ts`（追加 describe）

**Interfaces:**
- Produces（Task 2 依赖）：`STATUS_PALETTE: string[]`（8 色）、`statusColor(index: number): string`

- [ ] **Step 1: 写失败测试**

在 `web/src/pages/airdrop/board.test.ts` 末尾追加：

```ts
describe('statusColor', () => {
  it('前 8 列逐一取调色板原色', () => {
    for (let i = 0; i < 8; i++) expect(statusColor(i)).toBe(STATUS_PALETTE[i])
  })

  it('index 8/9 回绕到 0/1；负 index 安全回绕', () => {
    expect(statusColor(8)).toBe(STATUS_PALETTE[0])
    expect(statusColor(9)).toBe(STATUS_PALETTE[1])
    expect(statusColor(-1)).toBe(STATUS_PALETTE[7])
  })
})
```

并把文件顶部 import 行补上 `statusColor, STATUS_PALETTE`（现有 `import { deadlineBadge, diffDays, diffTodos, groupByStatus, reminderBannerText, todayLocal } from './board'` 追加两项）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web -- src/pages/airdrop/board.test.ts`
Expected: FAIL（`statusColor`/`STATUS_PALETTE` 未导出，编译/运行时错误）

- [ ] **Step 3: 实现**

在 `web/src/pages/airdrop/board.ts` 的「优先级展示元数据」段之前追加：

```ts
/** 状态列调色板（按列顺序循环取色；默认五列=蓝/橙/青/绿/灰） */
export const STATUS_PALETTE = ['#2f54eb', '#d46b08', '#13a8a8', '#52c41a', '#8c959f', '#722ed1', '#eb2f96', '#a0d911']

/** 按列顺序取色（index 循环回绕，负 index 安全） */
export function statusColor(index: number): string {
  return STATUS_PALETTE[((index % STATUS_PALETTE.length) + STATUS_PALETTE.length) % STATUS_PALETTE.length]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:web -- src/pages/airdrop`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/airdrop/board.ts web/src/pages/airdrop/board.test.ts
git commit -m "feat: 空投追踪状态列调色板纯函数（含单测）"
```

---

### Task 2: StatusColumn 传色 + StatusManageModal 圆点取色 + index.tsx 接线

**Files:**
- Modify: `web/src/pages/airdrop/StatusColumn.tsx`
- Modify: `web/src/pages/airdrop/StatusManageModal.tsx`
- Modify: `web/src/pages/airdrop/index.tsx`

**Interfaces:**
- Consumes：Task 1 的 `statusColor`/`STATUS_PALETTE`
- Produces：`StatusColumn` props 加 `color: string`（必填）；组件无单测（惯例）

- [ ] **Step 1: 改 StatusColumn.tsx**

（a）props 加 color：

```ts
export default function StatusColumn({ status, onAdd, color, children }: {
  status: AirdropStatusItem
  onAdd: () => void
  color: string
  children: ReactNode
}) {
```

（b）色点（第 30 行）改为：

```tsx
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }} />
```

- [ ] **Step 2: 改 index.tsx 渲染接线**

import 行补 `statusColor`（来自 './board'）；StatusColumn 渲染处改为：

```tsx
          {statuses.data.map((s, i) => (
            <StatusColumn key={s.id} status={s} color={statusColor(i)} onAdd={() => openCreate(s.id)}>
              {(grouped.get(s.id) ?? []).map((p) => (
                <ProjectCard key={p.id} project={p} onEdit={openEdit} />
              ))}
            </StatusColumn>
          ))}
```

- [ ] **Step 3: 改 StatusManageModal.tsx 圆点**

import 行加 `import { statusColor } from './board'`；行内圆点（第 52 行）改为：

```tsx
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(i), flex: 'none' }} />
```

- [ ] **Step 4: 验证**

Run: `npm run test:web`
Expected: PASS（全量前端测试）
Run: `npm run build:web`
Expected: 除 web/src/pages/profiles/index.tsx 2 个 HEAD 存量错误（TS2345/TS2322）外零错误

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/airdrop/StatusColumn.tsx web/src/pages/airdrop/StatusManageModal.tsx web/src/pages/airdrop/index.tsx
git commit -m "feat: 状态列色点按调色板循环取色"
```

---

## Self-Review 结论

- **Spec 覆盖**：STATUS_PALETTE/statusColor（Task 1）✓；StatusColumn 色点换色（Task 2）✓；StatusManageModal 圆点（Task 2）✓；index.tsx 接线（Task 2）✓；负 index 安全（Task 1 实现公式 + 测试）✓；换序后颜色随位置（按渲染 index 取色，天然满足）✓；文档不改（spec 已定）✓
- **占位符扫描**：无 TBD/TODO；全部步骤含完整代码
- **类型一致性**：`statusColor(index: number): string` 与 `color: string` prop 一致；index.tsx 的 `statuses.data.map((s, i) => ...)` 与 StatusManageModal 的 `statuses.map((s, i) => ...)` 两处取色口径一致（均按渲染顺序）

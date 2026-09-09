# 任务页分组重设计（rev2 方案 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务页的 ghost Collapse 折叠树替换为彩色图标卡片分区（方案 A），新增「全部展开/全部收起」按钮，默认全部收起。

**Architecture:** 纯展示改动，仅动 `web/src/pages/tasks/`（hooks.ts 加配色/切换纯函数 + index.tsx 重写渲染）与文档。后端/定时页/看板不动。

**Tech Stack:** React 18 + antd 5（theme.useToken 适配深浅色）、vitest（`npm run test:web`）、TypeScript 严格模式（无分号、单引号、2 空格、中文注释）。

**Spec:** `docs/superpowers/specs/2026-09-09-task-grouping-design.md` rev2 章节

## Global Constraints

- 默认全部收起（`useState<string[]>([])`）
- 组头：渐变图标块（组名首字白字）+ 组名 strong + 「N 个任务」+ ▲/▼；整行点击切换
- 配色：shelby `#1677FF`、inception `#52c41a`、portal `#faad14`、arc `#722ed1`、example `#8c8c8c`；未知组回退色 `['#13c2c2', '#eb2f96', '#fa541c', '#2f54eb', '#a0d911', '#7cb305']` 按索引轮换；渐变 `linear-gradient(135deg, 主色, 主色b3)`
- 按钮禁用：全部展开后「全部展开」禁用；无展开时「全部收起」禁用
- flat（全部未分组）时保持平铺网格、无工具栏
- 容器不硬编码 #fff，用 `theme.useToken()` 取 token
- 移除 Collapse 及 defaultActiveKey；TaskCard 本体不改
- 只改 tasks/hooks.ts、tasks/hooks.test.ts、tasks/index.tsx、docs/API-GUIDE.md 四个文件（按任务分批提交）
- commit 风格 `feat:`/`docs:` + 中文描述；验证 `npm run test:web` + `npm --prefix web exec tsc -b`

---

### Task 9: 配色与切换纯函数

**Files:**
- Modify: `web/src/pages/tasks/hooks.ts`（追加导出）
- Modify: `web/src/pages/tasks/hooks.test.ts`（追加测试）

**Interfaces:**
- Produces: `GROUP_COLOR_MAP: Record<string, string>`；`groupColor(key: string, index: number): string`；`toggleKey(keys: string[], key: string): string[]`

- [ ] **Step 1: 写失败测试**

`web/src/pages/tasks/hooks.test.ts` 文件末尾追加：

```ts
import { GROUP_COLOR_MAP, groupColor, toggleKey } from './hooks'

describe('groupColor', () => {
  it('已知分组取固定色', () => {
    expect(groupColor('shelby', 0)).toBe('#1677FF')
    expect(groupColor('inception', 0)).toBe('#52c41a')
    expect(groupColor('portal', 0)).toBe('#faad14')
    expect(groupColor('arc', 0)).toBe('#722ed1')
    expect(groupColor('example', 0)).toBe('#8c8c8c')
  })

  it('未知分组按索引轮换回退色', () => {
    expect(groupColor('unknown-a', 0)).toBe('#13c2c2')
    expect(groupColor('unknown-b', 1)).toBe('#eb2f96')
  })

  it('索引超出回退色数组长度时取模轮换', () => {
    expect(groupColor('unknown-c', 6)).toBe('#13c2c2')
    expect(groupColor('unknown-d', 7)).toBe('#eb2f96')
  })

  it('GROUP_COLOR_MAP 五个已知分组齐全', () => {
    expect(Object.keys(GROUP_COLOR_MAP).sort()).toEqual(['arc', 'example', 'inception', 'portal', 'shelby'])
  })
})

describe('toggleKey', () => {
  it('不存在时追加到末尾', () => {
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('存在时移除且其余顺序不变', () => {
    expect(toggleKey(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:web`
Expected: groupColor/toggleKey 用例 FAIL（未导出）

- [ ] **Step 3: 实现纯函数**

`web/src/pages/tasks/hooks.ts` 在 `groupTasks` 之后追加：

```ts
/** 分组图标配色：已知分组固定色（与面板 mockup 一致），未知分组按出现顺序回退 */
export const GROUP_COLOR_MAP: Record<string, string> = {
  shelby: '#1677FF',
  inception: '#52c41a',
  portal: '#faad14',
  arc: '#722ed1',
  example: '#8c8c8c',
}

const FALLBACK_GROUP_COLORS = ['#13c2c2', '#eb2f96', '#fa541c', '#2f54eb', '#a0d911', '#7cb305']

/** 分组图标底色：已知分组取固定色，未知分组按索引取模轮换回退色 */
export function groupColor(key: string, index: number): string {
  return GROUP_COLOR_MAP[key] ?? FALLBACK_GROUP_COLORS[index % FALLBACK_GROUP_COLORS.length]
}

/** 展开键集合切换：存在则移除，不存在则追加（其余顺序不变） */
export function toggleKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
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
git commit -m "feat: 任务分组配色与展开切换纯函数"
```

---

### Task 10: 任务页卡片分区重写

**Files:**
- Modify: `web/src/pages/tasks/index.tsx`

**Interfaces:**
- Consumes: `groupTasks`、`groupColor`、`toggleKey`（Task 2/9）
- Produces: 任务页卡片分区渲染（默认收起、全部展开/收起按钮、组头渐变图标块）

- [ ] **Step 1: 修改导入**

第 2 行 antd 导入去掉 `Collapse`、加 `theme`：

```tsx
import { Button, Card, Col, Empty, Row, Space, Spin, Switch, Tag, Typography, theme } from 'antd'
```

第 5-11 行 hooks 导入加 `groupColor, toggleKey`：

```tsx
import {
  categoryColor,
  categoryLabel,
  groupColor,
  groupTasks,
  toggleKey,
  useSetTaskEnabled,
  useTasks,
  useTriggerTask,
} from './hooks'
```

在 TaskCard 组件之后、TasksPage 之前新增 GroupCard 组件：

```tsx
function GroupCard({ group, color, open, onToggle }: { group: TaskGroup; color: string; open: boolean; onToggle: () => void }) {
  const { token } = theme.useToken()
  return (
    <div style={{ background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', cursor: 'pointer' }} onClick={onToggle}>
        <span style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${color}, ${color}b3)`, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flexShrink: 0 }}>
          {group.name.charAt(0)}
        </span>
        <Typography.Text strong>{group.name}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{group.tasks.length} 个任务</Typography.Text>
        <span style={{ marginLeft: 'auto', color: token.colorTextTertiary, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <Row gutter={[12, 12]} align="stretch" style={{ padding: '0 12px 12px' }}>
          {group.tasks.map((t) => (
            <Col key={t.key} xs={24} xl={12}>
              <TaskCard task={t} />
            </Col>
          ))}
        </Row>
      )}
    </div>
  )
}
```

同时从 `./hooks` 类型导入 `TaskGroup`（第 5-11 行 import 追加 `type TaskGroup`，与现有 `categoryColor...` 同一条 import 内写成 `type TaskGroup`）。

- [ ] **Step 2: 替换 TasksPage 渲染块**

把第 131-144 行（rev1 的 Collapse 渲染块）整体替换为：

```tsx
  const groups = groupTasks(tasks.data)
  const flat = groups.length === 1 && groups[0].key === ''
  const [openKeys, setOpenKeys] = useState<string[]>([])
  const allOpen = groups.length > 0 && openKeys.length >= groups.length

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
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Typography.Text>任务分组</Typography.Text>
            <Space size={8} style={{ marginLeft: 'auto' }}>
              <Button size="small" disabled={allOpen} onClick={() => setOpenKeys(groups.map((g) => g.key))}>全部展开</Button>
              <Button size="small" disabled={openKeys.length === 0} onClick={() => setOpenKeys([])}>全部收起</Button>
            </Space>
          </div>
          {groups.map((g, i) => (
            <GroupCard key={g.key} group={g} color={groupColor(g.key, i)} open={openKeys.includes(g.key)} onToggle={() => setOpenKeys((keys) => toggleKey(keys, g.key))} />
          ))}
        </>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        → 任务定义在代码（src/tasks），开关与触发在此页管理
      </Typography.Text>
    </Space>
  )
}
```

注意：`const groups`/`const flat`/`openKeys` 声明放 Empty 分支（tasks.data 判空返回）之后、return 之前；`useState` 不能放在条件返回之后调用规则——本页 Empty 分支在 hook 调用之前 return 会造成 hook 顺序问题，因此把 `useState` 移到组件顶部（与 `tasks = useTasks()` 并列），即：

```tsx
export default function TasksPage() {
  const tasks = useTasks()
  const [openKeys, setOpenKeys] = useState<string[]>([])
  ...
```

（`groups`/`flat`/`allOpen` 为普通变量，仍放 Empty 分支之后。）

- [ ] **Step 3: 测试与类型检查**

Run: `npm run test:web` 和 `npm --prefix web exec tsc -b`
Expected: 全部 PASS、零错误（tasks/hooks.test.ts 的 groupTasks/groupColor/toggleKey 用例继续通过）

- [ ] **Step 4: 提交**

```powershell
git add web/src/pages/tasks/index.tsx
git commit -m "feat: 任务页改为彩色图标卡片分区并支持一键展开收起"
```

---

### Task 11: 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md`（9.2 任务页条目）

- [ ] **Step 1: 改写任务页条目**

定位 9.2 面板使用章节的任务页条目（当前以「任务按空投分组折叠展示（Collapse 分区，组标题为「分组名 · N 个任务」，默认全展开；…」开头，位于约第 1157 行），把开头描述替换为：

```
任务按空投分组卡片分区展示：每组一张卡片，组头为彩色渐变图标块（组名首字）＋组名＋任务数，点击组头展开/收起；顶部「全部展开」「全部收起」按钮一键切换，默认全部收起；未写 group 的任务归入末尾「未分组」组；全部任务都未分组时保持平铺网格。
```

保留条目后续原文（「组内任务卡片网格（每卡两列，行内卡片等高），卡片含…」起）不变。

- [ ] **Step 2: 提交**

```powershell
git add docs/API-GUIDE.md
git commit -m "docs: 任务页卡片分区设计文档同步"
```

---

### Task 12: 全量验证

- [ ] **Step 1: 四个验证命令全过**

```powershell
npm run typecheck
npm test
npm run test:web
npm --prefix web exec tsc -b
```

Expected: 全部零错误、全部 PASS

- [ ] **Step 2: 手动验收（npm run dev）**

任务页：5 张分组卡片默认收起（组头渐变图标块）；点组头展开/收起；「全部展开/收起」按钮与禁用逻辑正确；深色模式切换无白底问题；定时页/看板不受影响

---

## 自审记录

- Spec 覆盖：rev2 需求（卡片分区/默认收起/一键按钮/配色/禁用逻辑/flat 回退/token 适配/文档）均有对应任务
- 类型一致性：`GROUP_COLOR_MAP`/`groupColor(key,index)`/`toggleKey(keys,key)`/`TaskGroup` 全计划命名一致
- 无占位符；Hook 规则（useState 位置）在 Task 10 Step 2 已显式说明

# 窗口页移除详情抽屉实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除窗口页详情抽屉，重置熔断移入表格操作列（仅熔断计数 > 0 时显示），同步后端注释与 API-GUIDE 文档。

**Architecture:** 纯 UI 层收缩：`web/src/pages/profiles/index.tsx` 删 Drawer 与两行提示，操作列「详情」替换为条件渲染的「重置熔断」链接按钮（复用现有 `useResetBreaker` hook 与 `POST /api/profiles/:id/breaker/reset` 接口，后端零改动）。

**Tech Stack:** React 18 + antd 5 + react-query + vitest（前端 web/ 一套；后端 TS 仅注释改动）。

## Global Constraints

- 无分号、单引号、2 空格缩进；中文注释；commit 用 conventional 中文（`feat:`/`fix:`/`docs:`）
- 每个任务结束必须 `npm run typecheck` 与 `npm run test:web` 通过
- 后端接口 `POST /api/profiles/:id/breaker/reset` 与 `useResetBreaker` hook 逻辑不改，仅调用点迁移
- 两行提示文本（「今日运行请查看运行批次页」「钱包解锁密码说明」）直接删除，不找新位置
- 不动历史文档（docs/superpowers/specs/*、docs/superpowers/plans/*）
- 本项目页面组件无单测先例：本任务无新逻辑，不加组件测试；现有 hooks 测试保持绿
- 执行期间 commit 已获用户授权

---

### Task 1: 移除详情抽屉 + 重置熔断入操作列 + 注释/文档同步

**Files:**
- Modify: `web/src/pages/profiles/index.tsx`
- Modify: `src/server/routes/profiles.ts:216`
- Modify: `docs/API-GUIDE.md:1108`

**Interfaces:**
- Consumes: 现有 `useResetBreaker()`（web/src/pages/profiles/hooks.ts，返回 react-query mutation，`isPending`/`variables`/`mutate(id)`），`ProfileRow.circuitBreakerCount: number`
- Produces: 无新接口；操作列新增条件按钮，后端无变化

- [ ] **Step 1: 修改 web/src/pages/profiles/index.tsx**

1. 导入区（1-18 行）删除 `Drawer`（第 7 行）与 `ReloadOutlined`（第 18 行）：

```tsx
import { useMemo, useState } from 'react'
import {
  App,
  Avatar,
  Button,
  Card,
  Empty,
  Input,
  Progress,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd'
import { CopyOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons'
```

2. 删除 `detailId` state（第 37 行整行）：

```tsx
  const [detailId, setDetailId] = useState<number | null>(null)
```

3. 操作列（179-205 行）宽度 300 → 240，「详情」按钮替换为条件渲染的「重置熔断」：

```tsx
    {
      title: '操作',
      key: 'action',
      width: 240,
      render: (_, p) => {
        const toggling = (open.isPending && open.variables === p.id) || (close.isPending && close.variables === p.id)
        return (
          <Space size="small">
            <Button
              type="link"
              size="small"
              danger={p.open}
              loading={toggling}
              onClick={() => (p.open ? close.mutate(p.id) : open.mutate(p.id))}
            >
              {p.open ? '关闭' : '打开'}
            </Button>
            <Button type="link" size="small" icon={<CopyOutlined />} onClick={() => copyId(p.bitbrowserId)}>
              复制ID
            </Button>
            {p.circuitBreakerCount > 0 && (
              <Button
                type="link"
                size="small"
                loading={reset.isPending && reset.variables === p.id}
                onClick={() => reset.mutate(p.id)}
              >
                重置熔断
              </Button>
            )}
          </Space>
        )
      },
    },
```

4. 删除 `detail` 计算（第 208 行整行）：

```tsx
  const detail = detailId != null ? (profiles.data ?? []).find((p) => p.id === detailId) : undefined
```

5. 删除 Drawer 块（243-267 行，`<Drawer ...>` 到 `</Drawer>` 整块，含两行提示与重置按钮）

- [ ] **Step 2: 修改 src/server/routes/profiles.ts 注释**

第 216 行：

```ts
    // 手动重置熔断：面板详情抽屉入口（连续失败恢复后放行）
```

改为：

```ts
    // 手动重置熔断：面板窗口操作列入口（连续失败恢复后放行）
```

- [ ] **Step 3: 修改 docs/API-GUIDE.md 窗口页描述**

第 1108 行整行替换为（操作列描述去掉 Drawer，顺带修正窗口表列清单中已不存在的「今日成功/失败数」——该列已在运行批次计划中移除）：

```markdown
- **窗口页**：搜索框（按名字/窗口 ID 过滤）＋「同步比特浏览器」按钮（拉取比特客户端窗口列表入库，含备注/序号/最近 IP/国家/内核版本元数据）＋ 窗口表（窗口名/序号、备注、IP、国家、内核、熔断计数与进度条、启用开关、操作列；表头可排序）。操作列含「打开/关闭」按钮（打开即拉起比特窗口并登记 `open_windows` 表，任务会话复用该窗口、结束后不关窗；再点一次关闭）、行内「复制ID」一键复制比特窗口 ID 到剪贴板；熔断计数 > 0 时显示「重置熔断」按钮（点击计数归零，按钮随之消失）。
```

- [ ] **Step 4: 类型检查与前端测试**

Run: `npm run typecheck`
Expected: 无错误

Run: `npm run test:web`
Expected: 9 个测试文件全部 PASS（hooks 无逻辑变化，纯回归确认）

- [ ] **Step 5: 搜索确认无残留**

用项目内搜索确认 `web/src/pages/profiles/` 与 `src/server/routes/profiles.ts` 中不再出现「详情」「Drawer」「detailId」（历史 plans/specs 除外）

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/profiles/index.tsx src/server/routes/profiles.ts docs/API-GUIDE.md
git commit -m "feat: 窗口页移除详情抽屉，重置熔断移入操作列（仅熔断计数>0 显示）"
```

---

### Task 2: 全量验证

**Files:**
- 无代码改动（仅验证）

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 2: 前端全量测试**

Run: `npm run test:web`
Expected: 全部 PASS

- [ ] **Step 3: 后端回归**

Run: `npm test`
Expected: 全部 PASS（后端仅注释改动，回归确认）

- [ ] **Step 4: 本地冒烟（可选，需真实环境）**

Run: `npm run dev`
Expected: 窗口页无「详情」入口；熔断计数 > 0 的行显示「重置熔断」，点击后计数归零且按钮消失；两行提示不再出现

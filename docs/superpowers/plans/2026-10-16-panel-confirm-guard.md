# 面板关键操作二次确认 + 防重复点击 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给面板的破坏性/高成本操作加统一二次确认，并统一防重复点击（提交中禁用 + 完成后短冷却）。

**Architecture:** 新增两个前端公共件——`ConfirmButton`（带确认的按钮）与 `useGuardedMutation`（去重 mutation）；页面按 A+B 档把对应按钮替换成 `ConfirmButton`，非 Button 入口（下拉菜单/复选框）用 `modal.confirm` + `useGuardedMutation`。纯前端交互，后端零改动。

**Tech Stack:** React 18、antd 5、@tanstack/react-query 5、vitest + @testing-library/react。

## Global Constraints

- 仅改 `web/`；不改后端/DB/任务代码。
- 代码风格：无分号、单引号、2 空格缩进、中文注释。
- 确认文案中文；危险操作确认按钮 `okText` 用「删除/停止/确认」，取消「取消」；`danger` 透传到确认按钮。
- 防重复冷却时长常量 `600ms`。
- 每个 Task 结束跑：`npm --prefix web run build`（tsc -b + vite build，等价类型检查）与 `npm run test:web`。
- 设计依据：`docs/superpowers/specs/2026-10-16-panel-confirm-guard-design.md`。

---

## 文件结构

- 新增 `web/src/components/ConfirmButton.tsx`（确认按钮）、`web/src/components/ConfirmButton.test.tsx`
- 新增 `web/src/components/useGuardedMutation.ts`（去重 mutation）、`web/src/components/useGuardedMutation.test.tsx`
- 修改页面：`dashboard/index.tsx`、`profiles/index.tsx`、`tasks/index.tsx`、`schedules/index.tsx`、`tools/file-assign.tsx`、`settings/index.tsx`、`airdrop/ProjectCard.tsx`、`airdrop/StatusManageModal.tsx`
- 修改测试：`web/src/pages/tasks/TasksPage.test.tsx`

---

### Task 1: `useGuardedMutation`（去重 mutation hook）

**Files:**
- Create: `web/src/components/useGuardedMutation.ts`
- Test: `web/src/components/useGuardedMutation.test.tsx`

**Interfaces:**
- Produces: `useGuardedMutation(options, opts?)` → `UseMutationResult & { run(vars): void }`（`run` 在 pending 或完成后 `cooldownMs` 内忽略重复调用）。

- [ ] **Step 1: Write the failing test**

`web/src/components/useGuardedMutation.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useGuardedMutation } from './useGuardedMutation'

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useGuardedMutation', () => {
  it('pending 期间忽略重复 run', async () => {
    const client = new QueryClient()
    let resolve: (v: unknown) => void = () => {}
    const mutationFn = vi.fn(() => new Promise<unknown>((r) => { resolve = r }))
    const { result } = renderHook(() => useGuardedMutation({ mutationFn }), { wrapper: wrapper(client) })
    act(() => { result.current.run(1); result.current.run(2) })
    expect(mutationFn).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(null) })
  })

  it('完成后 cooldownMs 内忽略重复，冷却后恢复', async () => {
    const client = new QueryClient()
    const mutationFn = vi.fn().mockResolvedValue(null)
    const { result } = renderHook(() => useGuardedMutation({ mutationFn }, { cooldownMs: 50 }), { wrapper: wrapper(client) })
    await act(async () => { result.current.run(1) })
    await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1))
    act(() => { result.current.run(2) })
    expect(mutationFn).toHaveBeenCalledTimes(1) // 冷却内
    await new Promise((r) => setTimeout(r, 60))
    await act(async () => { result.current.run(3) })
    expect(mutationFn).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- useGuardedMutation`
Expected: FAIL（模块不存在 / 未导出）

- [ ] **Step 3: Write minimal implementation**

`web/src/components/useGuardedMutation.ts`：

```ts
/**
 * useGuardedMutation（web 公共）：包装 useMutation，pending 或完成后 cooldownMs 内忽略重复 run
 * 依赖方向：仅依赖 @tanstack/react-query 与 react
 * 设计思路：非 Button 入口（Switch/菜单项/复选框）不便用加载态禁用，用本 hook 在逻辑层去重
 */
import { useCallback, useRef } from 'react'
import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query'

const DEFAULT_COOLDOWN_MS = 600

export function useGuardedMutation<TData, TError, TVariables, TContext>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  opts: { cooldownMs?: number } = {},
): UseMutationResult<TData, TError, TVariables, TContext> & { run: (vars: TVariables) => void } {
  const mutation = useMutation(options)
  const busyRef = useRef(false)
  const coolUntilRef = useRef(0)
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const mutate = mutation.mutate
  const run = useCallback((vars: TVariables) => {
    if (busyRef.current || Date.now() < coolUntilRef.current) return
    busyRef.current = true
    mutate(vars, {
      onSettled: () => {
        busyRef.current = false
        coolUntilRef.current = Date.now() + cooldownMs
      },
    })
  }, [mutate, cooldownMs])
  return { ...mutation, run }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- useGuardedMutation`
Expected: PASS（2 项）

- [ ] **Step 5: Commit**

```bash
git add web/src/components/useGuardedMutation.ts web/src/components/useGuardedMutation.test.tsx
git commit -m "feat(web): 新增 useGuardedMutation（mutation 去重 + 冷却防连点）"
```

---

### Task 2: `ConfirmButton`（带二次确认的按钮）

**Files:**
- Create: `web/src/components/ConfirmButton.tsx`
- Test: `web/src/components/ConfirmButton.test.tsx`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  interface ConfirmConfig { title: ReactNode; description?: ReactNode; okText?: string; cancelText?: string; mode?: 'popconfirm' | 'modal' }
  interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick'> { confirm: ConfirmConfig; onConfirm: () => void | Promise<void> }
  export default function ConfirmButton(props: ConfirmButtonProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

`web/src/components/ConfirmButton.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App } from 'antd'
import type { ReactElement } from 'react'
import ConfirmButton from './ConfirmButton'

function renderInApp(ui: ReactElement) {
  return render(<App>{ui}</App>)
}

describe('ConfirmButton', () => {
  it('popconfirm：点确认才执行，取消不执行', async () => {
    const onConfirm = vi.fn()
    renderInApp(
      <ConfirmButton confirm={{ title: '确认删除？', okText: 'OK', cancelText: 'Cancel' }} onConfirm={onConfirm}>删除</ConfirmButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await screen.findByText('确认删除？')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await screen.findByText('确认删除？')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('modal：确认后执行', async () => {
    const onConfirm = vi.fn()
    renderInApp(
      <ConfirmButton confirm={{ title: '确认停止？', mode: 'modal', okText: 'OK', cancelText: 'Cancel' }} onConfirm={onConfirm}>停止</ConfirmButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await screen.findByText('确认停止？')
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('执行中按钮禁用（busy），onConfirm 未结束不重复执行', async () => {
    let resolve: () => void = () => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    renderInApp(
      <ConfirmButton confirm={{ title: '确认？', okText: 'OK', cancelText: 'Cancel' }} onConfirm={onConfirm}>go</ConfirmButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    await screen.findByText('确认？')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    resolve()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- ConfirmButton`
Expected: FAIL（模块不存在 / 未导出）

- [ ] **Step 3: Write minimal implementation**

`web/src/components/ConfirmButton.tsx`：

```tsx
/**
 * ConfirmButton（web 公共）：带二次确认 + 防重复的按钮
 * - popconfirm 模式：行内小按钮；modal 模式：工具栏/下拉/卡片级
 * - onConfirm 执行期间按钮与确认 OK 均 loading 且禁用；完成后 cooldownMs 内禁用（吞连点）
 * 依赖方向：依赖 antd 与 react
 */
import { useState, type ReactNode } from 'react'
import { App, Button, Popconfirm, type ButtonProps } from 'antd'

const COOLDOWN_MS = 600

export interface ConfirmConfig {
  title: ReactNode
  description?: ReactNode
  okText?: string
  cancelText?: string
  mode?: 'popconfirm' | 'modal'
}

export interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick'> {
  confirm: ConfirmConfig
  onConfirm: () => void | Promise<void>
}

export default function ConfirmButton({ confirm, onConfirm, loading, disabled, ...buttonProps }: ConfirmButtonProps) {
  const { modal } = App.useApp()
  const [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setCooling(true)
      setTimeout(() => setCooling(false), COOLDOWN_MS)
    }
  }

  const blocked = !!disabled || busy || cooling
  const btn = <Button {...buttonProps} loading={loading || busy} disabled={blocked} />

  if (confirm.mode === 'modal') {
    return (
      <Button
        {...buttonProps}
        loading={loading || busy}
        disabled={blocked}
        onClick={() => {
          if (blocked) return
          modal.confirm({
            title: confirm.title,
            content: confirm.description,
            okText: confirm.okText ?? '确认',
            cancelText: confirm.cancelText ?? '取消',
            okButtonProps: { danger: buttonProps.danger },
            onOk: run,
          })
        }}
      />
    )
  }
  return (
    <Popconfirm
      title={confirm.title}
      description={confirm.description}
      okText={confirm.okText ?? '确认'}
      cancelText={confirm.cancelText ?? '取消'}
      okButtonProps={{ danger: buttonProps.danger, loading: busy }}
      disabled={blocked}
      onConfirm={run}
    >
      {btn}
    </Popconfirm>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- ConfirmButton`
Expected: PASS（3 项）

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ConfirmButton.tsx web/src/components/ConfirmButton.test.tsx
git commit -m "feat(web): 新增 ConfirmButton（二次确认 + 防重复点击）"
```

---

### Task 3: 看板停止加确认（批次级 + 行级）

**Files:**
- Modify: `web/src/pages/dashboard/index.tsx`

**Interfaces:**
- Consumes: `ConfirmButton`（Task 2）

- [ ] **Step 1: 加导入**

在 `web/src/pages/dashboard/index.tsx` 顶部 import 增加：

```tsx
import ConfirmButton from '../../components/ConfirmButton'
```

- [ ] **Step 2: RunsTable 行级「停止」换成 ConfirmButton**

`RunsTable` 内（约 78-81 行）：

```tsx
{r.inFlight ? (
  <ConfirmButton
    type="link"
    size="small"
    danger
    confirm={{ title: `停止窗口「${r.profileName}」的任务？`, okText: '停止' }}
    loading={stop.isPending && stop.variables === r.id}
    onConfirm={() => stop.mutate(r.id)}
  >
    停止
  </ConfirmButton>
) : (
  <Button type="link" size="small" loading={trigger.isPending && trigger.variables?.bitbrowserId === r.bitbrowserId} disabled={!r.bitbrowserId} onClick={() => { if (r.bitbrowserId) trigger.mutate({ key: r.taskKey, bitbrowserId: r.bitbrowserId }) }}>
    {r.status === 'failed' || r.status === 'captcha_failed' ? '重跑' : '执行'}
  </Button>
)}
```

- [ ] **Step 3: BatchCard 批次级「停止」换成 ConfirmButton（阻止冒泡到卡片展开）**

`BatchCard` 内（约 114-126 行）：

```tsx
{batchInFlight(batch) && (
  <span onClick={(e) => e.stopPropagation()}>
    <ConfirmButton
      size="small"
      danger
      confirm={{ title: '停止该批次？在途窗口会被中止', okText: '停止' }}
      loading={stop.isPending && stop.variables === batch.id}
      onConfirm={() => stop.mutate(batch.id)}
    >
      停止
    </ConfirmButton>
  </span>
)}
```

- [ ] **Step 4: SingleBatchRow 行级「停止」换成 ConfirmButton**

`SingleBatchRow` 内（约 174-177 行）：

```tsx
{r.inFlight ? (
  <ConfirmButton
    type="link"
    size="small"
    danger
    confirm={{ title: `停止窗口「${r.profileName}」的任务？`, okText: '停止' }}
    loading={stop.isPending && stop.variables === r.id}
    onConfirm={() => stop.mutate(r.id)}
  >
    停止
  </ConfirmButton>
) : (
  <Button type="link" size="small" loading={trigger.isPending && trigger.variables?.bitbrowserId === r.bitbrowserId} disabled={!r.bitbrowserId} onClick={() => { if (r.bitbrowserId) trigger.mutate({ key: batch.taskKey, bitbrowserId: r.bitbrowserId }) }}>
    {r.status === 'failed' || r.status === 'captcha_failed' ? '重跑' : '执行'}
  </Button>
)}
```

- [ ] **Step 5: 验证 + 提交**

Run: `npm --prefix web run build`
Expected: 编译通过

```bash
git add web/src/pages/dashboard/index.tsx
git commit -m "feat(web): 看板停止（批次/行级）加二次确认"
```

---

### Task 4: 窗口页关闭/打开加确认

**Files:**
- Modify: `web/src/pages/profiles/index.tsx`

**Interfaces:**
- Consumes: `ConfirmButton`（Task 2）

- [ ] **Step 1: 加导入**

```tsx
import ConfirmButton from '../../components/ConfirmButton'
```

- [ ] **Step 2: 单窗口「关闭」加确认（「打开」保持普通按钮）**

操作列（约 200-209 行）`<Space>` 内第一个元素改为：

```tsx
{p.open ? (
  <ConfirmButton
    type="link"
    size="small"
    danger
    confirm={{ title: `关闭窗口「${p.name}」？`, okText: '关闭' }}
    loading={close.isPending && close.variables === p.id}
    onConfirm={() => close.mutate(p.id)}
  >
    关闭
  </ConfirmButton>
) : (
  <Button type="link" size="small" loading={open.isPending && open.variables === p.id} onClick={() => open.mutate(p.id)}>
    打开
  </Button>
)}
```

同时删除该列顶部不再使用的 `const toggling = ...`（若仅此一处使用）。

- [ ] **Step 3: 批量「关闭」加确认、「打开」加确认**

工具栏（约 251-264 行）两个按钮改为：

```tsx
<ConfirmButton
  disabled={selectedRowKeys.length === 0}
  loading={batch.isPending && batch.variables?.action === 'open'}
  confirm={{ title: `打开选中的 ${selectedRowKeys.length} 个窗口？`, mode: 'modal' }}
  onConfirm={() => batch.mutate({ action: 'open', ids: selectedRowKeys.map(Number) })}
>
  批量打开
</ConfirmButton>
<ConfirmButton
  danger
  disabled={selectedRowKeys.length === 0}
  loading={batch.isPending && batch.variables?.action === 'close'}
  confirm={{ title: `关闭选中的 ${selectedRowKeys.length} 个窗口？`, mode: 'modal', okText: '关闭' }}
  onConfirm={() => batch.mutate({ action: 'close', ids: selectedRowKeys.map(Number) })}
>
  批量关闭
</ConfirmButton>
```

> `ConfirmButton` 的确认交互由 `confirm.mode` 决定（`'modal'` 走 `modal.confirm`），不要给按钮本体传 `mode` 属性。

- [ ] **Step 4: 验证 + 提交**

Run: `npm --prefix web run build`
Expected: 编译通过

```bash
git add web/src/pages/profiles/index.tsx
git commit -m "feat(web): 窗口打开/关闭、批量打开/关闭加二次确认"
```

---

### Task 5: 工具「执行分配」「立即执行一次」加确认

**Files:**
- Modify: `web/src/pages/tools/file-assign.tsx`

**Interfaces:**
- Consumes: `ConfirmButton`（Task 2）

- [ ] **Step 1: 加导入**

```tsx
import ConfirmButton from '../../components/ConfirmButton'
```

- [ ] **Step 2: 「执行分配」加确认**

（约 162-169 行）：

```tsx
<div>
  <ConfirmButton
    type="primary"
    danger
    disabled={!plan}
    loading={apply.isPending}
    confirm={{ title: '执行文件分配？', description: '会按预览改名文件并写回 Excel，不可撤销', mode: 'modal', okText: '执行' }}
    onConfirm={doApply}
  >
    执行分配
  </ConfirmButton>
  <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
    执行前需先生成并确认预览
  </Typography.Text>
</div>
```

> `mode: 'modal'` 写在 `confirm` 里（确认交互走 `modal.confirm`），按钮本体不传 `mode`。

- [ ] **Step 3: 「立即执行一次」加确认**

（约 222-228 行）：

```tsx
<ConfirmButton
  loading={runSchedule.isPending}
  disabled={!schedule || !schedule.enabled}
  confirm={{ title: '立即执行一次文件分配？', okText: '执行' }}
  onConfirm={() => { if (schedule) runSchedule.mutate(schedule.id) }}
>
  立即执行一次
</ConfirmButton>
```

- [ ] **Step 4: 验证 + 提交**

Run: `npm --prefix web run build`
Expected: 编译通过

```bash
git add web/src/pages/tools/file-assign.tsx
git commit -m "feat(web): 文件分配「执行分配/立即执行一次」加二次确认"
```

---

### Task 6: 任务「立即触发」加确认（含页面测试）

**Files:**
- Modify: `web/src/pages/tasks/index.tsx`
- Modify: `web/src/pages/tasks/TasksPage.test.tsx`

**Interfaces:**
- Consumes: `ConfirmButton`（Task 2）

- [ ] **Step 1: 写失败测试**

在 `web/src/pages/tasks/TasksPage.test.tsx` 末尾 `describe` 内新增（复用文件已有的 `renderPage`/`fetchTasks` mock；需 mock `triggerTask`）：

```tsx
it('点「立即触发」需经二次确认才调用触发接口', async () => {
  vi.mocked(fetchTasks).mockResolvedValue([
    { key: 'a', name: '启用任务', enabled: true },
  ] as unknown as TaskMetaView[])
  renderPage()
  const btn = await screen.findByRole('button', { name: /立即触发/ })
  fireEvent.click(btn)
  // 确认弹窗出现前不调用接口
  expect(vi.mocked(triggerTask)).not.toHaveBeenCalled()
  const ok = await screen.findByRole('button', { name: /确认|对全部/ })
  fireEvent.click(ok)
  await waitFor(() => expect(vi.mocked(triggerTask)).toHaveBeenCalledWith('a'))
})
```

同时在文件顶部从 `../../api/endpoints` 的 `vi.mock` 工厂中确保导出 `triggerTask`（现有工厂已 mock `triggerTask`，若未 mock 则补 `triggerTask: vi.fn()`），并 import `{ triggerTask }` 与 `waitFor`。

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix web run test -- TasksPage`
Expected: FAIL（未加确认，点击即调用）

- [ ] **Step 3: 修改任务卡「立即触发」**

`web/src/pages/tasks/index.tsx` 顶部加导入：

```tsx
import ConfirmButton from '../../components/ConfirmButton'
```

把（约 100-111 行）触发按钮：

```tsx
<Button
  type="primary"
  size="small"
  icon={<ThunderboltOutlined />}
  loading={trigger.isPending && trigger.variables === task.key}
  disabled={triggerButton(task.inFlight).disabled}
  onClick={() => trigger.mutate(task.key)}
>
  {triggerButton(task.inFlight).label}
</Button>
```

改为：

```tsx
<ConfirmButton
  type="primary"
  size="small"
  icon={<ThunderboltOutlined />}
  confirm={{ title: '将对全部启用窗口开窗执行，确认？', okText: '触发' }}
  loading={trigger.isPending && trigger.variables === task.key}
  disabled={triggerButton(task.inFlight).disabled}
  onConfirm={() => trigger.mutate(task.key)}
>
  {triggerButton(task.inFlight).label}
</ConfirmButton>
```

- [ ] **Step 4: 运行确认通过**

Run: `npm --prefix web run test -- TasksPage`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/tasks/index.tsx web/src/pages/tasks/TasksPage.test.tsx
git commit -m "feat(web): 任务「立即触发」加二次确认"
```

---

### Task 7: 定时页「立即运行」加确认 + 开关补 loading

**Files:**
- Modify: `web/src/pages/schedules/index.tsx`

**Interfaces:**
- Consumes: `ConfirmButton`（Task 2）

- [ ] **Step 1: 加导入**

```tsx
import ConfirmButton from '../../components/ConfirmButton'
```

- [ ] **Step 2: 「立即运行」加确认**

（约 118 行）改为：

```tsx
<ConfirmButton
  type="link"
  size="small"
  icon={<ClockCircleOutlined />}
  confirm={{ title: `立即触发计划「${s.name}」一次？`, okText: '运行' }}
  loading={run.isPending && run.variables === s.id}
  disabled={!s.enabled}
  onConfirm={() => run.mutate(s.id)}
>
  立即运行
</ConfirmButton>
```

- [ ] **Step 3: 启用开关补 loading（防连点）**

（约 112 行）：

```tsx
<Switch
  size="small"
  checked={v}
  loading={update.isPending && update.variables?.id === s.id}
  onChange={(checked) => update.mutate({ id: s.id, body: { enabled: checked } })}
/>
```

- [ ] **Step 4: 验证 + 提交**

Run: `npm --prefix web run build`
Expected: 编译通过

```bash
git add web/src/pages/schedules/index.tsx
git commit -m "feat(web): 定时「立即运行」加二次确认，启用开关补 loading"
```

---

### Task 8: 空投删除项目/状态列加确认，待办操作补防重复

**Files:**
- Modify: `web/src/pages/airdrop/ProjectCard.tsx`
- Modify: `web/src/pages/airdrop/StatusManageModal.tsx`

**Interfaces:**
- Consumes: `useGuardedMutation`（Task 1）

- [ ] **Step 1: ProjectCard 删除项目改为 modal.confirm**

`ProjectCard.tsx` 顶部 import 增加 `App`（已从 antd 引入 `Button, Checkbox, Dropdown, Popconfirm, Tag, Tooltip, Typography`，加入 `App`）：

```tsx
import { App, Button, Checkbox, Dropdown, Popconfirm, Tag, Tooltip, Typography } from 'antd'
```

组件内新增 `const { modal } = App.useApp()`，并把 Dropdown 的 `onClick`（约 52-55 行）改为：

```tsx
onClick: ({ key }) => {
  if (key === 'edit') onEdit(project)
  if (key === 'delete') {
    modal.confirm({
      title: `删除项目「${project.name}」？`,
      content: '将同时删除其待办子项',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteProject.mutateAsync(project.id),
    })
  }
},
```

- [ ] **Step 2: 待办勾选加防重复**

`airdrop/hooks.ts`：把 `invalidateAll` 加 `export`，并新增导出待办更新的 `mutationFn`（供 `useGuardedMutation` 复用，DRY）：

```ts
export function invalidateAll(qc: ReturnType<typeof useQueryClient>) { /* 原实现不变，仅加 export */ }

/** 待办更新的 mutationFn（抽出让 useGuardedMutation 复用，避免与 useUpdateTodo 重复实现） */
export const updateTodoFn = (input: { id: number; body: { done?: boolean; content?: string; dueDate?: string | null; priority: AirdropPriority } }) => updateAirdropTodo(input.id, input.body)
```

并把 `useUpdateTodo` 的 `mutationFn` 改为 `updateTodoFn`（行为不变）。

`ProjectCard.tsx`：`const updateTodo = useUpdateTodo()` 改为：

```tsx
const qc = useQueryClient()
const updateTodo = useGuardedMutation({ mutationFn: updateTodoFn, onSuccess: () => invalidateAll(qc) })
```

顶部 import 增加：

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { invalidateAll, updateTodoFn } from './hooks'
import { useGuardedMutation } from '../../components/useGuardedMutation'
```

待办 Checkbox `onChange` 改：

```tsx
onChange={(e) => updateTodo.run({ id: t.id, body: { done: e.target.checked } })}
```

待办删除 Popconfirm 补 loading：

```tsx
<Popconfirm title="删除该子项？" okButtonProps={{ loading: deleteTodo.isPending }} onConfirm={() => deleteTodo.mutate(t.id)}>
```

- [ ] **Step 3: StatusManageModal 删除状态列加确认**

`StatusManageModal.tsx` 已有 `const { message } = App.useApp()`，改为 `const { message, modal } = App.useApp()`。删除按钮（约 64 行）改为：

```tsx
<Button
  type="text"
  size="small"
  icon={<DeleteOutlined style={{ color: '#cf1322' }} />}
  onClick={() =>
    modal.confirm({
      title: `删除状态「${s.name}」？`,
      content: '该列下不能有项目',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteStatus.mutateAsync(s.id),
    })
  }
/>
```

- [ ] **Step 4: 验证 + 提交**

Run: `npm --prefix web run build`
Expected: 编译通过

```bash
git add web/src/pages/airdrop/ProjectCard.tsx web/src/pages/airdrop/StatusManageModal.tsx web/src/pages/airdrop/hooks.ts
git commit -m "feat(web): 空投删除项目/状态列加二次确认，待办操作防重复"
```

---

### Task 9: 设置页「重载数据源」加确认

**Files:**
- Modify: `web/src/pages/settings/index.tsx`

**Interfaces:**
- Consumes: `ConfirmButton`（Task 2）

- [ ] **Step 1: 加导入**

```tsx
import ConfirmButton from '../../components/ConfirmButton'
```

- [ ] **Step 2: 「重载」加确认**

（约 82 行）：

```tsx
<ConfirmButton
  icon={<ReloadOutlined />}
  loading={reload.isPending}
  confirm={{ title: '重新读取 Excel 数据源？' }}
  onConfirm={() => reload.mutate()}
>
  重载
</ConfirmButton>
```

- [ ] **Step 3: 验证 + 全量测试**

Run: `npm --prefix web run build` 且 `npm run test:web`
Expected: 编译通过、全部测试通过

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/settings/index.tsx
git commit -m "feat(web): 设置页「重载数据源」加二次确认"
```

---

## Self-Review

- **Spec coverage**：A 档（空投删除项目/状态列/待办、看板停止批次/行级、窗口单关闭/批量关闭、工具执行分配）= Task 3/4/5/8；B 档（任务立即触发、窗口批量打开、定时立即运行、工具立即执行一次、设置重载）= Task 4/5/6/7/9；C 档防重复（定时开关、待办勾选）= Task 7/8；公共件 = Task 1/2。覆盖完整。
- **Placeholder**：无 TBD/TODO，代码块均为可执行内容。
- **类型一致**：`ConfirmConfig`/`ConfirmButtonProps`/`useGuardedMutation` 签名在 Task 1/2 定义，后续任务按同签名使用；确认走 `confirm.mode`（顶层 `mode` 不作为 ConfirmButton 属性）。
- **已知取舍**：页面级改动以 `npm --prefix web run build` + 人工验收为验证；仅 `TasksPage` 有现成页面测试（Task 6 补一条）。其余页面无测试脚手架，不新造（YAGNI）。

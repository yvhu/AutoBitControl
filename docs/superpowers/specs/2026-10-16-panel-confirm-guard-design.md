# 面板关键操作：二次确认 + 防重复点击（ConfirmButton / useGuardedMutation）

日期：2026-10-16
状态：已确认（A+B 档确认 + 抽公共件统一；用户确认）

## 目标

面板上「破坏性 / 高成本」的关键操作统一加**二次确认**，并统一**防重复点击**（提交中禁用 + 完成后短冷却），避免误删、误触发、连点造成重复请求/重复开窗。

纯前端交互改动：后端接口、数据库、调度、任务代码零改动。

## 决策记录

- 覆盖范围：**A+B 档**（A=破坏性/不可逆；B=高成本/重）；C 档（可逆/低）不加确认，仅统一防重复
- 落地方式：**抽公共件统一**（不逐处手写），新增 `ConfirmButton` 与 `useGuardedMutation`
- 确认交互：行内小按钮用 `Popconfirm`；工具栏/下拉菜单/卡片级用 `Modal.confirm`（`ConfirmButton` 的 `mode` 切换）
- 防重复：按钮 loading 一律绑 `mutation.isPending`（行级用 `variables` 区分）；`ConfirmButton`/`useGuardedMutation` 内置「pending 或完成后 600ms 冷却内忽略再次触发」

## 现状审计（改动前）

| 页面 | 操作 | 危险/成本 | 二次确认 | 防重复 |
|---|---|---|---|---|
| 空投 | 删除项目（下拉菜单） | 破坏性（级联删待办） | ❌ 无 | ❌ |
| 空投 | 删除待办 | 破坏性 | ✅ Popconfirm | ❌ 无 loading |
| 空投 | 删除状态列 | 破坏性 | ❌ 无 | ❌ |
| 工具 | 执行分配 | 高破坏（改文件名+写 xlsx） | ❌ 仅预览 | ✅ loading |
| 工具 | 立即执行一次 | 中 | ❌ | ✅ |
| 看板 | 停止批次 / 行级停止 | 破坏性 | ❌ | ✅ |
| 看板 | 行级执行/重跑 | 中 | ❌ | ✅ |
| 任务 | 立即触发 | 高成本（全部启用窗口开窗） | ❌ | 仅入队瞬间 |
| 窗口 | 单窗口/批量关闭 | 中~高 | ❌ | ✅ |
| 窗口 | 单窗口/批量打开 | 中 | ❌ | ✅ |
| 定时 | 立即运行 | 中 | ❌ | ✅ |
| 定时 | 启用开关 | 可逆 | — | ❌ 未绑 loading |
| 设置 | 重新加载数据源 | 中 | ❌ | ✅ |

## 公共件设计

### 1. `web/src/components/ConfirmButton.tsx`

```ts
import type { ReactNode } from 'react'
import type { ButtonProps } from 'antd'

export interface ConfirmConfig {
  title: ReactNode
  description?: ReactNode
  okText?: string
  cancelText?: string
  /** 确认交互：popconfirm 行内小按钮（默认）；modal 工具栏/下拉/卡片级 */
  mode?: 'popconfirm' | 'modal'
}

export interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick'> {
  confirm: ConfirmConfig
  /** 确认后执行（sync/async）；执行期间按钮与确认 OK 均 loading 且禁用 */
  onConfirm: () => void | Promise<void>
}

export default function ConfirmButton(props: ConfirmButtonProps): JSX.Element
```

行为：
- 点击 → 弹确认（`mode='popconfirm'` 用 antd `Popconfirm` 包按钮；`mode='modal'` 用 `App.useApp().modal.confirm`）
- 确认 → `onConfirm()`；期间置内部 `busy`：按钮 `loading`、`disabled`
- `onConfirm` 结束 → `cooling = 600ms`，期间 `disabled`（吞掉连点/双击）
- 有效 `loading = props.loading || busy`；有效 `disabled = props.disabled || busy || cooling`
- `danger` 透传按钮与确认 OK 按钮（危险色）
- 取消 → 不执行

### 2. `web/src/components/useGuardedMutation.ts`

```ts
/**
 * 包装 useMutation：pending 或完成后 cooldownMs 内忽略再次 run。
 * 用于不便用加载态禁用的入口（Switch / 菜单项 / 勾选框）。
 */
export function useGuardedMutation<TData, TError, TVariables, TContext>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  opts?: { cooldownMs?: number },
): UseMutationResult<TData, TError, TVariables, TContext> & { run: (v: TVariables) => void }
```

实现要点：`useRef` 追踪 pending 与冷却截止时间；`run` 在守卫内转发到内部 `mutation.mutate`（`onSettled` 里复位 pending 并设冷却；mutation 级 `onSuccess/onError` 照常触发）。

> 非 Button 入口（下拉菜单项、复选框等）不渲染 `ConfirmButton`，改用 `App.useApp().modal.confirm(...)`（确认文案约定一致，`onOk` 返回 promise 自动 loading）+ `useGuardedMutation.run`（防重复），复用同一守卫语义。

## 改动清单（逐文件）

### A 档（破坏性/不可逆）→ ConfirmButton

| 文件 | 按钮 | mode | 确认文案要点 |
|---|---|---|---|
| `pages/airdrop/ProjectCard.tsx` | 删除项目（下拉菜单项） | modal | 「删除项目「X」？将同时删除其待办子项」 |
| `pages/airdrop/ProjectCard.tsx` | 删除待办 | popconfirm（保留） | 补 `loading`（`deleteTodo.isPending`） |
| `pages/airdrop/StatusManageModal.tsx` | 删除状态列 | modal | 「删除状态「X」？该列下不能有项目」 |
| `pages/dashboard/index.tsx` | 停止批次 | modal | 「停止该批次？在途窗口会被中止」 |
| `pages/dashboard/index.tsx` | 行级停止 | popconfirm | 「停止该窗口任务？」 |
| `pages/profiles/index.tsx` | 批量关闭 | modal | 「关闭选中的 N 个窗口？」 |
| `pages/profiles/index.tsx` | 单窗口关闭 | popconfirm | 「关闭窗口「X」？」 |
| `pages/tools/file-assign.tsx` | 执行分配 | modal | 「执行分配？会改名文件并写回 Excel，不可撤销」 |

### B 档（高成本/重）→ ConfirmButton

| 文件 | 按钮 | mode | 确认文案要点 |
|---|---|---|---|
| `pages/tasks/index.tsx` | 立即触发 | popconfirm | 「将对全部启用窗口开窗执行，确认？」 |
| `pages/profiles/index.tsx` | 批量打开 | modal | 「打开选中的 N 个窗口？」 |
| `pages/schedules/index.tsx` | 立即运行 | popconfirm | 「立即触发计划「X」一次？」 |
| `pages/tools/file-assign.tsx` | 立即执行一次 | popconfirm | 「立即执行一次文件分配？」 |
| `pages/settings/index.tsx` | 重新加载数据源 | popconfirm | 「重新读取 Excel 数据源？」 |

### C 档（仅防重复，不加确认）

- `pages/schedules/index.tsx` 启用开关：补 `loading={update.isPending && update.variables?.id === s.id}`（或改 `useGuardedMutation`）
- `pages/airdrop/ProjectCard.tsx` 待办勾选 `Checkbox`：改 `useGuardedMutation`（避免连点重复 PUT）
- `pages/tasks/index.tsx` 任务开关、`pages/profiles/index.tsx` 窗口开关：确认已有 loading 绑定（保持）
- 重置熔断、同步、测试连接、复制、编辑、生成预览：保持现状（不确认），确保 loading 绑定

## 测试

- `web/src/components/ConfirmButton.test.tsx`：
  - popconfirm 模式：点确认才调 `onConfirm`；取消不调
  - modal 模式：`modal.confirm` 被调用后确认才执行
  - 执行中按钮 `disabled`/loading；`onConfirm` 未结束时再次点击不重复执行
- `web/src/components/useGuardedMutation.test.ts`：
  - pending 期间 `run` 二次调用被忽略
  - 完成后 `cooldownMs` 内 `run` 被忽略，超过后恢复
- 页面用例（`pages/**/*.test.tsx`）：删除类操作必须**经确认后**才调用接口；批量按钮 loading 绑定到对应 action/item

## 文档同步

- 纯前端交互规范，`docs/API-GUIDE.md` 当前无「面板使用」章节（手册止于第 7 章），本次不改手册；若后续补面板章节，纳入「关键操作确认规范」。

## 验证

- `npm --prefix web run build`（tsc -b + vite build）通过
- `npm run test:web` 全过

## 范围外

- 全局「同一时刻只允许一个操作」的互斥锁（会造成操作排队，YAGNI）
- 失败重试提示、撤销（Undo）机制
- 非关键页面（文档页、看板诊断弹窗）的交互

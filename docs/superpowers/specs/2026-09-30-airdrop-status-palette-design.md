# 空投追踪状态列调色板设计（airdrop-status-palette）

日期：2026-09-30
状态：设计已确认（调色板自动循环方案）

## 目标

看板各状态列头与管理状态列弹窗中的状态色点当前统一使用主题主色（蓝色），改为按预设调色板按序循环取色——不同状态列显示不同颜色，视觉可区分。纯前端改动，不动后端与数据表。

## 需求要点（已与用户确认）

- 颜色分配策略：预设 8 色调色板按列顺序循环取色（`index % 8`）；状态列可自定义增删改，新增列自动往后排取色
- 换序（上移/下移）后颜色随新位置变化（按序循环语义）
- 只改色点颜色，不动列名/数量/加号等其他元素

## 设计

### 改动文件（全部 web 端）

| 文件 | 改动 |
|---|---|
| `web/src/pages/airdrop/board.ts` | 加 `STATUS_PALETTE`（8 色常量数组）与 `statusColor(index: number): string` 纯函数（`index % 8` 循环） |
| `web/src/pages/airdrop/board.test.ts` | 加 statusColor 用例（前 8 色逐一、index 8/9 回绕、负 index） |
| `web/src/pages/airdrop/StatusColumn.tsx` | 色点背景 `token.colorPrimary` → props 新增 `color: string`；index.tsx 渲染时按列顺序 `statusColor(i)` 传入 |
| `web/src/pages/airdrop/StatusManageModal.tsx` | 行内圆点背景硬编码 `#1677ff` → `statusColor(i)`（与看板同序） |

### 调色板（8 色，深色模式下色点高饱和仍可辨）

```ts
export const STATUS_PALETTE = ['#2f54eb', '#d46b08', '#13a8a8', '#52c41a', '#8c959f', '#722ed1', '#eb2f96', '#a0d911']
```

对应默认五列：关注中=蓝、待参与=橙、进行中=青、已完成=绿、已放弃=灰（与最初 UI 预览稿的配色语义一致）。

### 数据流

- index.tsx：`statuses.data.map((s, i) => <StatusColumn color={statusColor(i)} ... />)`
- StatusManageModal：`statuses.map((s, i) => ...)` 行内圆点同函数
- 两处颜色始终与列顺序一致，换序后同步变化（各自按各自渲染顺序取色，语义自洽）

## 测试

- `board.test.ts`：statusColor(0..7) 返回调色板原值；statusColor(8)===statusColor(0)；statusColor(-1)===statusColor(7)（JS 负模取余，函数实现用 `((index % 8) + 8) % 8` 保证非负）
- 组件无单测（项目惯例）；验证 build:web（忽略 profiles/index.tsx 2 个 HEAD 存量错误）+ test:web 全量

## 文档

- 无接口/配置变化，API-GUIDE 不改
- 不需要独立实施计划文档——改动单文件纯函数 + 两处颜色替换，一次提交完成

## 不做（YAGNI）

- 状态表 color 字段与颜色选择器（用户可选色，已确认走调色板循环）
- 拖拽调色板、按名称映射、深浅色双套色值

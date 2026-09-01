# 运行记录结束时间与总耗时展示设计

日期：2026-09-01
状态：设计已确认，待实施

## 背景

看板「执行记录」表格目前只展示开始时间（`startedAt`）；`runs` 表已有 `started_at` /
`finished_at`（本地墙钟毫秒精度字符串 `yyyy-MM-dd HH:mm:ss.SSS`），`/api/dashboard`
已原样返回两者。缺少：结束时间展示、总耗时展示。

## 目标

1. 看板执行记录表格新增「结束时间」「总耗时」两列
2. 总耗时由后端计算（时区安全、单一事实来源），不落库（派生字段）

## 设计

### 后端（src/server/routes/dashboard.ts）

- 每个 run 行在返回前附加派生字段 `durationSec: number | null`：
  - `startedAt` 与 `finishedAt` 都存在 → `Math.round((finished - started) / 1000)`，
    解析用 `new Date(s.replace(' ', 'T'))`（与 app.ts 重试恢复同口径）
  - 任一缺失 → `null`
  - 解析失败（NaN）→ `null`
- 更新该路由 Swagger 注解：runs.items 增加
  `durationSec: { type: integer, nullable: true, description: '总耗时（秒，started/finished 任一缺失为 null）' }`

### 前端类型（web/src/api/schema.d.ts）

- 由 openapi-typescript 从后端 Swagger 重新生成（与现有生成方式一致），
  使 `RunRow`（`EnvelopeData<'/api/dashboard'>['runs'][number]`）带上 `durationSec`

### 前端展示（web/src/pages/dashboard/index.tsx）

- 列顺序：`窗口 | 任务 | 开始时间 | 结束时间 | 总耗时 | 状态 | 尝试 | 错误 | 截图 | 操作`
- 「结束时间」列（width 130）：复用开始时间的格式化逻辑
  （`v.includes('T') ? v.slice(11, 23) : v`），null → `—`
- 「总耗时」列（width 90，`dataIndex: 'durationSec'`）：
  - `null` → `—`
  - `< 60` → `${s}s`
  - `>= 60` → `${m}m ${s}s`（秒取整）

### 范围外

- profiles 页矩阵与详情不动
- 不落库、不改表结构、无迁移

## 测试

- 后端：dashboard 路由测试（supertest）补 durationSec 断言：
  1. started+finished 都存在 → 正确秒数（含毫秒截断）
  2. 只有 started（running 行）→ null
  3. 两字段均缺失 → null
- 前端：列渲染逻辑如可抽成纯函数则补单测，否则依赖现有 web 测试基线 + `npm --prefix web run build` 类型验证

## 验证

- `npm test`（后端）+ `npm run typecheck`
- `npm --prefix web run test` + `npm --prefix web run build`

# 空投追踪工具设计（airdrop-tracker）

日期：2026-09-30
状态：设计已确认（UI 高保真预览用户已确认「可以」，数据层与 API、前端/提醒/测试两节均获「ok」）

## 目标

面板新增独立导航页「空投追踪」：一个备忘录 + todolist 集合体，用于人工记录每个空投项目的参与进度、备注与待办事项。与系统内自动运行的签到任务（tasks/runs）**无关联**——用户可录入尚未接入系统的空投项目（「先不做关联」已确认）。

## 需求要点（已与用户确认）

- 核心实体：用户手动维护的「空投项目条目」，与任务注册表解耦
- 项目字段：名称 + 备注、状态、优先级（高/中/低）、时间节点（快照/截止/发币）、项目链接、待办子项
- 待办子项：内容 + 完成勾选 + 自己的截止时间 + 优先级（与项目同款排序/高亮逻辑）
- 状态：看板列，**用户可自定义**（默认五列：关注中 / 待参与 / 进行中 / 已完成 / 已放弃）
- 展示形式：**看板拖拽**——卡片在列间拖拽流转状态
- 时间节点用途：**面板内提醒**——到期/过期在页顶横幅提示
- 入口：独立导航页（非工具中心卡片），高频使用

## 架构

### 分层定位

走 `server → infrastructure` 既有路径（无新顶层域）：数据表落在 `AppDb`，路由新增 `src/server/routes/airdrop.ts`，前端新增 `web/src/pages/airdrop/`。

### 数据模型（`src/infrastructure/db.ts` SCHEMA 追加 3 张表）

```
airdrop_statuses  id INTEGER PK, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL, created_at TEXT
airdrop_projects  id INTEGER PK, name TEXT NOT NULL, status_id INTEGER NOT NULL REFERENCES airdrop_statuses(id),
                  priority TEXT NOT NULL DEFAULT 'mid',   -- high/mid/low
                  deadline TEXT,                          -- YYYY-MM-DD 或 null
                  link TEXT, note TEXT,
                  created_at TEXT, updated_at TEXT
airdrop_todos     id INTEGER PK, project_id INTEGER NOT NULL REFERENCES airdrop_projects(id) ON DELETE CASCADE,
                  content TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
                  due_date TEXT,                          -- YYYY-MM-DD 或 null
                  priority TEXT NOT NULL DEFAULT 'mid',
                  created_at TEXT
```

- 首次建表时种入默认五列（sort_order 0-4）
- 删除状态列：列下仍有项目 → 409 拒绝（前端提示先移走项目）；删除项目级联删子项
- `cleanupOld` 历史清理**不碰**这三张表（长期台账，永久保留）
- 时间字段统一 YYYY-MM-DD（与 runs.date 同口径，字典序比较安全）；created_at/updated_at 用 `localWallNow()`

### 后端模块

| 文件 | 职责 |
|---|---|
| `src/infrastructure/db.ts` | 追加建表 + 种子 + AppDb 方法（statuses/projects/todos CRUD、reminders 查询） |
| `src/server/routes/airdrop.ts` | 路由工厂 `airdropRouter(deps: { db })`，@swagger 注解，统一 ok/fail |
| `src/server/app.ts` | `api.use(airdropRouter(...))` 挂载 |

### API 设计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/airdrop/statuses` | 列清单（按 sort_order，含每列项目数） |
| POST | `/api/airdrop/statuses` | 新增列 `{ name }` |
| PATCH | `/api/airdrop/statuses/:id` | 改名/换序 `{ name?, sortOrder? }` |
| DELETE | `/api/airdrop/statuses/:id` | 删除；列下有项目 → 409（专用错误码） |
| GET | `/api/airdrop/projects` | 全量项目（含子项数组与状态名，后端已按列 + 列内排序排好） |
| POST | `/api/airdrop/projects` | 新建项目 `{ name, statusId, priority, deadline?, link?, note? }` |
| PATCH | `/api/airdrop/projects/:id` | 部分更新（含拖拽流转 statusId） |
| DELETE | `/api/airdrop/projects/:id` | 删除（级联删子项） |
| POST | `/api/airdrop/projects/:id/todos` | 加子项 `{ content, dueDate?, priority }` |
| PATCH | `/api/airdrop/todos/:id` | 勾选 done / 改 content/dueDate/priority |
| DELETE | `/api/airdrop/todos/:id` | 删子项 |
| GET | `/api/airdrop/reminders` | 提醒汇总（见下） |

- 列内排序规则：优先级权重（high>mid>low）→ deadline 近者在前（无 deadline 排最后）→ 创建时间，后端排好，前端按序渲染，**不做列内拖拽排序**
- 错误码（`src/server/http/errors.ts` 追加）：`40905 AIRDROP_STATUS_NOT_EMPTY`（删除非空列）、`40407 AIRDROP_NOT_FOUND`（项目/子项/列不存在；40405 已被 BATCH_NOT_FOUND 占用，跳过）

### 提醒机制（`GET /api/airdrop/reminders`）

- 汇总规则（纯函数，便于单测）：窗口常量 `REMIND_WINDOW_DAYS = 5`
  - `upcoming`：deadline（项目）或 due_date（未完成子项）落在未来 5 天内，按日期升序
  - `overdue`：deadline/due_date 早于今天且未完成（项目一律计入、不看所处列——状态列是用户自定义的，系统无法判定"完成"语义；已完结项目由用户自行清空 deadline；子项仅未勾选计入），按日期升序
- 返回 `data: { upcoming: [{ type: 'project'|'todo', id, name, date, daysLeft }], overdue: [...] }`
- 横幅展示摘要即可（「未来 5 天到期 N 项：前 3 条…｜已过期 N 项：前 3 条…」，超长截断），列表数据全量返回由前端裁剪
- 前端 react-query `refetchInterval: 60_000` 轮询，页顶横幅展示；横幅可关闭（本次提醒集关闭后不再弹出，数据变化产生新提醒时再现）
- 不做后端推送（无 WebSocket 基建，60s 轮询足够）；提醒窗口 5 天写死常量（YAGNI，不进配置）

## 前端

### 文件清单

| 文件 | 改动 |
|---|---|
| `web/src/layouts/AppLayout.tsx` | menuItems 插入 `{ key: '/airdrop', icon: <RocketOutlined />, label: '空投追踪' }` |
| `web/src/App.tsx` | 加路由 `<Route path="airdrop" element={<AirdropPage />} />` |
| `web/src/pages/airdrop/index.tsx`（新建） | 看板页：提醒横幅 + 状态列 + 卡片 + 三个弹窗（新增项目/编辑项目/管理状态列） |
| `web/src/pages/airdrop/hooks.ts`（新建） | react-query hooks（statuses/projects/reminders 查询与全部变更）+ 可测纯函数 |
| `web/src/pages/airdrop/hooks.test.tsx`（新建） | hooks 单测（`npm run test:web`） |
| `web/src/pages/airdrop/board.ts`（新建） | 纯函数：列内排序/提醒汇总渲染数据构建/日期剩余天数计算，配单测 |
| `web/src/api/endpoints.ts` | 加 airdrop 系列请求函数 |
| `web/src/api/schema.d.ts` | 手补类型（项目先例）：AirdropStatus/AirdropProject/AirdropTodo/Reminders 等 |
| `web/package.json` | 新增依赖 `@dnd-kit/core`（React 18 兼容、维护活跃） |

### 面板交互（按已确认的 UI 预览）

- 看板横向滚动，列宽固定 290px，列头：色点 + 名称 + 项目数 + 「＋」快捷新建（预填该列）
- 卡片：优先级标签（高红/中橙/低绿）、名称、时间节点（过期红 + 剩 N 天/已过期徽标、5 天内黄、正常蓝）、链接（外跳新标签）、备注两行截断点击展开、待办子项（勾选即 PATCH done，行内时间 + 优先级点）、拖拽把手
- 拖拽：`@dnd-kit/core` 仅列间拖拽（卡片 useDraggable、列 useDroppable），drop 时 PATCH `statusId`，乐观更新失败回滚并 message 报错
- 弹窗：新增项目（名称/状态列/优先级/时间/链接/备注/子项编辑器）、编辑项目（同表单复用）、管理状态列（改名/删除/新增/换序；删除非空列被 409 拦截并提示）
- 提醒横幅：antd Alert 风格（upcoming 橙 / overdue 红），可关闭

## 测试

- 后端（vitest，`tests/`，`file::memory:` 注入隔离）：
  - AppDb 新方法：建表种子五列、状态列 CRUD 与非空删除拦截、项目/子项 CRUD 与级联删除、reminders 汇总查询
  - reminders 汇总纯函数：upcoming/overdue 边界（今天不算过期、恰好 5 天算 upcoming、子项 done 不计）
  - 路由：supertest 全接口正常 + 错误路径（404/409/参数格式）
- 前端：`hooks.test.tsx` + `board.ts` 纯函数单测（排序、剩余天数计算、提醒数据构建）

## 文档同步

- `docs/API-GUIDE.md`：
  - 8.2 面板使用：页面清单加「空投追踪」页说明（看板/卡片/提醒/状态列管理）
  - 8.3 REST 接口总表：加 `/api/airdrop/*` 全部接口行
- @swagger 注解随路由同步编写（openapi 自动聚合）
- 无新增配置项，8.1 配置表不动

## 不做（YAGNI）

- 与系统任务（task key）的关联/执行汇总（用户明确「先不做关联」）
- 到期主动推送（通知渠道/桌面通知）
- 列内拖拽排序、卡片颜色主题自定义
- 提醒窗口天数配置化（常量 5 天）
- 多用户/权限（单机单用户面板）
- 数据导出/导入

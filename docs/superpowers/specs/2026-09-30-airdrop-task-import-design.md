# 空投追踪「从系统任务导入」设计（airdrop-task-import）

日期：2026-09-30
状态：设计已确认（方案 A；「可绑定可解绑」「拒绝并提示」「逐行指定」等决策均已与用户确认）

## 目标

空投追踪页支持把系统已登记任务（任务注册表）批量导入为项目卡片，导入时可自主勾选任务、逐行指定状态列与优先级；项目与任务之间建立「可绑定可解绑」的软关联（task_key），手动创建的项目可事后补绑定，导入过的任务在导入弹窗中置灰防重复导入。关联不产生运行时联动（自动化照跑、追踪照记，互不干涉）。

## 需求要点（已与用户确认）

- 入口：页头「新增项目」旁独立「从系统任务导入」按钮 + 弹窗（不动现有新增流程）
- 导入粒度：弹窗列出全部系统任务多选，**逐行指定**状态列与优先级；名称←任务名、链接←任务 URL（无则空）、deadline/note 留空
- 关联管理：项目条目加可空 `task_key` 字段——导入时自动绑定；手动项目可在编辑弹窗「关联系统任务」下拉补绑定/解绑
- 绑定冲突：一个任务只能绑定一个项目（部分唯一索引保证）；绑定已占用任务 → 400 提示「该任务已关联其他项目」（用户先去旧项目解绑再绑定，不自动转移）
- 已导入判定：导入弹窗中已绑定的任务置灰显示「已导入」

## 架构

### 数据模型（src/infrastructure/db.ts）

- `airdrop_projects` 加 `task_key TEXT` 可空列
- 唯一性：**部分唯一索引**（SQLite ALTER 无法加表级 UNIQUE，部分索引对新库老库统一、NULL 不参与唯一）：
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_airdrop_projects_task_key ON airdrop_projects(task_key) WHERE task_key IS NOT NULL`
- 老库迁移（migrate 幂等）：`PRAGMA table_info` 查列，缺则 `ALTER TABLE airdrop_projects ADD COLUMN task_key TEXT`；索引无条件幂等创建（同 profiles 补列惯例）
- 新表 CREATE TABLE 定义含 `task_key TEXT`；`AirdropProjectRow`/`AirdropProjectView` 加 `taskKey: string | null`
- db 方法签名变化：`createAirdropProject`/`updateAirdropProject` 的 input/patch 加 `taskKey?: string | null`（null=解绑/清空，undefined=不动）；写入前不查重（查重与任务存在性校验在路由层，索引兜底唯一性）
- `cleanupOld` 不涉及

### API（src/server/routes/airdrop.ts）

- deps 加 `tasks: Map<string, SiteTask>`（任务存在性校验；挂载处 `api.use(airdropRouter({ db, tasks }))`，server → tasks 走 type-only 惯例同 schedulesRouter）
- `POST /api/airdrop/projects`：body 加可选 `taskKey`——非空字符串且任务注册表存在且未被其他项目绑定，违规 400（INVALID_ARGUMENT）
- `PATCH /api/airdrop/projects/:id`：加 `taskKey`——字符串=绑定（同上校验）、null=解绑、undefined=不动
- 新增 `POST /api/airdrop/projects/import`：
  - body `{ items: [{ taskKey, statusId, priority }] }`（items 非空数组；priority 缺省 mid）
  - 逐条处理：taskKey 非法/任务不存在/已绑定/statusId 不存在 → 记入 failed（reason 中文），其余创建（name=meta.name、link=meta.url ?? null、deadline/note 空、taskKey 写入）
  - 返回 `{ imported: number, failed: [{ taskKey, reason }] }`；单项失败不影响其他项（不整体回滚）
- `GET /api/airdrop/projects`：视图带 taskKey
- 无新增错误码（冲突/不存在均 40000 INVALID_ARGUMENT）
- @swagger 注解同步（POST/PATCH projects 参数、import 接口、GET 视图字段）

### 前端（web/src/pages/airdrop/）

| 文件 | 改动 |
|---|---|
| `ImportModal.tsx`（新建） | 导入弹窗：任务行（Checkbox + 任务名 + 状态列 Select + 优先级 Select）；已绑定任务置灰 + Tag「已导入」；确认后调 useImportProjects |
| `ProjectFormModal.tsx` | 加「关联系统任务」Select（allowClear=解绑；选项 = 全部任务，其中已被其他项目绑定的禁用并标注项目名，当前项目自己的 taskKey 正常显示） |
| `index.tsx` | 页头加「从系统任务导入」按钮 + ImportModal 挂载 |
| `hooks.ts` | 加 `useImportProjects`（成功 message「已导入 N 个项目」+ invalidateAll 三 key）；`useSaveProject` 的 values 类型加 taskKey |
| `board.ts` | 无改动 |
| `../../api/endpoints.ts` | 加 `importAirdropProjects(body)` |
| `../../types.ts` | 加 `AirdropImportItem`/`AirdropImportResult`；`AirdropProjectInput`/`AirdropProjectPatch`/`AirdropProjectView` 加 taskKey |

- 导入弹窗数据源：`fetchTasks()`（现有 GET /api/tasks，TaskMetaView 含 key/name/url）+ `useAirdropProjects()` 的 taskKey 集合
- 导入成功/失败提示：全成功 message.success；有失败 message.warning 显示失败原因（取前 3 条）

## 测试

- 后端（vitest，file::memory: 注入隔离）：
  - db：task_key 列与部分唯一索引行为（NULL 可多行不冲突；同 taskKey 第二行抛约束错误）；create/update 的 taskKey 写入与 null 解绑
  - 路由：POST/PATCH taskKey 校验（任务不存在 400、占用 400、解绑成功、GET 视图带 taskKey）；import 全成功/部分失败 failed 清单/空 items 400/statusId 不存在进 failed
- 前端：hooks.test.tsx 加 useImportProjects 成功 invalidate 断言；弹窗组件不单测（项目惯例）

## 文档同步

- `docs/API-GUIDE.md`：8.2 空投追踪页说明补「从系统任务导入」与编辑弹窗「关联系统任务」；8.3 REST 总表加 import 行、POST/PATCH projects 行描述更新
- @swagger 注解随路由同步

## 不做（YAGNI）

- 任务↔项目的运行时联动（任务执行结果自动写回项目、状态自动流转）
- 导入时自动同步任务分组（meta.group）为备注/标签
- 已导入任务与项目的批量解绑/重绑定工具
- 导入历史记录/撤销

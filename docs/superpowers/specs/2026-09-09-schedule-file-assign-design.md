# 定时计划「上传前自动文件随机分配」设计

日期：2026-09-09
状态：待审阅

## 1. 背景与目标

「文件随机分配」工具（`src/tools/file-assign`）目前是纯手动操作：面板生成预览 → 执行分配 → 改名文件并写回 accounts.xlsx 的「文件地址」列。shelbynet 上传任务（`xyz-shelbynet`）从该列读文件路径上传，站点按 blob 名查重：已传过的名字报 `Blob name already taken`（任务将其视为成功短路，实际文件没传上去）。

**失败模式**：定时上传前忘记手动执行分配 → 各窗口上传的还是上一轮的文件名 → 全部重复 → 一轮白跑且不报错。

**目标**：把「文件随机分配」焊进定时计划的触发链路，每次计划触发（到点或「立即运行」）在开窗前自动做一次分配；分配失败则本次不上传（结构性杜绝重复），日志写清原因。

## 2. 方案总览

计划级自动分配钩子：`schedules.config` JSON 增加可选 `fileAssign` 段；`Scheduler.fire` 在任务守卫之后、建批次入队之前执行一次分配（preview + apply + 数据源重载）。分配失败 → 计划内需要文件的任务记为 skipped（新 reason `file-assign-failed`），其余任务不受影响。

不做：任务级钩子（跨窗口"只执行一次"协调复杂）；双计划串行（无失败保障）。

## 3. 详细设计

### 3.1 ScheduleConfig 扩展（engine/schedule.ts）

```ts
/** 上传前自动文件随机分配配置（可选；与 tools/file-assign 参数同构） */
export interface FileAssignConfig {
  sourceDir: string
  column: string
  template: FileAssignTemplate  // type-only import from tools/file-assign/types
}

export interface ScheduleConfig {
  everyHours?: number
  times?: string[]
  weekdays?: number[]
  days?: number[]
  fileAssign?: FileAssignConfig  // 新增，可选
}
```

engine → tools 仅 `import type`（运行时依赖由 app.ts 注入，与 server → tasks 的 type-only 先例一致）。

### 3.2 TaskMeta 扩展（engine/task.ts）

```ts
/** 声明该任务上传数据源中的文件、依赖触发前的自动分配（scheduler 用它判断是否要执行分配） */
requiresFileAssign?: boolean
```

`ShelbyExplorerTask.meta` 置 `requiresFileAssign: true`。scheduler 不硬编码任务 key。

### 3.3 Scheduler.fire 流程改造（engine/scheduler.ts）

```
1. 解析 taskKeys（现有）
2. 逐个任务守卫：unknown-task / task-disabled / in-flight（现有，先收集哪些任务将通过）
3. 若 cfg.fileAssign 存在 且 将通过的任务中存在 requiresFileAssign 任务：
   a. 调用注入的 fileAssign.run(cfg.fileAssign)（preview+apply+数据源重载）
   b. 失败（ToolError 或闭包内任何异常，含 TOOL_BUSY）→ 所有 requiresFileAssign 任务记为 skipped('file-assign-failed')，warn 日志附原因；其余任务照常入队
   c. 成功 → 继续
4. 对通过守卫的任务建批次 + 全窗口入队（现有）
```

要点：

- 分配在**守卫之后**执行：在途/停用时不浪费一次改名。
- 分配**每次 fire 只执行一次**（多任务共享），成功后数据源已重载，开窗时 accountResolver 读到新路径。
- 幂等安全：即使 tick 异常重触发，重复分配只是再改名一次，模板保证唯一名，不会产生重复文件。
- 分配与开窗的时序：分配（同步 fs 操作，秒级）→ 入队 → 窗口按 staggerMaxSec（默认 120s）错峰开窗，余量充足。

### 3.4 依赖注入与装配（src/app.ts）

`SchedulerDeps` 增加：

```ts
fileAssign?: {
  run(config: FileAssignConfig): Promise<void>
}
```

app.ts 组装闭包：`preparePreview({...cfg, xlsxPath}) → FileAssignService.apply → datasource.load(cfg.dataSource.path)`。

**FileAssignService 单例下沉**：`routes/tools.ts` 的模块级单例移到 app.ts 创建，同时注入 toolsRouter 与 scheduler。busy 锁跨面板手动分配与自动分配生效：自动分配撞上面板正在执行分配 → TOOL_BUSY → 上传任务 skipped（并发改同一文件夹危险，宁可跳过）。

### 3.5 校验（server/routes/schedules.ts）

`parseBody` 校验 `config.fileAssign`（存在时）：

- `sourceDir`/`column` 非空字符串
- `template` 结构合法（复用 `validateTemplate`，server → tools 合法）
- 非法 → 400 INVALID_ARGUMENT

触发时的完整校验仍由 `preparePreview` 负责（目录存在、文件充足、唯一名冲突等）。

### 3.6 面板（web/src/pages/schedules）

- 弹窗新增折叠区「上传前自动分配文件」：开关 + 源文件夹 + 目标列 + 名称模板编辑器。
- 名称模板编辑器从 `web/src/pages/tools/file-assign.tsx` 提取为共享组件（如 `web/src/components/name-template-editor.tsx`），工具页与计划弹窗复用。
- 提交时 `config.fileAssign = { sourceDir, column, template }`；开关关闭则不携带该段（老行为）。
- 列表「关联任务」旁对带 fileAssign 的计划显示 Tag「自动分配」。
- 编辑回填：`s.config.fileAssign` → 表单。

### 3.7 API 变更

- `POST/PATCH /api/schedules`：config schema 增加 `fileAssign`（@swagger 同步）。
- `POST /api/schedules/{id}/run` 响应：`skipped[].reason` 枚举增加 `file-assign-failed`（@swagger 同步）。

## 4. 失败语义矩阵

| 场景 | 行为 |
| --- | --- |
| 计划无 fileAssign 段 | 原行为不变 |
| 有 fileAssign 但计划内无 requiresFileAssign 任务通过守卫 | 不执行分配（不浪费改名） |
| 分配执行失败（目录缺失/文件不足/模板非法/TOOL_BUSY） | requiresFileAssign 任务 skipped(file-assign-failed)，warn 日志附原因；其它任务照常 |
| 分配成功 | 重载数据源 → 建批次 → 全窗口入队（沿用错峰） |
| 手动路径（任务页「立即触发」、看板行级、task:run） | 不受自动分配保护（已知边界，写文档说明） |

## 5. 边界与非目标

- 文件池语义不变：分配只改名+写回，不移动/不删除已上传文件；文件夹维护仍由用户负责。
- 重试/熔断行为不变：任务失败重试时沿用已分配的路径（若首次实际已上传，重试按「已上传视为成功」收敛，现有语义）。
- 不新增 DB 表/字段（计划配置存 JSON，天然持久化）。
- 面板文件随机分配工具本身保持不变。

## 6. 测试计划

- `tests/scheduler.test.ts`（扩展）：fire 流程自动分配用例：
  - 分配成功 → 上传任务与其它任务均入队
  - 分配失败 → 上传任务 skipped(file-assign-failed)、其它任务入队、run 只调用一次
  - 在途守卫跳过 → 不调用分配
  - 无 fileAssign 段 → 不调用分配
  - 计划内无 requiresFileAssign 任务 → 不调用分配
- `tests/web.test.ts`（扩展，schedules 路由单测所在）：fileAssign 形状非法 → 400；合法 → 保存成功
- 前端：schedules 表单单测（自动分配开关、提交 payload 含/不含 fileAssign）
- 现有 `npm run typecheck` / `npm test` 全绿

## 7. 文档同步清单（与代码同批提交）

- `docs/API-GUIDE.md`：
  - 第 2 章 TaskMeta 字段表增加 `requiresFileAssign`
  - 定时任务章节增加「上传前自动文件随机分配」说明（触发时序、失败跳过语义、手动路径边界）
  - 9.3 REST 接口总表更新 schedules 接口 config 与 run 响应枚举
  - 9.2 面板使用更新（定时任务弹窗新区域）
- `docs/TASK-DEVELOPMENT-LESSONS.md`：无真机新经验，不更新

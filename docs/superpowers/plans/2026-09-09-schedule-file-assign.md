# 定时计划「上传前自动文件随机分配」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时计划触发（到点/立即运行）时，在开窗前自动执行一次文件随机分配；分配失败则跳过依赖文件的任务，结构性杜绝重复文件上传。

**Architecture:** `schedules.config` 增加可选 `fileAssign` 段；`Scheduler.fire` 在任务守卫之后、建批次入队之前调用注入的执行器（preview → apply → 数据源重载）；任务经 `meta.requiresFileAssign` 声明依赖分配。执行器与 FileAssignService 单例由 app.ts 装配注入，engine 层只做 type-only import。

**Tech Stack:** Node + TypeScript（严格模式）、vitest、express、antd + React 18、dayjs

**Spec:** `docs/superpowers/specs/2026-09-09-schedule-file-assign-design.md`

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、camelCase 命名、文件 kebab-case；文件头中文注释块说明模块职责与依赖方向
- 所有注释/文档/commit message 用中文；commit 风格 `feat:`/`docs:` + 中文描述
- 依赖方向：tasks → engine → {integrations, automation} → infrastructure；engine → tools 仅 `import type`
- 日志用 logger（中文消息，格式 `logger.info({count}, '消息')`）
- 验证命令：`npm run typecheck`（后端严格模式）与 `npm test`（后端 vitest）都要过；前端用 `npm --prefix web run test`；web 类型用 `npm --prefix web run build`（含 tsc -b）
- 每步 TDD：先写失败测试 → 跑红 → 最小实现 → 跑绿 → commit

---

### Task 1: engine 层自动分配钩子（类型 + Scheduler.fire 改造）

**Files:**
- Modify: `src/tools/file-assign/types.ts`（新增 FileAssignConfig 类型）
- Modify: `src/engine/task.ts:14-37`（TaskMeta 加 requiresFileAssign）
- Modify: `src/engine/schedule.ts:10-23`（ScheduleConfig 加 fileAssign）
- Modify: `src/engine/scheduler.ts`（SchedulerDeps.fileAssign + RunNowResult reason 枚举 + fire 两遍式改造）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: 无（本任务独立）
- Produces:
  - `FileAssignConfig { sourceDir: string; column: string; template: FileAssignTemplate }`（tools/file-assign/types.ts）
  - `TaskMeta.requiresFileAssign?: boolean`
  - `ScheduleConfig.fileAssign?: FileAssignConfig`
  - `SchedulerDeps.fileAssign?: { run(config: FileAssignConfig): Promise<void> }`
  - `RunNowResult.skipped[].reason` 增加 `'file-assign-failed'`
  - `Scheduler.fire` 行为：守卫 → 需要时执行一次分配 → 失败跳过 requiresFileAssign 任务 → 建批次入队

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.ts` 末尾（`afterEach` 之后、`describe('Scheduler')` 内部末尾或其后均可）追加 describe 块。先把 `MockDeps` 与 `makeDeps` 加上 fileAssign 字段（MockDeps 内加 `fileAssign: { run: Mock }`，makeDeps 返回对象加 `fileAssign: { run: vi.fn().mockResolvedValue(undefined) }`），然后追加：

```ts
describe('Scheduler 上传前自动文件随机分配', () => {
  const FA_TEMPLATE = { english: { count: 2, caseMode: 'lower' as const }, digits: null, special: null, position: { type: 'before' as const } }
  const FA_CFG = { sourceDir: 'C:\\files', column: '文件地址', template: FA_TEMPLATE }
  const makeUploadDeps = () => makeDeps({
    tasks: new Map([
      ['upload', { meta: { key: 'upload', name: '上传', url: '', requiresFileAssign: true } }],
      ['plain', { meta: { key: 'plain', name: '普通', url: '' } }],
    ]),
  })
  const scheduleWith = (config: string, taskKeys = '["upload"]') => makeSchedule({ config, taskKeys })

  it('计划带 fileAssign 且依赖文件任务通过守卫 → 先分配再入队（分配只调一次且先于建批次）', async () => {
    const deps = makeUploadDeps()
    const s = new Scheduler(deps)
    const result = await s.runNow(scheduleWith(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG })))
    expect(deps.fileAssign.run).toHaveBeenCalledTimes(1)
    expect(deps.fileAssign.run).toHaveBeenCalledWith(FA_CFG)
    expect(result.taskKeys).toEqual(['upload'])
    expect(deps.fileAssign.run.mock.invocationCallOrder[0]).toBeLessThan(deps.db.createBatch.mock.invocationCallOrder[0])
    expect(deps.db.createBatch).toHaveBeenCalledWith('schedule', 'upload', '计划#1 每日签到')
  })

  it('分配失败 → 依赖文件任务 skipped(file-assign-failed)，其它任务照常入队', async () => {
    const deps = makeUploadDeps()
    deps.fileAssign.run.mockRejectedValue(new Error('文件不足'))
    const s = new Scheduler(deps)
    const result = await s.runNow(scheduleWith(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG }), '["upload","plain"]'))
    expect(result.taskKeys).toEqual(['plain'])
    expect(result.skipped).toEqual([{ taskKey: 'upload', reason: 'file-assign-failed' }])
    expect(deps.logger.warn).toHaveBeenCalled()
    expect(deps.db.createBatch).toHaveBeenCalledWith('schedule', 'plain', '计划#1 每日签到')
  })

  it('无 fileAssign 段 → 不执行分配', async () => {
    const deps = makeUploadDeps()
    await new Scheduler(deps).runNow(scheduleWith('{"times":["09:00"]}'))
    expect(deps.fileAssign.run).not.toHaveBeenCalled()
  })

  it('计划内无依赖文件任务 → 不执行分配（避免浪费改名）', async () => {
    const deps = makeUploadDeps()
    await new Scheduler(deps).runNow(scheduleWith(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG }), '["plain"]'))
    expect(deps.fileAssign.run).not.toHaveBeenCalled()
  })

  it('依赖文件任务在途 → 不执行分配', async () => {
    const deps = makeUploadDeps()
    deps.db.countInFlightRuns.mockResolvedValue(1)
    const result = await new Scheduler(deps).runNow(scheduleWith(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG })))
    expect(deps.fileAssign.run).not.toHaveBeenCalled()
    expect(result.skipped).toEqual([{ taskKey: 'upload', reason: 'in-flight' }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: 类型错误（SchedulerDeps/MockDeps 无 fileAssign 字段、TaskMeta 无 requiresFileAssign、makeSchedule config 可含 fileAssign 但 fire 未实现新语义）导致编译失败或新用例失败。若只是类型错误，先做 Step 3 的类型部分再重跑。

- [ ] **Step 3: 最小实现**

`src/tools/file-assign/types.ts` 末尾追加：

```ts
/** 定时计划「上传前自动分配」配置（存 schedules.config.fileAssign，与预览参数同构） */
export interface FileAssignConfig {
  sourceDir: string
  column: string
  template: FileAssignTemplate
}
```

`src/engine/task.ts` TaskMeta 接口（`concurrency` 行后）追加：

```ts
  /** 声明任务依赖「上传前自动文件随机分配」：计划配置 fileAssign 时 fire 先执行一次分配，失败则本任务跳过 */
  requiresFileAssign?: boolean
```

`src/engine/schedule.ts`：文件头注释保持，顶部加 `import type { FileAssignConfig } from '../tools/file-assign/types'`，ScheduleConfig 接口末尾（`days` 后）追加：

```ts
  /** 上传前自动文件随机分配（可选）：fire 在开窗前执行一次分配，失败跳过依赖文件的任务 */
  fileAssign?: FileAssignConfig
```

`src/engine/scheduler.ts`：

顶部加 `import type { FileAssignConfig } from '../tools/file-assign/types'`。

RunNowResult 接口改为：

```ts
export interface RunNowResult {
  /** 实际入队的任务 key */
  taskKeys: string[]
  /** 被跳过任务的明细 */
  skipped: Array<{ taskKey: string; reason: 'unknown-task' | 'task-disabled' | 'in-flight' | 'file-assign-failed' }>
}
```

SchedulerDeps 接口（`timezone` 行前）追加：

```ts
  /** 上传前自动分配执行器（app.ts 注入 preview+apply+数据源重载；engine 不依赖 tools 运行时） */
  fileAssign?: {
    run(config: FileAssignConfig): Promise<void>
  }
```

`fire` 方法整体替换为（两遍式）：

```ts
  /** 触发计划内全部任务：第一遍守卫收集通过者 → 需要时执行一次自动分配 → 第二遍建批次入队 */
  private async fire(schedule: ScheduleRow): Promise<RunNowResult> {
    const result: RunNowResult = { taskKeys: [], skipped: [] }
    let keys: unknown
    try {
      keys = JSON.parse(schedule.taskKeys)
    } catch {
      this.deps.logger.warn({ id: schedule.id }, '计划任务列表 JSON 非法，跳过整个计划')
      return result
    }
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) {
      this.deps.logger.warn({ id: schedule.id, name: schedule.name }, '计划任务列表形状非法（须为字符串数组），跳过整个计划')
      return result
    }
    const cfg = parseConfig(schedule, this.deps.logger)
    if (!cfg) return result
    // 第一遍：任务级守卫，收集将通过的任务（分配只在有任务真正要跑时执行，避免在途/停用时白改名）
    const passing: string[] = []
    for (const key of keys as string[]) {
      const skip = async (reason: RunNowResult['skipped'][number]['reason']) => {
        this.deps.logger.warn({ schedule: schedule.name, task: key, reason }, '定时触发跳过任务')
        result.skipped.push({ taskKey: key, reason })
      }
      const t = this.deps.tasks.get(key)
      if (!t) { await skip('unknown-task'); continue }
      // 面板运行时开关（task_states 覆盖 meta.enabled）与手动触发守卫同语义
      if (!(await this.deps.db.getTaskEnabled(key, t.meta.enabled ?? true))) { await skip('task-disabled'); continue }
      if ((await this.deps.db.countInFlightRuns(key, todayLocal())) > 0 || this.deps.enqueuer.hasTaskInFlight(key)) { await skip('in-flight'); continue }
      passing.push(key)
    }
    // 上传前自动文件随机分配：计划配置了 fileAssign 且通过守卫的任务中有依赖文件的任务时执行一次；
    // 失败 → 依赖文件的任务全部 skipped(file-assign-failed)，其余任务不受影响（不上传旧文件防重复）
    const fa = cfg.fileAssign
    const needsAssign = !!fa && !!this.deps.fileAssign && passing.some((k) => this.deps.tasks.get(k)?.meta.requiresFileAssign)
    let assignFailed: string | null = null
    if (needsAssign) {
      try {
        await this.deps.fileAssign!.run(fa!)
        this.deps.logger.info({ schedule: schedule.name }, '上传前自动文件随机分配完成')
      } catch (e) {
        assignFailed = (e as Error).message
        this.deps.logger.warn({ schedule: schedule.name, err: assignFailed }, '自动文件随机分配失败，跳过依赖文件的任务')
      }
    }
    // 第二遍：建批次入队
    for (const key of passing) {
      if (assignFailed && this.deps.tasks.get(key)?.meta.requiresFileAssign) {
        this.deps.logger.warn({ schedule: schedule.name, task: key, reason: 'file-assign-failed' }, '定时触发跳过任务')
        result.skipped.push({ taskKey: key, reason: 'file-assign-failed' })
        continue
      }
      const batch = await this.deps.db.createBatch('schedule', key, `计划#${schedule.id} ${schedule.name}`)
      for (const p of await this.deps.db.listProfiles(true)) {
        this.deps.enqueuer.enqueue(p, key, { batchId: batch.id })
      }
      result.taskKeys.push(key)
      this.deps.logger.info({ schedule: schedule.name, task: key }, `定时触发已入队`)
    }
    return result
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: 全部 PASS（含既有用例——两遍式重构不改变无 fileAssign 计划的行为）。

- [ ] **Step 5: 全量校验**

Run: `npm run typecheck` 与 `npm test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/tools/file-assign/types.ts src/engine/task.ts src/engine/schedule.ts src/engine/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: 调度器支持计划级上传前自动文件随机分配（requiresFileAssign + fire 钩子）"
```

---

### Task 2: 分配执行器与装配（runner + 单例下沉 + app.ts 注入 + shelbynet 标记）

**Files:**
- Create: `src/tools/file-assign/runner.ts`
- Test: `tests/file-assign-runner.test.ts`
- Modify: `src/server/routes/tools.ts`（模块级 service 单例改为注入）
- Modify: `src/server/app.ts`（ServerDeps + toolsRouter 传参）
- Modify: `src/app.ts`（创建单例 + buildFileAssignRunner 注入 Scheduler + createApp 传参）
- Modify: `src/tasks/shelby-explorer.ts:107-108`（meta 加 requiresFileAssign）
- Modify: `tests/tools-route.test.ts:29`（toolsRouter 构造补参）

**Interfaces:**
- Consumes: Task 1 的 `FileAssignConfig`、`SchedulerDeps.fileAssign`
- Produces:
  - `buildFileAssignRunner(deps: { xlsxPath: string; apply(params: ApplyParams): Promise<ApplyResult>; reload(): Promise<void> }): (config: FileAssignConfig) => Promise<void>`
  - `ServerDeps.fileAssignService: FileAssignService`
  - `toolsRouter` 依赖增加 `fileAssignService: FileAssignService`

- [ ] **Step 1: 写失败测试** `tests/file-assign-runner.test.ts`

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { buildFileAssignRunner } from '../src/tools/file-assign/runner'
import type { FileAssignConfig } from '../src/tools/file-assign/types'

let dir: string
let xlsxPath: string
const cfg: FileAssignConfig = {
  sourceDir: '',
  column: '文件地址',
  template: { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } },
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'file-assign-runner-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  cfg.sourceDir = dir
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('buildFileAssignRunner', () => {
  it('按 预览 → 执行 → 重载 顺序串联，apply 收到真实预览计划', async () => {
    const apply = vi.fn().mockResolvedValue({ renamedCount: 1, updatedRows: 1 })
    const reload = vi.fn().mockResolvedValue(undefined)
    const run = buildFileAssignRunner({ xlsxPath, apply, reload })
    await run(cfg)
    expect(apply).toHaveBeenCalledTimes(1)
    const params = apply.mock.calls[0][0] as { sourceDir: string; column: string; xlsxPath: string; plan: Array<{ newName: string }> }
    expect(params.sourceDir).toBe(dir)
    expect(params.column).toBe('文件地址')
    expect(params.xlsxPath).toBe(xlsxPath)
    expect(params.plan).toHaveLength(1)
    expect(params.plan[0].newName).toMatch(/^[a-z]{2}[ab]\.png$/)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('预览失败（目录不存在）→ 不执行 apply 与 reload，错误向上抛', async () => {
    const apply = vi.fn()
    const reload = vi.fn()
    const run = buildFileAssignRunner({ xlsxPath, apply, reload })
    await expect(run({ ...cfg, sourceDir: join(dir, '不存在') })).rejects.toThrow(/源文件夹不存在/)
    expect(apply).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('apply 失败 → 不 reload，错误向上抛', async () => {
    const apply = vi.fn().mockRejectedValue(new Error('重命名失败'))
    const reload = vi.fn()
    const run = buildFileAssignRunner({ xlsxPath, apply, reload })
    await expect(run(cfg)).rejects.toThrow('重命名失败')
    expect(reload).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/file-assign-runner.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 最小实现** `src/tools/file-assign/runner.ts`

```ts
/**
 * 计划自动分配执行器（tools 层）：preview → apply → 数据源重载 的串联封装
 * 依赖方向：依赖 ./planner ./applier ./types；被 app.ts 装配、注入 engine/scheduler（engine 不依赖 tools 运行时）
 */
import { preparePreview } from './planner'
import type { ApplyParams, ApplyResult } from './applier'
import type { FileAssignConfig } from './types'

/** 执行器依赖：xlsxPath 为全局配置；apply 与 reload 由 app.ts 提供真实实现（测试可替换） */
export interface FileAssignRunnerDeps {
  xlsxPath: string
  apply(params: ApplyParams): Promise<ApplyResult>
  reload(): Promise<void>
}

/** 构建分配执行器：校验预览（不落盘）→ 执行改名与写回 → 重载数据源；任一步失败向上抛（Scheduler 捕获后跳过依赖文件的任务） */
export function buildFileAssignRunner(deps: FileAssignRunnerDeps): (config: FileAssignConfig) => Promise<void> {
  return async (config) => {
    const plan = await preparePreview({ sourceDir: config.sourceDir, column: config.column, template: config.template, xlsxPath: deps.xlsxPath })
    await deps.apply({ sourceDir: config.sourceDir, column: config.column, plan: plan.plan, xlsxPath: deps.xlsxPath })
    await deps.reload()
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/file-assign-runner.test.ts`
Expected: PASS。

- [ ] **Step 5: FileAssignService 单例下沉与装配**

`src/server/routes/tools.ts`：
- 删除第 17 行模块级 `const service = new FileAssignService()` 及其上方注释
- import 改为 `import type { FileAssignService } from '../../tools/file-assign/applier'`（保留原有 `import { FileAssignService }` 的其它用途？不需要——路由不再 new）
- toolsRouter 依赖签名改为：

```ts
export function toolsRouter(deps: {
  xlsxPath: string
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void> }
  clash: ClashRouteDeps
  /** 文件随机分配服务（app.ts 单例注入：面板手动分配与计划自动分配共用 busy 锁） */
  fileAssignService: FileAssignService
}): Router {
```

- apply 路由内 `await service.apply({...})` 改为 `await deps.fileAssignService.apply({...})`

`src/server/app.ts`：
- ServerDeps 接口（`clash` 段前）追加：

```ts
  /** 文件随机分配服务（面板工具路由与计划自动分配共用单实例） */
  fileAssignService: import('../tools/file-assign/applier').FileAssignService
```

- toolsRouter 挂载行改为：

```ts
  api.use(toolsRouter({ xlsxPath: deps.cfg.dataSource.path, datasource: deps.datasource, clash: deps.clash, fileAssignService: deps.fileAssignService }))
```

`src/app.ts`：
- 顶部 import 追加：

```ts
import { FileAssignService } from './tools/file-assign/applier'
import { buildFileAssignRunner } from './tools/file-assign/runner'
```

- 数据源装配块（`await datasource.load(...)` 之后）追加：

```ts
  // 文件随机分配服务：单实例共享（面板手动分配与计划自动分配共用 busy 锁，防并发改同一文件夹）
  const fileAssignService = new FileAssignService()
```

- Scheduler 构造改为：

```ts
  const scheduler = new Scheduler({
    db, enqueuer, tasks, logger, timezone: cfg.scheduler.timezone,
    // 计划级「上传前自动分配」：preview（校验+计划）→ apply（改名+写回）→ 重载数据源
    // （窗口开窗时 accountResolver 才能读到新路径；任一步失败由 Scheduler 捕获并跳过依赖文件的任务）
    fileAssign: {
      run: buildFileAssignRunner({
        xlsxPath: cfg.dataSource.path,
        apply: (params) => fileAssignService.apply(params),
        reload: () => datasource.load(cfg.dataSource.path),
      }),
    },
  })
```

- createApp 依赖对象追加 `fileAssignService,`

`src/tasks/shelby-explorer.ts` meta 内 `concurrency: 4,` 后追加：

```ts
    // 依赖数据源「文件地址」列：计划触发时先自动文件随机分配（Scheduler.fire 据此执行）
    requiresFileAssign: true,
```

`tests/tools-route.test.ts` 第 29 行改为：

```ts
  app.use('/api/tools', toolsRouter({ xlsxPath, datasource: { reload, summary }, clash, fileAssignService: new FileAssignService() }))
```

并在其 import 区追加 `import { FileAssignService } from '../src/tools/file-assign/applier'`（如已存在则跳过）。

- [ ] **Step 6: 全量校验**

Run: `npm run typecheck` 与 `npm test`
Expected: 全绿（tools-route/web 既有用例不回归）。

- [ ] **Step 7: Commit**

```bash
git add src/tools/file-assign/runner.ts tests/file-assign-runner.test.ts src/server/routes/tools.ts src/server/app.ts src/app.ts src/tasks/shelby-explorer.ts tests/tools-route.test.ts
git commit -m "feat: 文件分配执行器与装配（服务单例下沉/计划注入/shelbynet 标记依赖分配）"
```

---

### Task 3: 计划路由校验 + OpenAPI 注解 + 前端 schema 手补

**Files:**
- Modify: `src/server/routes/schedules.ts`（validateFileAssign + parseBody 校验 + swagger 注解）
- Modify: `web/src/api/schema.d.ts`（手补 fileAssign 类型与 run 响应 reason 枚举）
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FileAssignConfig`；`validateTemplate`（tools/file-assign/name-template.ts）
- Produces: POST/PATCH `/api/schedules` 拒绝形状非法的 `config.fileAssign`（400 40000）；schema.d.ts 中 schedules config 含 fileAssign（Task 4 前端类型依赖）

- [ ] **Step 1: 写失败测试** 在 `tests/web.test.ts` 的 schedules describe 块（约 217 行「非法配置/未知任务 400」用例后）追加：

```ts
    it('POST /api/schedules fileAssign 形状非法 400，合法保存成功', async () => {
      const deps = makeDeps()
      deps.db.createSchedule.mockResolvedValue(row)
      const tpl = { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }
      const badCases = [
        { name: 'x', mode: 'daily', config: { times: ['09:00'], fileAssign: {} }, taskKeys: ['t1'] },
        { name: 'x', mode: 'daily', config: { times: ['09:00'], fileAssign: { sourceDir: '', column: '文件地址', template: tpl } }, taskKeys: ['t1'] },
        { name: 'x', mode: 'daily', config: { times: ['09:00'], fileAssign: { sourceDir: 'C:\\f', column: '', template: tpl } }, taskKeys: ['t1'] },
        { name: 'x', mode: 'daily', config: { times: ['09:00'], fileAssign: { sourceDir: 'C:\\f', column: '文件地址', template: { english: null, digits: null, special: null, position: { type: 'before' } } } }, taskKeys: ['t1'] },
      ]
      for (const body of badCases) {
        const res = await request(createApp(deps as never)).post('/api/schedules').send(body)
        expect(res.status).toBe(400)
        expect(res.body.code).toBe(40000)
      }
      const ok = await request(createApp(deps as never))
        .post('/api/schedules')
        .send({ name: 'x', mode: 'daily', config: { times: ['09:00'], fileAssign: { sourceDir: 'C:\\f', column: '文件地址', template: tpl } }, taskKeys: ['t1'] })
      expect(ok.status).toBe(200)
      expect(ok.body.code).toBe(0)
    })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web.test.ts`
Expected: 新用例 FAIL（fileAssign 目前不被校验，非法请求返回 200）。

- [ ] **Step 3: 最小实现** `src/server/routes/schedules.ts`

import 区追加：

```ts
import { validateTemplate } from '../../tools/file-assign/name-template'
import type { FileAssignConfig } from '../../tools/file-assign/types'
```

文件顶部（parseBody 前）追加：

```ts
/** 校验 config.fileAssign 形状（存在时）；非法返回中文文案，合法返回 null（触发时的完整校验由 preparePreview 负责） */
function validateFileAssign(fa: unknown): string | null {
  if (typeof fa !== 'object' || fa === null) return 'fileAssign 须为对象'
  const f = fa as Record<string, unknown>
  if (typeof f.sourceDir !== 'string' || !f.sourceDir.trim()) return 'fileAssign.sourceDir 须为非空字符串'
  if (typeof f.column !== 'string' || !f.column.trim()) return 'fileAssign.column 须为非空字符串'
  const err = validateTemplate(f.template as FileAssignConfig['template'])
  if (err) return `fileAssign.template 校验失败：${err}`
  return null
}
```

parseBody 内 `validateScheduleConfig` 校验块之后追加：

```ts
  // 自动分配配置形状校验（存在时）
  if (finalConfig?.fileAssign !== undefined) {
    const faErr = validateFileAssign(finalConfig.fileAssign)
    if (faErr) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, faErr)
  }
```

swagger 注解：5 处 config schema（GET 列表约 103-109 行、POST requestBody 约 135-142 行、POST 200 约 164-167 行、PATCH requestBody 约 202-206 行、PATCH 200 约 228-231 行）都在 `days: { type: array, nullable: true, items: { type: integer } }` 行后追加（缩进与该行 `days` 对齐）：

```yaml
                       fileAssign:
                         type: object
                         nullable: true
                         properties:
                           sourceDir: { type: string }
                           column: { type: string }
                           template:
                             type: object
                             properties:
                               english: { type: object, nullable: true }
                               digits: { type: object, nullable: true }
                               special: { type: object, nullable: true }
                               position: { type: object }
```

run 端点注解（约 301 行）reason 枚举改为：

```yaml
                           reason: { type: string, enum: [unknown-task, task-disabled, in-flight, file-assign-failed] }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web.test.ts`
Expected: PASS。

- [ ] **Step 5: 手补 `web/src/api/schema.d.ts`**

5 处 schedules 相关 config 块（`grep -n "days?: number\[\] | null" web/src/api/schema.d.ts` 定位，均在 `/api/schedules` 路径区块内）在 `days` 行后追加（缩进与该行一致）：

```ts
                                    fileAssign?: {
                                        sourceDir?: string;
                                        column?: string;
                                        template?: {
                                            english?: {
                                                count?: number;
                                                caseMode?: "lower" | "upper" | "mixed";
                                            } | null;
                                            digits?: {
                                                count?: number;
                                            } | null;
                                            special?: {
                                                count?: number;
                                                charset?: string;
                                            } | null;
                                            position?: {
                                                type?: string;
                                                value?: string | number;
                                            };
                                        };
                                    } | null;
```

约 296 行 reason 枚举改为：

```ts
                                    reason?: "unknown-task" | "task-disabled" | "in-flight" | "file-assign-failed";
```

- [ ] **Step 6: 全量校验**

Run: `npm run typecheck` 与 `npm test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/schedules.ts web/src/api/schema.d.ts tests/web.test.ts
git commit -m "feat: 计划接口校验并文档化 fileAssign 配置（形状校验+swagger+schema）"
```

---

### Task 4: 前端（类型 + 模板编辑器共享组件 + 定时任务弹窗）

**Files:**
- Modify: `web/src/types.ts`（ScheduleConfigInput + FileAssignConfigInput）
- Create: `web/src/components/name-template.ts`（TemplateForm/buildTemplate/sampleName/templateToForm/DEFAULT_TEMPLATE_FORM）
- Create: `web/src/components/name-template-editor.tsx`（受控编辑器组件）
- Create: `web/src/components/name-template.test.ts`
- Modify: `web/src/pages/tools/hooks.ts`（移除纯函数，改为重导出）
- Modify: `web/src/pages/tools/file-assign.tsx`（改用共享编辑器）
- Modify: `web/src/pages/schedules/hooks.ts`（FormValues + buildPayload 移入并支持 fileAssign）
- Modify: `web/src/pages/schedules/index.tsx`（弹窗新增自动分配区、列表列、提交逻辑）
- Modify: `web/src/pages/schedules/hooks.test.ts`（buildPayload 用例）

**Interfaces:**
- Consumes: Task 3 的 schema.d.ts（ScheduleItem.config.fileAssign 类型）
- Produces:
  - `TemplateForm`、`buildTemplate`、`sampleName`、`templateToForm`、`DEFAULT_TEMPLATE_FORM`（components/name-template）
  - `NameTemplateEditor({ value, onChange })`（components/name-template-editor）
  - `buildPayload(values: FormValues, template: FileAssignTemplate | null)`（pages/schedules/hooks）
  - 类型 `FileAssignConfigInput { sourceDir; column; template }`（web/src/types.ts）

- [ ] **Step 1: 写失败测试**（纯函数部分先行）

创建 `web/src/components/name-template.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_TEMPLATE_FORM, templateToForm } from './name-template'

describe('templateToForm', () => {
  it('null/undefined → 默认表单', () => {
    expect(templateToForm(null)).toEqual(DEFAULT_TEMPLATE_FORM)
    expect(templateToForm(undefined)).toEqual(DEFAULT_TEMPLATE_FORM)
  })

  it('模板对象 → 表单状态（组件开关与数值还原）', () => {
    const f = templateToForm({ english: null, digits: { count: 5 }, special: { count: 2, charset: '!@' }, position: { type: 'after' } })
    expect(f.english).toBe(false)
    expect(f.digits).toBe(true)
    expect(f.digitsCount).toBe(5)
    expect(f.special).toBe(true)
    expect(f.specialCount).toBe(2)
    expect(f.position).toBe('after')
  })

  it('after-position 数值回填为字符串', () => {
    const f = templateToForm({ english: { count: 2, caseMode: 'mixed' }, digits: null, special: null, position: { type: 'after-position', value: 3 } })
    expect(f.positionValue).toBe('3')
  })
})
```

在 `web/src/pages/schedules/hooks.test.ts` 追加（import 区补 `import dayjs from 'dayjs'`、`import type { FileAssignTemplate } from '../../types'`）：

```ts
describe('buildPayload', () => {
  const tpl: FileAssignTemplate = { english: null, digits: { count: 3 }, special: null, position: { type: 'before' } }

  it('开启自动分配 → config 携带 fileAssign（daily 模式）', () => {
    const p = buildPayload({ name: 'n', mode: 'daily', taskKeys: ['xyz-shelbynet'], times: [dayjs('09:00', 'HH:mm')], fileAssignEnabled: true, fileAssignSourceDir: 'C:\\f', fileAssignColumn: '文件地址' }, tpl)
    expect(p.config.fileAssign).toEqual({ sourceDir: 'C:\\f', column: '文件地址', template: tpl })
    expect(p.config.times).toEqual(['09:00'])
  })

  it('关闭自动分配 → config 不含 fileAssign', () => {
    const p = buildPayload({ name: 'n', mode: 'daily', taskKeys: ['xyz-shelbynet'], times: [dayjs('09:00', 'HH:mm')], fileAssignEnabled: false }, tpl)
    expect(p.config.fileAssign).toBeUndefined()
  })

  it('interval 模式时间配置保持原语义', () => {
    const p = buildPayload({ name: 'n', mode: 'interval', everyHours: 6, taskKeys: ['xyz-shelbynet'], fileAssignEnabled: true, fileAssignSourceDir: 'C:\\f', fileAssignColumn: '文件地址' }, tpl)
    expect(p.config.everyHours).toBe(6)
    expect(p.config.fileAssign?.template).toEqual(tpl)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix web run test`
Expected: 新用例 FAIL（模块/函数不存在）。

- [ ] **Step 3: 最小实现**（按依赖顺序）

`web/src/types.ts`：`ScheduleConfigInput` 改为：

```ts
export type ScheduleConfigInput = {
  everyHours?: number
  times?: string[]
  weekdays?: number[]
  days?: number[]
  fileAssign?: FileAssignConfigInput
}

/** 计划级自动文件分配配置（与后端 FileAssignConfig 同构） */
export interface FileAssignConfigInput {
  sourceDir: string
  column: string
  template: FileAssignTemplate
}
```

创建 `web/src/components/name-template.ts`（把 tools/hooks.ts 里 TemplateForm/buildTemplate/sampleName/INVALID_FILENAME_CHARS 原样搬入，并新增 DEFAULT_TEMPLATE_FORM 与 templateToForm）：

```ts
/**
 * 名称模板纯函数与表单类型（components 共享层）：文件随机分配工具页与定时计划弹窗复用
 * 依赖方向：仅依赖 ../types（前端自顶向下）；纯函数无副作用便于单测
 * 生成规则与后端 src/tools/file-assign/name-template.ts 保持一致
 */
import type { EnglishCase, FileAssignTemplate, PositionType } from '../types'

/** 模板编辑表单状态（与后端 FileAssignTemplate 一一对应） */
export interface TemplateForm {
  english: boolean
  englishCount: number
  caseMode: EnglishCase
  digits: boolean
  digitsCount: number
  special: boolean
  specialCount: number
  charset: string
  position: PositionType
  positionValue: string
}

/** 模板编辑默认值（工具页与计划弹窗共用） */
export const DEFAULT_TEMPLATE_FORM: TemplateForm = {
  english: true,
  englishCount: 4,
  caseMode: 'lower',
  digits: true,
  digitsCount: 3,
  special: true,
  specialCount: 2,
  charset: '!@$%^',
  position: 'before',
  positionValue: '',
}

/** 后端模板对象 → 表单状态（编辑计划回填用）；缺失字段按默认值兜底 */
export function templateToForm(t: FileAssignTemplate | null | undefined): TemplateForm {
  if (!t) return { ...DEFAULT_TEMPLATE_FORM }
  return {
    english: t.english != null,
    englishCount: t.english?.count ?? DEFAULT_TEMPLATE_FORM.englishCount,
    caseMode: t.english?.caseMode ?? 'lower',
    digits: t.digits != null,
    digitsCount: t.digits?.count ?? DEFAULT_TEMPLATE_FORM.digitsCount,
    special: t.special != null,
    specialCount: t.special?.count ?? DEFAULT_TEMPLATE_FORM.specialCount,
    charset: t.special?.charset ?? DEFAULT_TEMPLATE_FORM.charset,
    position: t.position?.type ?? 'before',
    positionValue: t.position?.value !== undefined ? String(t.position.value) : '',
  }
}

/** Windows 文件名非法字符（与后端 name-template 同规则） */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 表单 → 模板对象；校验失败返回 error 文案 */
export function buildTemplate(form: TemplateForm): { template: FileAssignTemplate } | { error: string } {
  const template: FileAssignTemplate = {
    english: form.english ? { count: Math.floor(form.englishCount), caseMode: form.caseMode } : null,
    digits: form.digits ? { count: Math.floor(form.digitsCount) } : null,
    special: form.special ? { count: Math.floor(form.specialCount), charset: form.charset.trim() } : null,
    position: { type: form.position },
  }
  if (form.position === 'after-position') {
    const n = Number(form.positionValue)
    if (!Number.isInteger(n) || n < 1) return { error: '指定位置需为不小于 1 的整数' }
    template.position.value = n
  }
  if (form.position === 'after-text') {
    const text = form.positionValue.trim()
    if (!text) return { error: '指定文本不能为空' }
    template.position.value = text
  }
  if (![template.english, template.digits, template.special].some((c) => c && c.count > 0)) return { error: '至少勾选一个生成组件（英文/数字/特殊字符）' }
  if (form.special) {
    if (!form.charset.trim()) return { error: '特殊字符集不能为空' }
    if (INVALID_FILENAME_CHARS.test(form.charset)) return { error: '特殊字符集含文件名非法字符' }
  }
  for (const c of [template.english, template.digits, template.special]) {
    if (c && (c.count < 1 || c.count > 20)) return { error: '组件个数需在 1-20 之间' }
  }
  return { template }
}

/** 示例名（纯展示）：与后端同规则的轻量实现；after-text 未命中时生成串放末尾 */
export function sampleName(oldName: string, template: FileAssignTemplate, rand: () => number = Math.random): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const pools = { lower, upper: lower.toUpperCase(), mixed: lower + lower.toUpperCase() }
  const pick = (pool: string, count: number) => Array.from({ length: count }, () => pool[Math.floor(rand() * pool.length)]).join('')
  let gen = ''
  if (template.english) gen += pick(pools[template.english.caseMode], template.english.count)
  if (template.digits) gen += pick('0123456789', template.digits.count)
  if (template.special) gen += pick(template.special.charset, template.special.count)
  const dot = oldName.lastIndexOf('.')
  const stem = dot > 0 ? oldName.slice(0, dot) : oldName
  const ext = dot > 0 ? oldName.slice(dot) : ''
  const pos = template.position
  let newStem: string
  if (pos.type === 'replace') newStem = gen
  else if (pos.type === 'before') newStem = gen + stem
  else if (pos.type === 'after') newStem = stem + gen
  else if (pos.type === 'after-position') {
    const n = Number(pos.value)
    newStem = n >= stem.length ? stem + gen : stem.slice(0, n) + gen + stem.slice(n)
  } else {
    const text = String(pos.value)
    const idx = stem.indexOf(text)
    newStem = idx < 0 ? stem + gen : stem.slice(0, idx + text.length) + gen + stem.slice(idx + text.length)
  }
  return newStem + ext
}
```

创建 `web/src/components/name-template-editor.tsx`：

```tsx
/**
 * 名称模板编辑器（components 共享层）：文件随机分配工具页与定时计划弹窗复用
 * 受控组件：value/onChange 传 TemplateForm；内含实时示例预览
 */
import { Checkbox, Input, InputNumber, Radio, Select, Space, Typography } from 'antd'
import { buildTemplate, sampleName, type TemplateForm } from './name-template'
import type { PositionType } from '../types'

/** 示例文件名（实时示例用，固定值保证演示稳定） */
const SAMPLE_OLD = '4^orgn23.png'

export interface NameTemplateEditorProps {
  value: TemplateForm
  onChange: (v: TemplateForm) => void
}

export function NameTemplateEditor({ value, onChange }: NameTemplateEditorProps) {
  const set = (patch: Partial<TemplateForm>) => onChange({ ...value, ...patch })
  const built = buildTemplate(value)
  const sample = 'error' in built ? built.error : sampleName(SAMPLE_OLD, built.template)
  return (
    <Space direction="vertical" size={12} style={{ display: 'flex' }}>
      <Space wrap size={12}>
        <Typography.Text>名称生成组件</Typography.Text>
        <Checkbox checked={value.english} onChange={(e) => set({ english: e.target.checked })}>
          英文(随机)
        </Checkbox>
        <InputNumber min={1} max={20} disabled={!value.english} value={value.englishCount} onChange={(v) => set({ englishCount: v ?? 0 })} />
        <Select
          style={{ width: 120 }}
          disabled={!value.english}
          value={value.caseMode}
          onChange={(v) => set({ caseMode: v })}
          options={[
            { value: 'lower', label: '小写 a-z' },
            { value: 'upper', label: '大写 A-Z' },
            { value: 'mixed', label: '大小写混合' },
          ]}
        />
        <Checkbox checked={value.digits} onChange={(e) => set({ digits: e.target.checked })}>
          数字(随机)
        </Checkbox>
        <InputNumber min={1} max={20} disabled={!value.digits} value={value.digitsCount} onChange={(v) => set({ digitsCount: v ?? 0 })} />
        <Checkbox checked={value.special} onChange={(e) => set({ special: e.target.checked })}>
          特殊字符
        </Checkbox>
        <InputNumber min={1} max={20} disabled={!value.special} value={value.specialCount} onChange={(v) => set({ specialCount: v ?? 0 })} />
        <Input style={{ width: 110 }} disabled={!value.special} value={value.charset} onChange={(e) => set({ charset: e.target.value })} placeholder="字符集" />
      </Space>
      <Space wrap size={12}>
        <Typography.Text>插入位置</Typography.Text>
        <Radio.Group value={value.position} onChange={(e) => set({ position: e.target.value as PositionType })}>
          <Radio.Button value="replace">替换文件名</Radio.Button>
          <Radio.Button value="before">文件名前</Radio.Button>
          <Radio.Button value="after">文件名后</Radio.Button>
          <Radio.Button value="after-position">指定位置后</Radio.Button>
          <Radio.Button value="after-text">指定文本后</Radio.Button>
        </Radio.Group>
        {value.position === 'after-position' && (
          <InputNumber min={1} value={value.positionValue ? Number(value.positionValue) : undefined} onChange={(v) => set({ positionValue: String(v ?? '') })} placeholder="位置" />
        )}
        {value.position === 'after-text' && (
          <Input style={{ width: 110 }} value={value.positionValue} onChange={(e) => set({ positionValue: e.target.value })} placeholder="文本" />
        )}
      </Space>
      <Typography.Text type="secondary">
        示例：<Typography.Text code>{SAMPLE_OLD}</Typography.Text> →{' '}
        <Typography.Text code>{'error' in built ? built.error : sample}</Typography.Text>
        （扩展名始终保留）
      </Typography.Text>
    </Space>
  )
}
```

`web/src/pages/tools/hooks.ts`：删除 TemplateForm 接口、INVALID_FILENAME_CHARS、buildTemplate、sampleName 定义，改为重导出（保持既有引用与测试不变）；`import type { EnglishCase, FileAssignTemplate, FileAssignRow, PositionType, ClashNodeResult } from '../../types'` 缩减为仍需要的类型。文件开头改为：

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { applyFileAssign, fetchTools, previewFileAssign, fetchClashStatus, testClash, optimizeClash, setClashGroup } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { FileAssignTemplate, FileAssignRow, ClashNodeResult } from '../../types'

/** 名称模板纯函数与表单类型（components 共享层；此处重导出保持既有引用） */
export { buildTemplate, sampleName, DEFAULT_TEMPLATE_FORM, templateToForm } from '../../components/name-template'
export type { TemplateForm } from '../../components/name-template'
```

（文件其余部分原样保留。）

`web/src/pages/tools/file-assign.tsx` 整体替换为：

```tsx
import { useState } from 'react'
import { App, Button, Card, Divider, Input, Select, Space, Table, Tag, Typography } from 'antd'
import { useFileAssignApply, useFileAssignPreview } from './hooks'
import { buildTemplate, DEFAULT_TEMPLATE_FORM, type TemplateForm } from '../../components/name-template'
import { NameTemplateEditor } from '../../components/name-template-editor'
import type { FileAssignPreview } from '../../types'

export default function FileAssignPanel() {
  const { message } = App.useApp()
  const preview = useFileAssignPreview()
  const apply = useFileAssignApply()

  const [sourceDir, setSourceDir] = useState('')
  const [column, setColumn] = useState('文件地址')
  const [templateForm, setTemplateForm] = useState<TemplateForm>({ ...DEFAULT_TEMPLATE_FORM })
  const [plan, setPlan] = useState<FileAssignPreview | null>(null)

  const doPreview = () => {
    if (!sourceDir.trim()) {
      message.warning('请先填写源文件夹路径')
      return
    }
    const built = buildTemplate(templateForm)
    if ('error' in built) {
      message.warning(built.error)
      return
    }
    preview.mutate(
      { sourceDir: sourceDir.trim(), column, template: built.template },
      { onSuccess: (data) => setPlan(data) },
    )
  }

  const doApply = () => {
    if (!plan) return
    apply.mutate(
      { sourceDir: sourceDir.trim(), column, plan: plan.plan },
      { onSuccess: () => setPlan(null) },
    )
  }

  return (
    <Card size="small" title="文件随机分配">
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Space wrap size={12}>
          <Typography.Text>源文件夹路径</Typography.Text>
          <Input
            style={{ width: 420 }}
            placeholder="C:\Users\PC\Desktop\空投文件\全部文件"
            value={sourceDir}
            onChange={(e) => {
              setSourceDir(e.target.value)
              setPlan(null)
            }}
          />
          <Button type="primary" loading={preview.isPending} onClick={doPreview}>
            生成预览
          </Button>
          {plan && (
            <Tag color="blue">
              已检测：{plan.filesCount} 个文件 / 账号 {plan.accountsCount} 行
            </Tag>
          )}
        </Space>

        <Space wrap size={12}>
          <Typography.Text>写入目标列</Typography.Text>
          <Select
            style={{ width: 160 }}
            value={column}
            onChange={(v) => {
              setColumn(v)
              setPlan(null)
            }}
            options={[
              { value: '图片地址', label: '图片地址' },
              { value: '文件地址', label: '文件地址' },
            ]}
          />
        </Space>

        <NameTemplateEditor value={templateForm} onChange={setTemplateForm} />

        <div>
          <Button type="primary" danger disabled={!plan} loading={apply.isPending} onClick={doApply}>
            执行分配
          </Button>
          <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
            执行前需先生成并确认预览
          </Typography.Text>
        </div>

        {plan && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Table
              size="small"
              rowKey="rowNumber"
              pagination={false}
              dataSource={plan.plan}
              columns={[
                { title: '窗口', dataIndex: 'window', width: 100 },
                {
                  title: '文件改名',
                  render: (_, r) => (
                    <span>
                      <Typography.Text delete type="secondary">{r.oldName}</Typography.Text>
                      <span style={{ margin: '0 8px', color: '#999' }}>→</span>
                      <Typography.Text style={{ color: '#1677ff' }}>{r.newName}</Typography.Text>
                    </span>
                  ),
                },
                { title: '目标路径', dataIndex: 'newPath', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
              ]}
            />
          </>
        )}
      </Space>
    </Card>
  )
}
```

`web/src/pages/schedules/hooks.ts`：import 区补 `import type { Dayjs } from 'dayjs'` 与 `import type { ScheduleItem, ScheduleConfigInput, FileAssignTemplate } from '../../types'`；追加 FormValues 与 buildPayload：

```ts
/** 弹窗表单值（times 为 dayjs 列表，提交时转 'HH:mm' 字符串；everyHours 可 null 与视图类型对齐） */
export interface FormValues {
  name: string
  mode: ScheduleMode
  everyHours?: number | null
  weekdays?: number[]
  days?: number[]
  times?: Dayjs[]
  taskKeys: string[]
  fileAssignEnabled?: boolean
  fileAssignSourceDir?: string
  fileAssignColumn?: string
}

/** 表单值 → 创建/更新请求体；开启自动分配时 config 携带 fileAssign（模板经 buildTemplate 校验后传入） */
export function buildPayload(values: FormValues, template: FileAssignTemplate | null): { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } {
  const base = { name: values.name, taskKeys: values.taskKeys, mode: values.mode }
  const config: ScheduleConfigInput = values.mode === 'interval'
    ? { everyHours: values.everyHours ?? 6 }
    : {
        times: (values.times ?? []).map((t) => t.format('HH:mm')).sort(),
        ...(values.mode === 'weekly' ? { weekdays: values.weekdays ?? [] } : {}),
        ...(values.mode === 'monthly' ? { days: values.days ?? [] } : {}),
      }
  if (values.fileAssignEnabled && template) {
    config.fileAssign = {
      sourceDir: values.fileAssignSourceDir ?? '',
      column: values.fileAssignColumn ?? '文件地址',
      template,
    }
  }
  return { ...base, config }
}
```

`web/src/pages/schedules/index.tsx` 整体替换为：

```tsx
/**
 * 定时任务页：Card+Table 列表 + 新建/编辑弹窗（模式 → 动态参数 → 选任务 → 上传前自动分配）
 * 依赖方向：页面 → 本目录 hooks → api/endpoints；任务多选数据源复用 tasks/hooks 的 useTasks
 * 弹窗内 times 用 dayjs 列表承载，提交时 buildPayload 转 'HH:mm' 字符串（interval 模式只取 everyHours）
 */
import { useState } from 'react'
import {
  App, Button, Card, Divider, Empty, Form, Input, InputNumber, Modal, Popconfirm,
  Segmented, Select, Space, Switch, Table, Tag, TimePicker, Typography,
} from 'antd'
import { ClockCircleOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  MODE_OPTIONS, WEEKDAY_OPTIONS, DAY_OPTIONS, modeLabel, buildPayload,
  useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule, useRunSchedule,
  type ScheduleMode, type FormValues,
} from './hooks'
import { useTasks } from '../tasks/hooks'
import { NameTemplateEditor } from '../../components/name-template-editor'
import { buildTemplate, DEFAULT_TEMPLATE_FORM, templateToForm, type TemplateForm } from '../../components/name-template'
import type { ScheduleItem, FileAssignTemplate } from '../../types'

export default function SchedulesPage() {
  const { message } = App.useApp()
  const { data: schedules, isLoading } = useSchedules()
  const { data: tasks } = useTasks()
  const create = useCreateSchedule()
  const update = useUpdateSchedule()
  const remove = useDeleteSchedule()
  const run = useRunSchedule()

  const [form] = Form.useForm<FormValues>()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduleItem | null>(null)
  const [templateForm, setTemplateForm] = useState<TemplateForm>({ ...DEFAULT_TEMPLATE_FORM })
  const mode = Form.useWatch('mode', form) ?? 'daily'
  const fileAssignEnabled = Form.useWatch('fileAssignEnabled', form) ?? false

  const taskOptions = (tasks ?? []).map((t) => ({ label: t.name, value: t.key }))

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ mode: 'daily', times: [dayjs('09:00', 'HH:mm')], taskKeys: [], fileAssignEnabled: false, fileAssignColumn: '文件地址' })
    setTemplateForm({ ...DEFAULT_TEMPLATE_FORM })
    setOpen(true)
  }

  const openEdit = (s: ScheduleItem) => {
    setEditing(s)
    form.resetFields()
    form.setFieldsValue({
      name: s.name,
      mode: s.mode,
      everyHours: s.config.everyHours,
      weekdays: s.config.weekdays ?? [],
      days: s.config.days ?? [],
      times: (s.config.times ?? []).map((t) => dayjs(t, 'HH:mm')),
      taskKeys: s.taskKeys,
      fileAssignEnabled: !!s.config.fileAssign,
      fileAssignSourceDir: s.config.fileAssign?.sourceDir ?? '',
      fileAssignColumn: s.config.fileAssign?.column ?? '文件地址',
    })
    setTemplateForm(templateToForm(s.config.fileAssign?.template as unknown as FileAssignTemplate | null | undefined))
    setOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    const built = buildTemplate(templateForm)
    const template = 'error' in built ? null : built.template
    if (values.fileAssignEnabled) {
      if (!template) {
        message.warning((built as { error: string }).error)
        return
      }
      if (!values.fileAssignSourceDir?.trim()) {
        message.warning('已开启自动分配，请填写源文件夹路径')
        return
      }
    }
    const payload = buildPayload(values, template)
    if (editing) {
      update.mutate({ id: editing.id, body: payload }, { onSuccess: () => setOpen(false) })
    } else {
      create.mutate(payload, { onSuccess: () => setOpen(false) })
    }
  }

  const columns = [
    { title: '计划名称', dataIndex: 'name', render: (n: string) => <Typography.Text strong>{n}</Typography.Text> },
    {
      title: '触发规则', dataIndex: 'ruleText', render: (_: string, s: ScheduleItem) => (
        <Space size={6}><Tag color="blue">{modeLabel(s.mode)}</Tag><span>{s.ruleText}</span></Space>
      ),
    },
    { title: '下次执行', dataIndex: 'nextRun', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    {
      title: '关联任务', dataIndex: 'taskNames', render: (names: Array<string | null>) => (
        <Space size={4} wrap>{names.map((n, i) => (n ? <Tag key={i}>{n}</Tag> : <Tag key={i} color="red">未知任务</Tag>))}</Space>
      ),
    },
    {
      title: '自动分配', width: 90, render: (_: unknown, s: ScheduleItem) => (
        s.config.fileAssign ? <Tag color="green">开启</Tag> : <Typography.Text type="secondary">—</Typography.Text>
      ),
    },
    {
      title: '启用', dataIndex: 'enabled', width: 80, render: (v: boolean, s: ScheduleItem) => (
        <Switch size="small" checked={v} onChange={(checked) => update.mutate({ id: s.id, body: { enabled: checked } })} />
      ),
    },
    {
      title: '操作', width: 200, render: (_: unknown, s: ScheduleItem) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<ClockCircleOutlined />} loading={run.isPending && run.variables === s.id} disabled={!s.enabled} onClick={() => run.mutate(s.id)}>立即运行</Button>
          <Button type="link" size="small" onClick={() => openEdit(s)}>编辑</Button>
          <Popconfirm title={`删除计划「${s.name}」？`} onConfirm={() => remove.mutate(s.id)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="定时任务"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建计划</Button>}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        独立调度子系统：先配时间，再选任务。到点对全部启用窗口入队（沿用全局错峰），错过不补跑，任务在途则跳过。
      </Typography.Paragraph>
      <Table<ScheduleItem>
        rowKey="id"
        size="middle"
        loading={isLoading}
        dataSource={schedules}
        columns={columns}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无计划，点击右上角新建" /> }}
      />

      <Modal
        title={editing ? `编辑计划 · ${editing.name}` : '新建计划'}
        open={open}
        onOk={submit}
        confirmLoading={create.isPending || update.isPending}
        onCancel={() => setOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ mode: 'daily', everyHours: 6, times: [dayjs('09:00', 'HH:mm')], taskKeys: [], fileAssignEnabled: false }}>
          <Form.Item name="name" label="计划名称" rules={[{ required: true, message: '请填写计划名称' }]}>
            <Input placeholder="例如：每日签到集合" maxLength={30} />
          </Form.Item>
          <Form.Item name="mode" label="频率模式">
            <Segmented options={MODE_OPTIONS} />
          </Form.Item>

          {mode === 'interval' && (
            <Form.Item name="everyHours" label="执行间隔" rules={[{ required: true, message: '请填写间隔小时数' }]}>
              <InputNumber min={1} max={23} addonAfter="小时一次（自 00:00 起算）" style={{ width: 260 }} />
            </Form.Item>
          )}

          {mode === 'weekly' && (
            <Form.Item name="weekdays" label="星期" rules={[{ required: true, message: '至少选择一个星期' }]}>
              <Select mode="multiple" options={WEEKDAY_OPTIONS} placeholder="可多选" />
            </Form.Item>
          )}

          {mode === 'monthly' && (
            <Form.Item name="days" label="每月几号" rules={[{ required: true, message: '至少选择一个日期' }]}>
              <Select mode="multiple" options={DAY_OPTIONS} placeholder="可多选（小月无该日自动跳过）" />
            </Form.Item>
          )}

          {mode !== 'interval' && (
            <Form.Item label="执行时间点">
              <Form.List name="times" rules={[{ validator: async (_, value) => { if (!value || value.length === 0) throw new Error('至少一个时间点') } }]}>
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name }) => (
                      <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                        <Form.Item name={name} rules={[{ required: true, message: '请选择时间' }]} style={{ marginBottom: 0 }}>
                          <TimePicker format="HH:mm" />
                        </Form.Item>
                        <Button size="small" danger onClick={() => remove(name)}>删除</Button>
                      </Space>
                    ))}
                    <Button type="dashed" onClick={() => add(dayjs('09:00', 'HH:mm'))} block>
                      + 添加时间点
                    </Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          )}

          <Form.Item name="taskKeys" label="选择任务（到点后依次触发）" rules={[{ required: true, message: '至少选择一个任务' }]}>
            <Select mode="multiple" options={taskOptions} placeholder="多选任务" optionFilterProp="label" />
          </Form.Item>

          <Divider style={{ margin: '4px 0 12px' }} />
          <Form.Item name="fileAssignEnabled" label="上传前自动文件随机分配" valuePropName="checked" extra="到点或「立即运行」时先自动分配文件再上传；分配失败则跳过依赖文件的任务">
            <Switch checkedChildren="开" unCheckedChildren="关" />
          </Form.Item>
          {fileAssignEnabled && (
            <>
              <Form.Item name="fileAssignSourceDir" label="源文件夹路径" rules={[{ required: true, message: '请填写源文件夹路径' }]}>
                <Input placeholder="C:\Users\PC\Desktop\空投文件\全部文件" />
              </Form.Item>
              <Form.Item name="fileAssignColumn" label="写入目标列">
                <Select style={{ width: 160 }} options={[{ value: '文件地址', label: '文件地址' }, { value: '图片地址', label: '图片地址' }]} />
              </Form.Item>
              <Form.Item label="名称模板">
                <NameTemplateEditor value={templateForm} onChange={setTemplateForm} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Card>
  )
}
```

注意：`s.config.fileAssign` 的类型来自 schema.d.ts（Task 3 已手补）——若 openEdit 处报 `fileAssign` 不存在，说明 Task 3 的 schema 手补漏了 GET 列表块，回 Task 3 补齐。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix web run test`
Expected: 全部 PASS（含既有 tools/hooks.test.tsx、schedules/hooks.test.ts 与新用例）。

- [ ] **Step 5: 全量校验**

Run: `npm run typecheck`、`npm test`、`npm --prefix web run build`
Expected: 全绿（build 含 web 的 tsc -b）。

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/components/name-template.ts web/src/components/name-template-editor.tsx web/src/components/name-template.test.ts web/src/pages/tools/hooks.ts web/src/pages/tools/file-assign.tsx web/src/pages/schedules/hooks.ts web/src/pages/schedules/index.tsx web/src/pages/schedules/hooks.test.ts
git commit -m "feat: 定时任务弹窗支持上传前自动文件随机分配（共享模板编辑器）"
```

---

### Task 5: 文档同步（docs/API-GUIDE.md）

**Files:**
- Modify: `docs/API-GUIDE.md`（第 2 章字段表、第 8 章新小节与接口表、9.2、9.3）

**Interfaces:**
- Consumes: 全部前置任务产物（仅文档）
- Produces: 用户手册覆盖 requiresFileAssign、计划级自动分配语义、面板用法、REST 说明

- [ ] **Step 1: 第 2 章 TaskMeta 字段表**（约 165 行 `concurrency` 行后）追加一行：

```markdown
| `requiresFileAssign` | `boolean?` | `undefined` | 声明任务依赖「上传前自动文件随机分配」：计划 `config` 配置了 `fileAssign` 且该任务通过守卫时，触发会先自动执行一次分配；分配失败则该任务本次跳过（`file-assign-failed`）。shelbynet 上传任务（`xyz-shelbynet`）为 `true` |
```

- [ ] **Step 2: 第 8 章** 「面板使用」段落（约 1117 行）后新增小节：

```markdown
### 上传前自动文件随机分配

计划 `config` 可带可选 `fileAssign` 段：`{ sourceDir, column, template }`（与工具中心「文件随机分配」参数同构）。配置后每次触发（到点或「立即运行」）都在开窗前自动执行一次分配：重命名源文件夹内文件并按名称模板生成唯一新名 → 写回 `accounts.xlsx` 的 `column` 列 → 重载数据源 → 再入队开窗。

- **只在确实有任务要跑时分配**：依赖文件的任务（`meta.requiresFileAssign: true`，如 shelbynet 上传任务）通过守卫才执行，避免在途/停用时白白改名
- **分配失败即不上传**：目录缺失/文件不足/模板非法 → 依赖文件的任务本次跳过（日志记 `file-assign-failed`），计划内其它任务照常触发；绝不让上一轮旧文件名混进上传
- 计划内无 `requiresFileAssign` 任务时，即使配置了 `fileAssign` 也不会执行分配
- 手动路径（任务页「立即触发」、看板行级执行、task:run 脚本）不经过计划，不受自动分配保护

面板「定时任务」弹窗勾选「上传前自动文件随机分配」并填写源文件夹/目标列/名称模板即生成该配置。
```

第 8 章 REST 接口表 POST 行改为：

```markdown
| POST | `/api/schedules` | 新建：`{ name, mode, config, taskKeys }`；`config` 可带 `fileAssign` 自动分配配置；校验失败 400 |
```

- [ ] **Step 3: 9.2 面板使用**（约 1146 行定时任务页条目）改为：

```markdown
- **定时任务页**：计划列表（名称/频率摘要/下次执行时间/包含的任务/自动分配标记），支持新建（四种频率模式，见第 8 章）、编辑、删除、开关与「立即运行」；新建/编辑弹窗可选开启「上传前自动文件随机分配」（到点先分配再上传，分配失败跳过上传任务，见第 8 章）。
```

- [ ] **Step 4: 9.3 REST 接口总表**：

`POST /api/schedules` 行改为：

```markdown
| POST | `/api/schedules` | 新建定时计划（name/mode/config/taskKeys；config 可带 fileAssign 自动分配） |
```

`POST /api/schedules/:id/run` 行改为：

```markdown
| POST | `/api/schedules/:id/run` | 立即运行定时计划（在途/停用任务跳过；分配失败跳过依赖文件任务） |
```

- [ ] **Step 5: 校验与提交**

Run: `npm run typecheck`（文档不影响，仅确认无意外改动）
Expected: 通过。

```bash
git add docs/API-GUIDE.md
git commit -m "docs: 同步上传前自动文件随机分配说明（TaskMeta/第8章/9.2/9.3）"
```

---

## 最终验证清单（全部任务完成后）

- [ ] `npm run typecheck` 全绿
- [ ] `npm test` 全绿
- [ ] `npm --prefix web run test` 全绿
- [ ] `npm --prefix web run build` 全绿
- [ ] 真机验证（需比特浏览器环境，无法自动化时留待用户确认）：新建带 fileAssign 的计划 → 「立即运行」→ 日志出现「上传前自动文件随机分配完成」→ 窗口上传的文件名为新随机名

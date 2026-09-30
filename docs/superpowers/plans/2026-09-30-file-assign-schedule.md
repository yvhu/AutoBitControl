# 文件随机分配「定时执行」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给「工具中心 → 文件随机分配」加定时自动执行：复用 schedules 表与调度器支持「纯分配计划」（taskKeys 为空 + config.fileAssign），到点自动执行一次分配，不开窗口、不触发任务。

**Architecture:** 复用现有 tick 调度器（`src/engine/scheduler.ts`）与 `schedules` 表，`fire()` 增加纯分配分支；`parseBody` 放宽为空 taskKeys + fileAssign；工具页文件分配面板加「定时执行」区块（频率配置抽共享组件），定时任务页适配显示「仅分配」计划。无新表、无新端点、无新调度器。

**Tech Stack:** Node + TypeScript（严格模式）、express、vitest、React 18 + antd 5 + react-query、dayjs。

## Global Constraints

- **全程不执行 `git commit`**（用户明确要求：代码不得提交，待其确认完整代码后再决定）。每个任务的「提交」步骤替换为本地验证（typecheck/test），改动保留在工作区。
- 代码风格：无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块；日志用 logger 中文消息。
- 所有注释/文档中文；用户文档 `docs/API-GUIDE.md` 必须与代码同批改（Task 8）。
- 验证命令：`npm run typecheck`（tsc --noEmit）、`npm test`（vitest run，tests/**）、`npm run test:web`（前端单测）。
- 测试跑完进程即退出，不留后台 node 进程（AGENTS.md 要求）。
- 纯分配计划约定：`taskKeys='[]'` + `config.fileAssign` 存在，名称固定「文件随机分配（定时）」，至多一条。

---

### Task 1: 分配执行器返回执行结果（ApplyResult）

**Files:**
- Modify: `src/tools/file-assign/runner.ts`
- Test: `tests/file-assign-runner.test.ts`

**Interfaces:**
- Produces: `buildFileAssignRunner(deps): (config: FileAssignConfig) => Promise<ApplyResult>`（返回类型由 `Promise<void>` 改为 `Promise<ApplyResult>`，供 Task 2 的 Scheduler 透传 renamedCount）

- [ ] **Step 1: 写失败测试**（修改 `tests/file-assign-runner.test.ts` 第一个用例，断言返回值）

将第 33-46 行的用例改为：

```ts
  it('按 预览 → 执行 → 重载 顺序串联，apply 收到真实预览计划且结果透传', async () => {
    const apply = vi.fn().mockResolvedValue({ renamedCount: 1, updatedRows: 1 })
    const reload = vi.fn().mockResolvedValue(undefined)
    const run = buildFileAssignRunner({ xlsxPath, apply, reload })
    const result = await run(cfg)
    expect(result).toEqual({ renamedCount: 1, updatedRows: 1 })
    expect(apply).toHaveBeenCalledTimes(1)
    const params = apply.mock.calls[0][0] as { sourceDir: string; column: string; xlsxPath: string; plan: Array<{ newName: string }> }
    expect(params.sourceDir).toBe(dir)
    expect(params.column).toBe('文件地址')
    expect(params.xlsxPath).toBe(xlsxPath)
    expect(params.plan).toHaveLength(1)
    expect(params.plan[0].newName).toMatch(/^[a-z]{2}[ab]\.png$/)
    expect(reload).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/file-assign-runner.test.ts`
Expected: 类型不匹配——`await run(cfg)` 返回 `void`，`result` 为 undefined，断言失败。

- [ ] **Step 3: 实现最小改动**（`src/tools/file-assign/runner.ts` 全文替换）

```ts
/**
 * 计划自动分配执行器（tools 层）：preview → apply → 数据源重载 的串联封装
 * 依赖方向：依赖 ./planner ./applier ./types；被 app.ts 装配、注入 engine/scheduler（engine 不依赖 tools 运行时）
 */
import { preparePreview } from './planner'
import type { ApplyParams, ApplyResult, FileAssignConfig } from './types'

/** 执行器依赖：xlsxPath 为全局配置；apply 与 reload 由 app.ts 提供真实实现（测试可替换） */
export interface FileAssignRunnerDeps {
  xlsxPath: string
  apply(params: ApplyParams): Promise<ApplyResult>
  reload(): Promise<void>
}

/** 构建分配执行器：校验预览（不落盘）→ 执行改名与写回 → 重载数据源；任一步失败向上抛（Scheduler 捕获后跳过依赖文件的任务）；成功返回执行结果（renamedCount/updatedRows） */
export function buildFileAssignRunner(deps: FileAssignRunnerDeps): (config: FileAssignConfig) => Promise<ApplyResult> {
  return async (config) => {
    const plan = await preparePreview({ sourceDir: config.sourceDir, column: config.column, template: config.template, xlsxPath: deps.xlsxPath })
    const result = await deps.apply({ sourceDir: config.sourceDir, column: config.column, plan: plan.plan, xlsxPath: deps.xlsxPath })
    await deps.reload()
    return result
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/file-assign-runner.test.ts`
Expected: 3 个用例全 PASS（其余用例断言 `rejects.toThrow` 不受影响）。

- [ ] **Step 5: 验证（不提交）**

Run: `npm run typecheck`
Expected: 无错误（app.ts 的 `fileAssign: { run: buildFileAssignRunner(...) }` 与 SchedulerDeps 兼容，Task 2 才改 deps 类型）。

---

### Task 2: Scheduler 纯分配计划分支 + RunNowResult.fileAssign

**Files:**
- Modify: `src/engine/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ApplyResult`（`{ renamedCount: number; updatedRows: number }`）。
- Produces: `RunNowResult` 增加 `fileAssign?: { ran: boolean; ok: boolean; renamedCount?: number; error?: string }`；`SchedulerDeps.fileAssign.run(config): Promise<ApplyResult>`；`fire()` 对 `taskKeys=[]` 的计划走纯分配分支。

- [ ] **Step 1: 写失败测试**（`tests/scheduler.test.ts`）

先改 `makeDeps` 默认值（第 152 行）：

```ts
    fileAssign: { run: vi.fn().mockResolvedValue({ renamedCount: 1, updatedRows: 1 }) },
```

再在文件末尾（第 349 行 `})` 之后）追加新 describe：

```ts
describe('Scheduler 纯分配计划（定时文件随机分配）', () => {
  const FA_TEMPLATE = { english: { count: 2, caseMode: 'lower' as const }, digits: null, special: null, position: { type: 'before' as const } }
  const FA_CFG = { sourceDir: 'C:\\files', column: '文件地址', template: FA_TEMPLATE }
  const pure = (config: string) => makeSchedule({ config, taskKeys: '[]' })

  it('到点触发：执行一次分配，不入队、不建批次', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([pure(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG }))])
    await new Scheduler(deps).tick()
    expect(deps.fileAssign.run).toHaveBeenCalledTimes(1)
    expect(deps.fileAssign.run).toHaveBeenCalledWith(FA_CFG)
    expect(deps.db.createBatch).not.toHaveBeenCalled()
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith({ schedule: '每日签到', renamedCount: 1 }, '定时文件随机分配完成')
  })

  it('runNow 纯分配计划成功 → fileAssign {ran:true, ok:true, renamedCount}', async () => {
    const deps = makeDeps()
    const result = await new Scheduler(deps).runNow(pure(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG })))
    expect(result).toEqual({ taskKeys: [], skipped: [], fileAssign: { ran: true, ok: true, renamedCount: 1 } })
  })

  it('纯分配计划分配失败 → fileAssign ok:false 附错误并告警，不入队', async () => {
    const deps = makeDeps()
    deps.fileAssign.run.mockRejectedValue(new Error('文件不足'))
    const result = await new Scheduler(deps).runNow(pure(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG })))
    expect(result.taskKeys).toEqual([])
    expect(result.fileAssign).toMatchObject({ ran: true, ok: false, error: '文件不足' })
    expect(deps.logger.warn).toHaveBeenCalled()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })

  it('taskKeys 为空且无 fileAssign → 防御性跳过并告警', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([pure('{"times":["09:00"]}')])
    await new Scheduler(deps).tick()
    expect(deps.fileAssign.run).not.toHaveBeenCalled()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('纯分配计划但执行器未装配 → fileAssign ok:false，error=分配执行器未装配', async () => {
    const deps = makeDeps({ fileAssign: undefined })
    const result = await new Scheduler(deps).runNow(pure(JSON.stringify({ times: ['09:00'], fileAssign: FA_CFG })))
    expect(result.fileAssign).toMatchObject({ ran: true, ok: false, error: '分配执行器未装配' })
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: 新 describe 的用例失败——纯分配计划目前走任务循环（`passing=[]` → 不执行分配，`result.fileAssign` 为 undefined）。

- [ ] **Step 3: 实现**（`src/engine/scheduler.ts` 三处改动）

3a. 顶部 import（第 13 行后追加）：

```ts
import type { ApplyResult, FileAssignConfig } from '../tools/file-assign/types'
```

3b. `RunNowResult` 与 `SchedulerDeps.fileAssign` 类型（替换第 17-48 行对应部分）：

```ts
/** 一次触发的任务级结果（面板「立即运行」与日志共用） */
export interface RunNowResult {
  /** 实际入队的任务 key */
  taskKeys: string[]
  /** 被跳过任务的明细 */
  skipped: Array<{ taskKey: string; reason: 'unknown-task' | 'task-disabled' | 'in-flight' | 'file-assign-failed' }>
  /** 自动文件分配本次执行结果（计划带 fileAssign 且本次执行了分配时返回；ran=false 表示本次未执行） */
  fileAssign?: { ran: boolean; ok: boolean; renamedCount?: number; error?: string }
}
```

```ts
  /** 上传前自动分配执行器（app.ts 注入 preview+apply+数据源重载；engine 不依赖 tools 运行时） */
  fileAssign?: {
    run(config: FileAssignConfig): Promise<ApplyResult>
  }
```

3c. `fire()` 全文替换（第 104-169 行）：

```ts
  /** 触发计划：纯分配计划（taskKeys 为空）直接执行一次分配；任务计划先守卫再分配再入队 */
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
    const taskKeys = keys as string[]
    // 纯分配计划：无任务，仅定时文件随机分配 → 执行一次分配即结束（失败错过即跳过，不入队不开窗）
    if (taskKeys.length === 0) {
      const fa = cfg.fileAssign
      if (!fa) {
        this.deps.logger.warn({ schedule: schedule.name }, '纯分配计划缺少 fileAssign 配置，跳过')
        return result
      }
      if (!this.deps.fileAssign) {
        result.fileAssign = { ran: true, ok: false, error: '分配执行器未装配' }
        this.deps.logger.warn({ schedule: schedule.name }, '纯分配计划但分配执行器未装配，跳过')
        return result
      }
      try {
        const out = await this.deps.fileAssign.run(fa)
        result.fileAssign = { ran: true, ok: true, renamedCount: out.renamedCount }
        this.deps.logger.info({ schedule: schedule.name, renamedCount: out.renamedCount }, '定时文件随机分配完成')
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        result.fileAssign = { ran: true, ok: false, error: err }
        this.deps.logger.warn({ schedule: schedule.name, err }, '定时文件随机分配失败（错过即跳过）')
      }
      return result
    }
    // 第一遍：任务级守卫，收集将通过的任务（分配只在有任务真正要跑时执行，避免在途/停用时白改名）
    const passing: string[] = []
    for (const key of taskKeys) {
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
    // 失败（含执行器未装配）→ 依赖文件的任务全部 skipped(file-assign-failed)，其余任务不受影响（不上传旧文件防重复）
    const fa = cfg.fileAssign
    const hasFileTask = passing.some((k) => this.deps.tasks.get(k)?.meta.requiresFileAssign)
    const needsAssign = !!fa && !!this.deps.fileAssign && hasFileTask
    let assignFailed = false
    let assignErr = ''
    let assignCount: number | undefined
    if (needsAssign) {
      try {
        const out = await this.deps.fileAssign!.run(fa!)
        assignCount = out.renamedCount
        this.deps.logger.info({ schedule: schedule.name }, '上传前自动文件随机分配完成')
      } catch (e) {
        assignFailed = true
        assignErr = e instanceof Error ? e.message : String(e)
        this.deps.logger.warn({ schedule: schedule.name, err: assignErr }, '自动文件随机分配失败，跳过依赖文件的任务')
      }
    } else if (fa && !this.deps.fileAssign && hasFileTask) {
      assignFailed = true
      assignErr = '分配执行器未装配'
      this.deps.logger.warn({ schedule: schedule.name, err: assignErr }, '计划配置了 fileAssign 但分配执行器未装配，跳过依赖文件的任务')
    }
    if (fa && hasFileTask) {
      result.fileAssign = {
        ran: needsAssign,
        ok: !assignFailed,
        ...(assignFailed ? { error: assignErr } : {}),
        ...(assignCount !== undefined ? { renamedCount: assignCount } : {}),
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
Expected: 全部 PASS（含原有「上传前自动文件随机分配」用例——默认 mock 已返回 `{renamedCount:1,updatedRows:1}`）。

- [ ] **Step 5: 验证（不提交）**

Run: `npm test`（全量，确认 file-assign-runner 等无回归）；`npm run typecheck`
Expected: 均通过。

---

### Task 3: 路由 parseBody 放宽空 taskKeys + swagger 注解

**Files:**
- Modify: `src/server/routes/schedules.ts`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `RunNowResult.fileAssign`（路由 run 透传，无需代码改动，仅注解）。
- Produces: `POST/PATCH /api/schedules` 允许 `taskKeys: []`（当最终 `config.fileAssign` 合法存在时）；否则 400。

- [ ] **Step 1: 写失败测试**（`tests/web.test.ts` 的 `describe('schedules API', ...)` 内，第 318 行 `})` 之前追加）

```ts
    it('POST /api/schedules 纯分配计划（空 taskKeys + fileAssign）创建成功', async () => {
      const deps = makeDeps()
      deps.db.createSchedule.mockResolvedValue({ ...row, taskKeys: '[]' })
      const tpl = { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }
      const res = await request(createApp(deps as never))
        .post('/api/schedules')
        .send({ name: '文件随机分配（定时）', mode: 'daily', config: { times: ['09:00'], fileAssign: { sourceDir: 'C:\\f', column: '文件地址', template: tpl } }, taskKeys: [] })
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(0)
      expect(deps.db.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ name: '文件随机分配（定时）', taskKeys: '[]' }))
    })

    it('POST /api/schedules 空 taskKeys 且无 fileAssign → 400', async () => {
      const deps = makeDeps()
      const res = await request(createApp(deps as never)).post('/api/schedules').send({ name: 'x', mode: 'daily', config: { times: ['09:00'] }, taskKeys: [] })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(40000)
      expect(deps.db.createSchedule).not.toHaveBeenCalled()
    })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web.test.ts`
Expected: 两个新用例失败（当前 taskKeys 空数组直接 400）。

- [ ] **Step 3: 实现**（`src/server/routes/schedules.ts`）

3a. `parseBody` 全文替换（第 49-95 行）：

```ts
/** 校验请求体并解析出写入参数；非法抛 400 */
function parseBody(deps: { tasks: Map<string, SiteTask> }, body: Record<string, unknown>, existing?: ScheduleRow): { name?: string; enabled?: boolean; mode?: ScheduleMode; config?: ScheduleConfig; taskKeys?: string[] } {
  const out: { name?: string; enabled?: boolean; mode?: ScheduleMode; config?: ScheduleConfig; taskKeys?: string[] } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '计划名称不能为空')
    out.name = body.name.trim()
  } else if (!existing) {
    throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'name 必填')
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'enabled 必须为布尔值')
    out.enabled = body.enabled
  }
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode as ScheduleMode)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'mode 非法')
    out.mode = body.mode as ScheduleMode
  }
  if (body.config !== undefined) {
    out.config = body.config as ScheduleConfig
  }
  // 合成最终 mode/config（先于 taskKeys 校验：空 taskKeys 是否合法取决于最终配置是否带 fileAssign）
  const finalMode = out.mode ?? (existing?.mode as ScheduleMode | undefined)
  const finalConfig = out.config ?? (existing ? (JSON.parse(existing.config) as ScheduleConfig) : undefined)
  if (!finalMode) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'mode 必填')
  const err = validateScheduleConfig(finalMode, finalConfig ?? {})
  if (err) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, err)
  // 自动分配配置形状校验（存在时）
  if (finalConfig?.fileAssign !== undefined) {
    const faErr = validateFileAssign(finalConfig.fileAssign)
    if (faErr) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, faErr)
  }
  if (body.taskKeys !== undefined) {
    if (!Array.isArray(body.taskKeys) || !body.taskKeys.every((k) => typeof k === 'string')) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKeys 必须为字符串数组')
    }
    out.taskKeys = body.taskKeys as string[]
  } else if (!existing) {
    throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKeys 必填')
  }
  // 空 taskKeys 仅允许纯分配计划（最终配置带 fileAssign）；任务 key 必须已注册（不引用幽灵任务）
  const finalTaskKeys = out.taskKeys ?? (existing ? (JSON.parse(existing.taskKeys) as string[]) : [])
  if (finalTaskKeys.length === 0 && finalConfig?.fileAssign === undefined) {
    throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKeys 为空时须同时配置 fileAssign（纯分配计划）')
  }
  for (const k of finalTaskKeys) {
    if (!deps.tasks.has(k)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `任务不存在: ${k}`)
  }
  return out
}
```

3b. swagger 注解：POST 与 PATCH 的请求体 `taskKeys` 两处（第 186 行、第 277 行）改为：

```
 *               taskKeys: { type: array, items: { type: string }, description: '可为空数组（纯分配计划：仅定时文件随机分配，须同时带 config.fileAssign）' }
```

3c. swagger 注解：`/schedules/{id}/run` 响应 `data` 里 `skipped` 之后（第 384 行 `}` 前）追加：

```
 *                     fileAssign:
 *                       type: object
 *                       nullable: true
 *                       description: 本次触发的自动分配执行结果（纯分配计划或任务前分配；ran=false 表示本次未执行）
 *                       properties:
 *                         ran: { type: boolean }
 *                         ok: { type: boolean }
 *                         renamedCount: { type: integer, nullable: true }
 *                         error: { type: string, nullable: true }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web.test.ts`
Expected: 全部 PASS（原有非法用例仍 400：`taskKeys: ['ghost']` 命中未注册检查）。

- [ ] **Step 5: 验证（不提交）**

Run: `npm test`；`npm run typecheck`
Expected: 均通过。

---

### Task 4: 前端共享组件 schedule-fields（频率配置抽取）

**Files:**
- Create: `web/src/components/schedule-fields.tsx`
- Modify: `web/src/pages/schedules/hooks.ts`（常量/类型改重导出）
- Modify: `web/src/pages/schedules/index.tsx`（弹窗改用共享组件）

**Interfaces:**
- Produces: `ScheduleFields`（Form 上下文内渲染，字段名 mode/everyHours/weekdays/days/times）、`MODE_OPTIONS`、`WEEKDAY_OPTIONS`、`DAY_OPTIONS`、`modeLabel`、`type ScheduleMode`。Task 6 工具页复用。

- [ ] **Step 1: 新建组件**（`web/src/components/schedule-fields.tsx`）

```tsx
/**
 * 计划频率配置字段（components 共享层）：定时任务弹窗与工具页定时执行区复用
 * 依赖方向：仅依赖 antd/dayjs 与 ../types（不依赖 pages 层）；选项常量供 schedules/hooks 重导出
 * 须置于 Form 内使用；mode 经 Form.useWatch 驱动动态参数
 */
import { Button, Form, InputNumber, Segmented, Select, Space, TimePicker } from 'antd'
import dayjs from 'dayjs'
import type { ScheduleItem } from '../types'

export type ScheduleMode = ScheduleItem['mode']

/** 频率模式选项（Segmented 与摘要徽标共用） */
export const MODE_OPTIONS: Array<{ label: string; value: ScheduleMode }> = [
  { label: '每 N 小时', value: 'interval' },
  { label: '每日', value: 'daily' },
  { label: '每周', value: 'weekly' },
  { label: '每月', value: 'monthly' },
]

/** 模式徽标文案（未知模式回退原文） */
export function modeLabel(mode: ScheduleMode): string {
  return MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode
}

/** 星期选项（1=周一 … 7=周日，与后端一致） */
export const WEEKDAY_OPTIONS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 },
]

/** 几号选项（1–31） */
export const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ label: `${i + 1} 号`, value: i + 1 }))

/** 频率配置字段组：mode 切换显示对应动态参数 */
export function ScheduleFields() {
  const mode = Form.useWatch('mode') ?? 'daily'
  return (
    <>
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
    </>
  )
}
```

- [ ] **Step 2: `web/src/pages/schedules/hooks.ts` 改重导出**

删除第 16-43 行的 `ScheduleMode`/`MODE_OPTIONS`/`modeLabel`/`WEEKDAY_OPTIONS`/`DAY_OPTIONS` 定义，替换为（同时保持 `buildPayload` 等其它内容不动）：

```ts
import { MODE_OPTIONS, modeLabel, WEEKDAY_OPTIONS, DAY_OPTIONS, type ScheduleMode } from '../../components/schedule-fields'
export { MODE_OPTIONS, modeLabel, WEEKDAY_OPTIONS, DAY_OPTIONS, type ScheduleMode }
```

- [ ] **Step 3: `web/src/pages/schedules/index.tsx` 弹窗改用组件**

3a. 顶部 import 调整：antd import 去掉 `Segmented`、`InputNumber`、`TimePicker`（`Select`/`dayjs` 仍用），并加：

```tsx
import { ScheduleFields } from '../../components/schedule-fields'
```

3b. 删除弹窗内第 158-200 行（`<Form.Item name="mode">` 到时间点 `</Form.Item>` 整段），替换为：

```tsx
          <ScheduleFields />
```

- [ ] **Step 4: 跑前端单测确认无回归**

Run: `npm run test:web`
Expected: 全部 PASS（`schedules/hooks.test.ts` 经重导出仍能测 `modeLabel`/`MODE_OPTIONS`/`buildPayload`）。

- [ ] **Step 5: 验证（不提交）**

Run: `npm run typecheck`
Expected: 无错误。

---

### Task 5: 前端类型/endpoints/tools hooks

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api/endpoints.ts`
- Modify: `web/src/pages/tools/hooks.ts`
- Test: `web/src/pages/tools/hooks.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `ScheduleMode`（tools/hooks 经 components 引入，不 import pages 层）。
- Produces: `RunScheduleResult` 类型；`useFileAssignSchedule()`（返回 `{ schedule: ScheduleItem | null; isLoading: boolean }`）、`useSaveFileAssignSchedule()`、`useUpdateFileAssignSchedule()`、`useRunFileAssignSchedule()`、`buildFileAssignSchedulePayload(values, fileAssign)` 纯函数。Task 6/7 使用。

- [ ] **Step 1: 写失败测试**（`web/src/pages/tools/hooks.test.tsx`）

顶部 import 改为：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import dayjs from 'dayjs'
import { buildTemplate, sampleName, useFileAssignApply, useUpdateFileAssignSchedule, buildFileAssignSchedulePayload } from './hooks'
import type { FileAssignTemplate } from '../../types'
```

文件末尾追加：

```tsx
describe('buildFileAssignSchedulePayload', () => {
  const tpl: FileAssignTemplate = { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }
  const assign = { sourceDir: 'C:\\files', column: '文件地址', template: tpl }

  it('daily 模式：times 转 HH:mm 排序，fileAssign 固化，taskKeys 恒为空', () => {
    const p = buildFileAssignSchedulePayload({ mode: 'daily', times: [dayjs('15:00', 'HH:mm'), dayjs('09:00', 'HH:mm')] }, assign)
    expect(p).toEqual({
      name: '文件随机分配（定时）',
      mode: 'daily',
      config: { times: ['09:00', '15:00'], fileAssign: assign },
      taskKeys: [],
    })
  })

  it('interval 模式：带 everyHours，无 times', () => {
    const p = buildFileAssignSchedulePayload({ mode: 'interval', everyHours: 6 }, assign)
    expect(p.config).toEqual({ everyHours: 6, fileAssign: assign })
    expect(p.taskKeys).toEqual([])
  })

  it('weekly 模式：带 weekdays', () => {
    const p = buildFileAssignSchedulePayload({ mode: 'weekly', weekdays: [1, 5], times: [dayjs('09:00', 'HH:mm')] }, assign)
    expect(p.config).toEqual({ times: ['09:00'], weekdays: [1, 5], fileAssign: assign })
  })
})

describe('useUpdateFileAssignSchedule', () => {
  it('成功后失效 schedules 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateFileAssignSchedule(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({ id: 1, enabled: false })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedules'] }))
  })
})
```

注意：文件顶部已有 `vi.mock('../../api/endpoints', ...)`，将其**替换**为下面的扩展版（新增 `updateSchedule` mock，否则会发真实请求）：

```tsx
vi.mock('../../api/endpoints', () => ({
  applyFileAssign: vi.fn().mockResolvedValue({ renamedCount: 2, updatedRows: 2, reloadedRows: 2 }),
  updateSchedule: vi.fn().mockResolvedValue({}),
}))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/pages/tools/hooks.test.tsx`（workdir=web，走 web/vitest.config.ts；全量则 `npm run test:web`）
Expected: `buildFileAssignSchedulePayload` 未定义报错。

- [ ] **Step 3: 实现**

3a. `web/src/types.ts` 第 102 行后追加：

```ts
/** 计划「立即运行」结果（/api/schedules/{id}/run；fileAssign 为本次自动分配结果，ran=false 表示未执行） */
export interface RunScheduleResult {
  taskKeys: string[]
  skipped: Array<{ taskKey: string; reason: string }>
  fileAssign?: { ran: boolean; ok: boolean; renamedCount?: number; error?: string }
}
```

3b. `web/src/api/endpoints.ts`：第 2 行 import 列表加 `RunScheduleResult`，第 29 行替换为：

```ts
export const runSchedule = (id: number) => post<RunScheduleResult>(`/api/schedules/${id}/run`, {})
```

3c. `web/src/pages/tools/hooks.ts`：import 区替换为：

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { applyFileAssign, fetchSchedules, fetchTools, createSchedule, updateSchedule, runSchedule, previewFileAssign } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { FileAssignTemplate, FileAssignRow, FileAssignConfigInput, ScheduleItem, ScheduleConfigInput } from '../../types'
import type { ScheduleMode } from '../../components/schedule-fields'
import type { Dayjs } from 'dayjs'
```

文件末尾追加：

```ts
// ===== 定时执行（纯分配计划） =====

/** 文件随机分配定时计划（taskKeys 为空且 config.fileAssign 存在；约定至多一条，取 id 最小） */
export function useFileAssignSchedule(): { schedule: ScheduleItem | null; isLoading: boolean } {
  const { data, isLoading } = useQuery({ queryKey: ['schedules'], queryFn: fetchSchedules, refetchInterval: 15000 })
  const schedule = (data ?? []).filter((s) => s.taskKeys.length === 0 && !!s.config.fileAssign).sort((a, b) => a.id - b.id)[0] ?? null
  return { schedule, isLoading }
}

/** 定时区频率表单值 → 计划写入参数（纯分配计划 taskKeys 恒为空数组，名称固定） */
export function buildFileAssignSchedulePayload(
  values: { mode: ScheduleMode; everyHours?: number | null; weekdays?: number[]; days?: number[]; times?: Dayjs[] },
  fileAssign: { sourceDir: string; column: string; template: FileAssignTemplate },
): { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } {
  const config: ScheduleConfigInput = values.mode === 'interval'
    ? { everyHours: values.everyHours ?? 6 }
    : { times: (values.times ?? []).map((t) => t.format('HH:mm')).sort() }
  if (values.mode === 'weekly') config.weekdays = values.weekdays ?? []
  if (values.mode === 'monthly') config.days = values.days ?? []
  config.fileAssign = fileAssign as FileAssignConfigInput
  return { name: '文件随机分配（定时）', mode: values.mode, config, taskKeys: [] }
}

/** 保存定时配置：无计划则创建，有计划则整体更新（参数固化进 fileAssign） */
export function useSaveFileAssignSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number | null; payload: { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } }) =>
      input.id === null ? createSchedule(input.payload) : updateSchedule(input.id, input.payload),
    onSuccess: () => {
      message.success('定时分配配置已保存')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 启用/停用定时分配（开关） */
export function useUpdateFileAssignSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => updateSchedule(id, { enabled }),
    onSuccess: (_res, v) => {
      message.success(v.enabled ? '已开启定时分配' : '已关闭定时分配')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 立即执行一次（同步返回本次分配结果） */
export function useRunFileAssignSchedule() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: runSchedule,
    onSuccess: (res) => {
      if (res.fileAssign?.ran) {
        if (res.fileAssign.ok) message.success(`文件随机分配已完成：重命名 ${res.fileAssign.renamedCount ?? 0} 个文件`)
        else message.error(`文件随机分配失败：${res.fileAssign.error ?? '未知错误'}`)
      } else {
        message.warning('该计划未配置自动分配')
      }
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:web`
Expected: 新增用例 PASS，原有用例不回归。

- [ ] **Step 5: 验证（不提交）**

Run: `npm run typecheck`
Expected: 无错误。

---

### Task 6: 工具页「定时执行」区块

**Files:**
- Modify: `web/src/pages/tools/file-assign.tsx`

**Interfaces:**
- Consumes: Task 5 的全部 hooks 与 `buildFileAssignSchedulePayload`；Task 4 的 `ScheduleFields`。
- Produces: 文件随机分配面板下方「定时执行」区块（开关/频率/保存/立即执行）。

- [ ] **Step 1: 实现**（`web/src/pages/tools/file-assign.tsx` 全文替换）

```tsx
import { useEffect, useState } from 'react'
import { App, Button, Card, Divider, Form, Input, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import {
  useFileAssignApply, useFileAssignPreview, useFileAssignSchedule,
  useSaveFileAssignSchedule, useUpdateFileAssignSchedule, useRunFileAssignSchedule,
  buildFileAssignSchedulePayload,
} from './hooks'
import { buildTemplate, DEFAULT_TEMPLATE_FORM, type TemplateForm } from '../../components/name-template'
import { NameTemplateEditor } from '../../components/name-template-editor'
import { ScheduleFields } from '../../components/schedule-fields'
import type { FileAssignPreview } from '../../types'

export default function FileAssignPanel() {
  const { message } = App.useApp()
  const preview = useFileAssignPreview()
  const apply = useFileAssignApply()
  const { schedule, isLoading: scheduleLoading } = useFileAssignSchedule()
  const saveSchedule = useSaveFileAssignSchedule()
  const updateSchedule = useUpdateFileAssignSchedule()
  const runSchedule = useRunFileAssignSchedule()

  const [sourceDir, setSourceDir] = useState('')
  const [column, setColumn] = useState('文件地址')
  const [templateForm, setTemplateForm] = useState<TemplateForm>({ ...DEFAULT_TEMPLATE_FORM })
  const [plan, setPlan] = useState<FileAssignPreview | null>(null)
  const [scheduleForm] = Form.useForm()

  // 已有定时计划时回填频率表单（仅以 id 为依赖：计划每 15 秒轮询刷新会换对象引用，避免覆盖编辑中的表单）
  useEffect(() => {
    if (!schedule) return
    scheduleForm.setFieldsValue({
      mode: schedule.mode,
      everyHours: schedule.config.everyHours,
      weekdays: schedule.config.weekdays ?? [],
      days: schedule.config.days ?? [],
      times: (schedule.config.times ?? []).map((t) => dayjs(t, 'HH:mm')),
    })
  }, [schedule?.id])

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

  /** 校验主表单并组装分配参数（源文件夹/目标列/模板）；失败提示并返回 null */
  const buildAssignConfig = () => {
    if (!sourceDir.trim()) {
      message.warning('请先填写源文件夹路径')
      return null
    }
    const built = buildTemplate(templateForm)
    if ('error' in built) {
      message.warning(built.error)
      return null
    }
    return { sourceDir: sourceDir.trim(), column, template: built.template }
  }

  /** 开关：开=无计划则按默认频率创建（参数固化），有计划则启用；关=停用（保留配置） */
  const toggleSchedule = (checked: boolean) => {
    if (!checked) {
      if (schedule?.id) updateSchedule.mutate({ id: schedule.id, enabled: false })
      return
    }
    const assign = buildAssignConfig()
    if (!assign) return
    if (schedule?.id) {
      updateSchedule.mutate({ id: schedule.id, enabled: true })
    } else {
      const values = scheduleForm.getFieldsValue(true)
      saveSchedule.mutate({
        id: null,
        payload: buildFileAssignSchedulePayload(
          { mode: values.mode ?? 'daily', everyHours: values.everyHours, weekdays: values.weekdays, days: values.days, times: values.times ?? [dayjs('09:00', 'HH:mm')] },
          assign,
        ),
      })
    }
  }

  /** 保存定时配置：校验频率表单与主表单后创建/更新计划 */
  const saveScheduleConfig = async () => {
    const assign = buildAssignConfig()
    if (!assign) return
    let values
    try {
      values = await scheduleForm.validateFields()
    } catch {
      return
    }
    saveSchedule.mutate({
      id: schedule?.id ?? null,
      payload: buildFileAssignSchedulePayload(
        { mode: values.mode, everyHours: values.everyHours, weekdays: values.weekdays, days: values.days, times: values.times },
        assign,
      ),
    })
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

        <Divider style={{ margin: '8px 0' }} />
        <Space wrap size={12}>
          <Typography.Text strong>定时执行</Typography.Text>
          <Switch
            checked={!!schedule?.enabled}
            loading={scheduleLoading || saveSchedule.isPending || updateSchedule.isPending}
            onChange={toggleSchedule}
          />
          <Typography.Text type="secondary">
            到点自动分配一次（不触发任务、不开窗口），失败仅记日志、错过即跳过
          </Typography.Text>
        </Space>

        <Form
          form={scheduleForm}
          layout="vertical"
          initialValues={{ mode: 'daily', everyHours: 6, times: [dayjs('09:00', 'HH:mm')] }}
        >
          <ScheduleFields />
        </Form>

        <Space wrap size={12}>
          <Button type="primary" loading={saveSchedule.isPending} onClick={saveScheduleConfig}>
            保存定时配置
          </Button>
          <Button
            loading={runSchedule.isPending}
            disabled={!schedule || !schedule.enabled}
            onClick={() => schedule && runSchedule.mutate(schedule.id)}
          >
            立即执行一次
          </Button>
          <Typography.Text type="secondary">
            保存时把上方源文件夹/目标列/名称模板固化进计划；改参数后需重新保存才生效
          </Typography.Text>
        </Space>
      </Space>
    </Card>
  )
}
```

- [ ] **Step 2: 验证（不提交）**

Run: `npm run typecheck`；`npm run test:web`
Expected: 均通过。

---

### Task 7: 定时任务页适配（仅分配标签/校验/立即运行提示）

**Files:**
- Modify: `web/src/pages/schedules/index.tsx`
- Modify: `web/src/pages/schedules/hooks.ts`

**Interfaces:**
- Consumes: Task 5 的 `RunScheduleResult`（useRunSchedule 提示适配）、Task 4 的 `ScheduleFields`。

- [ ] **Step 1: 实现**（`web/src/pages/schedules/index.tsx`）

1a. 「关联任务」列（第 98-102 行）替换为：

```tsx
    {
      title: '关联任务', dataIndex: 'taskNames', render: (names: Array<string | null>, s: ScheduleItem) => (
        names.length === 0 && s.config.fileAssign
          ? <Tag color="purple">仅分配</Tag>
          : <Space size={4} wrap>{names.map((n, i) => (n ? <Tag key={i}>{n}</Tag> : <Tag key={i} color="red">未知任务</Tag>))}</Space>
      ),
    },
```

1b. `taskKeys` 表单项（第 202-204 行）替换为：

```tsx
          <Form.Item
            name="taskKeys"
            label="选择任务（到点后依次触发）"
            rules={[{
              validator: (_, value: string[] | undefined) => {
                if (!fileAssignEnabled && (!value || value.length === 0)) return Promise.reject(new Error('至少选择一个任务'))
                return Promise.resolve()
              },
            }]}
          >
            <Select mode="multiple" options={taskOptions} placeholder="多选任务（开启自动分配后可不选=仅分配计划）" optionFilterProp="label" />
          </Form.Item>
```

1c. `useRunSchedule` 提示适配（`web/src/pages/schedules/hooks.ts` 第 126-139 行 `onSuccess` 替换为）：

```ts
    onSuccess: (res) => {
      if (res.fileAssign?.ran && res.taskKeys.length === 0) {
        if (res.fileAssign.ok) {
          message.success(`文件随机分配已完成：重命名 ${res.fileAssign.renamedCount ?? 0} 个文件`)
        } else {
          message.error(`文件随机分配失败：${res.fileAssign.error ?? '未知错误'}`)
        }
        return
      }
      if (res.skipped.length > 0) {
        message.warning(`已触发 ${res.taskKeys.length} 个任务，跳过 ${res.skipped.length} 个（在途/停用）`)
      } else {
        message.success(`已触发 ${res.taskKeys.length} 个任务`)
      }
    },
```

- [ ] **Step 2: 验证（不提交）**

Run: `npm run test:web`；`npm run typecheck`
Expected: 均通过（schedules hooks 测试不覆盖 mutation 提示，仅纯函数）。

---

### Task 8: 用户文档同步（docs/API-GUIDE.md）

**Files:**
- Modify: `docs/API-GUIDE.md`

- [ ] **Step 1: 第 7 章新增小节**（第 1074 行「面板「定时任务」弹窗勾选…」段之后追加）

```markdown
### 独立定时分配（纯分配计划）

工具页「文件随机分配」面板的「定时执行」区创建的是**纯分配计划**：`taskKeys` 为空、`config.fileAssign` 非空。到点只执行一次文件随机分配（成功记日志），不触发任何任务、不开窗口；失败仅记日志、错过即跳过。计划列表「关联任务」列显示紫色「仅分配」标签；开关/编辑/删除/「立即运行」与普通计划一致。定时执行用的源文件夹/目标列/名称模板在「保存定时配置」时从工具面板主表单固化进计划配置。
```

- [ ] **Step 2: 8.2 面板使用更新**（第 1103、1104 行两处）

第 1103 行末尾追加：

```markdown
任务列表为空的纯分配计划标「仅分配」（来自工具页「文件随机分配」的定时执行区，见第 11 章）。
```

第 1104 行替换为：

```markdown
- **工具页**：工具卡片中心（卡片数据来自 `GET /api/tools`，随需扩展），目前一个工具——「文件随机分配」，点卡片展开对应工具面板（手动分配 ＋ 定时执行区），用法见[第 11 章](#11-工具中心)。
```

- [ ] **Step 3: 8.3 REST 接口总表更新**（第 1120、1123 行）

第 1120 行替换为：

```markdown
| POST | `/api/schedules` | 新建定时计划（name/mode/config/taskKeys；config 可带 fileAssign 自动分配；taskKeys 可为空数组=纯分配计划，须同时带 fileAssign） |
```

第 1123 行替换为：

```markdown
| POST | `/api/schedules/:id/run` | 立即运行定时计划（在途/停用任务跳过；分配失败跳过依赖文件任务；响应含 fileAssign 本次分配结果） |
```

- [ ] **Step 4: 第 11 章工具中心更新**（第 1608 行「执行是破坏性操作…」之后追加）

```markdown
- 定时执行：面板下方「定时执行」区开启后形成「纯分配计划」——「保存定时配置」时把上方源文件夹/目标列/名称模板固化进计划，按四种频率模式（每 N 小时/每日/每周/每月）到点自动执行一次分配（不触发任务、不开窗口）；失败仅记日志、错过即跳过；「立即执行一次」可当场验证并返回重命名数量。该计划同步出现在「定时任务」页（标「仅分配」），可开关/删除/编辑。
```

- [ ] **Step 5: 验证（不提交）**

Run: `npm run typecheck`
Expected: 无错误（文档不影响编译，仅确认无未预期改动）。

---

### Task 9: 全量验证

**Files:** 无

- [ ] **Step 1: 全量测试**

Run: `npm test`、`npm run test:web`、`npm run typecheck`
Expected: 三项全过。

- [ ] **Step 2: 面板手测指引（无需比特浏览器，dev 起服务后人工确认）**

1. `npm run dev` → 工具页 → 文件随机分配卡片：填源文件夹 → 打开「定时执行」开关 → 出现成功提示，定时任务页出现「文件随机分配（定时）」计划（「仅分配」标签、开启状态）。
2. 工具页点「立即执行一次」→ 提示「文件随机分配已完成：重命名 N 个文件」。
3. 改频率为每周并点「保存定时配置」→ 定时任务页该计划规则摘要变为「周… HH:mm」。
4. 关闭开关 → 计划「启用」列变灰，配置保留；再打开 → 直接恢复。
5. 手动「执行分配」与「立即执行一次」交替点 → busy 锁生效（409 提示或等待）。

**不提交任何 git commit（用户要求，等其确认完整代码后统一决定）。**

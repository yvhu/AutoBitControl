# 删除调度器与窗口级触发入口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目改为纯手动触发：彻底删除 Scheduler/croner/错峰/间隔调度，删除窗口页「立即跑」、看板「重跑今日失败」「全部窗口执行」三个入口，同步文档与测试。

**Architecture:** 纯删除型改动。触发面收敛为：任务页「立即触发」（任务×全部启用窗口）+ 看板行级「执行/重跑」（单窗口×单任务）+ 重试机制（retry_wait→scheduleRetry 定时器，与调度器无关）。任务开关保留，语义改为手动触发守卫（停用→409）。

**Tech Stack:** Node + TS strict（无新依赖；删除 croner）、vitest、react-query/antd 前端。

**Spec:** `docs/superpowers/specs/2026-09-03-remove-scheduler-and-window-triggers-design.md`

## Global Constraints

- 每步改动后 `npm run typecheck` 与 `npm test` 必须通过；涉及前端时 `npm run test:web` 也必须通过
- 无分号、单引号、2 空格缩进；注释/commit message 用中文；commit 风格 conventional（`feat:`/`refactor:`/`docs:` + 中文）
- `web/src/api/schema.d.ts` 为手补类型，不跑 openapi-typescript 重新生成
- 不提交 config/.env、config.local.json、accounts.xlsx
- 保留：retry-recovery、queue、WindowRunner 主流程、脚本（task:run/smoke）、任务开关与云端 task_states

---

### Task 1: 删除调度器（引擎 + 装配 + 配置 + 任务 meta + 对应测试）

**Files:**
- Delete: `src/engine/scheduler.ts`、`tests/scheduler.test.ts`
- Modify: `src/engine/task.ts`、`src/engine/window-runner.ts`、`src/app.ts`、`src/server/app.ts`、`src/server/routes/tasks.ts`、`src/server/routes/settings.ts`、`src/infrastructure/config.ts`、`config/config.json`、`package.json`、`src/tasks/example-checkin.ts`、`src/tasks/faucet-example.ts`、`src/tasks/mint-example.ts`、`src/tasks/inception-dachain.ts`、`src/tasks/portal-rhuna.ts`、`src/tasks/index.ts`、`tests/windowRunner.test.ts`、`tests/web.test.ts`、`web/src/pages/settings/index.tsx`、`web/src/api/schema.d.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `TaskMeta` 不再有 `schedule` 字段、不再有 `isIntervalSchedule`；`AppConfig.execution` 不再有 `timezone`；`ServerDeps`/`tasksRouter` 不再有 `onToggle`；`AppDb` 暂时保留 `getTaskFiredAt`/`setTaskFiredAt`（Task 2 删除）

- [ ] **Step 1: 删除调度器文件与任务 meta 的 schedule**

删除 `src/engine/scheduler.ts`、`tests/scheduler.test.ts` 两个文件。

`src/engine/task.ts`：删第 11 行注释中的「；schedule 支持 cron 字符串或错峰窗口（stagger 起止时刻）」，删第 28-29 行 `schedule` 字段、删第 45-51 行 `isIntervalSchedule` 函数（含其上注释），第 26 行 enabled 注释改为 `/** 任务开关（纯代码开关）：false 时手动触发接口 409；面板开关可运行时覆盖 */`。

`src/engine/window-runner.ts`：第 20 行改为 `import type { TaskMeta } from './task'`；删除第 299-302 行：

```ts
        // 间隔任务：成功完成时刻回写调度锚点（只增不减），下一轮 = 锚点 + N 小时 + 缓冲
        if (isIntervalSchedule(task.meta.schedule)) {
          await this.safeDb(() => db.setTaskFiredAt(taskKey, finishedAt), undefined)
        }
```

`src/tasks/example-checkin.ts` 删除：

```ts
    // 每日错峰执行：9 点到 11 点之间随机取一个时间点
    schedule: { stagger: ['09:00', '11:00'] },
```

`src/tasks/faucet-example.ts` 删除第 17 行 `    schedule: { stagger: ['10:00', '12:00'] },`。
`src/tasks/mint-example.ts` 删除第 17 行 `    schedule: undefined, // 无固定时间，手动触发（面板任务页点"立即触发"）`。
`src/tasks/inception-dachain.ts` 第 58 行与 `src/tasks/portal-rhuna.ts` 第 60 行删除 `    // 无 schedule：仅手动触发/窗口立即跑（按模板默认）`。
`src/tasks/index.ts` 第 4 行改为 ` * 设计思路：新任务三步——新建文件实现 SiteTask → 在 ALL 数组登记 → 自动获得 API/面板能力`；第 13 行改为 `// 全部任务实例（每个任务一个单例，跨 API/队列共享状态）`。

- [ ] **Step 2: 拆除 app.ts 装配与 server 层 onToggle**

`src/app.ts`：
- 删除第 14 行 `import { Scheduler } from './engine/scheduler'`
- 删除第 185-187 行（注释 + `let scheduler: Scheduler | undefined`）
- 删除第 203 行 `    onToggle: (key) => void scheduler?.refreshTask(key),`
- 删除第 218-219 行 `  scheduler = new Scheduler(cfg, db, tasks, enqueuer, logger)` 与 `  await scheduler.start()`
- 第 242 行 shutdown 中删除 `    scheduler.stop()`

`src/server/app.ts`：删除第 50-51 行：

```ts
  /** 任务开关 PATCH 成功后回调（key, enabled）：调度器按 key 即时重注册/停止 cron */
  onToggle?: (key: string, enabled: boolean) => void
```

`src/server/routes/tasks.ts`：
- 第 146 行 deps 类型删掉 `onToggle?: (key: string, enabled: boolean) => void`（注意保留前导逗号格式）
- GET 构建列表（约第 164 行）删除 `        schedule: m.schedule ?? null,`
- PATCH 中删除第 178-179 行注释与 `    deps.onToggle?.(key, body.enabled)`
- swagger 注解 `/api/tasks` get 的 properties 中删除：

```
 *                       schedule:
 *                         type: object
 *                         nullable: true
 *                         description: 'cron 字符串 / { stagger: [start, end] } 每日错峰 / { everyHours: N } 每 N 小时（锚点=最近一次成功完成时刻）'
```

- [ ] **Step 3: 删除 timezone 配置与设置暴露**

`src/infrastructure/config.ts`：删第 33 行 `  timezone: string`；删 defaults 中第 121-122 行：

```ts
    // croner 解析调度时间的时区
    timezone: 'Asia/Shanghai',
```

`config/config.json`：删 `execution` 段第 16 行 `    "timezone": "Asia/Shanghai",`。
`src/server/routes/settings.ts`：删 `PublicSettings` 中 `timezone: string`（第 14 行）、swagger properties 中 `timezone: { type: string }`（第 48 行）、响应构造中 `timezone: deps.cfg.execution.timezone,`（第 101 行）。
`web/src/pages/settings/index.tsx`：删第 70 行 `{ key: 'timezone', label: '时区', children: s.timezone },`。
`web/src/api/schema.d.ts`：删第 244 行 `timezone?: string;`。
`package.json`：删 `"croner": "^10.0.1",`。

- [ ] **Step 4: 更新受影响测试**

`tests/windowRunner.test.ts`：
- 删第 22 行 `    setTaskFiredAt: vi.fn().mockResolvedValue(undefined),`
- 删第 84-94 行 fixture：

```ts
/** 间隔调度（everyHours）任务 fixture：成功回写锚点用例用 */
class IntervalTask implements SiteTask {
  meta = { key: 'iv', name: 'IV', url: 'https://a.io', schedule: { everyHours: 8 } }
  run = vi.fn().mockResolvedValue(undefined)
}

/** 错峰窗口（stagger）任务 fixture：非间隔任务不回写锚点用例用 */
class StaggerTask implements SiteTask {
  meta = { key: 'daily', name: 'DAILY', url: 'https://a.io', schedule: { stagger: ['09:00', '11:00'] as [string, string] } }
  run = vi.fn().mockResolvedValue(undefined)
}
```

- 删第 312-324 行两个锚点用例（`间隔任务成功后回写锚点（只增不减）`、`非间隔任务成功不回写锚点`）

`tests/web.test.ts`：
- 第 26 行 meta 类型改 `{ key: string; name: string; url: string; wallet: string; enabled?: boolean }`（删 `schedule: string;`）
- 第 31 行 `execution` 类型删 `timezone: string;`
- 第 43 行删 `  onToggle: Mock`
- 第 65 行 fixture 删 `, schedule: '0 9 * * *'`
- 第 70 行删 `timezone: 'Asia/Shanghai', `
- 第 89 行删 `    onToggle: vi.fn(),`
- 第 196 行删 `    expect(deps.onToggle).toHaveBeenCalledWith('t1', false)`
- 第 204 行删 `    expect(deps.onToggle).not.toHaveBeenCalled()`

- [ ] **Step 5: 更新依赖锁与验证**

Run: `npm uninstall croner`
Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿
Run: `npm run test:web` → Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: 删除调度器 cron 与 meta.schedule（纯手动触发）"
```

---

### Task 2: 删除数据层调度锚点（task_states.last_fired_at）

**Files:**
- Modify: `src/infrastructure/db.ts`、`tests/db.test.ts`

**Interfaces:**
- Consumes: Task 1（`AppDb` 方法已无调用方）
- Produces: `AppDb` 不再有 `getTaskFiredAt`/`setTaskFiredAt`；`task_states` 表只剩 `task_key`/`enabled` 两列（新库）

- [ ] **Step 1: 删除 SCHEMA 列与迁移逻辑**

`src/infrastructure/db.ts`：
- 第 121 行删 `    last_fired_at TEXT`（task_states 建表语句只剩 `task_key`/`enabled` 两行）
- 删第 174-178 行迁移块：

```ts
    // 老库补列：task_states.last_fired_at（间隔调度锚点，毫秒 ISO）
    const tsInfo = await this.client.execute(`PRAGMA table_info(task_states)`)
    if (!tsInfo.rows.some((r) => String(r.name) === 'last_fired_at')) {
      await this.client.execute(`ALTER TABLE task_states ADD COLUMN last_fired_at TEXT`)
    }
```

- 删第 262-281 行两个方法（`getTaskFiredAt`/`setTaskFiredAt` 及其完整注释）

- [ ] **Step 2: 更新 db 测试**

`tests/db.test.ts`：
- 删第 161-172 行整个 describe 块：

```ts
describe('task_states 间隔锚点', () => {
  it('setTaskFiredAt 只增不减且不覆盖 enabled', async () => {
    ...
  })
})
```

- 「runs 老库迁移」用例中删第 192 行 `    await db.setTaskFiredAt('t', '2026-08-31T09:00:00.000Z')`（第 178 行注释「无 slot、无 last_fired_at」保留不动）

- [ ] **Step 3: 验证**

Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿（db.test.ts 内存库用例仍过）

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/db.ts tests/db.test.ts
git commit -m "refactor: 删除 task_states 调度锚点列与方法"
```

---

### Task 3: 删除窗口页「立即跑」（后端路由 + 前端按钮）

**Files:**
- Modify: `src/server/routes/profiles.ts`、`tests/web.test.ts`、`web/src/api/schema.d.ts`、`web/src/api/endpoints.ts`、`web/src/pages/profiles/hooks.ts`、`web/src/pages/profiles/index.tsx`

**Interfaces:**
- Consumes: Task 1
- Produces: `POST /api/profiles/:id/run` 不存在（404 兜底）；`endpoints.ts` 无 `runProfile`；profiles 页无 `useRunProfile`

- [ ] **Step 1: 删除后端路由与 swagger**

`src/server/routes/profiles.ts`：
- 第 2 行文件头注释改为 ` * 窗口路由（server 层）：窗口列表、启用开关、打开/关闭与熔断重置`
- 第 12 行删 `import type { SiteTask } from '../../tasks/base'`（该文件仅 deps 类型用到，一并清理）
- 第 200-207 行 deps 类型删 `  tasks: Map<string, SiteTask>`（`/run` 路由是该文件唯一使用方）
- 删 swagger 块 `/api/profiles/{id}/run`（第 87-114 行，从 `/**` 到 `*/` 完整注释块）
- 删路由（第 246-256 行）：

```ts
  router.post('/profiles/:id/run', asyncHandler(async (req, res) => {
    const profile = await find(Number(req.params.id))
    // 整窗口立即跑：全部启用任务入队（停用任务排除；CoalescingEnqueuer 自动合并为一次开窗会话）
    let count = 0
    for (const task of deps.tasks.values()) {
      if (!(await deps.db.getTaskEnabled(task.meta.key, task.meta.enabled ?? true))) continue
      deps.enqueuer.enqueue(profile, task.meta.key)
      count++
    }
    ok(res, { count })
  }))
```

`tests/web.test.ts`：
- 删用例「窗口立即跑排除停用任务（云端开关覆盖为 false）」（第 221-228 行）
- 删用例「POST /api/profiles/:id/run 入队全部任务」（第 244-249 行）
- 「openapi.json 覆盖全部业务接口路径」expected 数组删 `'/api/profiles/{id}/run',`
- 「窗口不存在返回业务码 40402」用例改为 `post('/api/profiles/999/open')`（原为 `/run`）

- [ ] **Step 2: 删除前端按钮与类型**

`web/src/api/schema.d.ts`：删第 542-596 行 `"/api/profiles/{id}/run": { ... },` 整个对象（从路径键到 `    };`，下一个键是 `"/api/profiles/{id}/breaker/reset"`）。
`web/src/api/endpoints.ts`：删第 10 行 `export const runProfile = (id: number) => post<{ count: number }>(`/api/profiles/${id}/run`, {})`。
`web/src/pages/profiles/hooks.ts`：删第 12 行 `  runProfile,` 导入；删第 78-90 行 `useRunProfile` 函数。
`web/src/pages/profiles/index.tsx`：
- 第 19 行删 `PlayCircleOutlined, `（该文件仅「立即跑」按钮使用）
- 第 33 行删 `  useRunProfile,`
- 第 63 行删 `  const run = useRunProfile()`
- 删第 251-259 行按钮：

```tsx
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={run.isPending && run.variables === p.id}
              onClick={() => run.mutate(p.id)}
            >
              立即跑
            </Button>
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿
Run: `npm run test:web` → Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: 删除窗口页「立即跑」入口（前后端）"
```

---

### Task 4: 删除看板「重跑今日失败」（后端 runs 路由 + 前端按钮）

**Files:**
- Delete: `src/server/routes/runs.ts`
- Modify: `src/server/app.ts`、`tests/web.test.ts`、`web/src/api/schema.d.ts`、`web/src/api/endpoints.ts`、`web/src/pages/dashboard/hooks.ts`、`web/src/pages/dashboard/index.tsx`

**Interfaces:**
- Consumes: Task 1
- Produces: `POST /api/runs/rerun-failed` 不存在；`endpoints.ts` 无 `rerunFailed`；dashboard 无 `useRerunFailed`

- [ ] **Step 1: 删除后端路由文件与装配**

删除 `src/server/routes/runs.ts` 整个文件。
`src/server/app.ts`：删第 21 行 `import { runsRouter } from './routes/runs'`；删第 67 行 `  api.use(runsRouter(deps))`。

`tests/web.test.ts`：
- 删第 326-387 行五个 rerun-failed 用例（`POST /api/runs/rerun-failed 重跑失败（failed 行入队一次）`、`无失败记录返回 count 0`、`只跑最新轮：历史轮失败但最新轮成功则不重跑`、`只跑最新轮：最新轮失败则入队一次（历史轮不重复入队）`、`跳过在途任务（DB 在途行或队列会话，任一命中不重跑）`）
- 「openapi.json 覆盖全部业务接口路径」expected 数组删 `'/api/runs/rerun-failed',`

- [ ] **Step 2: 删除前端按钮与类型**

`web/src/api/schema.d.ts`：删第 362-416 行 `"/api/runs/rerun-failed": { ... },` 整个对象（下一个键是 `"/api/profiles"`）。
`web/src/api/endpoints.ts`：删第 9 行 `export const rerunFailed = (date: string) => post<{ count: number }>('/api/runs/rerun-failed', { date })`。
`web/src/pages/dashboard/hooks.ts`：第 3 行导入改为 `import { fetchDashboard, fetchTasks, triggerTask } from '../../api/endpoints'`；删第 33-44 行 `useRerunFailed` 函数。
`web/src/pages/dashboard/index.tsx`：
- 第 23 行删 `, ReloadOutlined`（改为 `import { SearchOutlined, PlayCircleOutlined } from '@ant-design/icons'`）
- 第 28 行删 `, useRerunFailed`
- 第 116 行删 `  const rerun = useRerunFailed()`
- 删第 320-322 行按钮：

```tsx
          <Button icon={<ReloadOutlined />} loading={rerun.isPending} onClick={() => rerun.mutate(dateStr)}>
            重跑今日失败
          </Button>
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿
Run: `npm run test:web` → Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: 删除看板「重跑今日失败」入口（前后端）"
```

---

### Task 5: 删除看板「全部窗口执行」与任务页 schedule 摘要

**Files:**
- Modify: `web/src/pages/dashboard/index.tsx`、`web/src/pages/tasks/hooks.ts`、`web/src/pages/tasks/index.tsx`、`web/src/pages/tasks/hooks.test.ts`、`web/src/api/schema.d.ts`、`web/src/types.ts`

**Interfaces:**
- Consumes: Task 1（后端 GET /api/tasks 已无 schedule 字段）
- Produces: dashboard 无 `handleTriggerAll`/「全部窗口执行」按钮；tasks 页无 `scheduleText`；`schema.d.ts` 任务数据无 `schedule` 属性

- [ ] **Step 1: 删除看板「全部窗口执行」**

`web/src/pages/dashboard/index.tsx`：
- 第 23 行删 `PlayCircleOutlined, `（改为 `import { SearchOutlined } from '@ant-design/icons'`）
- 删第 264-270 行：

```tsx
  const handleTriggerAll = () => {
    if (!taskFilter) {
      message.warning('请先选择一个任务')
      return
    }
    trigger.mutate({ key: taskFilter })
  }
```

- 删第 323-331 行按钮：

```tsx
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={trigger.isPending && !trigger.variables?.bitbrowserId}
            disabled={taskFilter ? (taskNameByKey.get(taskFilter)?.inFlight ?? false) : true}
            onClick={handleTriggerAll}
          >
            全部窗口执行
          </Button>
```

- 保留：`taskFilter` 状态与 Select（仍用于表格行筛选）、`taskNameByKey`（任务列显示名用）、`useTriggerTask`（行级「执行/重跑」用）。`message` 仍被其他逻辑使用，勿删 `const { message } = App.useApp()`。

- [ ] **Step 2: 删除任务页 schedule 摘要**

`web/src/pages/tasks/hooks.ts`：删第 39-47 行 `scheduleText` 函数（含其注释）。
`web/src/pages/tasks/index.tsx`：第 7 行删 `  scheduleText,`；第 38 行改为：

```tsx
              ⏱ 钱包 {task.wallet ?? '无'} · 重试{' '}
```

（即删掉 `{scheduleText(task.schedule)} · ` 部分，保留 `⏱ ` 前缀与后续内容）

`web/src/pages/tasks/hooks.test.ts`：第 2 行删 `, scheduleText`（导入改为 `import { categoryColor, categoryLabel } from './hooks'`）；删第 30-45 行 `describe('scheduleText', ...)` 块。
`web/src/api/schema.d.ts`：删第 47-48 行：

```ts
                                /** @description cron 字符串或错峰窗口对象 {stagger:[start,end]} */
                                schedule?: Record<string, never> | null;
```

`web/src/types.ts`：第 28 行注释改为 `// 任务 meta 视图：与 /api/tasks envelope data 一致（retry/captcha 均为对象或 null，见 server 注解）`。

- [ ] **Step 3: 验证**

Run: `npm run typecheck` → Expected: 无错误
Run: `npm run test:web` → Expected: 全绿
Run: `npm test` → Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: 删除看板「全部窗口执行」与任务页调度摘要"
```

---

### Task 6: 同步文档（API-GUIDE.md + AGENTS.md）

**Files:**
- Modify: `docs/API-GUIDE.md`、`AGENTS.md`

**Interfaces:**
- Consumes: Task 1-5（以最终代码状态为准）
- Produces: 文档与代码一致

- [ ] **Step 1: 更新 docs/API-GUIDE.md（逐处精确替换）**

1. 第 3 行：删 `、\`src/engine/scheduler.ts\``
2. 第 22 行表格行改为：`| **框架**（引擎 + 浏览器） | 替你操作浏览器的「手」。它读你的说明书，真的去点网页、失败还会重试 |`
3. 第 28 行改为：`写任务（写说明书） → 试跑（本地单窗口验证） → 上线（面板开开关，手动触发执行）`
4. 第 31 行改为：`1. **写任务**：复制示例文件，改两处——\`meta\`（这任务叫什么、要不要钱包）和 \`run\`（具体操作步骤）。`
5. 第 33 行改为：`3. **上线**：面板任务页打开开关，之后手动触发执行（任务页「立即触发」或看板行级「执行」），看板自动记录结果。`
6. 第 55-56 行删两行（名词表 cron、错峰）
7. 第 80 行删（名词表 调度器）；第 82 行删（名词表 croner）
8. 第 133 行改为：`注意：\`url\` 为空字符串的任务只能在面板手动触发——示例任务正是如此。`
9. 第 157 行改为：`| \`key\` | \`string\` | 无（必填） | 全局唯一标识。API 路由（\`/api/tasks/:key/trigger\`）与数据库 runs 表都用它 |`
10. 第 159 行改为：`| \`url\` | \`string\` | 无（必填，可为 \`''\`） | 站点入口页 URL，\`goto()\` 从这里开始。空串 → 仅可手动触发 |`
11. 第 164 行改为：`| \`deprecated\` | \`boolean?\` | \`false\` | \`true\` → 面板置灰显示「已失效」（仅能手动触发） |`
12. 第 165 行改为：`| \`enabled\` | \`boolean?\` | \`true\` | 任务开关的代码默认值：\`false\` → 手动触发接口返回 409。面板任务页开关写入云端 \`task_states\` 表覆盖（立即生效，无需重启；跨机器生效、重启保留）。注意：上表的 \`true\` 只是代码默认值，三个示例任务（[example-checkin.ts](src://example-checkin.ts)/[faucet-example.ts](src://faucet-example.ts)/[mint-example.ts](src://mint-example.ts)）都显式写了 \`enabled: false\`（示例不参与日常执行，方便调试） |`
13. 第 166 行删（TaskMeta 表 schedule 行）
14. 第 183 行删（示例 meta 代码块中 `  schedule: { stagger: ['09:00', '11:00'] },`）
15. 第 191-199 行整段删（「错峰写法」段落 + 「cron 写法」段落 + 示例列表，保留其后第 200 行 `---`）
16. 第 851-905 行整章替换为：

````md
## 7. 手动触发

系统**没有定时调度**：任务全部由人在面板上手动触发，或由失败重试机制自动补跑（重试与调度器无关）。

### 触发入口

| 入口 | 接口 | 语义 |
| --- | --- | --- |
| 面板任务页「立即触发」 | `POST /api/tasks/:key/trigger`（不带 body） | 该任务推给**全部启用窗口** |
| 面板看板行级「执行」（失败行显示「重跑」） | `POST /api/tasks/:key/trigger`，body `{ bitbrowserId }` | **单窗口单任务**：只把该窗口的该任务入队（对应矩阵里那一行） |
| 失败重试（自动） | — | 任务失败进入 `retry_wait` 后退避到期自动重新入队（进程重启后由重试恢复扫描接续，见[第 9 章「任务的一生」](#任务的一生状态流转)） |

### 触发守卫

`POST /api/tasks/:key/trigger` 的前置检查（顺序）：

1. 任务未注册 → 404（业务码 40401）；
2. 任务已停用（云端 `task_states` 覆盖或代码 `enabled: false`）→ 409（业务码 40901），提示 `任务已停用`；
3. 带 `bitbrowserId` 时窗口不存在 → 404（业务码 40402）；
4. 在途检查：该任务（或该窗口该任务）已有 pending/running/retry_wait 行或已排队 → 409（业务码 40902），提示 `任务执行中`。

### 入队语义

所有入口最终都调用 `CoalescingEnqueuer.enqueue(profile, taskKey)`：同一窗口的多个任务合并为一次开窗会话（开窗/连接/探活只做一遍）；窗口正在执行时新的触发进入 follow-up 队列，窗口跑完再补跑，**不会并发开同一个窗口**。

### 面板运行时覆盖

面板任务页每张卡片的开关为**运行时覆盖**：点开关调用 `PATCH /api/tasks/:key`，写入云端 `task_states` 表（`key → enabled`），**立即生效（含重新启用，无需重启服务）**；覆盖值云端持久，重启保留、多台机器部署同库时跨机器生效。无覆盖记录时回落到代码 `meta.enabled ?? true`。停用的任务无法手动触发（409）。
````

17. 第 919 行 execution 行改为：`| \`execution\` | \`concurrency\`、\`windowTimeoutMs\`、\`probeUrl\`、\`taskTimeoutMs\`、\`retryMax\`、\`retryBackoffSec\`、\`circuitBreakerThreshold\`、\`humanize\` | 执行引擎：窗口并发默认 6；单窗口会话超时默认 15 分钟（到点剩余任务标「窗口超时」跳过）；\`probeUrl\` 是开窗后的探活地址；\`taskTimeoutMs\`/\`retryMax\`/\`retryBackoffSec\` 是单任务超时与重试的全局默认（任务 meta 可逐个覆盖）；\`circuitBreakerThreshold\` 是窗口熔断阈值（连续失败达到即跳过剩余任务）；\`humanize.minDelayMs\`/\`humanize.maxDelayMs\` 是拟人动作的随机停顿区间（默认 800/3000 毫秒） |`
18. 第 930 行看板描述改为：`- **看板（首页）**：四张统计卡（今日完成率环形图、结果分布标签、验证码花费与次数、实时运行窗口数）＋ 日期选择（DatePicker，可按天回看）＋ 任务筛选下拉 ＋ 状态 Segmented（全部/失败/成功/进行中）＋ 窗口搜索框 ＋ 运行记录表（窗口/任务/状态/尝试/错误/截图/操作）。行级「执行」= 单窗口单任务触发（失败行显示「重跑」）。停留在看板页时每 15 秒自动刷新。`
19. 第 931 行窗口页描述删去 `行内「立即跑」= 跑该窗口的全部启用任务；`
20. 第 932 行任务页描述改为：`- **任务页**：任务卡片网格（每卡两列），卡片含任务名/key/分类徽章（签到/领水/铸币/其他）、钱包/重试/验证码摘要、备注、来源页链接；停用或已失效任务半透明显示。卡片开关写入云端 \`task_states\` 表，切换**立即生效**（无需重启）；「立即触发」= 该任务在全部启用窗口跑一遍。`
21. 第 934 行设置页描述改为：`- **设置页**：比特浏览器卡（API 地址 ＋「测试连接」按钮与结果 Tag）；执行参数 Descriptions 只读展示（并发/探活 URL/熔断阈值/版本）；yescaptcha 卡（「查询余额」按钮展示剩余点数）；数据源卡（账号表加载状态：路径 ＋ N 行 + 列名，不可用时 Alert 报错，改完 xlsx 点「重载」即时生效，无需重启）；主题卡（三态 Segmented，与顶栏一致）。`
22. 第 948、950 行删（REST 总表 `POST /api/profiles/:id/run` 与 `POST /api/runs/rerun-failed` 两行）
23. 第 976 行注释改为 `│        ▲                                               │ 退避到期，重试定时器重新入队`
24. 第 1000 行改为：`- **重试不占窗口**：\`retry_wait\` 期间窗口立即释放（继续跑别的任务或正常关窗），到点由重试定时器重新入队、开新一轮窗口会话。`
25. 第 1006 行改为：`- 这里讲的是「任务已经入队之后」的流转；「任务根本没资格入队」的守卫（已停用/url 为空）见[第 7 章「触发守卫」](#触发守卫)。`
26. 第 1009 行改为：`> 同一天可有多轮（手动重复触发/失败重试），\`runs\` 表按 \`slot\` 列（当日第几轮，0 起）各占一行互不覆盖；面板 dashboard 页「开始时间」列可区分轮次。`
27. 第 1034 行改为：`对应的 \`meta\` 只需声明站点与钱包：`
28. 第 1042 行删（示例 meta 中 `  schedule: { stagger: ['09:00', '11:00'] },   // 每天 9:00-11:00 随机一分钟`）
29. 第 1062 行改为：`  （退避时间自然覆盖剩余冷却；千万不要把冷却中当成功，否则会整轮虚报）`
30. 第 1206 行改为：`- **重试不占窗**：进入 \`retry_wait\` 后立即释放窗口（不 sleep 占并发名额），当前窗口会话正常继续处理其他任务或关闭；退避到期由重试定时器重新入队，开新一轮窗口会话从续跑轮次开始执行。`
31. 第 1258 行改为：`| \`任务已停用\` | 手动触发被拒（接口 409） | 任务开关关着（云端 task_states 或代码 \`enabled: false\`） | 面板任务页打开开关（立即生效）；确实不想跑就别触发 |`
32. 第 1338 行删（模板中 `调度时间（每天几点/多久一次，或「不调度、只手动触发」）：`）
33. 第 1352 行改为：`| 任务 key | ✅ | 英文小写 + 连字符（如 \`my-checkin\`）。全局唯一标识，数据库/API 都用它 | 重复会冲突；中途改 key 等于换新任务，历史记录对不上 |`
34. 第 1361 行删（字段说明表 调度时间 行）
35. 第 1396 行删（填写示例中 `调度时间：每天 10:00-12:00 随机（错峰）`）
36. 第 1416 行改为：`6. **上线**：面板任务页打开开关，之后手动触发执行（任务页「立即触发」/看板行级「执行」，见[第 7 章](#7-手动触发)）。`

- [ ] **Step 2: 更新 AGENTS.md**

第 40 行改为：`- \`engine/\`：queue(p-queue 并发 + 同窗口任务合并 CoalescingEnqueuer)、window-runner（开窗→CDP 接管→顺序跑任务→关窗，patchright 驱动）、task-context（任务的 ctx 能力）、state（状态机）、retry-recovery（重启后恢复 retry_wait）`

第 51 行改为：`要点：任务 = \`meta\`（key/name/url/wallet/timeoutSec/retry/captcha） + \`run(ctx)\`；成功必须显式断言（ctx.clickCheckin 的 assert 等）；无定时调度，仅手动触发（任务页「立即触发」= 全部启用窗口、看板行级「执行/重跑」= 单窗口单任务）；\`meta.enabled=false\` 时手动触发 409；面板任务页开关写入云端 task_states 覆盖代码默认值。`

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿
Run: `npm run test:web` → Expected: 全绿
Run: `git grep -n "scheduler\|Scheduler\|croner\|timezone\|stagger\|everyHours\|rerun-failed\|/run'"` → Expected: 除 `docs/superpowers/`（历史文档）与 `package-lock.json` 残留外无命中；`package-lock.json` 中 croner 残留由 `npm uninstall` 在 Task 1 已清理

- [ ] **Step 4: Commit**

```bash
git add docs/API-GUIDE.md AGENTS.md
git commit -m "docs: 同步手册与协作者指南（纯手动触发）"
```
